// End-to-end check of sign-in and the project pages against a running dev
// server and a migrated database. Submits the forms the way a browser
// without JavaScript does, using the hidden fields React renders for server
// actions.
//
// Usage: SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/smoke-projects.mjs [base URL]

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3000";
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
assert.ok(email && password, "set SMOKE_EMAIL and SMOKE_PASSWORD");

const decode = (s) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The session cookie, as a browser would keep it between requests. */
let cookie = "";

function keepCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/(?:^|,s*)session=([^;]*)/);
  if (match) cookie = match[1] ? `session=${match[1]}` : "";
  return setCookie;
}

async function page(path) {
  const response = await fetch(base + path, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  keepCookie(response);
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
  };
}

/** Submits the form on `path` with `fields`, keeping React's hidden inputs. */
async function submit(path, fields) {
  const { status, html } = await page(path);
  assert.equal(status, 200, `GET ${path}`);

  const form = new FormData();
  for (const [, name, value = ""] of html.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g,
  )) {
    form.append(decode(name), decode(value));
  }
  assert.ok(
    [...form.keys()].some((key) => key.startsWith("$ACTION_")),
    `${path} renders a server action form`,
  );
  for (const [name, value] of Object.entries(fields)) form.set(name, value);

  const response = await fetch(base + path, {
    method: "POST",
    body: form,
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  const setCookie = keepCookie(response);
  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie,
    html: await response.text(),
  };
}

function step(name) {
  console.log(`- ${name}`);
}

step("signed-out visitors are sent to the sign-in page");
for (const path of [
  "/overview",
  "/spend",
  "/usage",
  "/projects",
  "/projects/new",
]) {
  const result = await page(path);
  assert.equal(result.status, 307, `GET ${path} while signed out`);
  const location = new URL(result.location, base);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), path);
}

step("a wrong password is rejected without revealing which part was wrong");
{
  const result = await submit("/login", { email, password: "wrong password" });
  assert.equal(result.status, 200);
  assert.match(result.html, /Invalid email or password/);
  assert.equal(cookie, "", "no session cookie after a failed sign-in");
}

step("signing in sets a secure session cookie and returns to the page");
{
  const result = await submit("/login?next=%2Fprojects%2Fnew", {
    email,
    password,
  });
  assert.equal(result.status, 303, "redirect after sign-in");
  assert.equal(new URL(result.location, base).pathname, "/projects/new");
  assert.match(result.setCookie, /HttpOnly/i);
  assert.match(result.setCookie, /SameSite=lax/i);
  assert.ok(cookie, "session cookie is set");
}

step("an off-site next parameter is ignored");
{
  const signedIn = cookie;
  cookie = "";
  const result = await submit("/login?next=%2F%2Fevil.example", {
    email,
    password,
  });
  assert.equal(new URL(result.location, base).pathname, "/overview");
  assert.equal(new URL(result.location, base).host, new URL(base).host);
  cookie = signedIn;
}

step("the spend overview renders totals for each window");
{
  const overview = await page("/overview");
  assert.equal(overview.status, 200);
  assert.match(overview.html, /Spend overview/);
  for (const window of ["today", "month", "last30Days"]) {
    assert.match(overview.html, new RegExp(`data-window="${window}"`));
  }
  // CI records known usage first and passes the expected total for today.
  const expected = process.env.EXPECT_TODAY_SPEND;
  if (expected) {
    const today = overview.html.match(/data-window="today"[^>]*>([^<]+)</)?.[1];
    assert.equal(today, expected, "today's total");
  }
}

step("the overview shows each project's monthly budget use");
{
  const overview = await page("/overview");
  const row = overview.html
    .split("<tr")
    .find((r) => r.includes(">Sample App<"));
  assert.ok(row, "seeded Sample App is listed");
  const budget = row
    .match(/data-testid="budget"[\s\S]*?<\/td>/)?.[0]
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
  assert.match(budget, /of \$100\.00/, "shows the seeded $100 budget");
  assert.match(budget, /left/, "shows what remains");
  assert.match(row, /role="meter"/, "renders a meter");
  // CI records $0.006 of usage for Sample App, 0.006% of its budget.
  if (process.env.EXPECT_TODAY_SPEND) {
    assert.match(budget, /\$0\.006 of \$100\.00/);
    assert.match(budget, /<0\.1%/);
  }
}

step("invalid values are rejected with inline errors");
{
  const result = await submit("/projects/new", {
    name: "",
    slug: "Bad_Slug",
    monthlyBudgetUsd: "-5",
  });
  assert.equal(result.status, 200);
  assert.match(result.html, /Name is required/);
  assert.match(result.html, /Use lowercase letters/);
  assert.match(result.html, /Enter an amount like/);
}

const slug = `smoke-${randomUUID().slice(0, 8)}`;

step(`creating "${slug}" redirects to the list, which shows it`);
{
  const result = await submit("/projects/new", {
    name: "Smoke Project",
    slug,
    monthlyBudgetUsd: "42.5",
  });
  assert.equal(result.status, 303, "redirect after create");
  assert.equal(new URL(result.location, base).pathname, "/projects");

  const list = await page("/projects");
  assert.equal(list.status, 200);
  assert.ok(list.html.includes(slug), "new project is listed");
  assert.ok(list.html.includes("$42.50"), "budget is formatted");
}

step("a duplicate slug shows an inline error");
{
  const result = await submit("/projects/new", {
    name: "Duplicate",
    slug,
    monthlyBudgetUsd: "",
  });
  assert.equal(result.status, 200);
  assert.match(result.html, /Another project already uses this slug/);
}

step("editing clears the budget and renames the project");
{
  const list = await page("/projects");
  const row = list.html.split("<tr").find((r) => r.includes(slug));
  const editPath = row?.match(/href="(\/projects\/[^"]+\/edit)"/)?.[1];
  assert.ok(editPath, "list links to the edit page");

  const edit = await page(editPath);
  assert.match(edit.html, /value="42\.50"/, "edit form is prefilled");

  const result = await submit(editPath, {
    name: "Smoke Project Renamed",
    slug,
    monthlyBudgetUsd: "",
  });
  assert.equal(result.status, 303, "redirect after edit");

  const after = await page("/projects");
  const updated = after.html.split("<tr").find((r) => r.includes(slug));
  assert.match(updated, /Smoke Project Renamed/);
  assert.match(updated, /No budget/);
}

step("spend over time filters by range and project");
{
  const total = (html) =>
    html.match(/data-testid="range-total"[^>]*>([^<]+)</)?.[1];
  const current = (html) =>
    html.match(/aria-current="true"[^>]*>(\d+)(?:<!-- -->)? days</)?.[1];

  const all = await page("/spend?range=7");
  assert.equal(all.status, 200);
  assert.equal(current(all.html), "7", "7-day range is selected");
  assert.match(all.html, /role="img"/, "chart renders");
  assert.match(all.html, /By provider/);
  assert.match(all.html, /By model/);
  const expected = process.env.EXPECT_TODAY_SPEND;
  if (expected) assert.equal(total(all.html), expected, "7-day total");

  // The smoke project has no usage, so filtering to it shows zero.
  const list = await page("/projects");
  const row = list.html.split("<tr").find((r) => r.includes(slug));
  const projectId = row?.match(/\/projects\/([^/"]+)\/edit/)?.[1];
  assert.ok(projectId, "found the smoke project id");
  const filtered = await page(`/spend?range=7&project=${projectId}`);
  assert.equal(total(filtered.html), "$0.00", "project filter applies");
  assert.match(filtered.html, /No usage in this range/);

  const fallback = await page("/spend?range=14&project=not-a-project");
  assert.equal(fallback.status, 200);
  assert.equal(current(fallback.html), "30", "invalid range falls back");
  if (expected)
    assert.equal(total(fallback.html), expected, "unknown project means all");
}

step("usage events are listed and filterable");
{
  const all = await page("/usage");
  assert.equal(all.status, 200);
  assert.match(all.html, /data-testid="usage-events"/, "table renders");
  // CI passes the request id of the usage it recorded earlier.
  const requestId = process.env.EXPECT_REQUEST_ID;
  if (requestId)
    assert.ok(all.html.includes(requestId), "recorded event is listed");

  const openai = await page("/usage?provider=openai&model=gpt-4.1");
  if (requestId)
    assert.ok(openai.html.includes(requestId), "matching filters keep it");
  assert.match(openai.html, /<option value="openai" selected="">/);

  const none = await page("/usage?provider=anthropic");
  assert.match(none.html, /No usage events match these filters/);
  assert.match(
    none.html,
    /href="\/usage"[^>]*>Clear</,
    "offers to clear filters",
  );

  const bad = await page("/usage?cursor=garbage&from=nope");
  assert.equal(bad.status, 200, "invalid parameters are ignored");
}

step("an unknown project id is a 404");
{
  assert.equal((await page(`/projects/${randomUUID()}/edit`)).status, 404);
  assert.equal((await page("/projects/not-a-uuid/edit")).status, 404);
}

step("budget alerts appear on the overview and projects list");
// Needs usage on Sample App, which CI records before running this script.
if (process.env.EXPECT_TODAY_SPEND) {
  const list = await page("/projects");
  const row = list.html.split("<tr").find((r) => r.includes(">sample-app<"));
  const editPath = row?.match(/href="(\/projects\/[^"]+\/edit)"/)?.[1];
  assert.ok(editPath, "found Sample App's edit page");
  const setBudget = async (monthlyBudgetUsd) => {
    const result = await submit(editPath, {
      name: "Sample App",
      slug: "sample-app",
      monthlyBudgetUsd,
    });
    assert.equal(result.status, 303, "budget saved");
  };
  const sampleRow = (html) =>
    // Table rows only: the alert summary above the table also names the project.
    html
      .split("<tr")
      .slice(1)
      .find((r) => r.includes(">Sample App<")) ?? "";

  // A $0.00 budget with spend is over budget.
  await setBudget("0.00");
  const overview = await page("/overview");
  assert.match(
    overview.html,
    /data-testid="budget-alerts"/,
    "alert summary shown",
  );
  assert.match(overview.html, /1 project needs attention/);
  assert.match(sampleRow(overview.html), /data-budget-state="over"/);
  assert.match(sampleRow(overview.html), /Over budget/);
  const projects = await page("/projects");
  assert.match(projects.html, /data-testid="budget-alerts"/);
  assert.match(sampleRow(projects.html), /data-budget-status="over"/);

  // Restoring the $100 budget clears the alerts.
  await setBudget("100.00");
  const restored = await page("/overview");
  assert.doesNotMatch(restored.html, /data-testid="budget-alerts"/);
  assert.match(sampleRow(restored.html), /data-budget-state="ok"/);
}

step("signing out ends the session, even if the old cookie is replayed");
{
  const signedIn = cookie;
  const list = await page("/projects");
  assert.equal(list.status, 200);
  assert.ok(list.html.includes(email), "shows the signed-in email");

  const result = await submit("/projects", {});
  assert.equal(result.status, 303, "redirect after sign-out");
  assert.equal(new URL(result.location, base).pathname, "/login");
  assert.equal(cookie, "", "session cookie is cleared");

  cookie = signedIn;
  assert.equal((await page("/projects")).status, 307, "old session is revoked");
}

console.log("Sign-in and project pages smoke test passed.");

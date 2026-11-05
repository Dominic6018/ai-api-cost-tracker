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
  "/breakdown",
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

step("the price list shows each seeded price with its source");
{
  const prices = await page("/prices");
  assert.equal(prices.status, 200);
  const row = prices.html
    .split("<tr")
    .find((r) => r.includes('data-model="claude-sonnet-5-5"'));
  assert.ok(row, "the seeded Claude Sonnet 5.5 price is listed");
  const text = row
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  assert.match(text, /Current/);
  // Seed prices per 1M tokens: $2 input, $0.10 cache reads, $10 output.
  assert.match(text, /\$2\.00 \$0\.10 \$2\.50 \$10\.00/);
  assert.match(
    row,
    /href="https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing"/,
  );
  assert.match(text, /Checked \d{4}-\d{2}-\d{2}/);
}

{
  const priceModel = `smoke-price-${randomUUID().slice(0, 8)}`;
  const today = new Date().toISOString().slice(0, 10);
  const price = {
    provider: "openai",
    model: priceModel,
    inputPerMTokUsd: "2",
    outputPerMTokUsd: "8",
    cachedInputPerMTokUsd: "0.5",
    effectiveFrom: "2026-01-01T00:00",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    checkedOn: today,
  };

  step("adding a price without a source shows an inline error");
  {
    const result = await submit("/prices/new", { ...price, sourceUrl: "" });
    assert.equal(result.status, 200);
    assert.match(result.html, /Where was this price read\?/);
  }

  step(
    `adding a price for "${priceModel}" lists it as current, with who added it`,
  );
  {
    const result = await submit("/prices/new", price);
    assert.equal(result.status, 303, "redirect after adding");
    assert.equal(new URL(result.location, base).pathname, "/prices");

    const prices = await page("/prices");
    const row = prices.html
      .split("<tr")
      .find((r) => r.includes(`data-model="${priceModel}"`));
    assert.ok(row, "the new price is listed");
    const text = row
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    assert.match(text, /Current/);
    assert.match(text, /\$2\.00 \$0\.50 — \$8\.00/);
    assert.match(
      row,
      /href="https:\/\/developers\.openai\.com\/api\/docs\/pricing"/,
    );
    assert.ok(text.includes(`Checked ${today}`), "shows the check date");
    assert.ok(text.includes(`Added by ${email}`), "shows who added it");
  }

  step("a second price starting at the same time is refused");
  {
    const result = await submit("/prices/new", price);
    assert.equal(result.status, 200);
    assert.match(result.html, /already has a price starting at this time/);
  }

  const priceRow = async () =>
    (await page("/prices")).html
      .split("<tr")
      .find((r) => r.includes(`data-model="${priceModel}"`));
  const endPath = (await priceRow()).match(
    /href="(\/prices\/[0-9a-f-]+\/end)"/,
  )?.[1];
  assert.ok(endPath, "a current price links to its end page");
  const ending = {
    endsAt: "2026-02-01T00:00",
    sourceUrl: "https://developers.openai.com/api/docs/deprecations",
    checkedOn: today,
  };

  step("ending a price before it starts shows an inline error");
  {
    const result = await submit(endPath, {
      ...ending,
      endsAt: "2025-06-01T00:00",
    });
    assert.equal(result.status, 200);
    assert.match(result.html, /after this price starts/);
  }

  step(`ending "${priceModel}" lists it as ended, with who ended it and why`);
  {
    const result = await submit(endPath, ending);
    assert.equal(result.status, 303, "redirect after ending");
    assert.equal(new URL(result.location, base).pathname, "/prices");

    const row = await priceRow();
    const text = row
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    // The status cell, between the provider and the first rate.
    assert.match(text, /openai Ended \$2\.00/);
    assert.doesNotMatch(row, /\/end"/, "an ended price has no End link");
    assert.match(text, /Ended per developers\.openai\.com/);
    assert.ok(
      text.includes(`Checked ${today}, by ${email}`),
      "shows who ended it",
    );
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

  // The forecast: all CI usage is from today, which the 7-full-day pace
  // leaves out, so the month-end forecast is this month's spend so far.
  const forecast = row
    .match(/data-testid="forecast"[^>]*>([\s\S]*?)<\/td>/)?.[1]
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .trim();
  assert.ok(forecast, "shows a month-end forecast");
  if (process.env.EXPECT_TODAY_SPEND) {
    assert.equal(forecast, process.env.EXPECT_TODAY_SPEND);
  }
  assert.doesNotMatch(row, /Forecast over budget/);
  // $0.006 today is under the $1 floor for a spending spike.
  assert.doesNotMatch(row, /data-testid="spike"/);
  assert.match(
    overview.html,
    /data-forecast="total"/,
    "shows a total forecast",
  );
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
    runBudgetUsd: "1.25",
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
  assert.match(edit.html, /value="1\.25"/, "run budget is prefilled");

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

step("the cost breakdown groups spend by each attribution field");
for (const by of ["customer", "user", "feature", "run"]) {
  const result = await page(`/breakdown?by=${by}&range=7`);
  assert.equal(result.status, 200, `GET /breakdown?by=${by}`);
  assert.match(result.html, /data-testid="breakdown-summary"/);
  // Usage recorded so far has no attribution, so it's all "Not set".
  assert.match(result.html, /data-kind="unset"/);
}
{
  const fallback = await page("/breakdown?by=nonsense");
  // React splits text with comment markers, so check the hidden input.
  assert.match(fallback.html, /name="by" value="customer"/);
}

step("the usage CSV export downloads the filtered events");
{
  const requestId = process.env.EXPECT_REQUEST_ID;
  const query = requestId ? `?model=gpt-4.1` : "";
  const response = await fetch(`${base}/usage/export${query}`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(response.status, 200, "GET /usage/export");
  assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /attachment; filename="usage-\d{4}-\d{2}-\d{2}\.csv"/,
  );
  const csv = await response.text();
  assert.ok(
    csv.startsWith("occurred_at,project,provider,model,"),
    "header row",
  );
  if (requestId)
    assert.ok(csv.includes(requestId), "the smoke event is exported");

  const focus = await fetch(`${base}/usage/export?format=focus`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(focus.status, 200, "GET /usage/export?format=focus");
  assert.match(
    focus.headers.get("content-disposition") ?? "",
    /filename="usage-focus-\d{4}-\d{2}-\d{2}\.csv"/,
  );
  const focusCsv = await focus.text();
  assert.ok(
    focusCsv.startsWith("BilledCost,EffectiveCost,ListCost,"),
    "FOCUS header row",
  );
  if (requestId) {
    // Nothing billed; the estimate is ListCost, for both token types.
    const rows = focusCsv.split("\r\n").filter((l) => l.includes(requestId));
    assert.equal(rows.length, 2, "input and output rows");
    assert.ok(
      rows.every((l) => l.startsWith("0,0,")),
      "BilledCost 0",
    );
  }

  const signedOut = await fetch(`${base}/usage/export`, { redirect: "manual" });
  assert.equal(signedOut.status, 307, "signed out");
  assert.equal(
    new URL(signedOut.headers.get("location"), base).pathname,
    "/login",
  );
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

step("repeated failed sign-ins are refused with a generic message");
{
  cookie = "";
  // An address with no account, so the smoke account stays usable.
  const target = `locked-${randomUUID()}@example.com`;
  for (let i = 0; i < 5; i++) {
    const result = await submit("/login", { email: target, password: "x" });
    assert.match(result.html, /Invalid email or password/);
  }
  const result = await submit("/login", { email: target, password: "x" });
  assert.equal(result.status, 200);
  assert.match(result.html, /Too many sign-in attempts/);
  assert.equal(cookie, "", "no session cookie when rate limited");
}

console.log("Sign-in and project pages smoke test passed.");

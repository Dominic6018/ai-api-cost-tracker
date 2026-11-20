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

/** React's hidden server action inputs on a page, as form data. */
function hiddenFields(html) {
  const form = new FormData();
  for (const [, name, value = ""] of html.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g,
  )) {
    form.append(decode(name), decode(value));
  }
  return form;
}

/** Submits the form on `path` with `fields`, keeping React's hidden inputs. */
async function submit(path, fields) {
  const { status, html } = await page(path);
  assert.equal(status, 200, `GET ${path}`);

  const form = hiddenFields(html);
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

step("every dashboard page has the same navigation, marking where it is");
{
  const sections = [
    "Overview",
    "Usage",
    "Insights",
    "Customers",
    "Budgets",
    "Prices",
    "Integrations",
  ];
  for (const [path, section] of [
    ["/overview", "Overview"],
    ["/usage", "Usage"],
    ["/spend", "Usage"],
    ["/breakdown", "Usage"],
    ["/changes", "Insights"],
    ["/savings", "Insights"],
    ["/revenue", "Customers"],
    ["/projects", "Budgets"],
    ["/prices", "Prices"],
    ["/ingestion", "Integrations"],
  ]) {
    const result = await page(path);
    assert.equal(result.status, 200, `GET ${path}`);
    const nav = result.html.match(
      /data-testid="dashboard-nav"[\s\S]*?<\/form>/,
    )?.[0];
    assert.ok(nav, `${path} has the navigation`);
    for (const label of sections) {
      assert.ok(nav.includes(`>${label}</a>`), `${path} links to ${label}`);
    }
    assert.match(
      nav,
      new RegExp(`aria-current="page"[^>]*>${section}</a>`),
      `${path} is under ${section}`,
    );
    assert.match(nav, /Sign out/);
  }
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
  // Seed prices per 1M tokens: $2 input, $0.10 cache reads, $2.50 5-minute
  // and $4 1-hour cache writes, $10 output; batch at 50%; $10 per 1,000
  // web searches.
  assert.match(text, /\$2\.00 \$0\.10 \$2\.50 \$4\.00 \$10\.00 50% \$10\.00/);
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
    serviceTier: "standard",
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
    // The tier is required too; the form's select always sends one.
    const noTier = await submit("/prices/new", { ...price, serviceTier: "" });
    assert.equal(noTier.status, 200);
    assert.match(noTier.html, /Choose a tier/);
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
    assert.match(text, /\$2\.00 \$0\.50 — — \$8\.00/);
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

  // The forecast: all CI usage is from today, so there are no full days
  // of history to take a pace from, and it says so rather than guessing.
  const forecast = row
    .match(/data-testid="forecast"[^>]*>([\s\S]*?)<\/td>/)?.[1]
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(forecast, "shows a month-end forecast");
  if (process.env.EXPECT_TODAY_SPEND) {
    assert.match(forecast, /^Not enough data \(0\/ ?7 days\)$/);
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

/** The hidden server action inputs of the one form on a page holding `marker`. */
function formFields(html, marker) {
  const form = html.split("<form").find((chunk) => chunk.includes(marker));
  assert.ok(form, `a form holds ${marker}`);
  return hiddenFields(form.split("</form>")[0]);
}

const KEY_PATTERN = /act_[A-Za-z0-9_-]{43}/g;
let keysPath;

step(
  "an admin creates an API key in the dashboard, shown once, and revokes it",
);
{
  const list = await page("/projects");
  const row = list.html.split("<tr").find((r) => r.includes(slug));
  keysPath = row?.match(/href="(\/projects\/[^"]+\/keys)"/)?.[1];
  assert.ok(keysPath, "the project list links to its keys");

  const empty = await page(keysPath);
  assert.equal(empty.status, 200);
  assert.match(empty.html, /No keys yet/);

  const unnamed = await submit(keysPath, { name: " ", scope: "read" });
  assert.equal(unnamed.status, 200);
  assert.match(unnamed.html, /Name is required/);
  assert.doesNotMatch(unnamed.html, KEY_PATTERN, "no key was created");

  const created = await submit(keysPath, {
    name: "smoke-reports",
    scope: "read",
  });
  assert.equal(created.status, 200);
  const shown = [...new Set(created.html.match(KEY_PATTERN) ?? [])];
  assert.equal(shown.length, 1, "the new key is shown");
  const [key] = shown;
  assert.match(created.html, /can(&#x27;|')t be shown again/);
  assert.match(created.html, /COST_TRACKER_READ_KEY/);

  const report = (presented) =>
    fetch(`${base}/api/reports/spend`, {
      headers: { authorization: `Bearer ${presented}` },
    });
  const allowed = await report(key);
  assert.equal(allowed.status, 200, "the new read key reads reports");
  await allowed.text();
  const ingest = await fetch(`${base}/api/usage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(ingest.status, 403, "a read key can't send usage");
  await ingest.text();

  const listed = await page(keysPath);
  assert.doesNotMatch(listed.html, KEY_PATTERN, "the key isn't shown again");
  assert.ok(listed.html.includes(key.slice(0, 12)), "it's listed by prefix");
  assert.match(listed.html, /Read reports/);

  const marker = `aria-label="Revoke smoke-reports (${key.slice(0, 12)})"`;
  const revoke = await fetch(base + keysPath, {
    method: "POST",
    body: formFields(listed.html, marker),
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(revoke.status, 303, "redirect after revoking");
  assert.equal(
    new URL(revoke.headers.get("location"), base).pathname,
    keysPath,
  );
  await revoke.text();

  // A valid key always gets through; a refused one is a 401, or a 429
  // once this address has sent too many invalid keys, as CI's earlier
  // rate limit check makes it.
  const refused = await report(key);
  const body = await refused.text();
  assert.ok(
    refused.status === 401 ||
      (refused.status === 429 && body.includes('"rate_limited"')),
    `the revoked key is refused (got ${refused.status})`,
  );
  const after = await page(keysPath);
  assert.match(after.html, /Revoked/);
  assert.ok(!after.html.includes(marker), "a revoked key has no revoke button");
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

step("savings are labelled as estimates");
{
  const result = await page("/savings");
  assert.equal(result.status, 200);
  const text = result.html.replace(/<!-- -->/g, "");
  assert.ok(text.includes("Savings estimates"));
  assert.ok(text.includes("These are estimates, not promises."));
  assert.equal((await page("/savings?project=not-a-project")).status, 200);
}

step("why spend changed adds up and states its method");
{
  for (const compare of ["30d", "7d", "month", "not-a-comparison"]) {
    const result = await page(`/changes?compare=${compare}`);
    assert.equal(result.status, 200, `GET /changes?compare=${compare}`);
    const text = result.html.replace(/<!-- -->/g, "");
    assert.ok(text.includes("Why spend changed"));
    assert.ok(text.includes("change-summary"), "the summary is shown");
  }
  const text = (await page("/changes?compare=7d")).html.replace(
    /<!-- -->/g,
    "",
  );
  if (!text.includes("No priced usage in either period")) {
    for (const label of [
      "Volume",
      "Model mix",
      "Tokens per request",
      "Input/output mix",
      "Cache rate",
      "Other",
      "Method:",
    ]) {
      assert.ok(text.includes(label), `the page shows "${label}"`);
    }
  }
}

step("revenue against AI API cost, never called profit");
{
  const result = await page("/revenue");
  assert.equal(result.status, 200);
  const text = result.html.replace(/<!-- -->/g, "");
  assert.ok(text.includes("Revenue minus AI API cost"), "the column is named");
  // "Profit" appears only to say the figure isn't profit (the page's
  // text is in the HTML twice: the markup and the render data).
  const saysNotProfit = /isn(?:'|&#x27;|&apos;)t profit/gi;
  assert.match(text, saysNotProfit, "the page says it isn't profit");
  assert.doesNotMatch(
    text.replace(saysNotProfit, ""),
    /profit/i,
    "nothing is labelled profit",
  );
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(text.includes(month), "the current month is shown");
  const fallback = await page("/revenue?month=not-a-month");
  assert.equal(fallback.status, 200, "an invalid month falls back");
  assert.ok(fallback.html.replace(/<!-- -->/g, "").includes(month));
}

step("ingestion health lists what each project sent today");
{
  const result = await page("/ingestion");
  assert.equal(result.status, 200);
  const text = result.html.replace(/<!-- -->/g, "");
  for (const label of [
    "Stored",
    "Unpriced",
    "Replayed",
    "Conflicts",
    "Invalid",
  ]) {
    assert.ok(text.includes(label), `the ingestion page has "${label}"`);
  }
  assert.ok(
    text.includes(new Date().toISOString().slice(0, 10)),
    "today's usage is counted",
  );
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

step("an admin changes roles on the accounts page, keeping an admin");
{
  /** Submits the role form on the row for `account`, as a browser would. */
  async function changeRole(account, role) {
    const { html } = await page("/team");
    const form = formFields(html, `aria-label="Change role for ${account}"`);
    form.set("role", role);
    const response = await fetch(`${base}/team`, {
      method: "POST",
      body: form,
      headers: { cookie },
      redirect: "manual",
    });
    await response.text();
    assert.equal(response.status, 303, `redirect after changing ${account}`);
    const location = new URL(response.headers.get("location"), base);
    assert.equal(location.pathname, "/team");
    return location.searchParams.get("status");
  }
  const roleShown = (html, account) =>
    html
      .split("<tr")
      .find((row) => row.includes(account))
      ?.match(/<option value="(\w+)" selected="">/)?.[1];

  const team = await page("/team");
  assert.equal(team.status, 200);
  assert.ok(team.html.includes(email), "the admin is listed");
  assert.match(team.html, /\(you\)/);

  // In CI the admin is the organization's only admin.
  if (roleShown(team.html, email) === "admin") {
    const others = team.html.match(/<option value="admin" selected="">/g);
    if (others.length === 1) {
      assert.equal(await changeRole(email, "member"), "last_admin");
      const after = await page("/team?status=last_admin");
      assert.match(after.html, /Each organization needs an admin/);
      assert.equal(roleShown(after.html, email), "admin", "still an admin");
    }
  }

  const viewer = process.env.SMOKE_VIEWER_EMAIL;
  if (viewer) {
    assert.equal(roleShown(team.html, viewer), "viewer");
    assert.equal(await changeRole(viewer, "member"), "changed");
    const changed = await page("/team?status=changed");
    assert.match(changed.html, /Role changed\./);
    assert.equal(roleShown(changed.html, viewer), "member");
    // Back, for the viewer checks below.
    assert.equal(await changeRole(viewer, "viewer"), "changed");
    assert.equal(roleShown((await page("/team")).html, viewer), "viewer");
  }
}

step("an admin invites someone by link, who joins with their own password");
{
  /** Creates an invitation on /team and returns its link's path. */
  async function invite(invitee, role) {
    const { html } = await page("/team");
    const form = formFields(html, 'id="invite-email"');
    form.set("email", invitee);
    form.set("role", role);
    const response = await fetch(`${base}/team`, {
      method: "POST",
      body: form,
      headers: { cookie },
      redirect: "manual",
    });
    const body = await response.text();
    assert.equal(response.status, 200, `inviting ${invitee}`);
    assert.match(body, /isn(&#x27;|')t emailed/);
    const paths = [
      ...new Set(body.match(/\/invite\/[A-Za-z0-9_-]{43}/g) ?? []),
    ];
    assert.equal(paths.length, 1, "the link is shown");
    return paths[0];
  }
  const invalid = /This invitation link can(&#x27;|')t be used/;

  const invitee = `invitee-${randomUUID().slice(0, 8)}@example.com`;
  const link = await invite(invitee, "member");
  const listed = await page("/team");
  assert.ok(listed.html.includes(invitee), "the open invitation is listed");
  assert.ok(!listed.html.includes(link), "the link isn't shown again");

  const admin = cookie;
  cookie = "";
  const opened = await page(link);
  assert.equal(opened.status, 200);
  assert.ok(opened.html.includes(invitee), "the link names the email");
  assert.match(opened.html, /<meta name="referrer" content="no-referrer"/);

  for (const [fields, message] of [
    [{ password: "short", confirmPassword: "short" }, /at least 12 characters/],
    [
      { password, confirmPassword: `${password}!` },
      /two passwords don(&#x27;|')t match/,
    ],
  ]) {
    const refused = await submit(link, fields);
    assert.equal(refused.status, 200);
    assert.match(refused.html, message);
  }

  const joined = await submit(link, { password, confirmPassword: password });
  assert.equal(joined.status, 303, "redirect after joining");
  assert.equal(new URL(joined.location, base).pathname, "/overview");
  assert.ok(cookie, "the new account is signed in");
  const overview = await page("/overview");
  assert.equal(overview.status, 200);
  assert.ok(overview.html.includes(invitee), "signed in as the invitee");
  const team = await page("/team");
  assert.equal(team.status, 307, "a member can't manage accounts");
  assert.match((await page(link)).html, invalid, "the link works once");

  cookie = admin;
  const joinedList = await page("/team");
  const row = joinedList.html.split("<tr").find((r) => r.includes(invitee));
  assert.match(row ?? "", /<option value="member" selected="">/);

  const revokedInvitee = `revoked-${randomUUID().slice(0, 8)}@example.com`;
  const revokedLink = await invite(revokedInvitee, "viewer");
  const withRevoke = await page("/team");
  const revoke = await fetch(`${base}/team`, {
    method: "POST",
    body: formFields(
      withRevoke.html,
      `aria-label="Revoke the invitation for ${revokedInvitee}"`,
    ),
    headers: { cookie },
    redirect: "manual",
  });
  await revoke.text();
  assert.equal(revoke.status, 303);
  assert.equal(
    new URL(revoke.headers.get("location"), base).search,
    "?status=invitation_revoked",
  );
  cookie = "";
  assert.match((await page(revokedLink)).html, invalid, "revoked links fail");
  cookie = admin;
}

step("the audit log records who changed projects and prices");
{
  const result = await page("/audit");
  assert.equal(result.status, 200);
  const text = result.html.replace(/<!-- -->/g, "");
  for (const label of [
    "Created project",
    "Updated project",
    "Added price",
    "Ended price",
    "Created API key",
    "Revoked API key",
    "Invited account",
    "Revoked invitation",
    "Created account",
    ...(process.env.SMOKE_VIEWER_EMAIL ? ["Changed role"] : []),
  ]) {
    assert.ok(text.includes(label), `the audit log shows "${label}"`);
  }
  assert.ok(text.includes(email), "the audit log names who made the change");
}

if (process.env.SMOKE_VIEWER_EMAIL) {
  step("a viewer can read but not change projects or prices");
  // An admin's copy of the form, so the viewer's request reaches the real
  // server action rather than stopping at a hidden link.
  const form = hiddenFields((await page("/projects/new")).html);
  const name = `Viewer ${randomUUID()}`;
  form.set("name", name);
  form.set("slug", `viewer-${randomUUID()}`);

  const admin = cookie;
  cookie = "";
  const signedIn = await submit("/login", {
    email: process.env.SMOKE_VIEWER_EMAIL,
    password,
  });
  assert.equal(signedIn.status, 303, "viewer signs in");

  for (const path of [
    "/projects/new",
    "/prices/new",
    "/audit",
    "/team",
    keysPath,
  ]) {
    const denied = await page(path);
    assert.equal(denied.status, 307, `GET ${path} as a viewer`);
    assert.equal(new URL(denied.location, base).pathname, "/no-access");
  }
  assert.match((await page("/no-access")).html, /viewer/);

  const projectsPage = await page("/projects");
  assert.equal(projectsPage.status, 200);
  assert.doesNotMatch(
    projectsPage.html,
    /New project|aria-label="Edit |aria-label="API keys for /,
  );
  // The audit log, and the Team section with it, isn't offered either.
  assert.doesNotMatch(projectsPage.html, /href="\/audit"/);
  assert.doesNotMatch(projectsPage.html, />Team<\/a>/);
  const pricesPage = await page("/prices");
  assert.equal(pricesPage.status, 200);
  assert.doesNotMatch(pricesPage.html, /Add price/);

  const posted = await fetch(base + "/projects/new", {
    method: "POST",
    body: form,
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(posted.status, 303, "the action refuses a viewer");
  assert.equal(
    new URL(posted.headers.get("location"), base).pathname,
    "/no-access",
  );
  assert.ok(
    !(await page("/projects")).html.includes(name),
    "the viewer's project wasn't created",
  );
  cookie = admin;
}

if (process.env.SMOKE_OTHER_ORG_EMAIL) {
  step("an account in another organization can't see or change this one");
  const list = await page("/projects");
  // Read separately: the order of the link's attributes isn't guaranteed.
  const link = list.html.match(/<a\b[^>]*aria-label="Edit [^"]+"[^>]*>/)?.[0];
  assert.ok(link, "found a project to look for");
  const projectId = link.match(/href="\/projects\/([^/"]+)\/edit"/)?.[1];
  const projectName = link.match(/aria-label="Edit ([^"]+)"/)?.[1];
  assert.ok(projectId && projectName, "read the project's id and name");
  const form = hiddenFields((await page(`/projects/${projectId}/edit`)).html);
  const hijacked = `Hijacked ${randomUUID()}`;
  form.set("name", hijacked);
  form.set("slug", `hijacked-${randomUUID()}`);

  const admin = cookie;
  cookie = "";
  const signedIn = await submit("/login", {
    email: process.env.SMOKE_OTHER_ORG_EMAIL,
    password,
  });
  assert.equal(
    signedIn.status,
    303,
    "the other organization's account signs in",
  );

  for (const path of [
    "/overview",
    "/projects",
    "/spend",
    "/breakdown",
    "/usage",
    `/usage?project=${projectId}`,
    "/audit",
    "/prices",
    "/ingestion",
    "/revenue",
    "/changes",
    "/savings",
    "/team",
  ]) {
    const result = await page(path);
    assert.equal(result.status, 200, `GET ${path}`);
    assert.ok(!result.html.includes(projectName), `${path} hides the project`);
    assert.ok(!result.html.includes(email), `${path} hides the other account`);
  }
  assert.equal(
    (await page(`/projects/${projectId}/edit`)).status,
    404,
    "another organization's project is a 404",
  );
  assert.equal(
    (await page(`/projects/${projectId}/keys`)).status,
    404,
    "another organization's keys are a 404",
  );
  const denied = await page("/prices/new");
  assert.equal(denied.status, 307, "GET /prices/new from another organization");
  assert.equal(new URL(denied.location, base).pathname, "/no-access");
  assert.doesNotMatch((await page("/prices")).html, /Add price/);

  const csv = await page("/usage/export");
  assert.equal(csv.status, 200);
  assert.equal(csv.html.trim().split("\r\n").length, 1, "the export is empty");

  const posted = await fetch(`${base}/projects/${projectId}/edit`, {
    method: "POST",
    body: form,
    headers: { cookie },
    redirect: "manual",
  });
  assert.notEqual(posted.status, 303, "the action doesn't save");
  await posted.text();

  cookie = admin;
  const after = await page("/projects");
  assert.ok(after.html.includes(projectName), "the project is unchanged");
  assert.ok(!after.html.includes(hijacked), "the project wasn't renamed");
}

if (process.env.SMOKE_OIDC) {
  step(
    "single sign-on signs in an existing account, only with its checks intact",
  );
  const admin = cookie;
  cookie = "";
  const login = await page("/login");
  // React separates text nodes with comments.
  assert.match(login.html.replace(/<!-- -->/g, ""), /Sign in with Test IdP/);

  /** Starts SSO; returns the provider's URL and this attempt's cookie. */
  const start = async (next) => {
    const response = await fetch(
      `${base}/login/oidc?next=${encodeURIComponent(next)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 307, "start redirects to the provider");
    const sso = response.headers.get("set-cookie")?.match(/oidc_login=[^;]+/);
    assert.ok(sso, "start sets the SSO cookie");
    const authorize = response.headers.get("location");
    assert.match(authorize, /code_challenge_method=S256/);
    assert.match(authorize, /[?&]nonce=/);
    return { authorize, sso: sso[0] };
  };
  /** Signs in at the test provider; returns the callback URL it sends to. */
  const provider = async (authorize, subject, claims) => {
    const response = await fetch(authorize, {
      method: "POST",
      body: new URLSearchParams({
        username: subject,
        claims: JSON.stringify(claims),
      }),
      redirect: "manual",
    });
    assert.equal(response.status, 302, "the provider redirects back");
    return response.headers.get("location");
  };
  const callback = async (url, sso) => {
    const response = await fetch(url, {
      headers: sso ? { cookie: sso } : {},
      redirect: "manual",
    });
    await response.text();
    return {
      status: response.status,
      location: new URL(response.headers.get("location"), base),
      session: response.headers
        .get("set-cookie")
        ?.match(/session=([^;]+)/)?.[1],
    };
  };
  const verified = { email, email_verified: true };

  // An existing account signs in, and lands where it asked to go.
  {
    const { authorize, sso } = await start("/spend");
    const done = await callback(
      await provider(authorize, "smoke-sso", verified),
      sso,
    );
    assert.equal(done.status, 303);
    assert.equal(done.location.pathname, "/spend");
    assert.ok(done.session, "signing in sets a session");
    cookie = `session=${done.session}`;
    assert.equal((await page("/spend")).status, 200);
    cookie = "";
  }
  const refused = async (name, run, error) => {
    const result = await run();
    assert.equal(result.location.pathname, "/login", name);
    assert.equal(result.location.searchParams.get("error"), error, name);
    assert.ok(!result.session, `${name}: no session`);
  };
  await refused(
    "a tampered state",
    async () => {
      const { authorize, sso } = await start("/");
      const url = new URL(await provider(authorize, "smoke-sso", verified));
      url.searchParams.set("state", "tampered");
      return callback(url, sso);
    },
    "sso_failed",
  );
  await refused(
    "a callback without its cookie",
    async () => {
      const { authorize } = await start("/");
      return callback(await provider(authorize, "smoke-sso", verified), null);
    },
    "sso_failed",
  );
  for (const [name, subject, claims] of [
    [
      "an unknown email",
      "nobody-sso",
      { email: "nobody@example.com", email_verified: true },
    ],
    ["an unverified email", "smoke-sso", { email, email_verified: false }],
    ["another subject for a bound account", "someone-else", verified],
  ]) {
    await refused(
      name,
      async () => {
        const { authorize, sso } = await start("/");
        return callback(await provider(authorize, subject, claims), sso);
      },
      "sso_denied",
    );
  }
  cookie = admin;
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

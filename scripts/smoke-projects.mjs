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
for (const path of ["/overview", "/projects", "/projects/new"]) {
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

step("an unknown project id is a 404");
{
  assert.equal((await page(`/projects/${randomUUID()}/edit`)).status, 404);
  assert.equal((await page("/projects/not-a-uuid/edit")).status, 404);
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

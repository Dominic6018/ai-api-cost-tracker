// End-to-end check of the project pages against a running dev server and a
// migrated database. Submits the forms the way a browser without JavaScript
// does, using the hidden fields React renders for server actions.
//
// Usage: node scripts/smoke-projects.mjs [base URL]

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3000";

const decode = (s) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

async function page(path) {
  const response = await fetch(base + path);
  return { status: response.status, html: await response.text() };
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
  assert.ok(form.has("$ACTION_KEY"), `${path} renders a server action form`);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);

  const response = await fetch(base + path, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
  };
}

function step(name) {
  console.log(`- ${name}`);
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

console.log("Project pages smoke test passed.");

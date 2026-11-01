// Captures the README screenshots from a running app, in light and dark
// mode, by driving headless Chrome over the DevTools protocol. Load demo
// data first (`npm run db:demo`) and create an account to sign in with.
//
// Usage: SHOT_EMAIL=... SHOT_PASSWORD=... node scripts/screenshots.mjs [base URL] [output dir]
// CHROME_PATH overrides the browser (default: google-chrome).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const outDir = process.argv[3] ?? "docs/screenshots";
const chrome = process.env.CHROME_PATH ?? "google-chrome";
const email = process.env.SHOT_EMAIL;
const password = process.env.SHOT_PASSWORD;
assert.ok(email && password, "set SHOT_EMAIL and SHOT_PASSWORD");

const PAGES = [
  ["overview", "/overview"],
  ["spend", "/spend?range=90"],
  ["usage", "/usage"],
  ["projects", "/projects"],
];
const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };

const profile = await mkdtemp(path.join(tmpdir(), "screenshots-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

try {
  // Chrome prints its DevTools address on standard error.
  const wsUrl = await new Promise((resolve, reject) => {
    let output = "";
    browser.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    browser.on("error", reject);
    browser.on("exit", (code) => reject(new Error(`Chrome exited (${code})`)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
  };

  const { targetId } = await send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const page = (method, params) => send(method, params, sessionId);
  const nextEvent = (method) =>
    new Promise((resolve) => {
      const listener = (message) => {
        if (message.method === method && message.sessionId === sessionId) {
          listeners.delete(listener);
          resolve(message.params);
        }
      };
      listeners.add(listener);
    });

  async function evaluate(expression) {
    const { result, exceptionDetails } = await page("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }

  async function waitFor(expression, what) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  async function open(pathname) {
    const loaded = nextEvent("Page.loadEventFired");
    await page("Page.navigate", { url: base + pathname });
    await loaded;
  }

  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    mobile: false,
  });

  // Sign in through the real form.
  await open("/login");
  await evaluate(`(() => {
    const form = document.querySelector("form");
    form.email.value = ${JSON.stringify(email)};
    form.password.value = ${JSON.stringify(password)};
    form.requestSubmit();
  })()`);
  await waitFor(`location.pathname === "/overview"`, "sign-in");

  await mkdir(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await page("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    for (const [name, pathname] of PAGES) {
      await open(pathname);
      await evaluate(`document.fonts.ready.then(() => true)`);
      // The dev server's floating indicator isn't part of the app.
      await evaluate(
        `document.querySelectorAll("nextjs-portal").forEach((el) => el.remove())`,
      );
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      const file = path.join(outDir, `${name}-${scheme}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`- ${file}`);
    }
  }
  ws.close();
} finally {
  // Wait for the browser to let go of its profile before deleting it, and
  // never let cleanup hide the error that got us here.
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(
    () => {},
  );
}

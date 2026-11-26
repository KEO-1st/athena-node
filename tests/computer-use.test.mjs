import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Opt-in physical-desktop test. It launches a real installed Chromium through
 * ATHENA Node, operates a local page through the DOM and captures the screen.
 * Run with: npm run test:computer
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.platform === "win32" && process.env.ATHENA_TEST_COMPUTER === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function request(port, route, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, type, json: type.includes("json") ? await res.json() : null, buffer: type.includes("json") ? null : Buffer.from(await res.arrayBuffer()) };
}

test("real Chromium navigation, DOM inspection, typing, clicking and evidence", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const page = http.createServer((req, res) => {
    if (req.url?.startsWith("/next")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<title>Next page</title><main><h1>Next page</h1><p>navigation worked</p></main>");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>ATHENA Browser Test</title>
      <main>
        <h1>ATHENA browser test</h1>
        <input id="search" name="q" placeholder="Search" />
        <button id="go" onclick="document.getElementById('out').textContent='clicked:' + document.getElementById('search').value">Search</button>
        <p id="out">not clicked</p>
        <a id="next" href="/next">Next page</a>
      </main>`);
  });
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  const pagePort = page.address().port;
  t.after(() => page.close());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-computer-"));
  const port = await freePort();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ name: "Computer test", port, openWindow: false, allowInput: true, allowScreen: true, allowShell: false, allowShutdown: false })
  );
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ id: "node_computer", token: "computer-token", hub: "hub_test", index: 1 }));
  const child = spawn(process.execPath, ["athena-node.mjs"], {
    cwd: ROOT,
    env: { ...process.env, ATHENA_NODE_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    child.kill();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const auth = { "x-athena-token": "computer-token" };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await request(port, "/api/hello")).status === 200) break;
    } catch {
      /* starting */
    }
    await sleep(150);
  }
  try {
    const status = await request(port, "/api/action", { method: "POST", headers: auth, body: { op: "browser", args: { op: "status" } } });
    assert.equal(status.status, 200, output);
    assert.ok(status.json.browsers.length > 0, "a real Chromium browser is installed");

    const opened = await request(port, "/api/action", {
      method: "POST",
      headers: auth,
      body: { op: "browser", args: { op: "open", url: `http://127.0.0.1:${pagePort}/` } },
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.page.title, "ATHENA Browser Test");
    assert.equal(opened.json.foreground.focused, true, `browser focus failed: ${JSON.stringify(opened.json.foreground)}`);

    const inspected = await request(port, "/api/action", { method: "POST", headers: auth, body: { op: "browser", args: { op: "inspect" } } });
    assert.equal(inspected.status, 200);
    assert.ok(inspected.json.links.some((link) => link.text.includes("Next page")), "real DOM links are returned");
    assert.ok(inspected.json.fields.some((field) => field.name === "q"), "real form fields are returned");

    const typed = await request(port, "/api/action", {
      method: "POST",
      headers: auth,
      body: { op: "browser", args: { op: "type", selector: "#search", text: "hello computer" } },
    });
    assert.equal(typed.status, 200);
    assert.equal(typed.json.action.typed, "hello computer");

    const clicked = await request(port, "/api/action", { method: "POST", headers: auth, body: { op: "browser", args: { op: "click", text: "Search" } } });
    assert.equal(clicked.status, 200);
    assert.match(clicked.json.page.text, /clicked:hello computer/, "the click changed the live page");

    const screen = await request(port, "/api/screen", { headers: auth });
    assert.equal(screen.status, 200);
    assert.equal(screen.type, "image/jpeg");
    assert.ok(screen.buffer.length > 1000, "a real JPEG frame is returned");

    const windows = await request(port, "/api/action", { method: "POST", headers: auth, body: { op: "windows", args: {} } });
    assert.equal(windows.status, 200);
    assert.ok(
      windows.json.windows.some((window) => window.title.includes("ATHENA Browser Test")),
      "the browser window is identified: " + JSON.stringify(windows.json.windows.map((window) => `${window.process}: ${window.title}`)) + `\nAGENT:\n${output.slice(-2500)}`
    );

    const moved = await request(port, "/api/action", {
      method: "POST",
      headers: auth,
      body: { op: "browser", args: { op: "click", text: "Next page" } },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.page.title, "Next page");
    assert.match(moved.json.page.url, /\/next$/);
  } finally {
    const bootstrap = await request(port, "/api/local/bootstrap", { headers: { "x-athena-panel": "1" } }).catch(() => null);
    if (bootstrap?.json?.token) {
      await request(port, "/api/local/quit", { method: "POST", headers: { "x-athena-local": bootstrap.json.token } }).catch(() => undefined);
      await sleep(800);
    }
  }
});

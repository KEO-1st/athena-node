import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 15_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`Node did not answer ${url}: ${last?.message || "timeout"}`);
}

test("authenticated Node API rejects bad tokens and disabled execution", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-node-api-"));
  const port = 49200 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      name: "API test node",
      port,
      openWindow: false,
      pairOpen: false,
      allowShell: false,
      allowShutdown: false,
      allowInput: false,
    })
  );
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ id: "node_test", token: "paired-token", hub: "hub_test", index: 1 })
  );

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
    await sleep(250);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hello = await waitFor(`${base}/api/hello`);
  const helloBody = await hello.json();
  assert.equal(helloBody.protocol, 1);
  assert.equal(helloBody.nodeVersion, "0.3.0");

  const noToken = await fetch(`${base}/api/status`);
  assert.equal(noToken.status, 403);
  const wrongToken = await fetch(`${base}/api/status`, { headers: { "x-athena-token": "wrong" } });
  assert.equal(wrongToken.status, 403);

  const status = await fetch(`${base}/api/status`, { headers: { "x-athena-token": "paired-token" } });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.id, "node_test");
  assert.ok("hardware" in statusBody);
  assert.ok("dependencies" in statusBody);
  assert.ok(Array.isArray(statusBody.hardware.disks) || statusBody.hardware.disks === null);

  const exec = await fetch(`${base}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-athena-token": "paired-token" },
    body: JSON.stringify({ op: "exec", args: { cmd: "whoami" } }),
  });
  assert.equal(exec.status, 403);
  assert.match((await exec.json()).error, /disabled/i);

  const shutdown = await fetch(`${base}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-athena-token": "paired-token" },
    body: JSON.stringify({ op: "shutdown", args: {} }),
  });
  assert.equal(shutdown.status, 403, "remote shutdown must be refused when disabled");
  assert.match((await shutdown.json()).error, /disabled/i);

  const input = await fetch(`${base}/api/input`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-athena-token": "paired-token" },
    body: JSON.stringify({ op: "click", x: 0.5, y: 0.5 }),
  });
  assert.equal(input.status, 403, "remote input must be refused when disabled");
  assert.match((await input.json()).error, /switched off|disabled/i);

  const unknown = await fetch(`${base}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-athena-token": "paired-token" },
    body: JSON.stringify({ op: "not-a-real-action" }),
  });
  assert.equal(unknown.status, 400);

  const bootstrapWithoutIntent = await fetch(`${base}/api/local/bootstrap`, {
    headers: { "x-athena-panel": "0" },
  });
  assert.equal(bootstrapWithoutIntent.status, 403);
  const bootstrap = await fetch(`${base}/api/local/bootstrap`, { headers: { "x-athena-panel": "1" } });
  assert.equal(bootstrap.status, 200);
  const { token } = await bootstrap.json();
  assert.ok(token);

  const diagnostics = await fetch(`${base}/api/local/diagnostics`, {
    headers: { "x-athena-local": token },
  });
  assert.equal(diagnostics.status, 200);
  const diagnosticBody = await diagnostics.json();
  assert.ok(Array.isArray(diagnosticBody.checks));
  assert.ok(diagnosticBody.checks.every((check) => "ok" in check));
  assert.equal(diagnosticBody.version, "0.3.0");

  const localStatus = await fetch(`${base}/api/local/status`, {
    headers: { "x-athena-local": token },
  });
  assert.equal(localStatus.status, 200);

  /* The panel may change local permissions; a Hub token may not. */
  const remoteWiden = await fetch(`${base}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-athena-token": "paired-token" },
    body: JSON.stringify({ op: "config", args: { allowShell: true } }),
  });
  assert.equal(remoteWiden.status, 403);
  const localWiden = await fetch(`${base}/api/local/config`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-athena-local": token },
    body: JSON.stringify({ allowShell: true, allowShutdown: true, allowInput: true }),
  });
  assert.equal(localWiden.status, 200);
  const widened = await (await fetch(`${base}/api/local/status`, { headers: { "x-athena-local": token } })).json();
  assert.equal(widened.capabilities.shell, true);
  assert.equal(widened.capabilities.shutdown, true);
  assert.equal(widened.capabilities.input, process.platform === "win32");
  assert.ok(output.includes("node up on"), `agent output was:\n${output}`);
});

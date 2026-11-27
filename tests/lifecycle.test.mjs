import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Compiles the real Windows launcher and proves the desktop lifecycle:
 * one agent, one launcher, a second launch exits, restart replaces exactly one
 * agent, and quit removes both. The panel is disabled for this headless test.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.platform === "win32" && process.env.ATHENA_TEST_LIFECYCLE !== "0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cscPath() {
  return [
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((file) => fs.existsSync(file));
}

function webView2Sdk() {
  const candidates = [
    path.join(ROOT, "tools", "webview2"),
    path.join(ROOT, "..", "tools", "webview2"),
    path.join(ROOT, "..", "tools", ".cache", "webview2", "extracted"),
    path.join(os.tmpdir(), "athena-webview2", "1.0.4370.26"),
  ];
  return candidates.find((dir) =>
    fs.existsSync(path.join(dir, "lib", "net462", "Microsoft.Web.WebView2.Core.dll")) &&
    fs.existsSync(path.join(dir, "lib", "net462", "Microsoft.Web.WebView2.WinForms.dll")) &&
    fs.existsSync(path.join(dir, "build", "native", "x64", "WebView2Loader.dll"))
  );
}

function freePort() {
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
    signal: AbortSignal.timeout(8000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the packaged launcher keeps one agent and one owner through launch, restart and quit", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const compiler = cscPath();
  assert.ok(compiler, "the .NET Framework C# compiler is required on Windows");
  const sdk = webView2Sdk();
  assert.ok(sdk, "the WebView2 managed SDK is required to compile the desktop launcher");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "athena-lifecycle-"));
  const folder = path.join(base, "product");
  const app = path.join(folder, "app");
  const runtime = path.join(folder, "runtime");
  const data = path.join(base, "data");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  for (const name of ["athena-node.mjs", "panel.html", "programs.mjs", "protocol.mjs", "version.mjs", "version.json", "inventory.mjs", "dependencies.mjs", "host-screen.ps1", "host-input.ps1"]) {
    fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  }
  fs.cpSync(path.join(ROOT, "lib"), path.join(app, "lib"), { recursive: true });
  fs.cpSync(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));

  for (const file of [
    path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.Core.dll"),
    path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.WinForms.dll"),
    path.join(sdk, "build", "native", "x64", "WebView2Loader.dll"),
  ]) fs.copyFileSync(file, path.join(folder, path.basename(file)));
  const exe = path.join(folder, "ATHENA Node.exe");
  const compile = spawnSync(
    compiler,
    [
      "/nologo",
      "/optimize+",
      "/target:winexe",
      `/out:${exe}`,
      "/r:System.dll",
      "/r:System.Windows.Forms.dll",
      "/r:System.Drawing.dll",
      `/r:${path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.Core.dll")}`,
      `/r:${path.join(sdk, "lib", "net462", "Microsoft.Web.WebView2.WinForms.dll")}`,
      `/win32icon:${path.join(ROOT, "assets", "athena.ico")}`,
      path.join(ROOT, "tools", "node-launcher.cs"),
    ],
    { encoding: "utf8" }
  );
  assert.equal(compile.status, 0, `launcher compilation failed:\n${compile.stdout}\n${compile.stderr}`);
  assert.ok(fs.existsSync(exe));

  const port = await freePort();
  fs.writeFileSync(
    path.join(data, "config.json"),
    JSON.stringify({ name: "Lifecycle test", port, pairOpen: false, allowShell: false, allowInput: false, allowScreen: true, allowShutdown: false, openWindow: false })
  );

  const env = { ...process.env, ATHENA_NODE_DIR: data, ATHENA_NO_BROWSER: "1", ATHENA_LAUNCHER_NAMESPACE: `test_${path.basename(base).replace(/[^a-zA-Z0-9]/g, "")}` };
  let launcher = spawn(exe, [], { cwd: folder, env, stdio: "ignore", windowsHide: true });
  const logFile = path.join(data, "launcher.log");
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
  t.after(() => {
    try {
      if (launcher.pid) spawnSync("taskkill", ["/pid", String(launcher.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* gone */
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  try {
    await waitFor(async () => (await request(port, "/api/hello")).status === 200, 25_000, "first launch");
  } catch (error) {
    console.error("LIFECYCLE DEBUG", { folder, data, files: fs.readdirSync(data), launcherLog: readLog(), nodeLog: fs.existsSync(path.join(data, "node.log")) ? fs.readFileSync(path.join(data, "node.log"), "utf8") : null });
    throw error;
  }
  assert.equal(readLog().match(/launcher started node \d+/g)?.length, 1);

  const second = spawn(exe, [], { cwd: folder, env, stdio: "ignore", windowsHide: true });
  const secondExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 8000);
    second.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(secondExit, 0, "a second launch signals the owner and exits");
  await sleep(700);
  assert.equal(readLog().match(/launcher started node \d+/g)?.length, 1, "the second launch started no agent");

  const bootstrap = await request(port, "/api/local/bootstrap", { headers: { "x-athena-panel": "1" } });
  assert.equal(bootstrap.status, 200);
  const restarted = await request(port, "/api/local/restart", { method: "POST", headers: { "x-athena-local": bootstrap.json.token } });
  assert.equal(restarted.status, 200);
  await waitFor(async () => {
    const hello = await request(port, "/api/hello").catch(() => null);
    return hello?.status === 200 && readLog().match(/launcher started node \d+/g)?.length === 2;
  }, 20_000, "restart");
  assert.equal(readLog().match(/launcher started node \d+/g)?.length, 2, "restart produced exactly one replacement agent");

  const bootstrap2 = await waitFor(async () => {
    const result = await request(port, "/api/local/bootstrap", { headers: { "x-athena-panel": "1" } }).catch(() => null);
    return result?.status === 200 ? result : null;
  }, 8000, "new local token");
  const quit = await request(port, "/api/local/quit", { method: "POST", headers: { "x-athena-local": bootstrap2.json.token } });
  assert.equal(quit.status, 200);
  await waitFor(async () => launcher.exitCode !== null, 12_000, "launcher exit after quit");
  assert.equal(launcher.exitCode, 0, "quit exits the launcher cleanly");
  const pids = [...readLog().matchAll(/launcher started node (\d+)/g)].map((match) => Number(match[1]));
  await waitFor(async () => pids.every((pid) => !alive(pid)), 8000, "agent processes to stop");
});

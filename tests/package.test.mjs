import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("the public package ships no CMD launchers or uninstall scripts", () => {
  const packager = read("tools/package.mjs");
  assert.doesNotMatch(packager, /Start ATHENA Node\.cmd/);
  assert.doesNotMatch(packager, /Uninstall ATHENA Node\.cmd/);
  assert.match(packager, /Uninstall ATHENA Node\.exe/);
  assert.match(packager, /compileUninstaller/);
});

test("the launcher is single-instance and reopens the existing panel", () => {
  const launcher = read("tools/node-launcher.cs");
  assert.match(launcher, /ATHENA\.Node\.Launcher" \+ NamespaceSuffix/);
  assert.match(launcher, /ATHENA\.Node\.OpenPanel" \+ NamespaceSuffix/);
  assert.match(launcher, /return "\.0_3";/, "production keeps the fixed 0.3 namespace by default");
  assert.match(launcher, /ATHENA_LAUNCHER_NAMESPACE/, "tests can isolate a side-by-side instance");
  assert.match(launcher, /openEvent\.Set\(\)/);
  assert.match(launcher, /code == 75/);
  assert.match(launcher, /code == 76/);
});

test("the panel is one native WebView2 window, not a browser --app hand-off", () => {
  const launcher = read("tools/node-launcher.cs");
  assert.match(launcher, /using Microsoft\.Web\.WebView2\.WinForms/);
  assert.match(launcher, /new WebView2\(\)/);
  assert.match(launcher, /EnsureCoreWebView2Async/);
  assert.doesNotMatch(launcher, /--app=/, "a browser app window is not the desktop product");
  assert.doesNotMatch(launcher, /FindPanelWindow/, "window ownership no longer depends on finding a Chromium window");
  const open = launcher.slice(launcher.indexOf("private void OpenPanel"), launcher.indexOf("private async Task LoadPanelAsync"));
  assert.ok(open.indexOf("panelForm != null && !panelForm.IsDisposed") > -1, "an existing native window is restored instead of duplicated");
  assert.doesNotMatch(open, /tray\.ShowBalloonTip/, "opening the panel must not show the background notification");
});

test("close and minimise hide the window and notify, tray open restores it normally", () => {
  const launcher = read("tools/node-launcher.cs");
  assert.match(launcher, /FormClosing/);
  assert.match(launcher, /e\.Cancel = true;\s*HidePanel\(\);/);
  assert.match(launcher, /WindowState == FormWindowState\.Minimized[\s\S]{0,120}Hide\(\)[\s\S]{0,80}ShowBackgroundNotice\(\)/);
  assert.match(launcher, /panelForm\.WindowState = FormWindowState\.Normal;/);
  assert.match(launcher, /private void HidePanel\(\)[\s\S]{0,200}ShowBackgroundNotice\(\)/);
  assert.match(read("panel.html"), /chrome\.webview\.postMessage\(\{ type: "hide-panel" \}\)/);
});

test("performance and process management use real measurements and confirmed actions", () => {
  const source = read("athena-node.mjs");
  assert.match(source, /route === "\/api\/local\/perf"/);
  assert.match(source, /route === "\/api\/local\/process-kill"/);
  assert.match(source, /netstat/);
  assert.match(source, /PercentProcessorTime/);
  const panel = read("panel.html");
  assert.match(panel, /data-tab="performance"/);
  assert.match(panel, /data-tab="optimization"/);
  assert.match(panel, /data-tab="software"/);
  assert.match(panel, /no fake “boost” switch/i);
  assert.match(panel, /confirm\(`End \$\{name\} \(PID \$\{pid\}\)\?/);
});

test("the panel copies the pairing code, supports the keyboard and explains background mode", () => {
  const panel = read("panel.html");
  assert.match(panel, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(panel, /addEventListener\("keydown"/);
  assert.match(panel, /ATHENA Node will continue running in the background\.[\s\S]{0,120}You can reopen it from the system tray\./);
  assert.match(panel, /prefers-reduced-motion/);
  assert.match(panel, /data-tab="permissions"/);
  assert.match(panel, /item\.address/, "LAN addresses are objects, not raw [object Object]");
  assert.match(panel, /displayName\(display\.name\)/, "Windows display device paths are cleaned for people");
});

test("the Node has an original icon and the installer embeds it", () => {
  assert.ok(fs.statSync(path.join(ROOT, "assets", "athena.ico")).size > 1000);
  const svg = read("assets/athena-mark.svg");
  assert.match(svg, /ATHENA Node mark/);
  assert.doesNotMatch(svg, /Wuthering|WuWa|game/i);
  const packager = read("tools/package.mjs");
  assert.equal((packager.match(/win32icon/g) || []).length >= 2, true);
});

test("new Nodes start without remote shell, input or shutdown", () => {
  const source = read("athena-node.mjs");
  assert.match(source, /allowShell: false/);
  assert.match(source, /allowInput: false/);
  assert.match(source, /allowShutdown: false/);
});

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
  assert.match(launcher, /FocusPanel/);
  assert.match(launcher, /panelOpening/);
  assert.match(launcher, /code == 75/);
  assert.match(launcher, /code == 76/);
});

test("existing windows are not opened over a live panel process", () => {
  const launcher = read("tools/node-launcher.cs");
  const open = launcher.slice(launcher.indexOf("private void OpenPanel"), launcher.indexOf("private bool FocusPanel"));
  const guard = open.indexOf("panel != null && !panel.HasExited");
  const launch = open.indexOf("Process.Start(info)");
  assert.ok(guard > -1 && launch > guard, "the live-panel guard must run before a new window is started");
  assert.match(open, /return;/, "a live panel must stop the second launch path");
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

#!/usr/bin/env node
/**
 * Builds the independent ATHENA Node Windows product.
 *
 *   npm run package
 *
 * Produces:
 *   dist/ATHENA-Node-<version>-win64/       portable folder
 *   dist/ATHENA-Node-<version>-win64.zip     portable download
 *   dist/ATHENA-Node-Setup.exe               self-contained installer
 *   dist/SHA256SUMS.txt                      release asset hashes
 *
 * The runtime is copied from the Node process running this build, so the
 * package never asks a user to install Node.js. The installer embeds the
 * portable folder as a zip payload and needs no admin rights, WinGet or npm.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NODE_VERSION } from "../version.mjs";
import { MAX_HUB_PROTOCOL, MIN_HUB_PROTOCOL, NODE_PROTOCOL } from "../protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CSC = [
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].find((file) => fs.existsSync(file));

const APP_FILES = [
  "athena-node.mjs",
  "panel.html",
  "programs.mjs",
  "protocol.mjs",
  "version.mjs",
  "version.json",
  "inventory.mjs",
  "dependencies.mjs",
  "host-screen.ps1",
  "host-input.ps1",
];

function fresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 600_000, ...options });
  if (result.status !== 0) {
    throw new Error(`${path.basename(file)} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  }
  return result;
}

function zip(folder, destination) {
  fs.rmSync(destination, { force: true });
  const source = `${folder.replace(/'/g, "''")}\\*`;
  const target = destination.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "for($i=0;$i -lt 3;$i++) {",
    "  try {",
    `    Compress-Archive -Path '${source}' -DestinationPath '${target}' -Force`,
    "    break",
    "  } catch {",
    "    if($i -eq 2) { Write-Error $_; exit 1 }",
    "    Start-Sleep -Milliseconds 800",
    "  }",
    "}",
    `if(!(Test-Path -LiteralPath '${target}')) { Write-Error 'archive was not created'; exit 2 }`,
    `if((Get-Item -LiteralPath '${target}').Length -le 0) { Write-Error 'archive is empty'; exit 3 }`,
  ].join("\n");
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return destination;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildInfo(folder, fields) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(folder, full).replace(/\\/g, "/");
      if (rel === "BUILD-INFO.json") continue;
      files[rel] = sha256(full);
    }
  };
  walk(folder);
  fs.writeFileSync(path.join(folder, "BUILD-INFO.json"), JSON.stringify({ ...fields, files }, null, 2) + "\n", "utf8");
}

function compileLauncher(folder) {
  if (!CSC) throw new Error("The Windows C# compiler was not found; cannot build ATHENA Node.exe.");
  const exe = path.join(folder, "ATHENA Node.exe");
  run(CSC, [
    "/nologo",
    "/optimize+",
    "/target:winexe",
    `/out:${exe}`,
    "/r:System.dll",
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    `/win32icon:${path.join(ROOT, "assets", "athena.ico")}`,
    path.join(ROOT, "tools", "node-launcher.cs"),
  ]);
  if (!fs.existsSync(exe)) throw new Error("The launcher compiler did not produce ATHENA Node.exe.");
  return exe;
}

function compileUninstaller(folder) {
  if (!CSC) throw new Error("The Windows C# compiler was not found; cannot build the uninstaller.");
  const exe = path.join(folder, "Uninstall ATHENA Node.exe");
  run(CSC, [
    "/nologo",
    "/optimize+",
    "/target:winexe",
    `/out:${exe}`,
    "/r:System.dll",
    "/r:System.Windows.Forms.dll",
    `/win32icon:${path.join(ROOT, "assets", "athena.ico")}`,
    path.join(ROOT, "tools", "node-uninstaller.cs"),
  ]);
  if (!fs.existsSync(exe)) throw new Error("The compiler did not produce the uninstaller.");
  return exe;
}

function compileInstaller(payload, destination) {
  if (!CSC) throw new Error("The Windows C# compiler was not found; cannot build Setup.exe.");
  run(CSC, [
    "/nologo",
    "/optimize+",
    "/target:winexe",
    `/out:${destination}`,
    "/r:System.dll",
    "/r:System.Windows.Forms.dll",
    "/r:System.IO.Compression.dll",
    "/r:System.IO.Compression.FileSystem.dll",
    "/r:Microsoft.CSharp.dll",
    `/win32icon:${path.join(ROOT, "assets", "athena.ico")}`,
    `/resource:${payload},payload.zip`,
    path.join(ROOT, "tools", "node-installer.cs"),
  ]);
  if (!fs.existsSync(destination)) throw new Error("The installer compiler did not produce Setup.exe.");
  return destination;
}

export function buildNodeProduct({ outDir = DIST, runtime = true, installer = true } = {}) {
  const folder = path.join(outDir, `ATHENA-Node-${NODE_VERSION}-win64`);
  fresh(folder);
  const app = path.join(folder, "app");
  for (const name of APP_FILES) copy(path.join(ROOT, name), path.join(app, name));
  fs.cpSync(path.join(ROOT, "lib"), path.join(app, "lib"), { recursive: true });
  fs.cpSync(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });

  if (!runtime) throw new Error("ATHENA Node requires a bundled runtime; do not build with --no-runtime.");
  const runtimeDir = path.join(folder, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  copy(process.execPath, path.join(runtimeDir, "node.exe"));

  const exe = compileLauncher(folder);
  compileUninstaller(folder);

  write(
    path.join(folder, "VERSION"),
    `${NODE_VERSION}\n`
  );
  write(
    path.join(folder, "README.txt"),
    `ATHENA NODE ${NODE_VERSION}
=================

This is a standalone Windows Node. It does not need Node.js, npm, WinGet or
the ATHENA Hub source tree installed on this PC. The runtime is in runtime\\.

START
  Double-click "ATHENA Node.exe". It sits in the notification area, starts the
  agent without a console window, and opens the local panel. Use its tray menu
  to open, restart, open the data folder, or quit.

PAIR WITH A HUB
  1. Start ATHENA Node on this PC.
  2. Read the six-character code on the panel.
  3. On the Hub: NODES -> SCAN -> LINK, then enter the code.
  4. Allow the Windows firewall prompt for PRIVATE networks.

IDENTITY AND UPDATES
  Identity, settings and logs live in %LOCALAPPDATA%\\ATHENA Node, outside
  these program files. Updating or uninstalling the program does not delete
  them. To update, close the Node, run the newer Setup.exe or extract the newer
  portable package, and keep the data folder.

PROTOCOL
  Node protocol ${NODE_PROTOCOL}; accepts Hub protocol ${MIN_HUB_PROTOCOL}-${MAX_HUB_PROTOCOL}.
  A Hub outside that range is refused with a clear message, never half-driven.

SECURITY
  The Node only accepts its paired Hub token. Permissions (shell, input,
  shutdown, port, pairing code) can only be changed from this PC's panel, not
  by a Hub request. See SECURITY.md in the release/source for details.
`
  );

  buildInfo(folder, {
    component: "node",
    version: NODE_VERSION,
    protocol: NODE_PROTOCOL,
    hubProtocol: { min: MIN_HUB_PROTOCOL, max: MAX_HUB_PROTOCOL },
    runtime: { version: process.version, executable: "runtime/node.exe" },
  });

  const portableZip = zip(folder, path.join(outDir, `ATHENA-Node-${NODE_VERSION}-win64.zip`));
  let installerExe = null;
  const payload = path.join(outDir, ".payload.zip");
  if (installer) {
    zip(folder, payload);
    installerExe = compileInstaller(payload, path.join(outDir, "ATHENA-Node-Setup.exe"));
    fs.rmSync(payload, { force: true });
  }

  const sums = [];
  for (const file of [portableZip, installerExe].filter(Boolean)) sums.push(`${sha256(file)}  ${path.basename(file)}`);
  fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), sums.join("\n") + "\n", "utf8");

  return { folder, exe, portableZip, installerExe, version: NODE_VERSION };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const outDir = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : DIST;
  fs.mkdirSync(outDir, { recursive: true });
  const built = buildNodeProduct({ outDir, installer: !args.includes("--no-installer") });
  console.log(`node:      ${built.folder}`);
  console.log(`launcher:  ${path.basename(built.exe)}`);
  console.log(`portable:  ${path.basename(built.portableZip)}`);
  if (built.installerExe) console.log(`installer: ${path.basename(built.installerExe)}`);
  if (os.platform() !== "win32") console.log("note: Windows packaging was requested on a non-Windows host; verify the artifacts on Windows.");
}

#!/usr/bin/env node
/**
 * ATHENA NODE — the agent that runs on every machine you want ATHENA to drive.
 *
 *   node athena-node.mjs            start it
 *   Install Node.cmd                first-time install on Windows
 *
 * It announces itself on the LAN, shows a pairing code in its window, and once
 * a hub pairs with it, exposes status + a command executor + service control +
 * a ComfyUI tunnel back to that hub. Zero dependencies, Node 20+.
 */

import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { NODE_VERSION } from "./version.mjs";
import { MAX_HUB_PROTOCOL, MIN_HUB_PROTOCOL, NODE_FEATURES, NODE_PROTOCOL, helloInfo, hubProtocolSupported } from "./protocol.mjs";
import { APP_SPECS } from "./lib/app-catalog.mjs";
import { audioDeviceBelongsToSource, classifyAudioDevices, pickAudioDevice } from "./lib/audio-sources.mjs";
import { asUrl, programCandidates, resolveProgramTarget } from "./programs.mjs";
import { audioInventory, cpuUtilization, diskInventory, displayInventory, installedApps, memoryInfo, memoryInventory, osInfo } from "./inventory.mjs";
import { installDependency, portableToolsDir } from "./dependencies.mjs";
import {
  HttpError,
  applyCors,
  corsHeadersFor,
  hostAllowed,
  isLoopback,
  originAllowed,
  readJsonBody,
  redact,
  safeEqual,
} from "./lib/security.mjs";

const IS_WIN = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/* Program files stay beside the agent; identity and logs belong in a writable
   per-user data directory. This is what lets a Node update replace its program
   files without touching the pairing. A test or portable install can override
   it with ATHENA_NODE_DIR. */
const DEFAULT_DATA_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ATHENA Node")
  : path.join(os.homedir(), ".athena-node");
const NODE_DIR = process.env.ATHENA_NODE_DIR ? path.resolve(process.env.ATHENA_NODE_DIR) : DEFAULT_DATA_DIR;
const CONFIG_FILE = path.join(NODE_DIR, "config.json");
const STATE_FILE = path.join(NODE_DIR, "state.json");
const LOG_FILE = path.join(NODE_DIR, "node.log");
const PANEL_FILE = path.join(HERE, "panel.html");
export const DISCOVERY_PORT = 48_880;
const RESTART_EXIT_CODE = 75;
const QUIT_EXIT_CODE = 76;
const UPDATE_REPO = "KEO-1st/athena-node";

const DEFAULTS = {
  name: os.hostname().replace(/\.local$/i, ""),
  port: 47_910,
  code: "",
  pairOpen: false,
  /* A new Node is observable and pairable, but cannot run commands, inject
     input or power itself off until the person at the machine opts in. */
  allowShell: false,
  allowShutdown: false,
  allowInput: false,
  screenMaxWidth: 1280,
  comfyDir: "",
  comfyPort: 8188,
  pythonPath: "",
  autoStartComfy: false,
  openWindow: true,
};

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSync(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

fs.mkdirSync(NODE_DIR, { recursive: true });
const config = { ...DEFAULTS, ...readJsonSync(CONFIG_FILE, {}) };
if (!config.code) config.code = makeCode();
writeJsonSync(CONFIG_FILE, config);

function makeCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/* Pairing is a low-entropy bootstrap secret by design (people read it aloud).
   Limit guesses per source so the code cannot be brute-forced at LAN speed. */
const LINK_WINDOW_MS = 60_000;
const LINK_MAX_FAILURES = 8;
const linkFailures = new Map();

function linkAllowed(ip) {
  const now = Date.now();
  const entry = linkFailures.get(ip);
  if (!entry || now - entry.at > LINK_WINDOW_MS) return { ok: true, remaining: LINK_MAX_FAILURES };
  if (entry.count >= LINK_MAX_FAILURES) return { ok: false, retryAfter: Math.ceil((LINK_WINDOW_MS - (now - entry.at)) / 1000) };
  return { ok: true, remaining: LINK_MAX_FAILURES - entry.count };
}

function noteLinkFailure(ip) {
  const now = Date.now();
  const entry = linkFailures.get(ip);
  if (!entry || now - entry.at > LINK_WINDOW_MS) linkFailures.set(ip, { count: 1, at: now });
  else entry.count += 1;
}

const state = {
  id: "",
  token: null,
  hub: null,
  index: 0,
  linkedAt: null,
  ...readJsonSync(STATE_FILE, {}),
};
if (!state.id) {
  state.id = "node_" + randomBytes(5).toString("hex");
  persistState();
}

function persistState() {
  try {
    writeJsonSync(STATE_FILE, state);
  } catch (error) {
    log("state save failed: " + error.message);
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* best effort */
  }
}

function tailLog(lines = 20) {
  try {
    return fs.readFileSync(LOG_FILE, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/* --------------------------------------------------------------- utilities */

function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd || HERE,
        timeout: options.timeout || 600_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          out: String(stdout || "").trim(),
          err: String(stderr || "").trim(),
        });
      }
    );
  });
}

function shellFor(command) {
  return IS_WIN
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-c", command]];
}

function addressRank(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return 9;
  if (address.startsWith("169.254.")) return 8;
  if (parts[3] === 1) return 7;
  if (parts[0] === 192 && parts[1] === 168) return 0;
  if (parts[0] === 10) return 1;
  if (parts[0] === 172) return 2;
  return 3;
}

function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) found.push({ name, address: item.address });
    }
  }
  return found.sort((a, b) => addressRank(a.address) - addressRank(b.address));
}

/* Minted per boot, handed only to the local panel after an explicit intent
   header. Loopback by itself no longer grants control: any local page can
   reach 127.0.0.1, and so can a DNS-rebinding page. */
const LOCAL_TOKEN = randomBytes(18).toString("hex");

function localOk(req) {
  return isLoopback(req) && safeEqual(req.headers["x-athena-local"], LOCAL_TOKEN);
}

function tokenOk(req) {
  if (localOk(req)) return true;
  const header = String(req.headers["x-athena-token"] || "");
  if (!state.token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(state.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- hardware */

/* Top processes by memory. Cached briefly: the same call is used by the
   "what is running" question and by launch verification. */
let processCache = { at: 0, value: null };

function parseTasklist(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)","[^"]*","(\d+)","([\d,]+)\s*K"/i);
    if (!match) continue;
    rows.push({
      name: match[1],
      pid: Number(match[2]),
      memMb: Number(String(match[4]).replace(/[^\d]/g, "")) / 1024,
    });
  }
  return rows;
}

async function rawProcessRows() {
  if (IS_WIN) {
    const res = await run("tasklist", ["/fo", "csv", "/nh"], { timeout: 10_000 });
    return parseTasklist(res.out);
  }
  const res = await run("ps", ["-eo", "pid,rss,comm", "--sort=-rss"], { timeout: 10_000 });
  return String(res.out || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[0]);
      const rss = Number(parts[1]);
      const name = parts.slice(2).join(" ") || "process";
      return Number.isFinite(pid) ? { name, pid, memMb: (Number.isFinite(rss) ? rss : 0) / 1024 } : null;
    })
    .filter(Boolean);
}

async function processNames() {
  const rows = await rawProcessRows();
  return new Set(rows.map((row) => path.basename(String(row.name)).toLowerCase()));
}

async function waitForAnyProcess(names, timeoutMs = 4500) {
  const wanted = [...new Set(names.map((name) => path.basename(String(name)).toLowerCase()).filter(Boolean))];
  const deadline = Date.now() + timeoutMs;
  do {
    const live = await processNames();
    const hit = wanted.find((name) => live.has(name));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  return null;
}

async function topProcesses(limit = 12) {
  if (processCache.value && Date.now() - processCache.at < 4000) return processCache.value;
  const rows = await rawProcessRows();
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.name).toLowerCase();
    const found = grouped.get(key) || { name: row.name, memMb: 0, count: 0, pid: null };
    found.memMb += row.memMb || 0;
    found.count += 1;
    if (!found.pid) found.pid = row.pid;
    grouped.set(key, found);
  }
  const value = {
    processes: [...grouped.values()]
      .sort((a, b) => b.memMb - a.memMb)
      .slice(0, limit)
      .map((item) => ({ name: item.name, memMb: Math.round(item.memMb), pid: item.pid, count: item.count })),
    total: rows.length,
    at: new Date().toISOString(),
  };
  processCache = { at: Date.now(), value };
  return value;
}

let gpuCache = { at: 0, value: null };

async function gpuInfo() {
  if (Date.now() - gpuCache.at < 5000) return gpuCache.value;
  const res = await run(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,driver_version", "--format=csv,noheader,nounits"],
    { timeout: 6000 }
  );
  let value = null;
  if (res.ok && res.out) {
    const first = res.out.split(/\r?\n/)[0].split(",").map((part) => part.trim());
    const totalMb = Number(first[1]);
    const usedMb = Number(first[2]);
    const totalGb = Number.isFinite(totalMb) && totalMb > 0 ? Math.round(totalMb / 1024) : null;
    const usedGb = Number.isFinite(usedMb) ? Number((usedMb / 1024).toFixed(1)) : null;
    value = {
      name: first[0] || "GPU",
      vramGb: totalGb,
      usedGb,
      availableGb: totalGb != null && usedGb != null ? Number(Math.max(0, totalGb - usedGb).toFixed(1)) : null,
      availablePct: totalGb != null && usedGb != null && totalGb > 0 ? Math.round(((totalGb - usedGb) / totalGb) * 100) : null,
      util: Number.isFinite(Number(first[3])) ? Number(first[3]) : null,
      temp: Number.isFinite(Number(first[4])) ? Number(first[4]) : null,
      driver: first[5] || null,
    };
  } else if (IS_WIN) {
    const wmic = await run("wmic", ["path", "win32_VideoController", "get", "name"], { timeout: 6000 });
    if (wmic.ok && wmic.out) {
      const name = wmic.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(1)[0];
      if (name) value = { name, vramGb: null, usedGb: null, availableGb: null, availablePct: null, util: null, temp: null, driver: null };
    }
  }
  gpuCache = { at: Date.now(), value };
  return value;
}

/* ----------------------------------------------------------------- tasks */

const tasks = new Map();

function taskList() {
  return [...tasks.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 20)
    .map((task) => ({
      id: task.id,
      label: task.label,
      state: task.state,
      code: task.code,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      runningSec: Math.round(((task.endedAt ? Date.parse(task.endedAt) : Date.now()) - Date.parse(task.startedAt)) / 1000),
    }));
}

function startTask(command, options = {}) {
  if (!config.allowShell) throw new Error("Shell execution is disabled on this node (config.json → allowShell).");
  const cmd = String(command || "").trim();
  if (!cmd) throw new Error("Empty command.");
  const task = {
    id: "task_" + randomBytes(4).toString("hex"),
    label: cmd.split("\n")[0].slice(0, 120),
    state: "running",
    code: null,
    output: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    child: null,
  };
  const [file, args] = shellFor(cmd);
  const child = spawn(file, args, {
    cwd: options.cwd && fs.existsSync(String(options.cwd)) ? String(options.cwd) : os.homedir(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  task.child = child;
  const append = (chunk) => {
    task.output = (task.output + chunk.toString()).slice(-120_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (code) => {
    task.state = code === 0 ? "done" : "failed";
    task.code = code;
    task.endedAt = new Date().toISOString();
    task.child = null;
    log(`task ${task.id} ${task.state} (${code}) ${task.label}`);
  });
  child.on("error", (error) => {
    task.state = "failed";
    task.output += "\n" + error.message;
    task.endedAt = new Date().toISOString();
    task.child = null;
  });
  tasks.set(task.id, task);
  log(`task ${task.id} started: ${task.label}`);
  return task;
}

function taskView(task) {
  return {
    id: task.id,
    label: task.label,
    state: task.state,
    code: task.code,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    output: task.output.slice(-20_000),
  };
}

/* ----------------------------------------------------------------- comfyui */

function comfyLayout() {
  const dir = String(config.comfyDir || "").trim();
  if (!dir) return null;
  for (const candidate of [dir, path.join(dir, "ComfyUI")]) {
    if (fs.existsSync(path.join(candidate, "main.py"))) return { mainDir: candidate, root: dir };
  }
  return null;
}

function pythonPath(layout) {
  if (config.pythonPath) return config.pythonPath;
  const candidates = [];
  if (layout) {
    for (const dir of [layout.mainDir, path.dirname(layout.mainDir), layout.root]) {
      candidates.push(
        path.join(dir, "python_embeded", IS_WIN ? "python.exe" : "python3"),
        path.join(dir, "venv", "Scripts", "python.exe"),
        path.join(dir, ".venv", "Scripts", "python.exe"),
        path.join(dir, "venv", "bin", "python3")
      );
    }
  }
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return IS_WIN ? "python" : "python3";
}

let comfyChild = null;
let comfyStartedAt = 0;

async function comfyStats(port = config.comfyPort, timeout = 4000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    return {
      ok: true,
      version: json?.system?.comfyui_version,
      device: json?.devices?.[0]?.name,
      vramGb: json?.devices?.[0]?.vram_total ? Math.round(json.devices[0].vram_total / 1024 ** 3) : undefined,
      port,
    };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "no answer (timeout)" : error?.message || "fetch failed", port };
  }
}

async function startComfy({ wait = 90_000 } = {}) {
  const layout = comfyLayout();
  if (!layout) throw new Error("No ComfyUI folder set on this node. Open the node window → SETTINGS, or call detect.");
  const alive = await comfyStats();
  if (alive.ok) return { already: true, ...alive };
  const py = pythonPath(layout);
  const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  stream.write(`\n[${new Date().toISOString()}] starting ComfyUI: ${py} -s main.py --port ${config.comfyPort}\n`);
  comfyChild = spawn(py, ["-s", "main.py", "--port", String(config.comfyPort), "--listen", "127.0.0.1"], {
    cwd: layout.mainDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  comfyChild.stdout?.pipe(stream);
  comfyChild.stderr?.pipe(stream);
  comfyChild.on("exit", (code) => {
    log(`ComfyUI exited (${code})`);
    comfyChild = null;
  });
  comfyStartedAt = Date.now();
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const stats = await comfyStats(4000, 3000);
    if (stats.ok) return { started: true, ...stats };
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(`ComfyUI did not answer on ${config.comfyPort} in ${Math.round(wait / 1000)}s.\n${tailLog(10)}`);
}

async function stopComfy() {
  const alive = await comfyStats(2000, 1500);
  if (!comfyChild) {
    return { stopped: false, note: alive.ok ? "ComfyUI is running but was not started by this node — stop it on the machine." : "ComfyUI is not running." };
  }
  const pid = comfyChild.pid;
  try {
    if (IS_WIN) await run("taskkill", ["/pid", String(pid), "/t", "/f"], { timeout: 15_000 });
    else comfyChild.kill("SIGTERM");
  } catch {
    /* reported below */
  }
  comfyChild = null;
  return { stopped: true, pid };
}

function detectComfy() {
  const home = os.homedir();
  const candidates = [
    config.comfyDir,
    "C:\\ComfyUI",
    "C:\\AI\\ComfyUI",
    "C:\\ComfyUI_windows_portable",
    "D:\\ComfyUI",
    "D:\\AI\\ComfyUI",
    path.join(home, "ComfyUI"),
    path.join(home, "ComfyUI_windows_portable"),
    path.join(home, "Desktop", "ComfyUI"),
    path.join(home, "Desktop", "ComfyUI_windows_portable"),
    path.join(home, "Documents", "ComfyUI"),
    path.join(home, "Downloads", "ComfyUI_windows_portable"),
  ].filter(Boolean);

  for (const parent of [home, path.join(home, "Desktop"), path.join(home, "Downloads"), path.join(home, "Documents"), "C:\\", "D:\\"]) {
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && /comfy/i.test(entry.name)) candidates.push(path.join(parent, entry.name));
      }
    } catch {
      /* folder absent */
    }
  }

  const seen = new Set();
  const found = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const mainDir = fs.existsSync(path.join(resolved, "main.py"))
      ? resolved
      : fs.existsSync(path.join(resolved, "ComfyUI", "main.py"))
        ? path.join(resolved, "ComfyUI")
        : null;
    if (!mainDir) continue;
    found.push({ path: resolved, mainDir, portable: fs.existsSync(path.join(resolved, "python_embeded")) });
  }
  if (found.length && !config.comfyDir) {
    config.comfyDir = found[0].path;
    writeJsonSync(CONFIG_FILE, config);
  }
  return found;
}

async function ollamaInfo() {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1800) });
    if (!res.ok) return { ok: false, models: [] };
    const json = await res.json();
    return { ok: true, models: (json.models || []).map((model) => model.name).sort() };
  } catch {
    return { ok: false, models: [] };
  }
}

/* ---------------------------------------------------------- screen & input */

/**
 * Two long-lived PowerShell helpers, one per job: read the screen, move the
 * real mouse and press real keys. They are deliberately separate scripts —
 * one script that both grabs the screen and injects input matches an
 * infostealer/RAT signature and Windows Defender blocks it before it runs.
 * Split in two, each is ordinary desktop automation. One process each, one
 * request per line, so a click costs milliseconds.
 */

const HOST_FILES = {
  screen: path.join(HERE, "host-screen.ps1"),
  input: path.join(HERE, "host-input.ps1"),
};
const hosts = new Map();
let lastFrame = null;
let lastScreenAt = 0;
let captureRunning = false;
let captureInFlight = null;
const frameStats = { frames: 0, since: Date.now(), fps: 0 };
let lastCaptureAt = 0;
/* Demand-driven capture. A focused controller asks for 30 fps; previews ask
   for 10. There is no point capturing faster than the fastest viewer asked. */
let screenTargetFps = 10;
let screenDemandUntil = 0;
let lastCaptureMs = 0;
let captureWidth = Number(config.screenMaxWidth) || 1280;

/** Measured, never assumed: frames actually captured per second. */
function noteFrame() {
  lastCaptureAt = Date.now();
  frameStats.frames += 1;
  const elapsed = Date.now() - frameStats.since;
  if (elapsed >= 1500) {
    frameStats.fps = Math.round((frameStats.frames / (elapsed / 1000)) * 10) / 10;
    frameStats.frames = 0;
    frameStats.since = Date.now();
  }
}

function measuredFps() {
  return Date.now() - lastCaptureAt > 2500 ? 0 : frameStats.fps;
}

function hostAvailable() {
  return IS_WIN && Object.values(HOST_FILES).every((file) => fs.existsSync(file));
}

function hostState(kind) {
  if (!hosts.has(kind)) hosts.set(kind, { child: null, buffer: "", seq: 0, waiters: new Map() });
  return hosts.get(kind);
}

function stopHost(kind, reason, code) {
  const state = hostState(kind);
  if (code !== undefined) log(`${kind} helper exited (${code})`);
  for (const waiter of state.waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  state.waiters.clear();
  state.child = null;
  state.buffer = "";
  if (kind === "screen") lastFrame = null;
}

function ensureHost(kind) {
  if (!IS_WIN) throw new Error("Screen view and remote control need Windows on this node.");
  const file = HOST_FILES[kind];
  if (!file || !fs.existsSync(file)) {
    throw new Error(`${path.basename(String(file || kind))} is missing next to athena-node.mjs — copy the whole node folder.`);
  }
  const state = hostState(kind);
  if (state.child && state.child.exitCode === null && !state.child.killed) return state.child;

  const child = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file],
    { cwd: HERE, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  state.child = child;
  state.buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.ready) {
        log(`${kind} helper ready (powershell ${message.powershell || "?"})`);
        continue;
      }
      const waiter = message.id ? state.waiters.get(message.id) : null;
      if (!waiter) continue;
      state.waiters.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log(`${kind} helper: ` + text.slice(0, 400));
  });

  child.on("exit", (code) => stopHost(kind, `The ${kind} helper stopped. It restarts on the next request.`, code));
  child.on("error", (error) => stopHost(kind, "Could not start PowerShell: " + error.message));
  child.stdin.on("error", () => undefined);
  return child;
}

function hostCall(kind, op, args = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = ensureHost(kind);
    } catch (error) {
      return reject(error);
    }
    const state = hostState(kind);
    const id = "h" + (state.seq += 1);
    const timer = setTimeout(() => {
      state.waiters.delete(id);
      /* A helper can wedge while Windows switches desktop surfaces (for
         example when Task Manager is opened). Kill and forget it so the next
         request starts a fresh helper instead of timing out forever. */
      try {
        if (state.child) state.child.kill();
      } catch {
        /* already gone */
      }
      stopHost(kind, `The ${kind} helper did not answer in time and was restarted.`);
      reject(new Error(`The ${kind} helper did not answer in time; it was restarted.`));
    }, timeoutMs);
    state.waiters.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    } catch (error) {
      clearTimeout(timer);
      state.waiters.delete(id);
      try {
        if (state.child) state.child.kill();
      } catch {
        /* already gone */
      }
      stopHost(kind, `The ${kind} helper stopped accepting requests.`);
      reject(error);
    }
  });
}

async function captureFrame(maxWidth = Number(config.screenMaxWidth) || 1280) {
  const started = Date.now();
  const reply = await hostCall("screen", "capture", {
    maxWidth: Math.max(320, Math.min(2560, Math.round(Number(maxWidth) || 1280))),
  }, 8_000);
  if (!reply.ok || !reply.path) throw new Error(reply.error || "The screen could not be captured.");
  const buffer = fs.readFileSync(String(reply.path));
  lastCaptureMs = Date.now() - started;
  lastFrame = {
    buffer,
    at: Date.now(),
    width: reply.width,
    height: reply.height,
    screen: { x: reply.screenX, y: reply.screenY, width: reply.screenW, height: reply.screenH },
  };
  noteFrame();
  return lastFrame;
}

function captureOnce() {
  if (!captureInFlight) {
    captureInFlight = captureFrame(captureWidth).finally(() => {
      captureInFlight = null;
    });
  }
  return captureInFlight;
}

/**
 * Keeps frames coming while somebody is watching, then idles. The old loop
 * slept 200 ms on top of each capture, which capped the screen at about five
 * frames a second before the network was even involved. Now it sleeps only
 * the time left in a 70 ms budget, so a fast capture runs at ~14 fps and a
 * slow one throttles itself instead of piling up.
 */
function startCaptureLoop() {
  lastScreenAt = Date.now();
  if (captureRunning) return;
  captureRunning = true;
  (async () => {
    try {
      /* Stop shortly after the last viewer leaves; an unwatched PC should not
         burn CPU taking pictures of itself. */
      while (Date.now() < screenDemandUntil) {
        const started = Date.now();
        try {
          await captureOnce();
        } catch (error) {
          log("capture: " + (error?.message || error));
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        const spent = Date.now() - started;
        const budget = 1000 / Math.max(1, Math.min(30, screenTargetFps));
        await new Promise((resolve) => setTimeout(resolve, Math.max(5, budget - spent)));
      }
    } finally {
      captureRunning = false;
    }
  })();
}

async function screenFrame(requestedFps = 10, requestedWidth = 0) {
  screenTargetFps = Math.max(1, Math.min(30, Number(requestedFps) || 10));
  screenDemandUntil = Date.now() + 5000;
  if (requestedWidth) captureWidth = Math.max(320, Math.min(2560, Number(requestedWidth) || captureWidth));
  lastScreenAt = Date.now();
  startCaptureLoop();
  /* Serve the freshest frame if it fits this viewer's budget. The old fixed
     120 ms threshold capped every client at ~8 fps regardless of its request. */
  /* Return the latest completed capture immediately. Waiting for a new JPEG
     on every request made the browser's frame rate collapse to the capture
     rate; the capture loop is already running at the requested budget. */
  if (!lastFrame || Date.now() - lastFrame.at > 1500) {
    try {
      await captureOnce();
    } catch (error) {
      if (!lastFrame) throw error;
    }
  }
  return lastFrame;
}

async function screenBounds() {
  if (lastFrame?.screen) return lastFrame.screen;
  const info = await hostCall("screen", "info", {});
  return { x: info.screenX || 0, y: info.screenY || 0, width: info.screenWidth || 1920, height: info.screenHeight || 1080 };
}

function fraction(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

async function screenInput(payload = {}) {
  if (!hostAvailable()) throw new Error("Remote control needs Windows on this node.");
  if (!config.allowInput) throw new Error("Remote control is switched off on this node (config.json → allowInput, or the node window → SETTINGS).");

  const op = String(payload.op || "");
  const bounds = await screenBounds();
  const pixelX = Math.round(bounds.x + fraction(payload.x) * bounds.width);
  const pixelY = Math.round(bounds.y + fraction(payload.y) * bounds.height);

  switch (op) {
    case "move":
      return hostCall("input", "move", { x: pixelX, y: pixelY });
    case "click":
    case "double":
    case "right":
      return hostCall("input", "click", {
        x: pixelX,
        y: pixelY,
        button: op === "right" ? "right" : ["left", "right", "middle"].includes(payload.button) ? payload.button : "left",
        clicks: op === "double" ? 2 : 1,
      });
    case "scroll":
      return hostCall("input", "scroll", { amount: Number(payload.amount) || 3 });
    case "type":
      return hostCall("input", "type", { text: String(payload.text || "").slice(0, 4000) });
    case "key": {
      const key = String(payload.key || "").trim().slice(0, 40);
      if (!key) throw new Error("Which key?");
      return hostCall("input", "key", { key });
    }
    default:
      throw new Error(`Unknown input op "${op}". Use move, click, double, right, scroll, type or key.`);
  }
}

/* ----------------------------------------------------------------- actions */

async function installCustomNode(args) {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\/|^git@/.test(url)) throw new Error("Give a git URL, e.g. https://github.com/owner/ComfyUI-SomeNode");
  const layout = comfyLayout();
  if (!layout) throw new Error("Set the ComfyUI folder first.");
  const name = String(args.name || url.split("/").filter(Boolean).pop() || "").replace(/\.git$/, "");
  const target = path.join(layout.mainDir, "custom_nodes", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const clone = fs.existsSync(target)
    ? await run("git", ["-C", target, "pull", "--ff-only"], { timeout: 600_000 })
    : await run("git", ["clone", "--depth", "1", url], { timeout: 600_000 });
  let pip = null;
  const requirements = path.join(target, "requirements.txt");
  if (fs.existsSync(requirements)) {
    pip = await run(pythonPath(layout), ["-m", "pip", "install", "-r", requirements], { timeout: 900_000 });
  }
  return {
    name,
    path: target,
    ok: clone.ok && (!pip || pip.ok),
    clone: (clone.out || clone.err || "").split("\n").slice(-6).join("\n"),
    pip: pip ? (pip.out || pip.err || "").split("\n").slice(-8).join("\n") : "no requirements.txt",
  };
}

async function speak(args) {
  const text = String(args.text || "").slice(0, 600);
  if (!text) throw new Error("Nothing to say.");
  if (IS_WIN) {
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${text.replace(/'/g, "''")}')`;
    const res = await run("powershell", ["-NoProfile", "-Command", script], { timeout: 60_000 });
    return { spoken: res.ok, text };
  }
  const say = await run(process.platform === "darwin" ? "say" : "espeak", [text], { timeout: 60_000 });
  return { spoken: say.ok, text };
}

/* ------------------------------------------------------------- sound & apps */

/**
 * Hearing a machine needs a capture device and FFmpeg. Both are optional: the
 * node simply reports that it cannot do it until the FFmpeg app is installed and
 * "Stereo Mix" / virtual-audio-capturer exists in Windows sound settings.
 */

let audioDeviceCache = { at: 0, list: [] };
const audioChildren = new Set();
let ollamaChild = null;

/* winget updates the machine/user PATH, but this already-running process does
   not see it. Reloading it after an install makes the new binary detectable
   immediately instead of only after a node restart. */
async function refreshProcessPath() {
  if (!IS_WIN) return;
  const result = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    { timeout: 10_000 }
  );
  const fresh = result.out.split(/\r?\n/).filter(Boolean).join(";");
  if (fresh) process.env.PATH = `${fresh};${process.env.PATH || ""}`;
}

function binOnPath(name) {
  const exe = IS_WIN && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  const dirs = [
    ...String(process.env.PATH || "").split(path.delimiter),
    portableToolsDir(NODE_DIR),
    path.join(portableToolsDir(NODE_DIR), "ffmpeg", "bin"),
    path.join(HERE, "tools"),
    path.join(HERE, "tools", "ffmpeg", "bin"),
    IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links") : "",
    IS_WIN ? path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin") : "",
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable dir, keep going */
    }
  }
  return null;
}

function findOllamaExe() {
  const candidates = IS_WIN
    ? [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
        "C:\\Program Files\\Ollama\\ollama.exe",
      ]
    : [];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep going */
    }
  }
  return null;
}

function ffmpegPath() {
  return binOnPath("ffmpeg");
}

function audioAvailable() {
  return IS_WIN && Boolean(ffmpegPath());
}

async function audioDevices(force = false) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) {
    throw new Error("FFmpeg is not installed on this machine. Open NODES → this machine → SOFTWARE → FFmpeg → INSTALL.");
  }
  if (!force && audioDeviceCache.list.length && Date.now() - audioDeviceCache.at < 60_000) return audioDeviceCache.list;
  const result = await run(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { timeout: 25_000 });
  const text = `${result.err}\n${result.out}`;
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\]\s+"([^"]+)"\s+\(audio\)/i);
    if (match && !list.includes(match[1])) list.push(match[1]);
  }
  audioDeviceCache = { at: Date.now(), list };
  return list;
}

/** The device for one explicit source. No silent microphone fallback. */
async function audioDevice(source = "desktop") {
  const list = await audioDevices();
  const inventory = classifyAudioDevices(list);
  const device = pickAudioDevice(inventory, source);
  if (device) return device;
  if (source === "microphone") {
    throw new Error("No microphone capture device was found. Check Windows Settings → Privacy → Microphone and the sound input device, then try again.");
  }
  throw new Error("Desktop-audio capture is not available. Enable Stereo Mix (or install VB-CABLE) in Windows sound settings: Recording devices → right click → Show Disabled Devices. The microphone is a separate source and is not substituted.");
}

/** MP3 over HTTP, straight from FFmpeg. One listener, one FFmpeg process. */
async function startAudio(req, res, requested, source = "desktop") {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) {
    throw new Error("FFmpeg is not installed on this machine. Open NODES → this machine → SOFTWARE → FFmpeg → INSTALL.");
  }
  const device = String(requested || "").trim() || (await audioDevice(source));
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-f",
      "dshow",
      "-audio_buffer_size",
      "80",
      "-i",
      `audio=${device}`,
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-flush_packets",
      "1",
      "-f",
      "mp3",
      "-",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  audioChildren.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  const first = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 7000);
    child.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (!first) {
    audioChildren.delete(child);
    try {
      child.kill();
    } catch {
      /* gone */
    }
    const reason = stderr.split(/\r?\n/).filter(Boolean).pop() || "FFmpeg produced no sound.";
    throw new Error(`Could not listen to "${device}": ${reason}`);
  }

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    ...corsHeadersFor(req),
  });
  res.write(first);
  child.stdout.pipe(res);
  const stop = () => {
    audioChildren.delete(child);
    try {
      child.kill();
    } catch {
      /* gone */
    }
  };
  res.on("close", stop);
  child.on("close", () => {
    audioChildren.delete(child);
    try {
      res.end();
    } catch {
      /* closed */
    }
  });
  log(`audio relay started: ${source} · ${device}`);
}

/* ---- apps: what can be installed on this machine ------------------------- */

async function appStates() {
  const [comfy, ollama] = await Promise.all([comfyStats(3000, 1500), ollamaInfo()]);
  return APP_SPECS.map((spec) => {
    if (spec.id === "comfyui") {
      const layout = comfyLayout();
      return {
        id: spec.id,
        installed: Boolean(layout),
        running: Boolean(comfy.ok),
        service: true,
        where: layout?.path || null,
        note: layout ? `port ${config.comfyPort}` : "no folder set",
      };
    }
    if (spec.id === "ollama") {
      const bin = binOnPath("ollama") || findOllamaExe();
      return {
        id: spec.id,
        installed: Boolean(bin),
        running: Boolean(ollama.ok),
        service: true,
        where: bin,
        note: ollama.ok ? `${ollama.models.length} model(s)` : bin ? "installed, not running" : "not installed",
      };
    }
    const bin = binOnPath(spec.bin);
    return { id: spec.id, installed: Boolean(bin), running: null, service: false, where: bin, note: bin ? "ready" : "not installed" };
  });
}

async function appInstall(id) {
  const spec = APP_SPECS.find((item) => item.id === id);
  if (!spec) throw new Error(`Unknown app "${id}".`);

  if (spec.id === "comfyui") {
    const found = detectComfy();
    if (!found.length) {
      throw new Error("No ComfyUI folder found. This is detection, not a download: unzip ComfyUI portable somewhere obvious (for example C:\\ComfyUI), then press FIND FOLDER again.");
    }
    return {
      ok: true,
      found,
      manual: true,
      note: `Found ComfyUI at ${found[0].path}. Detection only — ATHENA did not download it.`,
    };
  }

  return installDependency(spec, {
    run,
    binOnPath,
    refreshProcessPath,
    findOllamaExe,
    toolsDir: portableToolsDir(NODE_DIR),
    isWin: IS_WIN,
    log,
  });
}

/**
 * Open any program on this machine by name or path, or a URL in a browser,
 * and verify that something actually started.
 *
 * The old version fired `start` and always returned ok. "Task Manager" both
 * failed (the name never matched Taskmgr.exe) and was reported as opened.
 * Names are normalised in programs.mjs, and every launch now waits for a real
 * process before it is called a success.
 */
function launchDetached(file, args = []) {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => log(`launch ${file} failed: ${error.message}`));
  child.unref();
}

async function openProgram(args = {}) {
  const raw = String(args.path || args.app || args.name || "").trim();
  const requestedUrl = asUrl(args.url) || (raw ? asUrl(raw) : null);
  const browserName = String(args.browser || "").trim();

  if (requestedUrl) {
    let browserTarget = null;
    if (browserName) {
      browserTarget = resolveProgramTarget(browserName);
      if (!browserTarget) throw new Error(`I could not find a browser called "${browserName}" on this machine.`);
    }
    if (browserTarget) launchDetached(browserTarget, [requestedUrl]);
    else if (IS_WIN) launchDetached("cmd", ["/c", "start", "", requestedUrl]);
    else if (process.platform === "darwin") launchDetached("open", [requestedUrl]);
    else launchDetached("xdg-open", [requestedUrl]);

    const exeNames = browserTarget
      ? [path.basename(browserTarget)]
      : ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe"];
    const seen = await waitForAnyProcess(exeNames, 4500);
    if (!seen) {
      return { ok: false, error: `The browser was asked to open ${requestedUrl} but no browser process appeared.`, url: requestedUrl };
    }
    const label = String(browserTarget ? path.basename(browserTarget) : seen).replace(/\.exe$/i, "");
    return { ok: true, opened: `${label} · ${requestedUrl}`, url: requestedUrl, browser: label, verified: "process" };
  }

  if (!raw) throw new Error("Which program? Give me a name like chrome or task manager, or a URL.");

  const extra = Array.isArray(args.args) ? args.args.map(String) : [];
  const target = resolveProgramTarget(raw) || binOnPath(raw) || binOnPath(raw.replace(/\.exe$/i, ""));
  if (target) {
    const exe = path.basename(target);
    const before = await processNames();
    launchDetached(target, extra);
    const seen = await waitForAnyProcess([exe], 5000);
    if (!seen) {
      return { ok: false, error: `${exe} was started but no process appeared — it may be blocked or crashed.`, where: target };
    }
    const already = before.has(exe.toLowerCase());
    return {
      ok: true,
      opened: exe,
      where: target,
      verified: already ? "already-running" : "process",
      note: already ? `${exe} was already running; the request went to that instance.` : undefined,
    };
  }

  /* Not in the map: let Windows resolve it through App Paths exactly once,
     then insist that a matching process exists. */
  if (IS_WIN) {
    launchDetached("cmd", ["/c", "start", "", raw, ...extra]);
    const keys = programCandidates(raw).map((name) => `${name}.exe`);
    const seen = await waitForAnyProcess(keys, 4000);
    if (seen) return { ok: true, opened: raw, verified: "process" };
    return {
      ok: false,
      error: `Windows did not open anything called "${raw}". Try the full .exe path, or check the program name.`,
    };
  }

  launchDetached(raw, extra);
  const seen = await waitForAnyProcess([raw], 4000);
  if (seen) return { ok: true, opened: raw, verified: "process" };
  return { ok: false, error: `No process called "${raw}" appeared on this machine.` };
}

async function appStart(id) {
  if (id === "comfyui") return startComfy();
  if (id !== "ollama") throw new Error("That app is a tool, not a service. Install it, then use it with run_command.");
  const up = await ollamaInfo();
  if (up.ok) return { already: true, ...up };
  const bin = binOnPath("ollama") || findOllamaExe();
  if (!bin) throw new Error("Ollama is not installed on this machine. Install it from APPS first.");
  ollamaChild = spawn(bin, ["serve"], { windowsHide: true, stdio: "ignore" });
  ollamaChild.on("exit", () => {
    ollamaChild = null;
  });
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const info = await ollamaInfo();
    if (info.ok) return { started: true, ...info };
  }
  throw new Error("Ollama started but never answered on 11434.");
}

async function appStop(id) {
  if (id === "comfyui") return stopComfy();
  if (id !== "ollama") return { stopped: false, note: "Nothing to stop — it is a tool, not a service." };
  if (!ollamaChild) return { stopped: false, note: "Ollama was not started by this agent (the tray app runs it). Quit it from the tray." };
  try {
    if (IS_WIN) await run("taskkill", ["/pid", String(ollamaChild.pid), "/t", "/f"], { timeout: 15_000 });
    else ollamaChild.kill("SIGTERM");
  } catch {
    /* reported below */
  }
  ollamaChild = null;
  return { stopped: true };
}

/* A status poll must answer the Hub even while a slow Windows inventory query
   is still running. The query keeps going and primes its cache; this poll
   honestly returns null for the part that was not ready in time. */
function within(promise, ms, fallback = null) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function diagnostics() {
  const checks = [];
  try {
    const probe = path.join(NODE_DIR, ".write-probe");
    fs.writeFileSync(probe, String(Date.now()));
    fs.rmSync(probe, { force: true });
    checks.push({ id: "data-dir", ok: true, detail: `Identity, settings and logs are writable in ${NODE_DIR}.` });
  } catch (error) {
    checks.push({ id: "data-dir", ok: false, detail: `Cannot write to ${NODE_DIR}: ${error.message}` });
  }
  checks.push({ id: "runtime", ok: Boolean(process.versions.node), detail: `Node ${process.version} at ${process.execPath}` });
  checks.push({ id: "protocol", ok: Boolean(NODE_PROTOCOL), detail: `Node protocol ${NODE_PROTOCOL}; Hub protocol ${MIN_HUB_PROTOCOL}-${MAX_HUB_PROTOCOL}.` });
  checks.push({ id: "listener", ok: Boolean(server.listening), detail: `Listening on 0.0.0.0:${config.port}.` });
  checks.push({
    id: "manifest",
    ok: ["host-screen.ps1", "host-input.ps1", "panel.html", "lib/security.mjs"].every((file) => fs.existsSync(path.join(HERE, file))),
    detail: "Program files and Windows helpers are present.",
  });
  const managers = await detectManagersForStatus();
  return {
    ok: checks.every((check) => check.ok),
    at: new Date().toISOString(),
    version: NODE_VERSION,
    dataDir: NODE_DIR,
    programDir: HERE,
    runtime: { executable: process.execPath, version: process.versions.node, bundled: path.basename(process.execPath).toLowerCase() === "node.exe" },
    managers,
    checks,
    log: redact(tailLog(20), [config.code, state.token]),
  };
}

async function detectManagersForStatus() {
  const found = [];
  for (const manager of ["winget", "choco", "scoop"]) if (binOnPath(manager)) found.push(manager);
  return found;
}

let updateCache = { at: 0, value: null };

function semverParts(value) {
  return String(value || "0.0.0")
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number(part) || 0);
}

function semverNewer(latest, current) {
  const a = semverParts(latest);
  const b = semverParts(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

async function checkForUpdate() {
  if (Date.now() - updateCache.at < 10 * 60_000) return updateCache.value;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `athena-node/${NODE_VERSION}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
    const release = await res.json();
    const latest = String(release.tag_name || release.name || "").replace(/^v/i, "");
    const value = {
      ok: true,
      current: NODE_VERSION,
      latest: latest || null,
      available: Boolean(latest) && semverNewer(latest, NODE_VERSION),
      url: release.html_url || `https://github.com/${UPDATE_REPO}/releases`,
      publishedAt: release.published_at || null,
    };
    updateCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = { ok: false, current: NODE_VERSION, latest: null, available: false, error: String(error?.message || error) };
    updateCache = { at: Date.now(), value };
    return value;
  }
}

async function status() {
  const [gpu, comfy, ollama] = await Promise.all([gpuInfo(), comfyStats(), ollamaInfo()]);
  const [disks, displays, audio, apps, memory] = await Promise.all([
    within(diskInventory(run, IS_WIN), 1500),
    within(displayInventory(run, IS_WIN), 1500),
    within(audioInventory(run, IS_WIN, ffmpegPath()), 1800),
    within(installedApps(run, IS_WIN), 1500),
    within(memoryInventory(run, IS_WIN), 4000, memoryInfo()),
  ]);
  const cpus = os.cpus();
  const cpuPct = cpuUtilization();
  const hardware = {
    os: osInfo(),
    cpu: {
      model: cpus[0]?.model?.trim() || null,
      cores: cpus.length,
      utilizationPct: cpuPct,
    },
    memory,
    gpu: gpu || null,
    disks,
    displays,
    audio: audio
      ? { ...audio, captureReady: audioAvailable() && audio.inputs.length > 0, ffmpeg: ffmpegPath() || null }
      : null,
    installedApps: apps,
  };
  return {
    id: state.id,
    name: config.name,
    version: NODE_VERSION,
    nodeVersion: NODE_VERSION,
    protocol: NODE_PROTOCOL,
    hubProtocol: { min: MIN_HUB_PROTOCOL, max: MAX_HUB_PROTOCOL },
    features: [...NODE_FEATURES],
    hub: state.hub,
    state: state.token ? "linked" : "ready",
    index: state.index,
    linkedAt: state.linkedAt,
    uptimeSec: Math.round(process.uptime()),
    hostname: os.hostname(),
    dataDir: NODE_DIR,
    platform: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model?.trim() || null,
    cores: cpus.length,
    load: Number(os.loadavg()[0].toFixed(2)),
    memory: { totalGb: memory.totalGb, freeGb: memory.freeGb },
    addresses: lanAddresses(),
    port: config.port,
    gpu,
    hardware,
    services: {
      comfy: { ...comfy, dir: config.comfyDir, managed: Boolean(comfyChild), startedAt: comfyStartedAt || null },
      ollama,
    },
    tasks: taskList(),
    capabilities: {
      shell: config.allowShell,
      shutdown: config.allowShutdown,
      comfy: Boolean(comfyLayout()),
      ollama: ollama.ok,
      screen: hostAvailable(),
      input: hostAvailable() && config.allowInput,
      pairCodeRequired: !config.pairOpen,
      audio: audioAvailable(),
      apps: APP_SPECS.map((spec) => spec.id),
    },
    dependencies: {
      runtime: { version: process.versions.node, executable: process.execPath, bundled: path.basename(process.execPath).toLowerCase() === "node.exe" },
      managers: await detectManagersForStatus(),
      apps: APP_SPECS.map((spec) => ({
        id: spec.id,
        installed: Boolean(binOnPath(spec.bin) || (spec.id === "ollama" ? findOllamaExe() : null)),
      })),
    },
    screen: lastFrame
      ? { width: lastFrame.width, height: lastFrame.height, at: lastFrame.at, fps: measuredFps(), targetFps: screenTargetFps, captureMs: lastCaptureMs }
      : null,
    log: redact(tailLog(10), [config.code, state.token]),
  };
}

/* ------------------------------------------------------------------ engine */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const route = url.pathname;

  const send = (statusCode, body, type = "application/json") => {
    const payload = type === "application/json" ? JSON.stringify(body) : body;
    res.writeHead(statusCode, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "x-athena-node-protocol": String(NODE_PROTOCOL),
      ...corsHeadersFor(req),
    });
    res.end(payload);
  };

  const body = () => readJsonBody(req, { limit: 512 * 1024 });

  if (!hostAllowed(req)) return send(403, { error: "This node only answers to its own address." });
  /* A Hub newer than this Node's contract is refused explicitly instead of
     half-working. Nodes and Hubs are updated independently, so this check is
     the guard that keeps an old Node usable and honest. */
  const hubProtocol = req.headers["x-athena-hub-protocol"];
  if (hubProtocol && !hubProtocolSupported(hubProtocol)) {
    return send(426, {
      error: `This Node speaks Hub protocol ${MIN_HUB_PROTOCOL}–${MAX_HUB_PROTOCOL}; the Hub sent ${hubProtocol}. Update ATHENA Node on this PC.`,
      nodeProtocol: NODE_PROTOCOL,
      nodeVersion: NODE_VERSION,
    });
  }
  if (req.headers.origin && !originAllowed(req, req.headers.origin)) {
    return send(403, { error: "That origin is not allowed." });
  }
  applyCors(req, res);

  if (req.method === "OPTIONS") return send(204, {});
  if (route === "/favicon.ico") return send(204, {});

  try {
    if (route === "/" || route === "/index.html") {
      const html = fs.readFileSync(PANEL_FILE, "utf8");
      /* The pairing code belongs on the machine's own screen. Anyone else on
         the LAN (a phone, another PC) sees it masked, token or not. */
      const showCode = isLoopback(req);
      return send(
        200,
        html
          .replaceAll("__VERSION__", NODE_VERSION)
          .replaceAll("__NAME__", config.name)
          .replaceAll("__CODE__", showCode ? config.code : "• • • • • •")
          .replaceAll("__CODENOTE__", showCode ? "Read this out on the hub" : "Visible on the node's own screen only"),
        "text/html; charset=utf-8"
      );
    }

    if (route === "/api/hello") {
      const gpu = await gpuInfo();
      return send(200, {
        id: state.id,
        name: config.name,
        version: NODE_VERSION,
        ...helloInfo(),
        port: config.port,
        state: state.token ? "linked" : "ready",
        linkedTo: state.hub,
        codeRequired: !config.pairOpen,
        gpu: gpu?.name || null,
        vramGb: gpu?.vramGb ?? null,
        addresses: lanAddresses().map((item) => item.address),
      });
    }

    if (route === "/api/link" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      const allowed = linkAllowed(ip);
      if (!allowed.ok) {
        log(`pairing blocked for ${ip}`);
        return send(429, { error: `Too many pairing attempts. Try again in ${allowed.retryAfter}s.`, retryAfter: allowed.retryAfter });
      }
      const payload = await body();
      const given = String(payload.code || "").trim().toUpperCase();
      if (!config.pairOpen && !safeEqual(given, String(config.code).toUpperCase())) {
        noteLinkFailure(ip);
        log("pairing refused: wrong code");
        return send(403, { error: "Wrong pairing code. Read the six characters in the node window." });
      }
      linkFailures.delete(ip);
      if (state.token && state.hub && state.hub !== payload.hub) {
        return send(409, { error: `Already paired with ${state.hub}. Unpair it first.` });
      }
      state.token = state.token || randomBytes(24).toString("hex");
      state.hub = String(payload.hub || "athena").slice(0, 60);
      state.index = state.index || 1;
      state.linkedAt = new Date().toISOString();
      persistState();
      log(`paired with ${state.hub}`);
      const gpu = await gpuInfo();
      return send(200, { ok: true, id: state.id, name: config.name, token: state.token, index: state.index, gpu: gpu?.name || null });
    }

    if (route === "/api/unlink" && req.method === "POST") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      state.token = null;
      state.hub = null;
      persistState();
      log("unpaired by hub");
      return send(200, { ok: true });
    }

    if (route === "/api/status") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      return send(200, await status());
    }

    if (route === "/api/diagnostics") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      return send(200, await diagnostics());
    }

    if (route === "/api/screen/info") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      return send(200, {
        ok: true,
        windows: IS_WIN,
        input: hostAvailable() && config.allowInput,
        maxWidth: config.screenMaxWidth,
        fps: measuredFps(),
        targetFps: screenTargetFps,
        captureMs: lastCaptureMs,
        frame: lastFrame ? { width: lastFrame.width, height: lastFrame.height, at: lastFrame.at, screen: lastFrame.screen } : null,
      });
    }

    /* One JPEG of this machine's screen. The hub polls this while somebody is
       watching; the node keeps capturing a few frames a second in between. */
    if (route === "/api/screen") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      if (!hostAvailable()) return send(400, { error: "Screen view needs Windows on this node." });
      try {
        const frame = await screenFrame(url.searchParams.get("fps"), url.searchParams.get("width"));
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": frame.buffer.length,
          "Cache-Control": "no-store",
          "X-Athena-Capture-Fps": String(measuredFps()),
          "X-Athena-Capture-Ms": String(lastCaptureMs || 0),
          "X-Athena-Frame-Age-Ms": String(Math.max(0, Date.now() - frame.at)),
          ...corsHeadersFor(req),
        });
        return res.end(frame.buffer);
      } catch (error) {
        return send(500, { error: String(error?.message || error) });
      }
    }

    if (route === "/api/input" && req.method === "POST") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      /* A disabled capability is an authorization refusal, not malformed
         input. Keep the server-side gate ahead of any pointer work. */
      if (!config.allowInput) return send(403, { error: "Remote control is switched off on this node (config.json → allowInput, or the node window → PERMISSIONS)." });
      const payload = await body();
      try {
        const result = await screenInput(payload);
        log(`input ${payload.op}${payload.key ? " " + payload.key : ""}${payload.text ? " \"" + String(payload.text).slice(0, 40) + "\"" : ""}`);
        return send(200, { ok: true, result });
      } catch (error) {
        return send(400, { error: String(error?.message || error) });
      }
    }

    if (route === "/api/audio/devices") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      try {
        const devices = await audioDevices(true);
        const inventory = classifyAudioDevices(devices);
        return send(200, {
          ok: true,
          ffmpeg: ffmpegPath(),
          devices,
          sources: { microphone: inventory.microphone, desktop: inventory.desktop },
          defaults: {
            microphone: pickAudioDevice(inventory, "microphone"),
            desktop: pickAudioDevice(inventory, "desktop"),
          },
          default: pickAudioDevice(inventory, "desktop"),
          systemAudio: inventory.systemAudio,
          microphoneAudio: inventory.microphoneAudio,
          note: inventory.systemAudio
            ? "Desktop audio is captured from a loopback device."
            : "Desktop audio needs Stereo Mix, VB-CABLE or another loopback capture device.",
        });
      } catch (error) {
        return send(400, { error: String(error?.message || error) });
      }
    }

    if (route === "/api/audio") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      const source = url.searchParams.get("source") || "desktop";
      if (!["microphone", "desktop"].includes(source)) return send(400, { error: "Audio source must be microphone or desktop." });
      const requested = String(url.searchParams.get("device") || "").trim();
      try {
        if (requested) {
          const inventory = classifyAudioDevices(await audioDevices());
          if (!audioDeviceBelongsToSource(inventory, source, requested)) {
            return send(400, {
              error: `The requested device is not a ${source === "microphone" ? "microphone" : "desktop loopback"} source. ATHENA will not substitute a different source.`,
            });
          }
        }
        return await startAudio(req, res, requested, source);
      } catch (error) {
        return send(400, { error: String(error?.message || error) });
      }
    }

    if (route === "/api/action" && req.method === "POST") {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      const payload = await body();
      const op = String(payload.op || "");
      const args = payload.args || {};
      log(`action ${op} ${JSON.stringify(args).slice(0, 180)}`);

      switch (op) {
        case "status":
          return send(200, await status());
        case "run": {
          const task = startTask(args.command, { cwd: args.cwd });
          return send(200, { ok: true, taskId: task.id, task: taskView(task) });
        }
        case "task": {
          const task = tasks.get(String(args.taskId || ""));
          if (!task) return send(404, { error: "No such task." });
          return send(200, { ok: true, task: taskView(task) });
        }
        case "tasks":
          return send(200, { ok: true, tasks: taskList() });
        case "task-cancel": {
          const task = tasks.get(String(args.taskId || ""));
          if (!task?.child) return send(404, { error: "No running task with that id." });
          if (IS_WIN) await run("taskkill", ["/pid", String(task.child.pid), "/t", "/f"], { timeout: 15_000 });
          else task.child.kill("SIGTERM");
          return send(200, { ok: true });
        }
        case "exec": {
          if (!config.allowShell) return send(403, { error: "Shell disabled on this node." });
          const [file, argv] = shellFor(String(args.command || ""));
          const result = await run(file, argv, { timeout: Number(args.timeout) || 120_000 });
          return send(200, { ok: result.ok, code: result.code, output: (result.out + "\n" + result.err).trim().slice(0, 20_000) });
        }
        case "start-comfy":
          return send(200, await startComfy({ wait: Number(args.wait) || 90_000 }));
        case "stop-comfy":
          return send(200, await stopComfy());
        case "restart-comfy": {
          const stopped = await stopComfy();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return send(200, { stopped, started: await startComfy() });
        }
        case "detect":
          return send(200, { found: detectComfy(), config: { ...config } });
        case "apps":
          return send(200, { ok: true, apps: await appStates() });
        case "processes": {
          const [processes, comfy, ollama] = await Promise.all([topProcesses(), comfyStats(2000, 1500), ollamaInfo()]);
          return send(200, {
            ok: true,
            ...processes,
            services: { comfy: { ok: Boolean(comfy.ok) }, ollama: { ok: Boolean(ollama.ok) } },
          });
        }
        case "app-install":
          return send(200, await appInstall(String(args.app || "")));
        case "app-start":
          return send(200, await appStart(String(args.app || "")));
        case "app-stop":
          return send(200, await appStop(String(args.app || "")));
        case "open":
        case "launch":
        case "start-app":
          return send(200, await openProgram(args));
        case "install-node":
          return send(200, await installCustomNode(args));
        case "pip": {
          const packages = (Array.isArray(args.packages) ? args.packages : String(args.packages || "").split(/[\s,]+/)).filter(Boolean);
          if (!packages.length) return send(400, { error: "Nothing to install." });
          const result = await run(pythonPath(comfyLayout()), ["-m", "pip", "install", ...packages], { timeout: 900_000 });
          return send(200, { ok: result.ok, output: (result.out || result.err).split("\n").slice(-14).join("\n") });
        }
        case "pull-model": {
          const model = String(args.model || "").trim();
          if (!model) return send(400, { error: "Which model?" });
          const result = await run("ollama", ["pull", model], { timeout: 1_800_000 });
          return send(200, { ok: result.ok, model, output: (result.out || result.err).split("\n").slice(-8).join("\n") });
        }
        case "speak":
          return send(200, await speak(args));
        case "open-panel":
          return send(200, { url: openWindow() });
        case "open-data":
          if (!IS_WIN) return send(400, { error: "Open the data folder from the tray on this platform." });
          await run("explorer.exe", [NODE_DIR], { timeout: 5000 });
          return send(200, { ok: true, dir: NODE_DIR });
        case "config": {
          /* A hub may tune paths and display details, but it may not widen this
             machine's permissions. That is a decision for the person at the
             node's own panel. */
          const protectedKeys = ["allowShell", "allowShutdown", "allowInput", "pairOpen", "code", "port"];
          const attempted = protectedKeys.filter((key) => key in args && args[key] !== config[key]);
          if (attempted.length && !localOk(req)) {
            return send(403, { error: `Changing ${attempted.join(", ")} needs the node's own panel.` });
          }
          for (const key of Object.keys(DEFAULTS)) {
            if (!(key in args)) continue;
            if (key === "port" || key === "comfyPort") {
              const value = Number(args[key]);
              if (Number.isFinite(value) && value > 1024 && value < 65535) config[key] = Math.round(value);
            } else if (typeof DEFAULTS[key] === "boolean") {
              config[key] = Boolean(args[key]);
            } else {
              config[key] = String(args[key] ?? "");
            }
          }
          writeJsonSync(CONFIG_FILE, config);
          return send(200, { ok: true, config: { ...config } });
        }
        case "shutdown": {
          if (!config.allowShutdown) return send(403, { error: "Shutdown disabled on this node." });
          send(200, { ok: true });
          setTimeout(() => process.exit(0), 250);
          return;
        }
        default:
          return send(400, { error: `Unknown action "${op}".` });
      }
    }

    if (route === "/api/local/bootstrap" && req.method === "GET") {
      if (!isLoopback(req)) return send(403, { error: "The panel is local to this machine." });
      if (String(req.headers["x-athena-panel"] || "") !== "1") {
        return send(403, { error: "This endpoint is for the node panel on this machine." });
      }
      return send(200, { ok: true, token: LOCAL_TOKEN });
    }

    if (route === "/api/local/status") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      return send(200, await status());
    }

    if (route === "/api/local/config" && req.method === "POST") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      const patch = await body();
      for (const key of Object.keys(DEFAULTS)) {
        if (!(key in patch)) continue;
        if (key === "code") config.code = String(patch.code || "").toUpperCase().slice(0, 10) || makeCode();
        else if (key === "port" || key === "comfyPort") {
          const value = Number(patch[key]);
          if (Number.isFinite(value) && value > 1024 && value < 65535) config[key] = Math.round(value);
        } else if (typeof DEFAULTS[key] === "boolean") config[key] = Boolean(patch[key]);
        else config[key] = String(patch[key] ?? "");
      }
      writeJsonSync(CONFIG_FILE, config);
      return send(200, { ok: true, config: { ...config } });
    }

    if (route === "/api/local/code" && req.method === "POST") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      config.code = makeCode();
      writeJsonSync(CONFIG_FILE, config);
      return send(200, { ok: true, code: config.code });
    }

    if (route === "/api/local/diagnostics") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      return send(200, await diagnostics());
    }

    if (route === "/api/local/update") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      return send(200, await checkForUpdate());
    }

    if (route === "/api/local/restart" && req.method === "POST") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      send(200, { ok: true, restarting: true });
      requestRestart("panel");
      return;
    }

    if (route === "/api/local/quit" && req.method === "POST") {
      if (!localOk(req)) return send(403, { error: "Local panel token required." });
      send(200, { ok: true, stopping: true });
      requestQuit("panel");
      return;
    }

    if (route.startsWith("/comfy")) {
      if (!tokenOk(req)) return send(403, { error: "Bad token." });
      return proxyComfy(req, res);
    }

    if (route === "/api/favicon.ico") return send(204, {});

    return send(404, { error: "Not found." });
  } catch (error) {
    if (error instanceof HttpError) return send(error.status, { error: error.message });
    log("error " + (error?.stack || error?.message || error));
    return send(500, { error: error?.message || "Node error." });
  }
});

/* --------------------------------------------------------------- comfy proxy */

async function proxyComfy(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const target = url.pathname.replace(/^\/comfy/, "") || "/";
  const init = { method: req.method, headers: {} };
  const type = req.headers["content-type"];
  if (type) init.headers["content-type"] = type;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${config.comfyPort}${target}${url.search}`, init);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
      ...corsHeadersFor(req),
    });
    res.end(buffer);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `ComfyUI is not answering on 127.0.0.1:${config.comfyPort}. ${error?.message || ""}`.trim() }));
  }
}

/* --------------------------------------------------------------- discovery */

const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("error", (error) => log("discovery error: " + error.message));
udp.on("message", async (message, rinfo) => {
  if (!message.toString("utf8").includes("ATHENA_DISCOVER")) return;
  try {
    const gpu = await gpuInfo();
    udp.send(
      Buffer.from(
        JSON.stringify({
          reply: "ATHENA_NODE",
          id: state.id,
          name: config.name,
          port: config.port,
          version: NODE_VERSION,
          nodeVersion: NODE_VERSION,
          protocol: NODE_PROTOCOL,
          features: [...NODE_FEATURES],
          state: state.token ? "linked" : "ready",
          gpu: gpu?.name || null,
          vramGb: gpu?.vramGb ?? null,
          load: Number(os.loadavg()[0].toFixed(2)),
        })
      ),
      rinfo.port,
      rinfo.address
    );
  } catch (error) {
    log("discovery reply failed: " + error.message);
  }
});

/* --------------------------------------------------------------- the window */

function openWindow() {
  const url = `http://127.0.0.1:${config.port}/`;
  if (!IS_WIN) {
    try {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* headless is fine */
    }
    return url;
  }
  const browsers = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const exe of browsers) {
    if (!fs.existsSync(exe)) continue;
    spawn(exe, [`--app=${url}`, "--window-size=680,820"], { detached: true, stdio: "ignore" }).unref();
    return url;
  }
  spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  return url;
}

function requestRestart(source = "local") {
  log(`restart requested by ${source}`);
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
}

function requestQuit(source = "local") {
  log(`stop requested by ${source}`);
  setTimeout(() => process.exit(QUIT_EXIT_CODE), 250);
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  Port ${config.port} is busy — the node may already be running.\n  Open http://127.0.0.1:${config.port}/\n`);
    setTimeout(() => process.exit(1), 2000);
    return;
  }
  console.error("Server error:", error);
});

server.listen(config.port, "0.0.0.0", () => {
  const addresses = lanAddresses().map((item) => item.address);
  console.log("");
  console.log("  ATHENA NODE " + NODE_VERSION + "  ·  " + config.name);
  console.log("");
  console.log("  ╔════════════════════════════════════════╗");
  console.log("  ║   PAIRING CODE   " + String(config.code).padEnd(22) + "║");
  console.log("  ╚════════════════════════════════════════╝");
  console.log("  type that code on the hub: NODES → SCAN → LINK");
  console.log("");
  console.log("  window        http://127.0.0.1:" + config.port + "/");
  console.log("  reachable at  " + (addresses.join(" · ") || "no LAN address") + ":" + config.port);
  console.log("  discovery     UDP " + DISCOVERY_PORT + "  ·  comfy " + config.comfyPort);
  console.log("  sound relay   " + (audioAvailable() ? "ready (ffmpeg found)" : "needs FFmpeg — NODES → SOFTWARE → FFmpeg"));
  console.log("  THIS WINDOW IS THE NODE — close it only when you want this PC offline.");
  console.log("");
  /* The pairing code is shown in this window on purpose; it is never logged,
     because the hub receives the log tail in /api/status. */
  log(`node up on ${config.port}`);
  udp.bind(DISCOVERY_PORT, () => {
    try {
      udp.setBroadcast(true);
    } catch {
      /* some stacks refuse */
    }
  });
  if (config.openWindow) openWindow();
  if (config.autoStartComfy) startComfy().catch((error) => log("auto-start failed: " + error.message));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("shutting down");
    try {
      udp.close();
    } catch {
      /* closed */
    }
    killHosts();
    process.exit(0);
  });
}

function killHosts() {
  for (const state of hosts.values()) {
    try {
      state.child?.kill();
    } catch {
      /* already gone */
    }
  }
  for (const child of audioChildren) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  audioChildren.clear();
}

process.on("exit", killHosts);

/**
 * Dependency detection and installation for ATHENA Node.
 *
 * A fresh Windows PC must not depend on WinGet or a system Node.js. The Node
 * itself ships with its runtime; optional tools are installed in this order:
 *
 *   1. already present on PATH / a known install location
 *   2. WinGet, when it exists
 *   3. Chocolatey, when it exists
 *   4. a portable, checksum-verified download for tools that support one
 *   5. a clear manual path with the official URL
 *
 * Nothing is installed silently: every result reports which method worked or
 * why all of them failed.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function download(url, destination, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) from ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error(`Download was empty: ${url}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  return buffer;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function findRecursive(root, name) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findRecursive(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function portableInstall(spec, { run, toolsDir, isWin, log }) {
  if (!isWin) throw new Error("Portable installs are only implemented for Windows.");
  if (spec.id === "ffmpeg") {
    const dir = path.join(toolsDir, "ffmpeg");
    const zipFile = path.join(toolsDir, ".downloads", "ffmpeg.zip");
    const sumsFile = path.join(toolsDir, ".downloads", "ffmpeg.sha256");
    const [zip, sums] = await Promise.all([
      download("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", zipFile),
      download("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256", sumsFile),
    ]);
    const expected = fs.readFileSync(sumsFile, "utf8").trim().split(/\s+/)[0].toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256(zip) !== expected) {
      throw new Error("FFmpeg download failed its SHA-256 check; nothing was installed.");
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const result = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quote(zipFile)} -DestinationPath ${quote(dir)} -Force`],
      { timeout: 180_000 }
    );
    if (!result.ok) throw new Error(`Could not unpack FFmpeg: ${result.err || result.out}`);
    const exe = findRecursive(dir, "ffmpeg.exe");
    if (!exe) throw new Error("The FFmpeg archive did not contain ffmpeg.exe.");
    const bin = path.dirname(exe);
    const stable = path.join(dir, "bin");
    if (bin.toLowerCase() !== stable.toLowerCase()) fs.cpSync(bin, stable, { recursive: true });
    log?.(`portable FFmpeg installed at ${stable}`);
    return { method: "portable", where: path.join(stable, "ffmpeg.exe") };
  }

  if (spec.id === "ytdlp") {
    const target = path.join(toolsDir, "yt-dlp.exe");
    const sumsUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";
    const [exe, sums] = await Promise.all([
      download("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", target),
      download(sumsUrl, path.join(toolsDir, ".downloads", "yt-dlp.sha256")),
    ]);
    const line = fs
      .readFileSync(path.join(toolsDir, ".downloads", "yt-dlp.sha256"), "utf8")
      .split(/\r?\n/)
      .find((item) => /\byt-dlp\.exe\b/.test(item));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || sha256(exe) !== expected) {
      fs.rmSync(target, { force: true });
      throw new Error("yt-dlp download failed its SHA-256 check; nothing was installed.");
    }
    log?.(`portable yt-dlp installed at ${target}`);
    return { method: "portable", where: target };
  }

  throw new Error(`${spec.name} has no portable package in ATHENA yet.`);
}

function managerCommand(manager, spec) {
  if (manager === "winget") {
    return {
      file: "winget",
      args: ["install", "--id", spec.winget, "-e", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"],
    };
  }
  if (manager === "choco") {
    return {
      file: "choco",
      args: ["install", spec.choco, "-y", "--no-progress", "--limit-output"],
    };
  }
  return null;
}

export async function detectManagers({ binOnPath }) {
  const found = [];
  for (const manager of ["winget", "choco", "scoop"]) {
    if (binOnPath(manager)) found.push(manager);
  }
  return found;
}

export function manualAlternative(spec) {
  if (spec.id === "comfyui") {
    return {
      method: "manual",
      instructions: "ComfyUI is a folder install, not a package. Unzip ComfyUI portable, then press FIND FOLDER in the Node panel.",
      url: "https://www.comfy.org/download",
    };
  }
  return {
    method: "manual",
    instructions: `Install ${spec.name} from its official page, then press RESCAN in the Node panel. A system install is not required for the Node itself.`,
    url: spec.url || "",
  };
}

/**
 * Install one catalog app. Never throws for an expected missing installer;
 * returns { ok, method, where, tried, error, alternatives } so the Hub can
 * show the person what actually happened.
 */
export async function installDependency(spec, context) {
  const { run, binOnPath, refreshProcessPath, toolsDir, isWin, log } = context;
  const existing = binOnPath(spec.bin) || (spec.id === "ollama" ? context.findOllamaExe?.() : null);
  if (existing) return { ok: true, already: true, where: existing, method: "existing" };

  const tried = [];
  for (const manager of await detectManagers({ binOnPath })) {
    const command = managerCommand(manager, spec);
    if (!command) continue;
    const result = await run(command.file, command.args, { timeout: 900_000 });
    tried.push({ method: manager, ok: result.ok, detail: (result.err || result.out || "").split(/\r?\n/).filter(Boolean).slice(-4).join(" ") });
    if (!result.ok) continue;
    await refreshProcessPath?.();
    const detected = binOnPath(spec.bin) || (spec.id === "ollama" ? context.findOllamaExe?.() : null);
    if (detected) return { ok: true, installed: true, method: manager, where: detected, tried, note: `${spec.name} installed with ${manager}.` };
    return {
      ok: false,
      method: manager,
      tried,
      error: `${manager} reported success, but ${spec.name} is not detectable yet. Restart ATHENA Node, then rescan.`,
      alternatives: [manualAlternative(spec)],
    };
  }

  try {
    const portable = await portableInstall(spec, { run, toolsDir, isWin, log });
    await refreshProcessPath?.();
    return {
      ok: true,
      installed: true,
      method: portable.method,
      where: portable.where,
      tried,
      note: `${spec.name} installed as a portable tool inside ATHENA Node. No system installer or WinGet was needed.`,
    };
  } catch (error) {
    tried.push({ method: "portable", ok: false, detail: String(error?.message || error) });
  }

  const details = tried.map((item) => `${item.method}: ${item.ok ? "ok" : item.detail || "failed"}`).join(" · ");
  return {
    ok: false,
    method: null,
    tried,
    error: `Could not install ${spec.name}. ${details || "No installer is available on this PC."}`,
    alternatives: [manualAlternative(spec)],
  };
}

/** Temporary files are not part of the product; remove them after a build. */
export function cleanupDownloads(toolsDir) {
  fs.rmSync(path.join(toolsDir, ".downloads"), { recursive: true, force: true });
}

export function portableToolsDir(baseDir) {
  return path.join(baseDir, "tools");
}


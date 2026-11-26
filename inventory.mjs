/**
 * Machine inventory for ATHENA Node.
 *
 * Everything here is measured. A value that cannot be read is `null`, never
 * zero: "no disk information" and "a full disk" must not look the same to the
 * Hub or to a person reading the panel.
 *
 * Windows queries use CIM/PowerShell because CPU, disk, display and endpoint
 * data are not exposed by Node's standard library. The parser functions are
 * exported separately so they can be tested without Windows.
 */

import os from "node:os";

const GB = 1024 ** 3;
const round1 = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null);

function parseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf("[");
    const last = raw.lastIndexOf("]");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    const open = raw.indexOf("{");
    const close = raw.lastIndexOf("}");
    if (open >= 0 && close > open) {
      try {
        return JSON.parse(raw.slice(open, close + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseDisks(text) {
  const value = parseJson(text);
  if (value === null) return null;
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .filter((row) => row && row.DeviceID)
    .map((row) => {
      /* Number(null) is 0. A missing CIM value must stay unavailable, not
         become a real-looking zero-gigabyte disk. */
      const total = row.Size == null || row.Size === "" ? null : Number(row.Size);
      const free = row.FreeSpace == null || row.FreeSpace === "" ? null : Number(row.FreeSpace);
      return {
        id: String(row.DeviceID),
        label: row.VolumeName ? String(row.VolumeName) : null,
        totalGb: Number.isFinite(total) ? round1(total / GB) : null,
        freeGb: Number.isFinite(free) ? round1(free / GB) : null,
        usedPct: Number.isFinite(total) && total > 0 && Number.isFinite(free) ? Math.round(((total - free) / total) * 100) : null,
      };
    });
}

export function parseDisplays(text) {
  const value = parseJson(text);
  if (value === null) return null;
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .filter((row) => row && (row.width || row.bounds))
    .map((row) => {
      const bounds = row.bounds || {};
      return {
        name: row.name ? String(row.name) : null,
        primary: Boolean(row.primary),
        width: Number(row.width ?? bounds.width) || null,
        height: Number(row.height ?? bounds.height) || null,
        refreshHz: Number.isFinite(Number(row.refreshHz)) ? Number(row.refreshHz) : null,
      };
    });
}

export function classifyAudioNames(names = []) {
  const list = [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
  const inputPattern = /microphone|mic\b|line in|capture|input|headset mic/i;
  const outputPattern = /speaker|headphone|headset earphone|display audio|hdmi|output|realtek|audio device/i;
  const inputs = list.filter((name) => inputPattern.test(name));
  const outputs = list.filter((name) => !inputPattern.test(name) && outputPattern.test(name));
  return { all: list, inputs, outputs };
}

export function parseAudio(text) {
  const value = parseJson(text);
  if (value === null) return null;
  const rows = Array.isArray(value) ? value : [value];
  const names = rows
    .map((row) => (typeof row === "string" ? row : row?.name || row?.FriendlyName || row?.Name))
    .filter(Boolean)
    .map(String);
  if (!names.length) return { all: [], inputs: [], outputs: [] };
  return classifyAudioNames(names);
}

export function parseInstalledApps(text) {
  const value = parseJson(text);
  if (value === null) return null;
  const rows = Array.isArray(value) ? value : [value];
  const names = [...new Set(rows.map((row) => row?.name || row?.DisplayName).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
  return {
    count: names.length,
    sample: names.slice(0, 60),
  };
}

/* CPU utilization is a delta between two reads. The first read returns null
   rather than pretending the machine is at 0% or 100%. */
let cpuPrevious = null;

export function cpuUtilization() {
  const cpus = os.cpus();
  const now = cpus.reduce(
    (sum, cpu) => {
      const times = cpu.times || {};
      const total = Object.values(times).reduce((value, part) => value + Number(part || 0), 0);
      return { total: sum.total + total, idle: sum.idle + Number(times.idle || 0) };
    },
    { total: 0, idle: 0 }
  );
  if (!cpuPrevious) {
    cpuPrevious = now;
    return null;
  }
  const total = now.total - cpuPrevious.total;
  const idle = now.idle - cpuPrevious.idle;
  cpuPrevious = now;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

export function memoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  if (!Number.isFinite(total) || total <= 0) return { totalGb: null, freeGb: null, usedGb: null, availablePct: null };
  return {
    totalGb: round1(total / GB),
    freeGb: round1(free / GB),
    usedGb: round1((total - free) / GB),
    availablePct: Math.round((free / total) * 100),
  };
}

export function osInfo() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    type: os.type(),
    release: os.release(),
    version: typeof os.version === "function" ? os.version() : null,
    arch: os.arch(),
    uptimeSec: Math.round(os.uptime()),
  };
}

const cache = new Map();

async function cached(key, ms, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  let value = null;
  try {
    value = await load();
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

const PS = (script) => [
  "powershell",
  ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='SilentlyContinue'; ${script} | ConvertTo-Json -Compress -Depth 4`],
  { timeout: 20_000 },
];

export async function diskInventory(run, isWin) {
  if (!isWin) {
    return cached("disks", 60_000, async () => {
      const res = await run("df", ["-kP"], { timeout: 8000 });
      if (!res.ok) return null;
      const rows = res.out
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 6 && parts[0].startsWith("/"))
        .map((parts) => {
          const total = Number(parts[1]) * 1024;
          const free = Number(parts[3]) * 1024;
          return {
            id: parts[5],
            label: null,
            totalGb: Number.isFinite(total) ? round1(total / GB) : null,
            freeGb: Number.isFinite(free) ? round1(free / GB) : null,
            usedPct: Number.isFinite(total) && total > 0 ? Math.round(((total - free) / total) * 100) : null,
          };
        });
      return rows.length ? rows : null;
    });
  }
  return cached("disks", 60_000, async () => {
    const [script, args, options] = PS(
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace"
    );
    const res = await run(script, args, options);
    return res.ok ? parseDisks(res.out) : null;
  });
}

export async function displayInventory(run, isWin) {
  if (!isWin) return null;
  return cached("displays", 60_000, async () => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$rate = Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentRefreshRate } | Select-Object -First 1 -ExpandProperty CurrentRefreshRate",
      "$screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ name=$_.DeviceName; primary=$_.Primary; width=$_.Bounds.Width; height=$_.Bounds.Height; refreshHz=$rate } }",
      "$screens",
    ].join("; ");
    const [file, args, options] = PS(script);
    const res = await run(file, args, options);
    return res.ok ? parseDisplays(res.out) : null;
  });
}

export async function audioInventory(run, isWin, ffmpegPath) {
  if (!isWin) return null;
  return cached("audio", 60_000, async () => {
    /* Prefer the actual capture endpoints FFmpeg can open. Without FFmpeg,
       report the Windows audio endpoints by name and mark capture unready. */
    if (ffmpegPath) {
      const res = await run(ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { timeout: 25_000 });
      const text = `${res.err}\n${res.out}`;
      const names = [];
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/\]\s+"([^"]+)"\s+\(audio\)/i);
        if (match && !names.includes(match[1])) names.push(match[1]);
      }
      if (names.length) return { ...classifyAudioNames(names), source: "ffmpeg-dshow" };
    }
    const [file, args, options] = PS(
      "Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object FriendlyName"
    );
    const res = await run(file, args, options);
    const inventory = res.ok ? parseAudio(res.out) : null;
    return inventory ? { ...inventory, source: "windows-audio-endpoints" } : null;
  });
}

export async function installedApps(run, isWin) {
  if (!isWin) return null;
  return cached("apps", 5 * 60_000, async () => {
    const script = [
      "$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
      "Get-ItemProperty $paths | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | Select-Object -ExpandProperty DisplayName -Unique | ForEach-Object { [pscustomobject]@{ name = $_ } }",
    ].join("; ");
    const [file, args, options] = PS(script);
    const res = await run(file, args, options);
    return res.ok ? parseInstalledApps(res.out) : null;
  });
}

export function resetInventoryCache() {
  cache.clear();
  cpuPrevious = null;
}

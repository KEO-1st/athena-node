import fs from "node:fs";

/**
 * Program and URL resolution for a node.
 *
 * Kept separate from the agent so it can be tested without starting a server
 * or owning a Windows desktop. "open task manager" used to fail because the
 * name never matched the exe (`taskmgr.exe`), and "open youtube in chrome"
 * had no URL path at all. Both are pure data problems, solved here.
 */

export const KNOWN_APPS = {
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
  ],
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  firefox: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe", "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"],
  notepad: ["C:\\Windows\\System32\\notepad.exe"],
  explorer: ["C:\\Windows\\explorer.exe"],
  calc: ["C:\\Windows\\System32\\calc.exe"],
  cmd: ["C:\\Windows\\System32\\cmd.exe"],
  powershell: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  taskmgr: ["C:\\Windows\\System32\\Taskmgr.exe"],
  wt: ["%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"],
};

/** Names people actually type, mapped to the exe key above. */
const ALIASES = new Map([
  ["taskmanager", "taskmgr"],
  ["taskmgr", "taskmgr"],
  ["tasksmanager", "taskmgr"],
  ["fileexplorer", "explorer"],
  ["explorer", "explorer"],
  ["files", "explorer"],
  ["calculator", "calc"],
  ["calc", "calc"],
  ["googlechrome", "chrome"],
  ["chrome", "chrome"],
  ["chromebrowser", "chrome"],
  ["microsoftedge", "edge"],
  ["edge", "edge"],
  ["edgebrowser", "edge"],
  ["mozillafirefox", "firefox"],
  ["firefox", "firefox"],
  ["commandprompt", "cmd"],
  ["cmdprompt", "cmd"],
  ["cmd", "cmd"],
  ["powershell", "powershell"],
  ["windowspowershell", "powershell"],
  ["terminal", "wt"],
  ["windowsterminal", "wt"],
  ["wt", "wt"],
  ["notepad", "notepad"],
]);

/** Sites people name without a scheme. Anything else with a dot becomes https. */
const KNOWN_SITES = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  gmail: "https://mail.google.com",
  github: "https://github.com",
  chatgpt: "https://chatgpt.com",
  reddit: "https://www.reddit.com",
  twitter: "https://x.com",
  x: "https://x.com",
  instagram: "https://www.instagram.com",
  facebook: "https://www.facebook.com",
  spotify: "https://open.spotify.com",
  netflix: "https://www.netflix.com",
  twitch: "https://www.twitch.tv",
};

export function normalizeProgramName(raw) {
  return String(raw || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\.exe$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Every key worth trying for a name: the name itself, then its alias. */
export function programCandidates(raw) {
  const normalized = normalizeProgramName(raw);
  if (!normalized) return [];
  const alias = ALIASES.get(normalized);
  return [...new Set(alias && alias !== normalized ? [normalized, alias] : [normalized])];
}

export function expandEnv(value, env = process.env) {
  return String(value || "").replace(/%([^%]+)%/g, (_, key) => env[key] || env[key.toUpperCase()] || "");
}

export function looksLikeUrl(value) {
  const raw = String(value || "").trim();
  if (/^https?:\/\/\S+$/i.test(raw)) return true;
  return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw);
}

/**
 * Turns "youtube", "youtube.com" or a full URL into something a browser can
 * open. Returns null for ordinary program names so they are not mistaken for
 * websites.
 */
export function asUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\/\S+$/i.test(raw)) return raw;
  const site = KNOWN_SITES[normalizeProgramName(raw)];
  if (site) return site;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw)) return `https://${raw}`;
  return null;
}

/**
 * Resolves a program name or path to something that exists on this machine.
 * `exists` is injectable so the rules can be tested off Windows.
 */
export function resolveProgramTarget(raw, { exists = defaultExists, env = process.env, knownApps = KNOWN_APPS } = {}) {
  const cleaned = String(raw || "").trim().replace(/^"|"$/g, "");
  if (!cleaned) return null;

  /* A path was given explicitly. */
  if (/[\\/]/.test(cleaned)) {
    const expanded = expandEnv(cleaned, env);
    return exists(expanded) ? expanded : null;
  }

  const direct = expandEnv(cleaned, env);
  if (exists(direct)) return direct;

  for (const key of programCandidates(cleaned)) {
    for (const candidate of knownApps[key] || []) {
      const full = expandEnv(candidate, env);
      if (full && exists(full)) return full;
    }
  }
  return null;
}

function defaultExists(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

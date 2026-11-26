import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpSocket } from "./cdp.mjs";

/**
 * Chromium control for ATHENA Node.
 *
 * A controlled browser profile is launched with the DevTools protocol on a
 * loopback auto-assigned port. Reusing that profile keeps one browser session
 * across commands, while a normal browser the person already has open is left
 * alone. Navigation, DOM inspection, clicks and typing are verified against the
 * live page. This is not a process-launch facade.
 */

const BROWSER_NAMES = {
  chrome: ["chrome.exe", "Google Chrome"],
  msedge: ["msedge.exe", "Microsoft Edge"],
  brave: ["brave.exe", "Brave"],
};

function envFolders(env) {
  return [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA,
  ].filter(Boolean);
}

/** Installed Chromium browsers, newest canonical copy per family. */
export function findChromiumBrowsers(env = process.env, exists = fs.existsSync) {
  const roots = envFolders(env);
  const candidates = [
    ["chrome", path.join("Google", "Chrome", "Application", "chrome.exe")],
    ["chrome", path.join("Google", "Chrome Beta", "Application", "chrome.exe")],
    ["msedge", path.join("Microsoft", "Edge", "Application", "msedge.exe")],
    ["brave", path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe")],
  ];
  const found = [];
  const seen = new Set();
  for (const base of roots) {
    for (const [family, relative] of candidates) {
      const file = path.join(base, relative);
      if (!exists(file) || seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      found.push({ id: family, name: BROWSER_NAMES[family][1], path: file });
    }
  }
  return found;
}

export function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Give me a website address or a search query.");
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw)) return `https://${raw}`;
  throw new Error(`"${raw}" is not a web address. Use search for a query, or include https://.`);
}

export function searchUrl(query, engine = "google") {
  const q = String(query || "").trim();
  if (!q) throw new Error("What should I search for?");
  const encoded = encodeURIComponent(q);
  if (String(engine).toLowerCase() === "bing") return `https://www.bing.com/search?q=${encoded}`;
  if (String(engine).toLowerCase() === "duckduckgo") return `https://duckduckgo.com/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonHttp(port, route, { method = "GET", timeout = 6000, query } = {}) {
  const suffix = query ? `?${encodeURIComponent(query)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}${route}${suffix}`, {
    method,
    signal: AbortSignal.timeout(timeout),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Browser debug HTTP ${res.status}.`);
  return res.json();
}

function keyPayload(combo) {
  const raw = String(combo || "").trim();
  if (!raw) throw new Error("Which key?");
  const parts = raw.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const keyName = parts.pop();
  const modifiers = (parts.includes("ctrl") || parts.includes("control") ? 2 : 0) | (parts.includes("alt") ? 1 : 0) | (parts.includes("shift") ? 8 : 0);
  const table = {
    enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
    tab: { key: "Tab", code: "Tab", vk: 9 },
    escape: { key: "Escape", code: "Escape", vk: 27 },
    esc: { key: "Escape", code: "Escape", vk: 27 },
    backspace: { key: "Backspace", code: "Backspace", vk: 8 },
    delete: { key: "Delete", code: "Delete", vk: 46 },
    space: { key: " ", code: "Space", vk: 32, text: " " },
    arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    home: { key: "Home", code: "Home", vk: 36 },
    end: { key: "End", code: "End", vk: 35 },
    pageup: { key: "PageUp", code: "PageUp", vk: 33 },
    pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
    f5: { key: "F5", code: "F5", vk: 116 },
    l: { key: "l", code: "KeyL", vk: 76 },
    t: { key: "t", code: "KeyT", vk: 84 },
    w: { key: "w", code: "KeyW", vk: 87 },
    r: { key: "r", code: "KeyR", vk: 82 },
  };
  const base = table[keyName];
  if (!base) throw new Error(`Unsupported browser key "${keyName}". Use enter, tab, escape, pageup/pagedown or a simple ctrl+letter shortcut.`);
  return {
    key: base.key,
    code: base.code,
    windowsVirtualKeyCode: base.vk,
    nativeVirtualKeyCode: base.vk,
    modifiers,
    ...(base.text ? { text: base.text } : {}),
  };
}

export class BrowserController {
  constructor({ dataDir, log = () => undefined, exists = fs.existsSync, env = process.env }) {
    this.dataDir = dataDir;
    this.profile = path.join(dataDir, "browser-profile");
    this.log = log;
    this.exists = exists;
    this.env = env;
    this.child = null;
    this.port = 0;
    this.browser = null;
    this.socket = null;
    this.pageTarget = null;
  }

  browsers() {
    return findChromiumBrowsers(this.env, this.exists);
  }

  profilePortFile() {
    return path.join(this.profile, "DevToolsActivePort");
  }

  readPort() {
    try {
      const lines = fs.readFileSync(this.profilePortFile(), "utf8").split(/\r?\n/);
      const port = Number(lines[0]);
      return Number.isInteger(port) && port > 1024 && port < 65_536 ? port : 0;
    } catch {
      return 0;
    }
  }

  processAlive() {
    if (this.port) {
      return fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1200) })
        .then((res) => res.ok)
        .catch(() => false);
    }
    return Promise.resolve(Boolean(this.child && this.child.exitCode === null));
  }

  async launch() {
    const browsers = this.browsers();
    if (!browsers.length) throw new Error("No Chrome, Edge or Brave installation was found on this node.");
    this.browser = browsers[0];
    fs.mkdirSync(this.profile, { recursive: true });
    for (const stale of [this.profilePortFile()]) {
      try {
        fs.rmSync(stale, { force: true });
      } catch {
        /* best effort */
      }
    }
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1365,900",
      "--new-window",
      this.startUrl || "about:blank",
    ];
    /* windowsHide would hide Chrome's first top-level window: the page works
       but Windows never sees a window to focus. This browser is intentionally
       visible because ATHENA is meant to operate what the person can see. */
    /* Chrome started directly by a windowless Node process can create its
       page without ever showing a top-level window. Start-Process with an
       explicit Normal window style creates the browser on the interactive
       desktop every time; the PowerShell console itself stays hidden. */
    const shellLaunch = process.platform === "win32";
    let child;
    if (shellLaunch) {
      const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      const script = `Start-Process -FilePath ${quote(this.browser.path)} -ArgumentList @(${args.map(quote).join(",")}) -WindowStyle Normal`;
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
    } else {
      child = spawn(this.browser.path, args, { stdio: "ignore" });
    }
    this.child = child;
    child.on("error", (error) => this.log(`browser launch failed: ${error.message}`));
    child.unref();
    this.port = 0;
    const deadline = Date.now() + 14_000;
    while (Date.now() < deadline) {
      const port = this.readPort();
      if (port) {
        try {
          await jsonHttp(port, "/json/version", { timeout: 1500 });
          this.port = port;
          this.browser = { ...this.browser, pid: process.platform === "win32" ? null : child.pid || null };
          this.log(`browser ready: ${this.browser.name} on debug port ${port}`);
          return;
        } catch {
          /* process still starting */
        }
      }
      /* cmd.exe exits immediately after START; that is not the browser. */
      if (!shellLaunch && child.exitCode !== null) break;
      await sleep(250);
    }
    throw new Error(`${this.browser.name} did not expose its debugging port. It may be blocked by policy or already using the ATHENA browser profile.`);
  }

  async ensureBrowser() {
    if (this.port) {
      if (await this.processAlive()) return;
      this.port = 0;
      try {
        this.socket?.close();
      } catch {
        /* stale */
      }
      this.socket = null;
      this.pageTarget = null;
    }
    await this.launch();
  }

  pageSocket() {
    return this.socket;
  }

  async pageList() {
    await this.ensureBrowser();
    const list = await jsonHttp(this.port, "/json/list");
    return Array.isArray(list) ? list.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl) : [];
  }

  async openTarget(url) {
    const target = await jsonHttp(this.port, "/json/new", { method: "PUT", query: url, timeout: 9000 });
    if (!target?.webSocketDebuggerUrl) throw new Error("The browser opened a tab but did not expose it.");
    return target;
  }

  async attach(target) {
    if (this.socket && !this.socket.closed && this.pageTarget?.id === target.id) return this.socket;
    if (this.socket) this.socket.close();
    const socket = new CdpSocket(target.webSocketDebuggerUrl);
    await socket.connect();
    await socket.send("Page.enable", {}, 8000);
    await socket.send("Runtime.enable", {}, 8000);
    this.socket = socket;
    this.pageTarget = target;
    return socket;
  }

  async ensurePage({ create = false, url = "about:blank" } = {}) {
    await this.ensureBrowser();
    let list = await this.pageList();
    /* The debug port opens a moment before Chrome has published its visible
       about:blank tab. Creating a target during that gap used to navigate an
       extra tab while the visible window stayed blank. */
    for (let attempt = 0; attempt < 20 && !list.length; attempt += 1) {
      await sleep(250);
      list = await this.pageList();
    }
    let target = this.pageTarget && list.find((entry) => entry.id === this.pageTarget.id);
    if (!target) target = list[0];
    if (!target && create) target = await this.openTarget(url);
    if (!target) target = await this.openTarget("about:blank");
    return { socket: await this.attach(target), target };
  }

  async evaluate(expression) {
    const { socket } = await this.ensurePage();
    const result = await socket.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      15_000
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "The page script failed.");
    }
    return result.result?.value;
  }

  async snapshot() {
    return this.evaluate(`(() => ({
      title: document.title || "",
      url: location.href,
      readyState: document.readyState,
      text: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 3500)
    }))()`);
  }

  async navigate(url, { wait = true } = {}) {
    const targetUrl = normalizeUrl(url);
    this.startUrl = targetUrl;
    const { socket, target } = await this.ensurePage({ url: targetUrl });
    const loaded = wait ? socket.waitFor("Page.loadEventFired", 12_000) : Promise.resolve(null);
    const result = await socket.send("Page.navigate", { url: targetUrl }, 15_000);
    if (result.errorText) throw new Error(`The browser refused ${targetUrl}: ${result.errorText}`);
    await loaded;
    await sleep(350);
    this.pageTarget = target;
    return this.snapshot();
  }

  async inspect() {
    return this.evaluate(`(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
      };
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const links = [];
      for (const a of document.querySelectorAll("a[href]")) {
        if (!visible(a)) continue;
        const label = clean(a.innerText || a.getAttribute("aria-label") || a.title);
        if (!label) continue;
        links.push({ text: label.slice(0, 180), href: a.href });
        if (links.length >= 60) break;
      }
      const fields = [...document.querySelectorAll("input, textarea, [contenteditable=true]")]
        .filter(visible)
        .slice(0, 12)
        .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || null, name: el.name || null, placeholder: el.placeholder || null }));
      return {
        title: document.title || "",
        url: location.href,
        readyState: document.readyState,
        text: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 5000),
        links,
        fields
      };
    })()`);
  }

  async click({ text, selector }) {
    const wanted = String(text || "").trim();
    const css = String(selector || "").trim();
    if (!wanted && !css) throw new Error("Tell me which link or button to click.");
    const result = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(wanted.toLowerCase())};
      const selector = ${JSON.stringify(css)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
      };
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const candidates = selector
        ? [...document.querySelectorAll(selector)]
        : [...document.querySelectorAll("a, button, [role=button], input[type=button], input[type=submit], summary")];
      let exact = null;
      let partial = null;
      for (const el of candidates) {
        if (!visible(el)) continue;
        const label = clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title).toLowerCase();
        if (!selector && !label) continue;
        if (label === wanted) { exact = el; break; }
        if (!partial && wanted && label.includes(wanted)) partial = el;
      }
      const element = exact || partial || (selector ? candidates.find(visible) : null);
      if (!element) return { ok: false, error: wanted ? "No visible link or button contains \\"" + wanted + "\\"." : "No visible element matches that selector." };
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return { ok: true, clicked: clean(element.innerText || element.value || element.getAttribute("aria-label") || element.title || element.tagName).slice(0, 180), tag: element.tagName.toLowerCase(), href: element.href || null };
    })()`);
    if (!result?.ok) throw new Error(result?.error || "That element could not be clicked.");
    await sleep(900);
    return { action: result, page: await this.snapshot() };
  }

  async type({ text, selector, submit = false }) {
    const value = String(text ?? "");
    const css = String(selector || "").trim();
    if (!value && !css) throw new Error("Tell me what to type.");
    const result = await this.evaluate(`(() => {
      const selector = ${JSON.stringify(css)};
      const value = ${JSON.stringify(value)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
      };
      let el = selector ? document.querySelector(selector) : document.activeElement;
      if (!el || !visible(el) || !(el.matches("input, textarea, [contenteditable=true]"))) {
        el = [...document.querySelectorAll("input[type=search], input[name=q], input[type=text], textarea, [contenteditable=true]")].find(visible) || null;
      }
      if (!el) return { ok: false, error: "No visible text field is focused or available." };
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, value); else el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, typed: value.slice(0, 300), field: el.getAttribute("aria-label") || el.name || el.placeholder || el.tagName.toLowerCase() };
    })()`);
    if (!result?.ok) throw new Error(result?.error || "That field could not be typed into.");
    if (submit) await this.key("enter");
    return { action: result, page: await this.snapshot() };
  }

  async key(combo) {
    const { socket } = await this.ensurePage();
    const key = keyPayload(combo);
    await socket.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, 8000);
    await socket.send("Input.dispatchKeyEvent", { type: "keyUp", ...key, text: undefined }, 8000);
    await sleep(700);
    return { pressed: String(combo), page: await this.snapshot() };
  }

  async back() {
    const { socket } = await this.ensurePage();
    await socket.send("Runtime.evaluate", { expression: "history.back()" }, 8000);
    await sleep(900);
    return this.snapshot();
  }

  async status() {
    const browsers = this.browsers();
    let page = null;
    let running = false;
    if (this.port && (await this.processAlive())) {
      try {
        running = true;
        page = await this.snapshot();
      } catch {
        page = null;
      }
    }
    return {
      ok: true,
      browsers,
      browser: this.browser ? { id: this.browser.id, name: this.browser.name, path: this.browser.path } : null,
      running,
      controlledProfile: this.profile,
      page,
    };
  }

  async action(payload = {}) {
    const op = String(payload.op || "status").toLowerCase();
    switch (op) {
      case "status":
        return this.status();
      case "open":
      case "navigate":
        return { ok: true, op, page: await this.navigate(payload.url) };
      case "search": {
        const url = searchUrl(payload.query, payload.engine);
        const page = await this.navigate(url);
        return { ok: true, op, engine: payload.engine || "google", query: payload.query, page };
      }
      case "inspect":
        return { ok: true, op, ...(await this.inspect()) };
      case "click":
        return { ok: true, op, ...(await this.click(payload)) };
      case "type":
        return { ok: true, op, ...(await this.type(payload)) };
      case "key":
        return { ok: true, op, ...(await this.key(payload.key)) };
      case "back":
        return { ok: true, op, page: await this.back() };
      default:
        throw new Error(`Unknown browser op "${op}". Use status, open, navigate, search, inspect, click, type, key or back.`);
    }
  }

  async shutdown() {
    try {
      if (this.socket) this.socket.close();
    } catch {
      /* closed */
    }
    this.socket = null;
    /* Close only the controlled browser instance through CDP. Killing a pid
       would be wrong on Windows because the browser was started by the shell
       and may share a process tree with the person's own Chrome. */
    try {
      if (this.port) {
        const version = await jsonHttp(this.port, "/json/version", { timeout: 1500 });
        if (version?.webSocketDebuggerUrl) {
          const socket = new CdpSocket(version.webSocketDebuggerUrl);
          await socket.connect();
          await socket.send("Browser.close", {}, 3000).catch(() => undefined);
          socket.close();
        }
      }
    } catch {
      /* browser already gone */
    }
    this.child = null;
    this.port = 0;
  }
}

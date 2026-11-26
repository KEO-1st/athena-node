import net from "node:net";
import crypto from "node:crypto";

/**
 * A deliberately small Chrome DevTools Protocol WebSocket client.
 *
 * ATHENA Node has no npm dependencies and must stay installable from a zip.
 * CDP is the reliable way to drive Chromium (DOM, navigation, typing, clicks)
 * instead of pretending that launching a browser process operated the page.
 * This client implements only RFC 6455 text frames, which is all CDP uses.
 */

function websocketFrame(text, opcode = 0x1) {
  const payload = Buffer.from(String(text), "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

export class CdpSocket {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.handshake = false;
    this.closed = false;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const socket = net.connect(Number(this.url.port) || 80, this.url.hostname);
      this.socket = socket;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("The browser's debugging socket did not answer.")), this.timeoutMs);

      socket.once("error", fail);
      socket.once("connect", () => {
        socket.write(
          `GET ${this.url.pathname || "/"}${this.url.search} HTTP/1.1\r\n` +
            `Host: ${this.url.host}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });

      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshake) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = this.buffer.subarray(0, end).toString("latin1");
          this.buffer = this.buffer.subarray(end + 4);
          if (!/^HTTP\/1\.[01] 101\b/.test(head)) return fail(new Error(`The browser refused the debug socket: ${head.split("\r\n")[0]}`));
          const expected = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          if (!head.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
            return fail(new Error("The browser returned an invalid WebSocket handshake."));
          }
          this.handshake = true;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(this);
          }
        }
        this.drain();
      });

      socket.on("close", () => {
        const error = new Error("The browser debug connection closed.");
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.pending.clear();
        this.closed = true;
      });
    });
  }

  drain() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(32 * 1024 * 1024)) return this.close();
        length = Number(large);
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.raw(websocketFrame(payload.toString("latin1"), 0xA));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.message(text);
        }
      } else if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.message(text);
        }
      }
    }
  }

  message(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (value.id != null) {
      const waiter = this.pending.get(value.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(value.id);
      if (value.error) waiter.reject(new Error(value.error.message || `CDP ${value.method} failed.`));
      else waiter.resolve(value.result);
      return;
    }
    if (!value.method) return;
    const set = this.listeners.get(value.method);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(value.params || {});
      } catch {
        /* a listener cannot break the protocol reader */
      }
    }
  }

  raw(buffer) {
    if (this.closed || !this.socket) return false;
    try {
      this.socket.write(buffer);
      return true;
    } catch {
      return false;
    }
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error("The browser debug connection is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.raw(websocketFrame(JSON.stringify({ id, method, params })))) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Could not write to the browser."));
      }
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  waitFor(method, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      let done = false;
      const off = this.on(method, (params) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve(params);
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.socket) this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

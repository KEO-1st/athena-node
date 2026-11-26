import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { CdpSocket } from "../lib/cdp.mjs";
import { findChromiumBrowsers, normalizeUrl, searchUrl } from "../lib/browser.mjs";

function frame(text) {
  const payload = Buffer.from(text, "utf8");
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** A tiny RFC 6455 server used only to prove the CDP transport. */
async function fakeCdp(t) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] || "";
        const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        setTimeout(() => socket.write(frame(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }))), 25);
      }
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        const masked = Boolean(buffer[1] & 0x80);
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const mask = masked ? buffer.subarray(offset - 4, offset) : null;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length);
        const request = JSON.parse(payload.toString("utf8"));
        if (request.method === "Browser.getVersion") {
          socket.write(frame(JSON.stringify({ id: request.id, result: { product: "FakeChrome/1" } })));
        } else {
          socket.write(frame(JSON.stringify({ id: request.id, result: { echoed: request.method } })));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return server.address().port;
}

test("browser discovery keeps real Chromium paths and removes duplicates", () => {
  const existing = new Set([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
  const found = findChromiumBrowsers(
    { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    (file) => existing.has(file)
  );
  assert.deepEqual(found.map((item) => item.id), ["chrome", "msedge"]);
  assert.equal(found[0].name, "Google Chrome");
});

test("URLs and searches are built explicitly, not guessed by a process launch", () => {
  assert.equal(normalizeUrl("youtube.com"), "https://youtube.com");
  assert.equal(normalizeUrl("https://example.com/a"), "https://example.com/a");
  assert.throws(() => normalizeUrl("CaseOh latest video"), /not a web address/i);
  assert.equal(searchUrl("CaseOh", "google"), "https://www.google.com/search?q=CaseOh");
  assert.equal(searchUrl("a b", "duckduckgo"), "https://duckduckgo.com/?q=a%20b");
});

test("the CDP transport completes a handshake, request and pushed event", async (t) => {
  const port = await fakeCdp(t);
  const socket = new CdpSocket(`ws://127.0.0.1:${port}/devtools/page/1`);
  await socket.connect();
  t.after(() => socket.close());
  const result = await socket.send("Browser.getVersion", {});
  assert.equal(result.product, "FakeChrome/1");
  const event = await socket.waitFor("Page.loadEventFired", 1000);
  assert.equal(event.timestamp, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_HUB_PROTOCOL,
  MIN_HUB_PROTOCOL,
  NODE_FEATURES,
  NODE_PROTOCOL,
  helloInfo,
  hubProtocolSupported,
} from "../protocol.mjs";
import { NODE_VERSION } from "../version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("version.json and version.mjs agree", () => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "version.json"), "utf8"));
  assert.equal(file.version, NODE_VERSION);
  assert.equal(file.version, "0.3.0");
  assert.equal(file.protocol, NODE_PROTOCOL);
});

test("hello declares protocol, version, features and Hub range", () => {
  const hello = helloInfo();
  assert.equal(hello.protocol, NODE_PROTOCOL);
  assert.equal(hello.nodeVersion, NODE_VERSION);
  assert.deepEqual(hello.features, NODE_FEATURES);
  assert.equal(hello.hubProtocol.min, MIN_HUB_PROTOCOL);
  assert.equal(hello.hubProtocol.max, MAX_HUB_PROTOCOL);
});

test("Hub protocol negotiation accepts only the declared range", () => {
  assert.equal(hubProtocolSupported(MIN_HUB_PROTOCOL), true);
  assert.equal(hubProtocolSupported(MAX_HUB_PROTOCOL), true);
  assert.equal(hubProtocolSupported(MAX_HUB_PROTOCOL + 1), false);
  assert.equal(hubProtocolSupported(MIN_HUB_PROTOCOL - 1), false);
  assert.equal(hubProtocolSupported("1"), true);
  assert.equal(hubProtocolSupported(""), false);
  assert.equal(hubProtocolSupported(null), false);
  assert.equal(hubProtocolSupported(1.5), false);
});

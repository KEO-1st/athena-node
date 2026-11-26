import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "version.json");

/**
 * The Node is independently versioned. This file travels with the Node
 * package, so a Node 0.1 installation keeps reporting 0.1 after the Hub is
 * upgraded. Never read the Hub's version.json from here.
 */
export function readNodeVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const version = String(parsed?.version || "").trim();
    return /^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version) ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const NODE_VERSION = readNodeVersion();

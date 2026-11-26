import { NODE_VERSION } from "./version.mjs";

/**
 * ATHENA Node protocol contract.
 *
 * The protocol number is not the software version. It only changes when the
 * shape of `/api/hello`, `/api/status`, `/api/action` or `/api/input` changes
 * in a way an older Hub cannot understand. Additive fields do not bump it.
 *
 * A Node declares the Hub protocols it can talk to. A Hub must refuse a Node
 * outside that range and must never silently assume compatibility. This is
 * what lets Hub 3.x keep a Node 0.1 working after the Hub is updated.
 */
export const NODE_PROTOCOL = 1;
export const MIN_HUB_PROTOCOL = 1;
export const MAX_HUB_PROTOCOL = 1;

/** Stable feature names, not runtime permission flags. */
export const NODE_FEATURES = [
  "status",
  "screen",
  "input",
  "shell",
  "apps",
  "processes",
  "power",
  "audio",
  "comfy",
  "ollama",
  "discovery",
];

/** The part of `/api/hello` the Hub negotiates with. */
export function helloInfo() {
  return {
    protocol: NODE_PROTOCOL,
    nodeVersion: NODE_VERSION,
    features: [...NODE_FEATURES],
    hubProtocol: { min: MIN_HUB_PROTOCOL, max: MAX_HUB_PROTOCOL },
  };
}

/** True when this Node understands the Hub protocol that called it. */
export function hubProtocolSupported(protocol) {
  const value = Number(protocol);
  return Number.isInteger(value) && value >= MIN_HUB_PROTOCOL && value <= MAX_HUB_PROTOCOL;
}

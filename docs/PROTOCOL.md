# ATHENA Node protocol

The Node is independently versioned and independently deployed. The Hub and
Node share a small HTTP contract, not source imports.

```text
NODE_VERSION   = 0.2.0     (software, this repository)
NODE_PROTOCOL  = 1         (wire contract)
hubProtocol    = { min: 1, max: 1 }
```

A Hub and Node negotiate before pairing. A Hub outside the Node's accepted range
is refused with a readable reason and is never half-linked. A Node upgrade does
not require a Hub upgrade while the protocol range still intersects.

## Discovery and identity

- UDP discovery on port `48880` advertises `{ id, name, port, protocol, nodeVersion }`.
- `GET /api/hello` is unauthenticated and returns the same identity plus
  `features` and `hubProtocol`. It contains no secret and no machine inventory.
- Pairing uses a short, human-readable code. The Hub exchanges the code at
  `POST /api/link`; the Node returns a long random token. The Hub stores it.

## Hub → Node requests

All authenticated routes take `x-athena-token: <paired token>`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/hello` | GET | protocol/version/features, no auth |
| `/api/link` | POST | pair with the Node's current code |
| `/api/status` | GET | live machine status and inventory |
| `/api/action` | POST | `{ op, args }` operations |
| `/api/screen/info` | GET | screen dimensions and capture metrics |
| `/api/screen` | GET | one JPEG frame |
| `/api/input` | POST | keyboard/mouse events |
| `/api/audio/devices` | GET | capture endpoints |
| `/api/audio` | GET | audio stream |
| `/api/diagnostics` | GET | runtime and data-directory checks |
| `/api/events` | GET | NDJSON task/service events |

`/api/action` operations are intentionally generic so a newer Hub can use an
older Node without a route change. Adding a new operation is additive; changing
the meaning of an existing one requires a protocol bump.

### Status shape (protocol 1)

Existing fields (`cpu`, `cores`, `memory`, `gpu`, `services`, `tasks`,
`capabilities`, `screen`) remain. 0.2.0 adds:

```json
{
  "hardware": {
    "os": { "hostname": "...", "platform": "win32", "type": "Windows_NT", "release": "..." },
    "cpu": { "model": "...", "cores": 16, "utilizationPct": 12 },
    "memory": { "totalGb": 32, "freeGb": 18.4, "usedGb": 13.6, "availablePct": 58 },
    "gpu": { "name": "...", "vramGb": 8, "utilizationPct": 4 },
    "disks": [{ "id": "C:", "label": "System", "totalGb": 953.9, "freeGb": 201.2, "usedPct": 79 }],
    "displays": [{ "name": "\\\\.\\DISPLAY1", "primary": true, "width": 2560, "height": 1440, "refreshHz": 165 }],
    "audio": { "all": ["..."], "inputs": ["..."], "outputs": ["..."], "source": "ffmpeg-dshow", "captureReady": true },
    "installedApps": { "count": 84, "sample": ["..."] }
  },
  "dependencies": {
    "runtime": { "version": "26.x", "executable": "...", "bundled": true },
    "managers": ["winget", "choco"],
    "apps": [{ "id": "ffmpeg", "installed": true }]
  }
}
```

Rules:

- A value that could not be measured is `null`. It is never `0`.
- Arrays may be empty when the machine has no such device.
- GPU fields are `null` when no GPU is exposed, not omitted.
- `hardware` is additive; Hub 3.2 ignores fields it does not know.
- A slow WMI/CIM query may make one poll return `null` for that section while the
  cache warms. The next poll returns the measured value.

### Privileged operations

These operations are Hub-administrator-only at the Hub. The Node still enforces
its own token and permission flags; it does not trust the Hub to be the only
guard.

```text
run, exec, task-cancel, app-install, install-node, pip, pull-model,
config, shutdown
```

The canonical list is `lib/node-privilege.mjs` in the Hub. The Node rejects
permission widening through `config` even when a valid Hub token asks for it:
those keys can only be changed at the Node's local panel.

## Compatibility policy

- **Additive fields:** safe, no protocol change.
- **New action op:** safe for old Nodes (they answer `Unknown action`); new
  Hubs must tolerate that error.
- **Removed/retyped field, changed endpoint semantics, changed auth:** bump
  `NODE_PROTOCOL` and update both the Node's `hubProtocol` and the Hub's accepted
  range. Do not silently reinterpret a protocol-1 field.
- **Hub/Node versions:** report separately. Never present the Hub's `3.x` version
  as the Node's version or vice versa.

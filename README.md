# ATHENA Node

An independent Windows agent for an [ATHENA Hub](https://github.com/KEO-1st/athena).
It runs on a PC you want ATHENA to see and drive: screen, mouse and keyboard,
shell, hardware telemetry, audio, ComfyUI, Ollama and installable apps.

This repository is the canonical Node product. A Hub upgrade does **not**
upgrade a Node, and a Node upgrade does not require rebuilding the Hub.

- **Node version:** 0.2.0
- **Node protocol:** 1
- **Hub protocol accepted:** 1
- **Runtime:** bundled Node.js — no system Node, npm or WinGet needed

## Install on Windows

### Installer (recommended)

Download `ATHENA-Node-Setup.exe` from
[Releases](https://github.com/KEO-1st/athena-node/releases). It installs under
`%LOCALAPPDATA%\Programs\ATHENA Node` without an administrator prompt, creates
Desktop/Start Menu shortcuts, and starts the Node.

### Portable

Download `ATHENA-Node-0.2.0-win64.zip`, extract the **whole** folder, and run
`ATHENA Node.exe`. Keep `runtime\` and `app\` beside the launcher.

Identity, settings and logs live in `%LOCALAPPDATA%\ATHENA Node`, outside the
program folder. Installer upgrades and uninstalls preserve that directory.

### Pair with the Hub

1. Start ATHENA Node.
2. Read the six-character pairing code on the Node panel.
3. On the Hub: **NODES → SCAN → LINK**, then type the code.
4. Allow the Windows firewall prompt for **Private** networks.

## What 0.2.0 adds

- **Desktop launcher** (`ATHENA Node.exe`): starts the bundled runtime with no
  console window, opens the panel, lives in the notification area, and offers
  Open / Restart / Data folder / Quit. It supervises crashes and restarts.
- **Lifecycle:** panel restart exits with code `75`, stop with `76`; the launcher
  restarts only on `75` and does not fight an intentional shutdown.
- **Measured hardware inventory:** CPU model and delta utilisation, RAM total /
  free / used, GPU and VRAM, fixed disks, display resolution and refresh rate,
  audio endpoints, OS/machine identity and installed applications.
  Unavailable data is `null`, never a fabricated zero.
- **Diagnostics:** data-directory write check, bundled runtime identity, manifest
  check, listener state, protocol range, detected package managers and a
  redacted recent log.
- **Update check:** reads the latest public release from GitHub and reports
  current/latest/available; it never installs silently.
- **Dependency installation:** existing install → WinGet → Chocolatey →
  checksum-verified portable FFmpeg / yt-dlp → official manual instructions.
  Every result lists what was tried and why it failed.
- **Panel:** storage, display, audio and installed-app summaries, diagnostics,
  update check and restart/stop controls.

## Develop

```sh
npm start          # run the agent from source
npm run check      # parse every JavaScript file
npm test           # inventory, dependency, protocol and API tests
npm run package    # portable zip + self-contained Setup.exe
```

`npm run package` copies `process.execPath` into `runtime\node.exe`, compiles the
C# launcher with the Windows built-in compiler, builds the portable zip, embeds
it in `Setup.exe`, and writes `SHA256SUMS.txt` under `dist/`.

The agent has no runtime npm dependencies.

## Compatibility

The protocol number is separate from the software version. Hub 3.2 accepts
protocol 1, so this Node and older 0.1 Nodes can be paired by the same Hub.
Additive status fields do not change the protocol. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Security

The Node trusts only its paired Hub token for Hub calls. Permission changes
(`allowShell`, `allowShutdown`, `allowInput`, `pairOpen`, `code`, `port`) are
accepted only from the machine's own panel. Hub-side remote execution, installs,
configuration and shutdown are administrator-only; API keys are intentionally
not administrator credentials. See [SECURITY.md](SECURITY.md).

## Limitations

- Built and verified on one Windows 11 PC. A second physical PC has **not** been
  used for validation; firewall prompts, clean-machine install and another GPU
  still need that test.
- Hardware queries use Windows CIM/PowerShell. Values that the machine does not
  expose remain `null`.
- Audio capture requires FFmpeg; the inventory reports endpoints without it but
  marks capture as not ready.
- The installer is unsigned, so Windows SmartScreen may warn on first download.

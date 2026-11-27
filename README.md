# ATHENA Node

An independent Windows agent for an [ATHENA Hub](https://github.com/KEO-1st/athena).
It runs on a PC you want ATHENA to see and drive: screen, mouse and keyboard,
shell, hardware telemetry, audio, ComfyUI, Ollama and installable apps.

This repository is the canonical Node product. A Hub upgrade does **not**
upgrade a Node, and a Node upgrade does not require rebuilding the Hub.

- **Node version:** 0.3.0
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

Download `ATHENA-Node-0.3.0-win64.zip`, extract the **whole** folder, and run
`ATHENA Node.exe`. Keep `runtime\` and `app\` beside the launcher.

Identity, settings and logs live in `%LOCALAPPDATA%\ATHENA Node`, outside the
program folder. Installer upgrades and uninstalls preserve that directory.

### Pair with the Hub

1. Start ATHENA Node.
2. Read the six-character pairing code on the Node panel.
3. On the Hub: **NODES → SCAN → LINK**, then type the code.
4. Allow the Windows firewall prompt for **Private** networks.

## What 0.3.0 adds

- **One window, supervised:** the installer no longer shows a success dialog
  before the launcher opens the panel. A second launch signals the running
  launcher and focuses/reopens the existing panel. The launcher owns exactly one
  panel, the agent holds an exclusive instance lock, and crash recovery is
  bounded to three retries with backoff instead of an endless restart loop.
- **Adaptive desktop panel:** tabbed Overview / Machine / Processes /
  Permissions / Diagnostics, fixed-height shell, no page scrolling,
  reduced-motion support and a click-to-copy pairing code. CPU and memory have
  measured meters, and the Processes tab reads the live process table on demand
  (it stops polling when the tab is left and never kills anything).
- **Background notice:** the first hide action explains that closing the panel
  leaves the agent running in the tray.
- **Safe first run:** new Nodes deny shell, keyboard/mouse input and remote
  shutdown until the person at the machine enables them. Existing configs keep
  their saved choices.
- **Memory truth:** installed physical RAM is reported separately from usable
  and currently available memory. GPU VRAM available is measured from total and
  used; unavailable values stay `null`.
- **No public CMD files:** `Start Node` and the CMD uninstaller are gone. The
  package has `ATHENA Node.exe`, a compiled `Uninstall ATHENA Node.exe`, and the
  agent files. PowerShell helpers are internal screen/input automation only.
- **Real computer use:** list, focus and close visible windows; capture the
  desktop; drive the mouse and keyboard; and open a URL or app. A launch is
  verified in three separate steps — a real process appeared, a window was
  created, and that window is visible — so a stub like `calc.exe` that hands off
  to the UWP Calculator is still recognised, and a process with no visible
  window is reported as partial. Browser control
  uses a controlled Chrome/Edge/Brave profile over the DevTools protocol for
  navigation, DOM inspection, clicking, typing, keys and verified page changes.
  Closing a controlled browser uses CDP, so the person's own browser is left
  alone. Screen/window inspection needs `allowScreen`; input and browser
  manipulation need `allowInput`. No paid API or extra runtime dependency.
- **Original identity:** an original gold obelisk/wing sigil is used for the
  executable, installer, tray and panel. Reference images supplied by the owner
  were not copied.

## What 0.2.0 added

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
npm run test:lifecycle  # compiled launcher: one agent, one panel, restart, quit
                        # (uses ATHENA_LAUNCHER_NAMESPACE so a running Node
                        #  does not look like a second test instance)
npm run test:computer   # opt-in: real Chromium navigation/DOM/input/screenshot
                        # set ATHENA_TEST_COMPUTER=1 first
npm run package    # portable zip + self-contained Setup.exe
```

The computer test is intentionally opt-in because it opens a real browser
window and captures the physical desktop. It is not part of `npm test` and is
also skipped unless `ATHENA_TEST_COMPUTER=1` is set.

`npm run package` copies `process.execPath` into `runtime\node.exe`, compiles the
C# launcher with the Windows built-in compiler, builds the portable zip, embeds
it in `Setup.exe`, and writes `SHA256SUMS.txt` under `dist/`.

The agent has no runtime npm dependencies.

## Compatibility

The protocol number is separate from the software version. Hub 3.2 and Hub 3.3
accept protocol 1, so this Node and older 0.1/0.2 Nodes can be paired by the
same Hub.
Additive status fields do not change the protocol. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Security

The Node trusts only its paired Hub token for Hub calls. Permission changes
(`allowShell`, `allowShutdown`, `allowInput`, `allowScreen`, `pairOpen`, `code`,
`port`) are accepted only from the machine's own panel. `allowScreen` covers
screen capture and window inspection; `allowInput` covers mouse, keyboard,
window focus/close and browser control. Hub-side remote execution, installs,
configuration and shutdown are administrator-only; API keys are intentionally
not administrator credentials. See [SECURITY.md](SECURITY.md).

## Limitations

- Built and verified on one Windows 11 PC. A second physical PC has **not** been
  used for validation; firewall prompts, clean-machine install and another GPU
  still need that test.
- Real browser control was verified with installed Chrome on that one PC. A
  machine without Chrome, Edge or Brave fails explicitly instead of pretending
  to browse. Windows blocks input to elevated apps (UIPI), including elevated
  browsers.
- Hardware queries use Windows CIM/PowerShell. Values that the machine does not
  expose remain `null`.
- Audio capture requires FFmpeg; the inventory reports endpoints without it but
  marks capture as not ready.
- The installer is unsigned, so Windows SmartScreen may warn on first download.

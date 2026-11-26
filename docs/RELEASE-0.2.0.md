# ATHENA Node 0.2.0

The first independent ATHENA Node release: a downloadable Windows product with
its own launcher, installer, lifecycle, measured hardware inventory, diagnostics,
update check and dependency fallbacks.

## Download

- `ATHENA Node Setup.exe` — per-user installer, no admin prompt. Installs to
  `%LOCALAPPDATA%\Programs\ATHENA Node` and preserves `%LOCALAPPDATA%\ATHENA Node`.
- `ATHENA-Node-0.2.0-win64.zip` — portable folder with `runtime\node.exe`.
- `SHA256SUMS.txt` — verify both assets.

Neither asset needs Node.js, npm or WinGet on the target PC.

## Highlights

- Tray launcher with Open / Restart / Data folder / Quit and crash recovery.
- Restart exit code `75`, stop exit code `76`; the launcher respects both.
- Measured CPU utilisation, RAM, GPU/VRAM, fixed disks, displays and refresh
  rate, audio endpoints, OS identity and installed applications. Unknown values
  are `null`, never invented zeroes.
- Diagnostics endpoint and panel: data-directory writability, runtime identity,
  manifest, listener, protocol range and available package managers.
- Update check against the public GitHub release; no silent install.
- Dependency install order: existing → WinGet → Chocolatey → checksum-verified
  portable FFmpeg/yt-dlp → official manual instructions.
- No runtime npm dependencies.

## Compatibility

- Node software version: **0.2.0**
- Node protocol: **1**
- Accepted Hub protocol: **1**
- Hub 3.2 pairs with this Node; an out-of-range Hub is refused before linking.

## Verification performed

- `npm run check`: all files parsed.
- `npm test`: 15 Node tests pass (inventory parsers, null-vs-zero, dependency
  fallbacks, protocol negotiation, authenticated API and local diagnostics).
- Portable package booted from its bundled runtime; `/api/hello` and `/api/status`
  returned measured inventory.
- Installer extracted the payload into a clean temporary directory.
- Launcher started the agent, answered health, restarted on exit code `75`, and
  stopped on exit code `76`.

Not performed: installation on a second physical Windows PC. Firewall behavior,
SmartScreen and a clean-machine install still need that test. The binaries are
unsigned.

## Security

Remote execution, installs, configuration and shutdown are Hub-administrator
only. API keys are not administrator credentials. Permission changes are accepted
only from the Node's local panel. See `SECURITY.md`.

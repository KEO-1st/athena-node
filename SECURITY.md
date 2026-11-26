# ATHENA Node security

## Trust boundary

The Node is a remote-access agent. Anyone with its paired Hub token can see the
machine's screen and, when the local owner enabled them, use input, shell, audio,
apps and power actions. Treat the token and the Hub PC as credentials.

- Pairing uses a short code that a person reads aloud. The code is rotated after
  pairing and can be replaced from the local panel.
- The Hub stores the long token. It is never returned by `/api/status` or logs.
- The local panel bootstrap token is minted per boot and given only on loopback
  after an explicit panel intent header. Loopback alone is not control: a local
  web page or DNS-rebinding attempt is not enough.
- Hub calls require `x-athena-token`; the local panel uses a separate
  `x-athena-local` token.

## Permission ownership

`allowShell`, `allowShutdown`, `allowInput`, `pairOpen`, `code` and `port` are
decisions for the person at the Node's own panel. A Hub request that tries to
change one of them is rejected, even with a valid Hub token. A Hub can tune
non-security settings (for example a ComfyUI path), not widen this machine's
permissions.

The Node also re-checks `allowShell` and `allowShutdown` at execution time.
Disabling shell in the panel therefore stops shell actions immediately.

## Hub-side authorization

Remote command execution, task listing/cancellation, app installation, node
software installation, pip installs, model pulls, node configuration changes and
shutdown are **Hub-administrator-only**. Controllers may still open an already
installed app, inspect state and use the screen, which are ordinary controller
workflows; those actions cannot run arbitrary code or change security settings.

An administrator session is minted only by the Hub itself on a direct local
request. It cannot be replayed through a LAN hostname or proxy. API keys are
explicitly not administrator credentials: they can read status and use the
observation APIs, but cannot execute commands or manage jobs.

Job records include the command line and output. Non-admin controllers receive
redacted job views; the full record is visible only to the administrator. The
same redaction applies to the SSE job event.

The AI tool path consults the same privilege list (`lib/node-privilege.mjs` in
the Hub), so a controller cannot ask the model to call a privileged node action
that the HTTP API would refuse. `run_command` was already administrator-only;
`node_action` now enforces the same boundary.

## Dependency installation

There are no runtime npm dependencies. Optional tools use this order:

1. already installed on PATH or a known location
2. WinGet
3. Chocolatey
4. checksum-verified portable download (FFmpeg, yt-dlp)
5. official manual instructions

Downloads are SHA-256 checked before use. A failed check deletes the download
and reports failure; it does not install unverified binaries. Nothing is
silently installed: the Hub receives the method, path, attempts and errors.

## Network exposure

The Node listens on all interfaces so a Hub on the LAN can reach it. Do not
expose its port to the public internet. Use Windows Firewall private-network
rules, and unlink the Node from the Hub if the PC is lost or sold.

## Reporting

This project has no bug bounty. Report a vulnerability privately to the
repository owner rather than opening a public issue with exploit details.

## Known limitations

- The Windows installer and launcher are unsigned. SmartScreen may warn.
- The build was verified on one PC, not a second clean Windows PC.
- Hardware inventory values are only as trustworthy as the Windows CIM/provider
  data on that machine; unavailable values stay `null`.

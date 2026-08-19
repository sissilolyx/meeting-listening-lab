# Security policy

## Supported version

Security fixes are provided for the latest commit on the public `main` branch.

## Reporting a vulnerability

Report security problems privately to the repository owner, preferably through
a private GitHub Security Advisory. Do not open a public issue for an
undisclosed vulnerability.

Include a minimal reproduction, affected version, and expected impact. Do not
attach real recordings, transcripts, Codex output, authentication files,
Feishu/Lark links, tokens, or local `.data` content. Replace them with fictional
fixtures before sharing logs or screenshots.

The repository owner will acknowledge a report when practical, investigate it,
and coordinate a private fix before any disclosure.

## Safe local operation

- Keep the server bound to `127.0.0.1`; do not expose it to a LAN or the public
  internet.
- Use only your own Codex, Cursor, and Feishu/Lark authentication.
- Review dependency and setup-script changes before running them.
- Keep `.data/`, `.models/`, `.env*`, logs, generated output, and media files out
  of Git.
- Stop the local server when it is not in use, especially on a shared computer.

This local single-user application is not a hardened multi-user or hosted
service.

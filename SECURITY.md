# Security policy

## Supported version

Security fixes are provided only for the latest commit shared with invited
testers during the private macOS evaluation.

## Reporting a vulnerability

Report security problems privately to the repository owner through a private
invitation channel or a private GitHub Security Advisory. Do not open a public
issue.

Include a minimal reproduction, affected version, and expected impact. Do not
attach real recordings, transcripts, Codex output, authentication files,
Feishu/Lark links, tokens, or local `.data` content. Replace them with fictional
fixtures before sharing logs or screenshots.

The repository owner will acknowledge a report when practical, investigate it,
and coordinate a private fix with invited testers before any disclosure.

## Safe local operation

- Keep the server bound to `127.0.0.1`; do not expose it to a LAN or the public
  internet.
- Use only your own Codex and Feishu/Lark authentication.
- Review dependency and setup-script changes before running them.
- Keep `.data/`, `.models/`, `.env*`, logs, generated output, and media files out
  of Git.
- Stop the local server when it is not in use, especially on a shared computer.

This private evaluation is not a hardened multi-user or hosted service.

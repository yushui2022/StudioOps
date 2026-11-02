# Security Policy

## Supported versions

StudioOps is pre-1.0. Security fixes are applied to the `main` branch and the
latest tagged release.

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, reproduction steps and impact.

Please do not include real API keys, private certificates, prompts or user data
in the report. Use redacted values.

## Scope

Security-sensitive areas include:

- local Agent and Gateway authentication
- remote access through Tailscale or SSH tunnels
- path traversal and file serving
- service action allowlists
- secret leakage in logs, SQLite or JSONL records
- prompt/body logging
- LaunchAgent installation and privilege boundaries

## Secret handling

StudioOps must never commit:

- API keys or bearer tokens
- TLS private keys (`.key`, `.pem`)
- `.env` files
- real `services.yaml`
- SQLite databases, logs or model files

If a secret is accidentally committed, rotate it first, then remove it from the
working tree and Git history.

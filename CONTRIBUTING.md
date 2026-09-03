# Contributing

Thanks for helping improve Codex Mobile Bridge. Small, focused changes with a
clear Windows use case are easiest to review.

## Before opening an issue

- Search existing issues first.
- Remove tailnet hostnames, access URLs, tokens, account names, personal paths,
  real conversation content, logs, and runtime state from all reports.
- Reduce failures to the smallest reproducible sequence when possible.
- Use fictional data in screenshots and fixtures.

Never publish a suspected vulnerability or credential in a public issue. Contact
the maintainer privately through their GitHub profile first.

## Development

Requirements match the main project:

- Windows 10 or 11
- PowerShell 5.1 or newer
- Node.js 20 or newer

Run the complete local check before submitting a pull request:

```powershell
npm run check
```

The project has no runtime npm dependencies, so an install step is not required.

## Pull requests

- Keep each pull request focused on one problem.
- Explain what changed, why it changed, and what was actually verified.
- Preserve the loopback plus Tailscale trust boundary.
- Treat approval policy, sandbox mode, process termination, thread-writer
  ownership, and local session history as security-sensitive behavior.
- Do not claim phone, Tailscale, watchdog, or installed Codex compatibility from
  unit tests alone; state any remaining verification boundary explicitly.
- Update both English and Simplified Chinese user-facing text together.
- Update `CHANGELOG.md` for user-visible behavior.

By contributing, you agree that your contribution is licensed under the
repository's MIT License.

# Changelog

All notable changes to Codex Mobile Bridge are documented here.

## 0.5.0 - 2026-09-02

### Added

- Compact newest-10-turn history with on-demand full tool details.
- Brotli/gzip responses and a static-only service-worker app-shell cache.
- Explicit SSE heartbeats, instance-aware bounded replay, incremental catch-up,
  and single-flight browser reconnects.
- Verified blue-green restart script with pre-switch checks and rollback.

### Changed

- Conversation-list reads are coalesced behind a five-second cache.
- The watchdog repairs Serve independently and persists transient readiness
  failures before replacing an otherwise live bridge.

## 0.4.0 - 2026-09-02

### Added

- `setup.ps1` with dependency validation, safe automatic port selection,
  Tailscale Serve configuration, and optional watchdog installation.
- Git-ignored local configuration at `state/config.json` with environment
  variable overrides.
- English and Simplified Chinese UI switching with a per-browser preference.
- MIT license and distribution-oriented setup documentation.

### Changed

- Removed personal filesystem paths and tailnet hostnames from tracked files.
- Startup and status scripts now read generated configuration and report its
  location.
- Tailscale health checks now verify the configured HTTPS port and proxy target.
- Minimum supported Node.js version is documented as 20.

### Upgrade notes

- Existing installations should run `.\setup.ps1` once to generate
  `state/config.json`, retain or select ports, refresh Tailscale Serve, and
  reinstall the watchdog.
- The execution defaults remain `danger-full-access` and `never`; review
  tailnet ACLs before sharing access.

## 0.3.0 - 2026-09-02

- Modularized the browser application.
- Added structured logging and bounded HTTP/App Server metrics.

## 0.2.0 - 2026-08-29

- Established the first versioned bridge baseline with paginated history,
  mobile controls, Tailscale lifecycle scripts, and watchdog recovery.

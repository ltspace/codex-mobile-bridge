# Changelog

All notable changes to Codex Mobile Bridge are documented here.

## 0.6.3 - 2026-09-02

### Changed

- Keep active answers and tool executions running by queuing mobile follow-up
  messages instead of steering or interrupting them.
- Persist queued messages locally and retry automatically when another Codex
  client releases the conversation writer.
- Allow composing while a conversation is active in another client, with an
  explicit queue status in the mobile UI.

## 0.6.2 - 2026-09-02

### Changed

- Moved the four compact-screen actions out of the conversation drawer and into
  a separate top-bar drawer so the conversation history keeps the available height.

## 0.6.1 - 2026-09-02

### Fixed

- Replaced the inconsistent mobile browser `datalist` picker with a touch-friendly
  recent-directory dropdown while retaining manual absolute-path entry.
- Release the Codex thread writer after each completed mobile turn so the same
  conversation can be resumed immediately from the desktop client.

## 0.6.0 - 2026-09-02

### Added

- Browser-menu installation guidance without an intrusive in-app prompt.
- Dedicated maskable icon metadata and a new-conversation app shortcut.
- Automated PWA manifest, lifecycle, cache-boundary, and server-header checks.

### Changed

- Navigations now fall back to the cached shell after a short network-first
  window, while all API and conversation responses remain uncached.
- Service-worker upgrades follow the default waiting lifecycle and activate
  after current clients close, avoiding both mixed resources and in-app prompts.
- Standalone safe-area, drawer positioning, viewport fallback, and overscroll
  behavior are tuned for mobile app windows.

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

# Changelog

All notable changes to Codex Mobile Bridge are documented here.

## Unreleased

### Added

- Add a pinned, least-privilege Windows CI workflow, automated GitHub Actions
  update checks, contribution guidance, and privacy-aware issue and pull-request
  templates.
- Add an explicit, double-confirmed mobile conversation takeover that identifies
  the exact Windows lock owner and only stops a verified VS Code Codex App
  Server, while protecting the Bridge and refusing unknown owners.

### Fixed

- Refuse desktop takeover while the target turn is active or when the same VS
  Code App Server owns other thread writers, preventing forced process exit
  from corrupting an unrelated rollout's ordinal sequence.
- Launch the scheduled watchdog directly through hidden Windows PowerShell so
  Windows Script Host or security-product interception of a VBS wrapper cannot
  disable automatic bridge recovery.
- Run the scheduled watchdog under a non-interactive S4U user token so its
  minute-level checks never flash a PowerShell console on the desktop.
- Remove pending approvals, questions, and unsupported MCP elicitation cards
  when their turn completes or is interrupted, without affecting other threads.

## 0.7.2 - 2026-09-02

### Fixed

- Keep queued messages visible after conversation refreshes, reconnects, and
  Bridge restarts, with exact per-message cancellation from the mobile UI.
- Distinguish a conversation held by another Codex client from a locally owned
  active turn, without offering an unsafe stop or process-level takeover.
- Keep the blue-green candidate probe from blocking on a conversation writer
  that another client owns but App Server reports as `notLoaded`.

## 0.7.1 - 2026-09-02

### Fixed

- Read conversation lists from the App Server state database without scanning
  and repairing the full JSONL session archive on each cache miss.
- Enter a bounded 15-to-60-second recovery cooldown after a real App Server RPC
  timeout, reject new work immediately during that window, and recover early
  when a late response proves the App Server is responsive again.
- Distinguish an App Server request-queue recovery from a phone network
  disconnection in the status pill, composer hint, health view, and API errors.
- Run `thread/archive` through a short-lived isolated App Server so recursive
  archive work cannot block conversation reads and sends on the main channel.
  Concurrent archive requests fail fast instead of building another queue.

## 0.7.0 - 2026-09-02

### Added

- Added a Codex/OpenClaw conversation switch that defaults to Codex on every
  page load.
- Classify and filter OpenClaw-created Codex sessions on the server before the
  conversation list reaches the browser.

## 0.6.4 - 2026-09-02

### Added

- Added an archive action for the selected conversation to the top-bar action
  menu on desktop and compact screens.
- Added confirmation, active-turn and queued-message guards, automatic list
  refresh, and `thread/archive` protocol coverage.

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

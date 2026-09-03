# Architecture

## Runtime topology

```text
Phone browser
    │ HTTPS, tailnet only
    ▼
Tailscale Serve :8443
    │ proxy
    ▼
Node HTTP bridge 127.0.0.1:<configured local port>
    │ JSONL over stdio
    ▼
codex app-server
    │
    ▼
Local Codex sessions, tools, and workspace files
```

Only Tailscale Serve has a remotely reachable listener. The bridge and App
Server remain local to the Windows host.

## Components

- `server.mjs` composes configuration, HTTP routing, lifecycle, and health.
- `src/codex-client.mjs` owns the App Server child process, JSON-RPC request
  correlation, initialization handshake, timeouts, and exponential restart.
- `src/thread-service.mjs` maps mobile operations to thread/turn protocol calls,
  classifies Codex and OpenClaw-created sessions, tracks active turns, coalesces
  short-lived conversation-list reads, compacts history pages, and loads
  individual tool details on demand. Archive requests are serialized through a
  short-lived isolated App Server so recursive archive traversal cannot occupy
  the main interactive RPC channel.
- `src/event-hub.mjs` fans App Server notifications out over SSE, emits visible
  heartbeat events, and retains a bounded replay window with per-process
  instance identity for reconnecting phones.
- `src/state-store.mjs` atomically persists newly created threads that have not
  received their first turn yet.
- `src/http-utils.mjs` centralizes body limits, structured errors, Brotli/gzip
  responses, static files, cache validators, and browser security headers.
- `src/logger.mjs` emits one JSON record per lifecycle, failure, or write event;
  message bodies are never included.
- `src/metrics.mjs` keeps bounded in-memory HTTP and App Server RPC counters and
  latency summaries.
- `public/app.js` orchestrates page behavior. `public/modules/` separates API
  transport, DOM references, state, protocol formatting, and message rendering;
  `public/styles.css` owns responsive presentation.
- `public/modules/i18n.js` owns English and Simplified Chinese messages, browser
  language preference, and static-document translation.
- `setup.ps1` discovers dependencies, selects non-conflicting ports, writes the
  local configuration, and composes initial service/watchdog installation.
- `bridge-common.ps1` centralizes Windows process ownership and path discovery.
- `watchdog.ps1` is a one-shot health/repair transaction. Task Scheduler invokes
  it every minute through `install-watchdog.ps1` under the user's
  non-interactive S4U token, so checks never create a desktop console window.
  Transient readiness failures require a persisted threshold while a missing
  process/listener is repaired immediately. `bluegreen-restart.ps1` is the
  planned-upgrade path.

## State and recovery

Machine-specific executable paths, ports, language, and the generated tailnet
URL are stored under the Git-ignored `state/config.json`. Environment variables
take precedence over local configuration, which takes precedence over automatic
discovery. No machine-specific path or tailnet hostname belongs in tracked
files.

The App Server client moves through:

```text
stopped → starting → ready
              │        │ child exits
              └────────▼
                   restarting ──backoff──► starting

ready ──RPC timeout──► degraded cooldown ──timer or late response──► ready
```

HTTP stays alive while an App Server child restarts. `/api/health` returns 503
until the required `initialize` then `initialized` handshake succeeds. The web
UI keeps history visible, marks the connection degraded, and reconnects its SSE
stream automatically.

The first real RPC timeout opens a 15-second cooldown. Consecutive timeouts can
extend it to at most 60 seconds. Calls arriving during the cooldown fail fast
with a retry interval instead of joining the App Server's existing queue; any
late or ordinary response closes the circuit early. Conversation-list reads use
the App Server state database only, while their short-lived raw page cache is
shared before Codex/OpenClaw classification.

The Windows recovery loop does not depend on one permanent console process.
Every scheduled watchdog run checks:

1. the bridge health response, including App Server readiness;
2. the Tailscale Serve rule for the configured HTTPS and loopback ports;
3. process ownership before stopping or replacing a PID.

Serve-only failures are repaired without restarting a healthy bridge. A live
listener with a transient readiness failure is restarted only after the
persisted failure threshold/grace period; a missing process or listener is
recovered immediately. A failed invocation exits non-zero and the next minute
remains an independent recovery opportunity. Start, stop, watchdog recovery,
and blue-green switching share one lifecycle lock and resolve configuration
after acquiring it, so a scheduled check cannot act on a stale port mid-switch.

## Conversation lifecycle

```text
Existing conversation: thread/resume → turn/start → streamed notifications
New conversation:      thread/start  → persisted pending-first-turn marker
                                     → turn/start → marker removed
Active conversation:                  turn/steer or turn/interrupt
History:               thread/list (state DB only) → compact thread/turns/list with opaque cursor
Catch-up:                              latest-page delta from known turn ID
Tool detail:                           thread/items/list only when opened
```

The pending-first-turn marker prevents the bridge from incorrectly resuming a
new empty thread after the Node process itself restarts. Writes are atomic and
bounded to 100 entries with a seven-day expiry.

## HTTP contract

- Successful endpoints return the matching App Server result.
- Errors use `{ "error": { "code", "message", "retryable", "details"? } }`.
- State-changing endpoints require `application/json` and reject browser
  requests marked `Sec-Fetch-Site: cross-site`.
- Conversation takeover is a two-step operation. The read-only preflight binds
  a process-bound server token to the thread ID, writer PID, and process start
  time. Both steps require the target thread to be confirmed idle. The mutation
  repeats the complete Windows Restart Manager lock inventory immediately before
  termination and only stops a VS Code extension-owned `codex.exe app-server`
  that owns this thread alone. Bridge descendants, shared writers, and every
  unrecognized owner are refused.
- SSE messages include monotonically increasing IDs, process instance identity,
  visible heartbeats, timestamps, method names, and params. Reconnecting clients
  replay the bounded recent window or perform an incremental history catch-up
  when the replay window cannot cover the gap.
- Static assets use ETags, Brotli/gzip transfer compression, and a versioned
  service-worker app-shell cache. Navigations are network-first with a bounded
  wait and an offline shell fallback; shell assets remain cache-first within one
  version. API responses remain `no-store`; no conversation data enters the
  service-worker cache or HTML strings. A new worker follows the default waiting
  lifecycle and activates after all current clients close, preventing mixed
  frontend versions without adding an in-app prompt.
- `/api/metrics` returns process-lifetime HTTP/RPC counters, bounded route/method
  dimensions, error counts, and average/max latency. `/api/health` embeds the
  same snapshot for the status UI and PowerShell diagnostics.

## Telemetry

Logs are newline-delimited JSON on stdout/stderr. Successful read requests are
represented by counters only; state transitions, failed requests, and mutation
requests produce log records with request ID, route, status, and duration. Raw
prompts and response bodies are deliberately excluded.

Metrics reset when the Node process restarts. Route labels never contain thread
or request IDs, preventing unbounded metric cardinality.

## Verification boundaries

Automated tests prove the local HTTP and protocol mapping against a fixture.
Alternate-port live tests prove compatibility with the installed Codex CLI and
stored sessions. Production restart, listener identity, local health, Tailscale
Serve status, watchdog scheduling, and a separate phone request are distinct
gates; none should be reported as proof of another.

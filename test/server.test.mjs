import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

test("watchdog runs outside the interactive desktop session", async () => {
  const installer = await readFile(join(ROOT, "install-watchdog.ps1"), "utf8");
  assert.match(installer, /New-ScheduledTaskPrincipal[^\r\n]+-LogonType S4U/);
  assert.doesNotMatch(installer, /-LogonType Interactive/);
  assert.match(installer, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
});

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`bridge exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok && (await response.json()).ready) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("bridge readiness timed out");
}

test("bridge serves the UI and maps the Codex protocol", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-mobile-bridge-test-"));
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_STATE_FILE: join(temporary, "bridge-state.json"),
      BRIDGE_UI_LANGUAGE: "zh-CN",
      CODEX_HOME: join(temporary, "codex-home"),
      CODEX_COMMAND: process.execPath,
      CODEX_ARGS_JSON: JSON.stringify([join(ROOT, "test", "fake-codex.mjs")]),
      FAKE_CODEX_REQUIRE_ARCHIVE_CHANNEL: "1",
      FAKE_CODEX_ARCHIVE_DELAY_MS: "400",
      FAKE_CODEX_CONFLICT_THREAD: "thread-conflict,thread-active-conflict,thread-terminal-conflict,thread-notloaded-active-conflict,thread-unknown-conflict",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  context.after(async () => {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    await rm(temporary, { recursive: true, force: true });
  });

  await waitForReady(baseUrl, child);

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.version, "0.8.3");
  assert.equal(health.uiLanguage, "zh-CN");
  assert.equal(health.appServer.ready, true);
  assert.ok(health.eventStream.instanceId);
  assert.ok(health.metrics.http.requestsTotal >= 1);

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await page.text(), /Codex Bridge/);
  const browserModule = await fetch(`${baseUrl}/modules/api.js`);
  assert.equal(browserModule.status, 200);
  assert.match(browserModule.headers.get("content-type"), /^text\/javascript/);
  assert.match(await browserModule.text(), /export async function api/);
  const languageModule = await fetch(`${baseUrl}/modules/i18n.js`);
  assert.equal(languageModule.status, 200);
  assert.match(await languageModule.text(), /export function setLanguage/);
  const markdownModule = await fetch(`${baseUrl}/modules/markdown.js`);
  assert.equal(markdownModule.status, 200);
  assert.match(await markdownModule.text(), /export function markdownToHtml/);
  const serviceWorker = await fetch(`${baseUrl}/service-worker.js`);
  assert.equal(serviceWorker.status, 200);
  assert.equal(serviceWorker.headers.get("service-worker-allowed"), "/");
  assert.match(serviceWorker.headers.get("cache-control"), /no-store/);
  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.id, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.shortcuts[0].url, "/?source=pwa&action=new");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));

  const list = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(list.data[0].id, "thread-1");
  assert.equal(list.data.length, 6);
  const openclawList = await (await fetch(`${baseUrl}/api/threads?client=openclaw`)).json();
  assert.equal(openclawList.data[0].id, "openclaw-1");
  assert.equal(openclawList.data.length, 1);
  const invalidClientResponse = await fetch(`${baseUrl}/api/threads?client=other`);
  assert.equal(invalidClientResponse.status, 400);
  assert.equal((await invalidClientResponse.json()).error.code, "invalid_thread_client");
  const turnsResponse = await fetch(`${baseUrl}/api/threads/thread-1/turns?limit=10`);
  const turns = await turnsResponse.json();
  assert.equal(turns.data[0].items[1].text, "world");
  assert.equal(turns.data[0].items[2].compact, true);
  assert.equal(turns.data[0].items[2].detailAvailable, true);
  assert.ok(turns.data[0].items[2].text.length < 400);

  const sync = await (await fetch(`${baseUrl}/api/threads/thread-1/sync?knownTurnId=turn-1`)).json();
  assert.equal(sync.resetRequired, false);
  assert.equal(sync.data[0].id, "turn-1");

  const detailResponse = await fetch(`${baseUrl}/api/threads/thread-1/turns/turn-1/items/item-tool`, {
    headers: { "Accept-Encoding": "br, gzip" },
  });
  assert.equal(detailResponse.status, 200);
  assert.match(detailResponse.headers.get("content-encoding"), /^(br|gzip)$/);
  const detail = await detailResponse.json();
  assert.ok(detail.item.aggregatedOutput.length > 4_000);

  const unsupported = await fetch(`${baseUrl}/api/threads`, { method: "POST", body: "{}" });
  assert.equal(unsupported.status, 415);
  const crossSite = await fetch(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ cwd: temporary }),
  });
  assert.equal(crossSite.status, 403);

  const createdResponse = await fetch(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: temporary }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.thread.id, "draft-1");

  const sentResponse = await fetch(`${baseUrl}/api/threads/draft-1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "test" }),
  });
  assert.equal(sentResponse.status, 202);
  assert.equal((await sentResponse.json()).turn.id, "turn-live-1");

  const activeArchiveResponse = await fetch(`${baseUrl}/api/threads/draft-1/archive`, {
    method: "POST",
  });
  assert.equal(activeArchiveResponse.status, 409);
  assert.equal((await activeArchiveResponse.json()).error.code, "turn_active");

  const queuedResponse = await fetch(`${baseUrl}/api/threads/draft-1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "follow up", mode: "queue" }),
  });
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.equal(queued.mode, "queue");
  assert.equal(queued.queued, true);
  assert.equal(queued.position, 1);

  const activeQueue = await (await fetch(`${baseUrl}/api/threads/draft-1/queue`)).json();
  assert.equal(activeQueue.data.length, 1);
  assert.equal(activeQueue.data[0].id, queued.queueId);
  assert.equal(activeQueue.data[0].text, "follow up");

  const conflictResponse = await fetch(`${baseUrl}/api/threads/thread-conflict/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "wait for desktop" }),
  });
  assert.equal(conflictResponse.status, 202);
  const conflictQueued = await conflictResponse.json();
  assert.equal(conflictQueued.mode, "queue");
  assert.equal(conflictQueued.item.reason, "thread_in_use");
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  const conflictQueue = await (await fetch(`${baseUrl}/api/threads/thread-conflict/queue`)).json();
  assert.equal(conflictQueue.blockedByExternalWriter, true);
  assert.equal(conflictQueue.data[0].text, "wait for desktop");
  const takeoverPreflightResponse = await fetch(`${baseUrl}/api/threads/thread-conflict/takeover`);
  assert.equal(takeoverPreflightResponse.status, 200);
  const takeoverPreflight = await takeoverPreflightResponse.json();
  assert.equal(takeoverPreflight.available, false);
  assert.ok(["owner_missing", "unsupported_platform"].includes(takeoverPreflight.reason));
  const cancelConflict = await fetch(`${baseUrl}/api/threads/thread-conflict/queue/${conflictQueued.queueId}`, { method: "DELETE" });
  assert.equal(cancelConflict.status, 200);
  assert.equal((await cancelConflict.json()).remaining, 0);
  assert.equal((await (await fetch(`${baseUrl}/api/threads/thread-conflict/queue`)).json()).data.length, 0);

  const activeConflictResponse = await fetch(`${baseUrl}/api/threads/thread-active-conflict/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "do not force stop the active desktop task" }),
  });
  assert.equal(activeConflictResponse.status, 202);
  const activeConflictQueued = await activeConflictResponse.json();
  const activeTakeoverResponse = await fetch(`${baseUrl}/api/threads/thread-active-conflict/takeover`);
  assert.equal(activeTakeoverResponse.status, 200);
  const activeTakeover = await activeTakeoverResponse.json();
  assert.equal(activeTakeover.available, false);
  assert.equal(activeTakeover.reason, "active_remote_turn");
  const activeTakeoverPost = await fetch(`${baseUrl}/api/threads/thread-active-conflict/takeover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: null, owner: null }),
  });
  assert.equal(activeTakeoverPost.status, 409);
  assert.equal((await activeTakeoverPost.json()).error.code, "takeover_active_remote_turn");
  await fetch(`${baseUrl}/api/threads/thread-active-conflict/queue/${activeConflictQueued.queueId}`, { method: "DELETE" });

  const terminalConflictResponse = await fetch(`${baseUrl}/api/threads/thread-terminal-conflict/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "take over after the persisted terminal turn" }),
  });
  assert.equal(terminalConflictResponse.status, 202);
  const terminalConflictQueued = await terminalConflictResponse.json();
  const terminalTakeoverResponse = await fetch(`${baseUrl}/api/threads/thread-terminal-conflict/takeover`);
  assert.equal(terminalTakeoverResponse.status, 200);
  const terminalTakeover = await terminalTakeoverResponse.json();
  assert.equal(terminalTakeover.available, false);
  assert.ok(["owner_missing", "unsupported_platform"].includes(terminalTakeover.reason));
  await fetch(`${baseUrl}/api/threads/thread-terminal-conflict/queue/${terminalConflictQueued.queueId}`, { method: "DELETE" });

  const notLoadedActiveResponse = await fetch(`${baseUrl}/api/threads/thread-notloaded-active-conflict/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "do not stop a persisted active turn" }),
  });
  assert.equal(notLoadedActiveResponse.status, 202);
  const notLoadedActiveQueued = await notLoadedActiveResponse.json();
  const notLoadedActiveTakeoverResponse = await fetch(`${baseUrl}/api/threads/thread-notloaded-active-conflict/takeover`);
  assert.equal(notLoadedActiveTakeoverResponse.status, 200);
  assert.equal((await notLoadedActiveTakeoverResponse.json()).reason, "active_remote_turn");
  await fetch(`${baseUrl}/api/threads/thread-notloaded-active-conflict/queue/${notLoadedActiveQueued.queueId}`, { method: "DELETE" });

  const unknownConflictResponse = await fetch(`${baseUrl}/api/threads/thread-unknown-conflict/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "do not force stop without proven idle state" }),
  });
  assert.equal(unknownConflictResponse.status, 202);
  const unknownConflictQueued = await unknownConflictResponse.json();
  const unknownTakeoverResponse = await fetch(`${baseUrl}/api/threads/thread-unknown-conflict/takeover`);
  assert.equal(unknownTakeoverResponse.status, 200);
  const unknownTakeover = await unknownTakeoverResponse.json();
  assert.equal(unknownTakeover.available, false);
  assert.equal(unknownTakeover.reason, "thread_state_unknown");
  const unknownTakeoverPost = await fetch(`${baseUrl}/api/threads/thread-unknown-conflict/takeover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: null, owner: null }),
  });
  assert.equal(unknownTakeoverPost.status, 409);
  assert.equal((await unknownTakeoverPost.json()).error.code, "takeover_thread_state_unknown");
  await fetch(`${baseUrl}/api/threads/thread-unknown-conflict/queue/${unknownConflictQueued.queueId}`, { method: "DELETE" });

  const releaseDeadline = Date.now() + 3_000;
  let releasedHealth;
  while (Date.now() < releaseDeadline) {
    releasedHealth = await (await fetch(`${baseUrl}/api/health`)).json();
    if (releasedHealth.metrics.rpc.byMethod["thread/unsubscribe"] >= 2) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(releasedHealth.activeTurns["draft-1"], undefined);
  assert.equal(releasedHealth.drafts.queuedMessages, 0);
  assert.equal(releasedHealth.metrics.rpc.byMethod["turn/start"], 2);
  assert.equal(releasedHealth.metrics.rpc.byMethod["thread/unsubscribe"], 2);
  let archiveFinished = false;
  const archiveRequest = fetch(`${baseUrl}/api/threads/draft-1/archive`, {
    method: "POST",
  }).finally(() => { archiveFinished = true; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const archiveHealth = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(archiveHealth.archive.busy, true);
  assert.equal(archiveHealth.appServer.degraded, false);
  const concurrentArchive = await fetch(`${baseUrl}/api/threads/thread-2/archive`, { method: "POST" });
  assert.equal(concurrentArchive.status, 409);
  assert.equal((await concurrentArchive.json()).error.code, "archive_busy");
  const concurrentRead = await fetch(`${baseUrl}/api/threads?limit=7&search=archive-isolation`);
  assert.equal(concurrentRead.status, 200);
  assert.equal(archiveFinished, false, "main App Server read waited for isolated archive completion");
  const archiveResponse = await archiveRequest;
  assert.equal(archiveResponse.status, 200);
  const archiveDoneHealth = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(archiveDoneHealth.archive.busy, false);
  const metrics = await (await fetch(`${baseUrl}/api/metrics`)).json();
  assert.ok(metrics.http.requestsTotal >= 8);
  assert.ok(metrics.http.errorsTotal >= 2);
  assert.ok(metrics.rpc.requestsTotal >= 5);
  assert.ok(metrics.rpc.byMethod["thread/list"] >= 1);
  assert.equal(metrics.rpc.byMethod["thread/archive"], 1);
  const records = stdout.join("").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.event === "bridge_listening" && record.version === "0.8.3"));
  assert.equal(stderr.some((line) => line.includes("initial app-server start failed")), false);
});

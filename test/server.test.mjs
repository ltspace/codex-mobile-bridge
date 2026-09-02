import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

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
      CODEX_COMMAND: process.execPath,
      CODEX_ARGS_JSON: JSON.stringify([join(ROOT, "test", "fake-codex.mjs")]),
      FAKE_CODEX_REQUIRE_ARCHIVE_CHANNEL: "1",
      FAKE_CODEX_ARCHIVE_DELAY_MS: "400",
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
  assert.equal(health.version, "0.7.1");
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
  assert.equal(list.data.length, 1);
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
  assert.ok(records.some((record) => record.event === "bridge_listening" && record.version === "0.7.1"));
  assert.equal(stderr.some((line) => line.includes("initial app-server start failed")), false);
});

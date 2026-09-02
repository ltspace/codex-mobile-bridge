import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventHub } from "../src/event-hub.mjs";
import { resolveSpawnSpec } from "../src/codex-client.mjs";
import { entriesFromTurns } from "../public/modules/formatters.js";
import { BridgeMetrics } from "../src/metrics.mjs";
import { rpcFailure } from "../src/thread-service.mjs";
import { BridgeStateStore } from "../src/state-store.mjs";
import { hasTranslation, setLanguage, t } from "../public/modules/i18n.js";
import { markdownToHtml } from "../public/modules/markdown.js";

test("event hub keeps a bounded replay window", () => {
  const hub = new EventHub({ replaySize: 2 });
  hub.publish("one", {});
  hub.publish("two", {});
  hub.publish("three", {});
  assert.deepEqual(hub.history.map((event) => event.method), ["two", "three"]);
});

test("non-Windows commands remain direct child processes", () => {
  assert.deepEqual(resolveSpawnSpec("codex", ["app-server"], "linux"), {
    command: "codex",
    args: ["app-server"],
  });
});

test("frontend history formatter normalizes turns without DOM access", () => {
  const entries = entriesFromTurns({ data: [{ id: "turn-1", items: [
    { id: "agent-1", type: "agentMessage", text: "done" },
    { id: "user-1", type: "userMessage", content: [{ text: "go" }] },
  ] }] });
  assert.deepEqual(entries.map(({ role, text }) => ({ role, text })), [
    { role: "agent", text: "done" },
    { role: "user", text: "go" },
  ]);
});

test("metrics aggregate bounded route and RPC summaries", () => {
  const metrics = new BridgeMetrics();
  metrics.beginHttp();
  metrics.recordHttp({ route: "health", status: 200, durationMs: 10 });
  metrics.beginHttp();
  metrics.recordHttp({ route: "thread_list", status: 503, durationMs: 30 });
  metrics.recordRpc({ method: "thread/list", outcome: "timeout", durationMs: 40 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.http.requestsTotal, 2);
  assert.equal(snapshot.http.errorsTotal, 1);
  assert.equal(snapshot.http.averageDurationMs, 20);
  assert.equal(snapshot.rpc.timeoutsTotal, 1);
  assert.deepEqual(snapshot.rpc.byMethod, { "thread/list": 1 });
});

test("active thread writer conflicts become an actionable client error", () => {
  const error = rpcFailure({ code: -32600, message: "thread-store conflict: thread example already has an active writer" });
  assert.equal(error.status, 409);
  assert.equal(error.code, "thread_in_use");
  assert.equal(error.retryable, false);
});

test("queued follow-ups survive a bridge restart until delivered", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-bridge-queue-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const statePath = join(temporary, "state.json");
  const first = new BridgeStateStore(statePath);
  const queued = first.enqueueMessage("thread-1", "continue after the current task");
  assert.equal(queued.position, 1);

  const restored = new BridgeStateStore(statePath);
  assert.equal(restored.snapshot().queuedMessages, 1);
  assert.equal(restored.peekQueuedMessage("thread-1").text, "continue after the current task");
  assert.equal(restored.removeQueuedMessage(queued.id), true);
  assert.equal(restored.snapshot().queuedMessages, 0);
});

test("UI messages switch between English and Chinese", () => {
  setLanguage("en", { persist: false });
  assert.equal(t("actions.send"), "Send");
  assert.equal(t("threads.count", { count: 3 }), "3 conversations");
  setLanguage("zh-CN", { persist: false });
  assert.equal(t("actions.send"), "发送");
  assert.equal(t("threads.count", { count: 3 }), "3 个会话");
  setLanguage("en", { persist: false });
});

test("assistant Markdown renders common formatting without executable HTML", () => {
  const html = markdownToHtml("# Result\n\n- **done**\n- [OpenAI](https://openai.com)\n\n`code`\n\n[app.js](C:/work/app.js)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))");
  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<ul><li><strong>done<\/strong><\/li>/);
  assert.match(html, /href="https:\/\/openai\.com"/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /class="file-reference">app\.js<\/span>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("every referenced UI message exists in both languages", async () => {
  const sources = await Promise.all([
    "../public/app.js",
    "../public/index.html",
    "../public/modules/api.js",
    "../public/modules/formatters.js",
    "../public/modules/messages.js",
  ].map((path) => import("node:fs/promises").then(({ readFile }) => readFile(new URL(path, import.meta.url), "utf8"))));
  const keys = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\("([^"]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.add(match[1]);
  }
  for (const key of keys) {
    assert.equal(hasTranslation(key, "en"), true, `missing English message: ${key}`);
    assert.equal(hasTranslation(key, "zh-CN"), true, `missing Chinese message: ${key}`);
  }
});

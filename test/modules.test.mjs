import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EventHub } from "../src/event-hub.mjs";
import { CodexClient, resolveSpawnSpec } from "../src/codex-client.mjs";
import { entriesFromTurns } from "../public/modules/formatters.js";
import { BridgeMetrics } from "../src/metrics.mjs";
import { rpcFailure, ThreadService, threadClient } from "../src/thread-service.mjs";
import { BridgeStateStore } from "../src/state-store.mjs";
import { isEligibleVsCodeOwner, ThreadTakeoverService } from "../src/thread-takeover.mjs";
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

test("takeover stops only the exact verified VS Code writer", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-bridge-takeover-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const lockDirectory = join(temporary, "thread-writer-locks");
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, "thread-1.lock"), "");
  const owner = {
    pid: 43210,
    startedAt: "2026-09-03T00:00:00.000Z",
    executablePath: "C:\\Users\\test\\.vscode\\extensions\\openai.chatgpt-1.2.3-win32-x64\\bin\\windows-x86_64\\codex.exe",
    commandLine: "codex.exe app-server --analytics-default-enabled",
    parentPid: 1234,
    ancestorPids: [1234],
    threadIds: ["thread-1"],
  };
  let alive = true;
  const terminated = [];
  const service = new ThreadTakeoverService({
    platform: "win32",
    codexHome: temporary,
    protectedPids: () => [9999],
    probeOwners: async () => alive ? [owner] : [],
    terminate: async (target) => { terminated.push(target.pid); alive = false; },
    secret: Buffer.alloc(32, 7),
  });

  assert.equal(isEligibleVsCodeOwner(owner), true);
  const preflight = await service.inspect("thread-1");
  assert.equal(preflight.available, true);
  assert.deepEqual(preflight.owner, {
    pid: 43210,
    startedAt: "2026-09-03T00:00:00.000Z",
    client: "vscode",
    application: "Codex App Server",
    lockedThreadCount: 1,
  });
  await assert.rejects(
    service.takeover("thread-1", {
      token: preflight.token,
      pid: preflight.owner.pid,
      startedAt: "2026-09-03T00:00:01.000Z",
    }),
    (error) => error.code === "takeover_owner_changed",
  );
  assert.deepEqual(terminated, []);
  const result = await service.takeover("thread-1", {
    token: preflight.token,
    pid: preflight.owner.pid,
    startedAt: preflight.owner.startedAt,
  });
  assert.equal(result.terminated, true);
  assert.deepEqual(terminated, [43210]);
});

test("takeover refuses Bridge descendants and non-VS Code owners", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-bridge-takeover-guard-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const lockDirectory = join(temporary, "thread-writer-locks");
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, "thread-1.lock"), "");
  let owner = {
    pid: 2222,
    startedAt: "2026-09-03T00:00:00.000Z",
    executablePath: "C:\\Users\\test\\.vscode\\extensions\\openai.chatgpt-1.2.3-win32-x64\\bin\\codex.exe",
    commandLine: "codex.exe app-server",
    ancestorPids: [1111],
    threadIds: ["thread-1"],
  };
  const service = new ThreadTakeoverService({
    platform: "win32",
    codexHome: temporary,
    protectedPids: () => [1111],
    probeOwners: async () => [owner],
    secret: Buffer.alloc(32, 9),
  });

  assert.equal((await service.inspect("thread-1")).reason, "protected_owner");
  owner = {
    ...owner,
    ancestorPids: [3333],
    executablePath: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe",
  };
  assert.equal((await service.inspect("thread-1")).reason, "unsupported_owner");
});

test("takeover refuses a VS Code App Server shared by multiple threads and revalidates before termination", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-bridge-shared-writer-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const lockDirectory = join(temporary, "thread-writer-locks");
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, "thread-1.lock"), "");
  const owner = {
    pid: 43210,
    startedAt: "2026-09-03T00:00:00.000Z",
    executablePath: "C:\\Users\\test\\.vscode\\extensions\\openai.chatgpt-1.2.3-win32-x64\\bin\\windows-x86_64\\codex.exe",
    commandLine: "codex.exe app-server",
    ancestorPids: [1234],
    threadIds: ["thread-1"],
  };
  let shared = false;
  const terminated = [];
  const service = new ThreadTakeoverService({
    platform: "win32",
    codexHome: temporary,
    protectedPids: () => [],
    probeOwners: async () => [{ ...owner, threadIds: shared ? ["thread-1", "thread-2"] : ["thread-1"] }],
    terminate: async (target) => terminated.push(target.pid),
    secret: Buffer.alloc(32, 11),
  });

  const preflight = await service.inspect("thread-1");
  assert.equal(preflight.available, true);
  shared = true;
  await assert.rejects(
    service.takeover("thread-1", {
      token: preflight.token,
      pid: preflight.owner.pid,
      startedAt: preflight.owner.startedAt,
    }),
    (error) => error.code === "takeover_shared_owner",
  );
  assert.deepEqual(terminated, []);
  const sharedPreflight = await service.inspect("thread-1");
  assert.equal(sharedPreflight.available, false);
  assert.equal(sharedPreflight.reason, "shared_owner");
  assert.equal(sharedPreflight.owner.lockedThreadCount, 2);
});

test("RPC timeout opens a bounded recovery cooldown", async (context) => {
  const client = new CodexClient({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))],
    env: { ...process.env, FAKE_CODEX_HANG_METHOD: "fixture/hang" },
    rpcCooldownMs: 30,
    rpcCooldownMaxMs: 60,
    logger: { error() {} },
  });
  context.after(() => client.stop());
  await client.start();

  await assert.rejects(client.request("fixture/hang", {}, 10), (error) => error.code === "rpc_timeout");
  assert.equal(client.snapshot().degraded, true);
  await assert.rejects(
    client.request("thread/read", { threadId: "thread-1" }),
    (error) => error.code === "rpc_circuit_open" && error.retryAfterMs > 0,
  );

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client.snapshot().degraded, false);
  const result = await client.request("thread/read", { threadId: "thread-1" });
  assert.equal(result.thread.id, "thread-1");
  assert.equal(client.snapshot().timeoutStreak, 0);
});

test("recovery cooldown errors tell the phone when to retry", () => {
  const error = rpcFailure({ code: "rpc_circuit_open", retryAfterMs: 1_200 });
  assert.equal(error.status, 503);
  assert.equal(error.code, "codex_recovering");
  assert.equal(error.retryable, true);
  assert.equal(error.details.seconds, 2);
});

test("a late RPC response closes the recovery cooldown early", async (context) => {
  const client = new CodexClient({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))],
    env: { ...process.env, FAKE_CODEX_DELAY_METHOD: "fixture/delay", FAKE_CODEX_DELAY_MS: "40" },
    rpcCooldownMs: 500,
    rpcCooldownMaxMs: 500,
    logger: { error() {} },
  });
  context.after(() => client.stop());
  await client.start();

  const lateResponse = once(client, "rpcLate");
  await assert.rejects(client.request("fixture/delay", {}, 10), (error) => error.code === "rpc_timeout");
  assert.equal(client.snapshot().degraded, true);
  const [observation] = await lateResponse;
  assert.equal(observation.method, "fixture/delay");
  assert.equal(observation.outcome, "late_ok");
  assert.equal(client.snapshot().degraded, false);
  assert.equal(client.snapshot().timeoutStreak, 0);
});

test("thread client classification separates OpenClaw sessions from ordinary Codex threads", () => {
  assert.equal(threadClient({ cwd: "C:\\work\\project", preview: "help me configure openclaw" }), "codex");
  assert.equal(threadClient({ cwd: "C:\\work\\project", preview: "Conversation info: ⟦openclaw:ctx⟧\n{}" }), "openclaw");
  assert.equal(threadClient({ cwd: "/work/project", preview: "OpenClaw runtime context for this turn:\ncontext" }), "openclaw");
  assert.equal(threadClient({ cwd: "C:\\home\\lut\\.openclaw\\workspace", preview: "hello" }), "openclaw");
});

test("completed and interrupted turns resolve only their own pending server requests", async () => {
  class FakeClient extends EventEmitter {
    ready = true;

    snapshot() {
      return { ready: true };
    }

    request(method) {
      assert.equal(method, "thread/unsubscribe");
      return Promise.resolve({});
    }
  }

  const client = new FakeClient();
  const eventHub = new EventHub();
  const stateStore = {
    snapshot: () => ({}),
    peekQueuedMessage: () => null,
  };
  const service = new ThreadService({ client, eventHub, stateStore });
  client.emit("serverRequest", {
    id: 1,
    method: "mcpServer/elicitation/request",
    params: { threadId: "thread-a", turnId: "turn-a" },
  });
  client.emit("serverRequest", {
    id: 2,
    method: "mcpServer/elicitation/request",
    params: { threadId: "thread-b", turnId: "turn-b" },
  });

  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn-a", status: "interrupted" } },
  });

  assert.deepEqual(service.pendingRequests().data.map((request) => request.requestId), ["2"]);
  assert.deepEqual(
    eventHub.history.filter((event) => event.method === "bridge/requestResolved").map((event) => event.params),
    [{ requestId: "1", threadId: "thread-a", turnId: "turn-a", reason: "turn_completed" }],
  );

  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-b", turn: { id: "turn-b", status: "completed" } },
  });
  assert.deepEqual(service.pendingRequests().data, []);
  await new Promise((resolve) => setImmediate(resolve));
});

test("queued follow-ups survive a bridge restart until delivered", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-bridge-queue-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const statePath = join(temporary, "state.json");
  const first = new BridgeStateStore(statePath);
  const queued = first.enqueueMessage("thread-1", "continue after the current task", { reason: "thread_in_use" });
  const other = first.enqueueMessage("thread-2", "unrelated queue");
  assert.equal(queued.position, 1);

  const restored = new BridgeStateStore(statePath);
  assert.equal(restored.snapshot().queuedMessages, 2);
  assert.equal(restored.peekQueuedMessage("thread-1").text, "continue after the current task");
  assert.equal(restored.queuedMessagesForThread("thread-1")[0].reason, "thread_in_use");
  assert.equal(restored.removeQueuedMessageForThread("thread-2", queued.id), false);
  assert.equal(restored.removeQueuedMessageForThread("thread-1", queued.id), true);
  assert.equal(restored.removeQueuedMessage(other.id), true);
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

test("assistant Markdown renders skill citations as compact traceable cards", () => {
  const html = markdownToHtml("Done.\n\n<skill-citation>\nC:/Users/lut/.codex/skills/anyextract-test-release/SKILL.md\n</skill-citation>");
  assert.match(html, /<p>Done\.<\/p>/);
  assert.match(html, /class="citation-card skill-citation"/);
  assert.match(html, /class="citation-name">anyextract-test-release<\/span>/);
  assert.match(html, /<code>C:\/Users\/lut\/\.codex\/skills\/anyextract-test-release\/SKILL\.md<\/code>/);
  assert.doesNotMatch(html, /&lt;\/?skill-citation&gt;/);

  const unsafe = markdownToHtml("<skill-citation>\nC:/skills/<img src=x onerror=alert(1)>/SKILL.md\n</skill-citation>");
  assert.doesNotMatch(unsafe, /<img/);
  assert.match(unsafe, /&lt;img src=x onerror=alert\(1\)&gt;/);
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

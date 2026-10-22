import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ThreadTakeoverService, takeoverFailure } from "../src/thread-takeover.mjs";
import { ThreadService } from "../src/thread-service.mjs";
import { BridgeStateStore } from "../src/state-store.mjs";
import { EventHub } from "../src/event-hub.mjs";
import { publicError } from "../src/errors.mjs";
import { createLogger } from "../src/logger.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);

test("native Windows probe distinguishes one thread, a shared process and coordination files", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-native-lock-"));
  const handles = [];
  t.after(async () => { for (const handle of handles) await handle.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const target = join(directory, "thread-a.lock");
  handles.push(await open(target, "w"));
  handles.push(await open(join(directory, ".coordination.lock"), "w"));
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "src", "find-thread-writer.ps1"), "-LockPath", target];
  const first = JSON.parse((await exec("powershell.exe", args, { windowsHide: true, timeout: 20_000 })).stdout);
  const owner = first.owners.find((item) => item.pid === process.pid);
  assert.ok(owner, "native Restart Manager must see the test process's actual file handle");
  assert.equal(owner.sharedOwner, false, "coordination file is not a conversation");
  assert.deepEqual(owner.threadIds, ["thread-a"]);
  handles.push(await open(join(directory, "thread-b.lock"), "w"));
  const second = JSON.parse((await exec("powershell.exe", args, { windowsHide: true, timeout: 20_000 })).stdout);
  assert.equal(second.owners.find((item) => item.pid === process.pid).sharedOwner, true);
  assert.equal(second.terminated, false);
  await assert.rejects(exec("powershell.exe", [...args, "-Terminate", "-ExpectedPid", "0", "-ExpectedStartedAt", owner.startedAt], { windowsHide: true, timeout: 20_000 }), (error) => /Lock owner PID changed/.test(error.stderr));
});

test("batched shared-owner evidence blocks termination; concurrent inspections share only in-flight work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-takeover-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(directory, "thread-writer-locks"));
  await writeFile(join(directory, "thread-writer-locks", "thread-1.lock"), "");
  const owner = { pid: 43210, startedAt: "2026-09-03T00:00:00.000Z", executablePath: "C:\\Users\\test\\.vscode\\extensions\\openai.chatgpt-1.0\\bin\\codex.exe", commandLine: "codex.exe app-server", threadIds: ["thread-1"], sharedOwner: false };
  let probes = 0;
  let terminated = false;
  const service = new ThreadTakeoverService({ platform: "win32", codexHome: directory, probeOwners: async () => { probes++; await new Promise((resolveWait) => setTimeout(resolveWait, 5)); return [owner]; }, terminate: async () => { terminated = true; } });
  const [preflight] = await Promise.all([service.inspect("thread-1"), service.inspect("thread-1")]);
  assert.equal(probes, 1);
  owner.sharedOwner = true;
  const shared = await service.inspect("thread-1");
  assert.equal(probes, 2, "completed inspections must not be reused as stale ownership evidence");
  assert.equal(shared.reason, "shared_owner");
  assert.equal(shared.owner.lockedThreadCountIsLowerBound, true);
  await assert.rejects(service.takeover("thread-1", { token: preflight.token, pid: owner.pid, startedAt: owner.startedAt }), (error) => error.code === "takeover_shared_owner");
  assert.equal(terminated, false);
});

test("timeouts and permission failures retain local diagnostics without exposing stderr to clients", () => {
  const timeout = takeoverFailure({ killed: true, signal: "SIGTERM", stderr: "private diagnostic" }, "inspect");
  assert.equal(timeout.code, "takeover_probe_timeout");
  assert.equal(takeoverFailure({ stderr: "Access is denied" }, "release").code, "takeover_access_denied");
  assert.doesNotMatch(JSON.stringify(publicError(timeout)), /private diagnostic/);
  const lines = [];
  const logger = createLogger("test", { errors: { write: (line) => lines.push(line) } });
  logger.error("failed", { error: timeout });
  assert.equal(JSON.parse(lines[0]).error.diagnostic.stderr, "private diagnostic");
});

async function queueFixture(t, request) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-takeover-delivery-"));
  const store = new BridgeStateStore(join(directory, "state.json"));
  store.addDraft("thread-1");
  const item = store.enqueueMessage("thread-1", "already authorized message", { reason: "thread_in_use" });
  const client = new EventEmitter();
  client.ready = true;
  client.snapshot = () => ({ ready: client.ready });
  client.request = request;
  const service = new ThreadService({ client, stateStore: store, eventHub: new EventHub() });
  t.after(async () => { client.ready = false; for (const timer of service.queueRetryTimers.values()) clearTimeout(timer); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { service, store, item };
}

test("takeover waits for the specific queued message's turn/start receipt, including a fast completed turn", async (t) => {
  let acknowledge;
  let calls = 0;
  const { service, store, item } = await queueFixture(t, async (method) => { assert.equal(method, "turn/start"); calls++; return new Promise((resolveStart) => { acknowledge = resolveStart; }); });
  let settled = false;
  const confirmation = service.confirmQueuedMessageStarted("thread-1", item.id).then((result) => { settled = true; return result; });
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(settled, false);
  assert.equal(store.queuedMessageCount("thread-1"), 1);
  acknowledge({ turn: { id: "started-turn" } });
  assert.deepEqual(await confirmation, { acquired: true, queueId: item.id, turnId: "started-turn" });
  service.activeTurns.clear();
  assert.equal((await service.confirmQueuedMessageStarted("thread-1", item.id)).turnId, "started-turn");
  assert.equal(calls, 1);
});

test("failed reacquisition preserves the queued message and never reports takeover success", async (t) => {
  const { service, store, item } = await queueFixture(t, async () => { throw { code: -32600, message: "thread-store conflict: thread already has an active writer" }; });
  await assert.rejects(service.confirmQueuedMessageStarted("thread-1", item.id, { timeoutMs: 30 }), (error) => error.code === "takeover_not_acquired" && error.details.lastCode === "thread_in_use");
  assert.equal(store.queuedMessageCount("thread-1"), 1);
});

test("queue removal or an unrelated active turn is not a delivery receipt", async (t) => {
  const { service, store, item } = await queueFixture(t, async () => { throw new Error("must not start"); });
  service.activeTurns.set("thread-1", "unrelated-turn");
  store.removeQueuedMessage(item.id);
  await assert.rejects(service.confirmQueuedMessageStarted("thread-1", item.id), (error) => error.code === "takeover_not_acquired");
});

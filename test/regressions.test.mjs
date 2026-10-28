import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ThreadService } from "../src/thread-service.mjs";
import { BridgeStateStore } from "../src/state-store.mjs";
import { EventHub } from "../src/event-hub.mjs";
import { codexEnvironment } from "../src/codex-environment.mjs";

async function fixture(context, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-regression-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  class Client extends EventEmitter {
    ready = true;
    restarts = 0;
    calls = [];
    loaded = new Set();
    persisted = new Set();
    snapshot() { return { ready: this.ready, pendingRpc: 0 }; }
    async request(method, params) {
      this.calls.push({ method, params });
      const id = params.threadId || "draft";
      if (method === "thread/start") {
        this.loaded.add(id);
        return { thread: { id, status: { type: "idle" } } };
      }
      if (!this.loaded.has(id) && !this.persisted.has(id)) {
        throw Object.assign(new Error(`thread not loaded: ${id}`), { code: -32600 });
      }
      if (method === "thread/read") return { thread: { id } };
      if (method === "thread/resume") { this.loaded.add(id); return { thread: { id } }; }
      if (method === "turn/start") {
        assert.ok(this.loaded.has(id));
        this.persisted.add(id);
        return { turn: { id: "turn" } };
      }
      if (method === "thread/turns/list" && !this.persisted.has(id)) {
        throw Object.assign(new Error("not materialized before first user message"), { code: -32600 });
      }
      return { data: [], nextCursor: null };
    }
    async restart() {
      this.restarts++;
      this.ready = false;
      this.loaded.clear();
      this.emit("state", this.snapshot());
      await delay(15);
      this.ready = true;
      this.emit("state", this.snapshot());
    }
  }
  const client = new Client();
  const stateStore = new BridgeStateStore(join(directory, "state.json"));
  const eventHub = new EventHub();
  const service = new ThreadService({ client, stateStore, eventHub, disconnectGraceMs: 1, disconnectRetryMs: 5, ...options });
  context.after(() => { clearTimeout(service.disconnectRecycleTimer); });
  return { directory, client, stateStore, eventHub, service };
}

test("disconnect preserves an unmaterialized draft and its first message", async (t) => {
  const { client, service, eventHub, directory } = await fixture(t);
  await service.createThread({ cwd: directory });
  assert.equal(service.snapshot().writerLifecycle.loadedDrafts, 1);
  eventHub.emit("clientsChanged", 0);
  await delay(35);
  assert.equal(client.restarts, 0);
  assert.deepEqual(await service.getTurns("draft"), { data: [], nextCursor: null });
  assert.equal(client.calls.some((c) => c.method === "thread/turns/list"), false);
  await service.send("draft", { text: "first message" });
  assert.equal(client.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(service.snapshot().writerLifecycle.loadedDrafts, 0);
});

test("lost drafts return 410 without retrying or silently recreating a thread", async (t) => {
  const { service, client, stateStore } = await fixture(t);
  stateStore.addDraft("lost");
  for (const operation of [
    () => service.getThread("lost"), () => service.getTurns("lost"),
    () => service.send("lost", { text: "keep this input" }),
    () => service.updateSettings("lost", { effort: "high" }),
  ]) {
    await assert.rejects(operation, { status: 410, code: "draft_expired", retryable: false });
  }
  assert.ok(client.calls.every((c) => c.method === "thread/read"));
});

test("persisted draft marker after restart does not skip resume before sending", async (t) => {
  const { service, client, stateStore } = await fixture(t);
  stateStore.addDraft("persisted");
  client.persisted.add("persisted");
  await service.send("persisted", { text: "next message" });
  assert.deepEqual(client.calls.map((c) => c.method), ["thread/read", "thread/resume", "turn/start"]);
  assert.equal(stateStore.hasDraft("persisted"), false);
});

test("requests wait for planned recycling and recycling waits for admitted requests", async (t) => {
  let busy = true;
  const { service, client, eventHub } = await fixture(t, { hasActiveRequests: () => busy });
  service.loadedThreads.add("stored");
  eventHub.emit("clientsChanged", 0);
  await delay(25);
  assert.equal(client.restarts, 0);
  busy = false;
  for (let n = 0; !service.recyclePromise && n < 100; n++) await delay(1);
  assert.ok(service.recyclePromise);
  await service.waitForRecycle();
  assert.equal(client.ready, true);
  assert.equal(client.restarts, 1);
});

test("Codex proxy settings survive local config BOM and do not mutate the parent environment", async (t) => {
  const { directory } = await fixture(t);
  const file = join(directory, "config.json");
  await writeFile(file, '\ufeff' + JSON.stringify({ codexProxyUrl: "http://proxy.local:8080", codexNoProxy: "localhost,.local" }));
  const original = { HTTPS_PROXY: "http://old.local:80", PATH: "fixture" };
  const child = codexEnvironment(file, original);
  assert.equal(child.HTTPS_PROXY, "http://proxy.local:8080");
  assert.equal(child.https_proxy, child.HTTPS_PROXY);
  assert.equal(child.NO_PROXY, "localhost,.local");
  assert.equal(original.HTTPS_PROXY, "http://old.local:80");
  assert.equal(codexEnvironment(file, { BRIDGE_CODEX_PROXY_URL: "" }).HTTPS_PROXY, undefined);
  await writeFile(file, JSON.stringify({ codexProxyUrl: "http://user:password@proxy.local" }));
  assert.throws(() => codexEnvironment(file, {}), /without embedded credentials/);
});

test("isolated archive waits for thread/closed rather than unsubscribe acknowledgement", async (t) => {
  let archiveStarted = false;
  const archive = new EventEmitter();
  archive.ready = true;
  archive.start = async () => { archiveStarted = true; };
  archive.stop = async () => {};
  archive.request = async () => ({});
  const { service, client, stateStore } = await fixture(t, { archiveClientFactory: () => archive });
  service.loadedThreads.add("stored");
  client.persisted.add("stored");
  const promise = service.archiveThread("stored");
  await delay(40);
  assert.equal(archiveStarted, false);
  client.emit("notification", { method: "thread/closed", params: { threadId: "stored" } });
  await promise;
  assert.equal(archiveStarted, true);
  assert.equal(stateStore.hasDraft("stored"), false);
});

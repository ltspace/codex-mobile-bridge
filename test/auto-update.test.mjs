import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { stableVersion, isNewer } from "../src/codex-release.mjs";
import { DeploymentGate } from "../src/deployment-gate.mjs";
import { ThreadService } from "../src/thread-service.mjs";
import { BridgeStateStore } from "../src/state-store.mjs";
import { EventHub } from "../src/event-hub.mjs";

test("stable release selection rejects prereleases, injection, downgrade and lexical ordering", () => {
  for (const version of ["0.164.0-alpha.1", "latest", "0.163.0+build", "0.163.0 && echo bad", "01.2.3", null]) {
    assert.throws(() => stableVersion(version));
  }
  assert.equal(isNewer("0.163.0", "0.99.0"), true);
  assert.equal(isNewer("0.162.0", "0.163.0"), false);
  assert.equal(isNewer("0.163.0", "0.163.0"), false);
});

test("expired lease restores only the selected writer and malformed state fails closed", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "bridge-gate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const gate = new DeploymentGate(join(temporary, "bridge-state.json"), 8765);
  await writeFile(join(temporary, "config.json"), '\uFEFF{"localPort":8765}');
  await writeFile(join(temporary, "deployment-lease.json"), JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(gate.snapshot().blocked, false);
  await writeFile(join(temporary, "config.json"), '{"localPort":8766}');
  assert.equal(gate.snapshot().blocked, true);
  assert.equal(gate.snapshot().standby, true);
  await writeFile(join(temporary, "config.json"), 'corrupt');
  assert.equal(gate.snapshot().blocked, true);
});

test("standby cannot drain a persisted queue; activation starts it exactly once", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "bridge-queue-gate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const store = new BridgeStateStore(join(temporary, "state.json"));
  store.addDraft("draft-1");
  store.enqueueMessage("draft-1", "queued");
  const client = new EventEmitter();
  client.ready = true;
  client.snapshot = () => ({ ready: true });
  let starts = 0;
  client.request = async (method) => {
    if (method === "thread/read" || method === "thread/resume") return { thread: { id: "draft-1" } };
    assert.equal(method, "turn/start");
    starts += 1;
    return { turn: { id: "turn-1" } };
  };
  let blocked = true;
  const service = new ThreadService({ client, stateStore: store, eventHub: new EventHub(), isDeploymentBlocked: () => blocked });
  client.emit("state", { ready: true });
  service.resumeQueuedMessages();
  assert.equal(starts, 0);
  assert.equal(store.queuedMessageCount("draft-1"), 1);
  blocked = false;
  service.resumeQueuedMessages();
  service.resumeQueuedMessages();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(store.queuedMessageCount("draft-1"), 0);
});

test("PowerShell cutover rolls back partial switches and preserves both instances if rollback fails", { skip: process.platform !== "win32" }, async () => {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "deployment.test.ps1")], { windowsHide: true });
  assert.match(stdout, /deployment tests passed/);
});

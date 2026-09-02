import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EventHub } from "../src/event-hub.mjs";
import { compactTurnPage, deltaFromTurnPage, findThreadItem } from "../src/mobile-history.mjs";
import { EventStreamController, eventStreamUrl, reconnectDelay } from "../public/modules/event-stream.js";

test("mobile history keeps messages and summarizes tool output", () => {
  const page = compactTurnPage({ data: [{ id: "turn-2", items: [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "run it" }] },
    { id: "agent-1", type: "agentMessage", text: "done" },
    { id: "tool-1", type: "commandExecution", command: "npm test", aggregatedOutput: "x".repeat(2_000), status: "completed" },
  ] }], nextCursor: "older" }, { summaryLimit: 80 });

  assert.equal(page.data[0].items[0].content[0].text, "run it");
  assert.equal(page.data[0].items[1].text, "done");
  assert.equal(page.data[0].items[2].detailAvailable, true);
  assert.ok(page.data[0].items[2].text.length <= 80);
  assert.equal(page.data[0].items[2].aggregatedOutput, undefined);
});

test("turn delta includes the known newest turn for in-place updates", () => {
  const page = { data: [{ id: "turn-3" }, { id: "turn-2" }, { id: "turn-1" }], nextCursor: "older" };
  assert.deepEqual(deltaFromTurnPage(page, "turn-2").data.map((turn) => turn.id), ["turn-3", "turn-2"]);
  assert.equal(deltaFromTurnPage(page, "turn-missing").resetRequired, true);
});

test("thread item lookup accepts item pagination entries", () => {
  assert.deepEqual(findThreadItem({ data: [{ turnId: "turn-1", item: { id: "item-1", text: "full" } }] }, "item-1"), {
    turnId: "turn-1",
    item: { id: "item-1", text: "full" },
  });
});

test("event stream resume URL and reconnect delay stay bounded", () => {
  assert.equal(eventStreamUrl({ lastEventId: 42, instanceId: "instance-a" }), "/api/events?lastEventId=42&instanceId=instance-a");
  assert.equal(reconnectDelay(0, () => 0.5), 1_000);
  assert.equal(reconnectDelay(20, () => 0.5), 15_000);
});

test("event stream controller keeps one source and closes it on failure", () => {
  const sources = [];
  let offline = 0;
  const controller = new EventStreamController({
    onOffline: () => { offline += 1; },
    eventSourceFactory: (url) => {
      const source = {
        url,
        listeners: new Map(),
        addEventListener(name, handler) { this.listeners.set(name, handler); },
        close() { this.closed = true; },
      };
      sources.push(source);
      return source;
    },
  });
  controller.start();
  controller.start();
  assert.equal(sources.length, 1);
  sources[0].onopen();
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.equal(offline, 1);
  controller.stop();
});

test("event hub resumes retained events and emits observable heartbeats", () => {
  const hub = new EventHub({ replaySize: 2 });
  hub.publish("one", {});
  hub.publish("two", {});
  const request = new EventEmitter();
  request.headers = {};
  request.url = `/api/events?lastEventId=1&instanceId=${hub.instanceId}`;
  const chunks = [];
  const response = {
    writeHead: () => {},
    write: (value) => chunks.push(value),
    end: () => {},
  };

  assert.equal(hub.attach(request, response, { ready: true }), true);
  hub.heartbeat();
  const output = chunks.join("");
  assert.match(output, /"method":"two"/);
  assert.match(output, /"replayedCount":1/);
  assert.match(output, /event: bridge-ping/);
  request.emit("close");
  assert.equal(hub.clients.size, 0);
});

test("new conversation uses a touch-friendly workspace picker", async () => {
  const root = new URL("..", import.meta.url);
  const [page, app] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
  ]);

  assert.doesNotMatch(page, /<datalist\b|\blist="workspaceOptions"/);
  assert.match(page, /id="workspaceToggle"/);
  assert.match(page, /id="workspaceOptions"[^>]+role="listbox"/);
  assert.match(app, /workspaceToggle\.addEventListener\("click", toggleWorkspaceOptions\)/);
});

test("mobile actions use a topbar drawer instead of consuming conversation-list space", async () => {
  const root = new URL("..", import.meta.url);
  const [page, app] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
  ]);

  const sidebar = page.match(/<aside id="sidebar"[\s\S]*?<\/aside>/)?.[0] || "";
  assert.match(page, /id="actionMenuButton"[^>]+aria-controls="actionDrawer"/);
  assert.match(page, /id="actionDrawer"[^>]+role="group"[^>]+inert/);
  assert.match(page, /id="drawerArchiveThreadButton"/);
  assert.doesNotMatch(sidebar, /id="drawer(?:NewThread|Refresh|ArchiveThread|Theme|Language)Button"/);
  assert.match(app, /function openActionDrawer\(\)/);
  assert.match(app, /thread\/archive/);
  assert.match(app, /closeActionDrawer\(\);\s*\n\s*document\.body\.classList\.add\("drawer-open"\)/);
});

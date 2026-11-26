import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { ThreadService } from "../src/thread-service.mjs";
import { EventHub } from "../src/event-hub.mjs";
import { t } from "../public/modules/i18n.js";

const PINNED_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

function serviceFixture() {
  class Client extends EventEmitter {
    calls = [];
    pins = Array.from({ length: 102 }, (_, index) => ({
      id: `old-${index}`, name: `Pinned ${index}`, updatedAt: index,
      section: { id: "pins", name: "Pinned" }, is_pinned: 0,
    }));
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === "threadSection/list") {
        return params.cursor
          ? { data: [{ id: PINNED_SECTION_ID, name: "Pinned" }], nextCursor: null }
          : { data: [{ id: "custom", name: "Pinned" }], nextCursor: "sections-2" };
      }
      assert.equal(method, "thread/list");
      let data = params.sectionId ? this.pins : [{ id: "recent", name: "Recent" }];
      if (params.searchTerm) data = data.filter((thread) => thread.name.includes(params.searchTerm));
      const offset = Number(params.cursor || 0);
      return { data: data.slice(offset, offset + params.limit), nextCursor: offset + params.limit < data.length ? String(offset + params.limit) : null };
    }
  }
  const client = new Client();
  const service = new ThreadService({ client, eventHub: new EventHub(), stateStore: {} });
  return { client, service };
}

test("new conversations use native project identity or explicitly remain projectless", async () => {
  const client = new EventEmitter();
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "project/list") return params.cursor
      ? { data: [{ id: "fictional-project", name: "Example project", roots: [{ path: tmpdir() }] }] }
      : { data: [], nextCursor: "page-2" };
    assert.equal(method, "thread/start");
    return { thread: { id: "new-thread" } };
  };
  const service = new ThreadService({ client, eventHub: new EventHub(), stateStore: { addDraft() {} } });
  assert.equal((await service.projects()).data[0].name, "Example project");
  await service.createThread({ projectId: "fictional-project", cwd: "ignored" });
  assert.equal(calls.at(-1).params.projectId, "fictional-project");
  assert.equal(calls.at(-1).params.cwd, resolve(tmpdir()));
  await service.createThread({ projectId: null, cwd: "ignored" });
  assert.equal(calls.at(-1).params.projectId, null);
  assert.equal(calls.at(-1).params.cwd, resolve(homedir()));
  await assert.rejects(service.createThread({ projectId: "missing" }), { code: "invalid_project" });
  await assert.rejects(service.createThread({ projectId: 123 }), { code: "invalid_project" });
});

test("pin mutations use the built-in pinned section across pages, validate state and report unavailable support", async () => {
  const { client, service } = serviceFixture();
  const calls = [];
  const sectionPages = [
    { data: [{ id: "custom", name: "Pinned" }], nextCursor: "sections-2" },
    { data: [{ id: PINNED_SECTION_ID, name: "Pinned" }], nextCursor: null },
  ];
  let pageIndex = 0;
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "threadSection/list") return sectionPages[pageIndex++] || { data: [], nextCursor: null };
    return {};
  };

  await service.setThreadPinned("A", { pinned: true });
  assert.deepEqual(calls.at(-1), { method: "thread/section/move", params: { threadId: "A", sectionId: PINNED_SECTION_ID } });
  assert.equal(calls.filter((call) => call.method === "threadSection/list").length, 2);

  pageIndex = 0;
  calls.length = 0;
  await service.setThreadPinned("A", { pinned: false });
  assert.deepEqual(calls.at(-1), { method: "thread/section/move", params: { threadId: "A", sectionId: null } });
  assert.equal(calls.filter((call) => call.method === "threadSection/list").length, 0);

  await assert.rejects(service.setThreadPinned("A", { pinned: "true" }), { code: "invalid_pin_state" });

  client.request = async (method) => method === "threadSection/list"
    ? { data: [{ id: "custom", name: "Recent" }], nextCursor: null }
    : {};
  await assert.rejects(service.setThreadPinned("A", { pinned: true }), { code: "pin_unavailable" });

  client.request = async () => { throw Object.assign(new Error("unsupported"), { code: -32601 }); };
  await assert.rejects(service.setThreadPinned("A", { pinned: false }), { code: "pin_unavailable" });
});

test("pinned history follows section order across every page, independent of recent history", async () => {
  const { client, service } = serviceFixture();
  const recent = await service.listThreads({ limit: 100 });
  assert.equal(recent.data[0].id, "recent");
  const pins = await service.listPinnedThreads();
  assert.equal(pins.data.length, 102);
  assert.equal(pins.data[0].id, "old-0");
  assert.equal(pins.data.at(-1).id, "old-101");
  assert.equal(pins.nextCursor, null);
  const calls = client.calls.filter(({ params }) => params.sectionId);
  assert.equal(calls.length, 2);
  for (const { params } of calls) {
    assert.equal(params.sortKey, "section_position");
    assert.equal(params.sortDirection, "asc");
    assert.equal(params.useStateDbOnly, true);
    assert.equal(params.archived, false);
    assert.deepEqual(params.modelProviders, []);
    assert.deepEqual(params.sourceKinds, ["vscode", "appServer", "cli"]);
  }
});

test("pinned search and source filters apply to all section pages", async () => {
  const { client, service } = serviceFixture();
  client.pins[101] = { ...client.pins[101], cwd: "C:\\fixture\\.openclaw\\workspace" };
  const codex = await service.listPinnedThreads();
  assert.equal(codex.data.length, 101);
  const openclaw = await service.listPinnedThreads({ client: "openclaw" });
  assert.deepEqual(openclaw.data.map((thread) => thread.id), ["old-101"]);
  const search = await service.listPinnedThreads({ searchTerm: "Pinned 100" });
  assert.deepEqual(search.data.map((thread) => thread.id), ["old-100"]);
  assert.deepEqual((await service.listPinnedThreads({ searchTerm: "missing" })).data, []);
  await assert.rejects(service.listPinnedThreads({ client: "other" }), { code: "invalid_thread_client" });
});

test("refresh bypasses cached pins and reflects desktop reorder and unpin immediately", async () => {
  const { client, service } = serviceFixture();
  client.pins = client.pins.slice(0, 3);
  await service.listPinnedThreads();
  client.pins = [client.pins[2], client.pins[0]];
  const fresh = await service.listPinnedThreads({ refresh: true });
  assert.deepEqual(fresh.data.map((thread) => thread.id), ["old-2", "old-0"]);
  assert.deepEqual((await service.listPinnedThreads()).data, fresh.data);
  client.pins = [];
  client.emit("notification", { method: "threadSection/updated", params: {} });
  assert.deepEqual((await service.listPinnedThreads()).data, []);
});

test("an invalidated in-flight history read cannot overwrite newer cache data", async () => {
  const { client, service } = serviceFixture();
  let finishOld;
  let calls = 0;
  client.request = async () => ++calls === 1
    ? new Promise((resolve) => { finishOld = resolve; })
    : { data: [{ id: "new" }], nextCursor: null };
  const old = service.listThreads();
  client.emit("notification", { method: "thread/section/changed", params: {} });
  await service.listThreads();
  finishOld({ data: [{ id: "old" }], nextCursor: null });
  await old;
  assert.equal((await service.listThreads()).data[0].id, "new");
  assert.equal(calls, 2);
});

test("missing or unsupported sections preserve ordinary history", async () => {
  const { client, service } = serviceFixture();
  const request = client.request.bind(client);
  client.request = async (method, params) => method === "threadSection/list"
    ? { data: [], nextCursor: null } : request(method, params);
  assert.deepEqual((await service.listPinnedThreads()).data, []);
  client.request = async () => { throw Object.assign(new Error("Unsupported method"), { code: -32601 }); };
  assert.deepEqual((await service.listPinnedThreads()).data, []);
  client.request = async () => { throw Object.assign(new Error("Unavailable"), { code: -32001 }); };
  await assert.rejects(service.listPinnedThreads(), { code: "codex_overloaded" });
});

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("new-project picker restores a valid remembered project and safely falls back", async () => {
  let remembered = "project-b";
  let fail = false;
  const node = () => ({ classList: { remove() {} }, focus() {}, value: "", textContent: "" });
  const elements = Object.fromEntries(["newThreadModal", "newThreadHint", "newCwd", "workspaceToggle"].map((key) => [key, node()]));
  const context = vm.createContext({
    elements, state: { selected: { projectId: "project-a" } }, recentWorkspaces: [],
    localStorage: { getItem: () => remembered },
    loadModels() {}, setWorkspaceOptionsOpen() {}, renderNewModelControls() {}, renderWorkspaceOptions() {},
    t: (key) => key, matchMedia: () => ({ matches: false }),
    errorInfo: (error) => ({ message: error.message }),
    api: async () => {
      if (fail) throw new Error("offline");
      return { data: [{ id: "project-a", name: "Example A" }, { id: "project-b", name: "Example B" }] };
    },
  });
  vm.runInContext(appSource.slice(appSource.indexOf("async function openNewThread()"), appSource.indexOf("function closeNewThread()")), context);
  await context.openNewThread();
  assert.equal(elements.newCwd.value, "project-b");
  assert.equal(elements.newCwd.textContent, "Example B");
  remembered = "deleted-project";
  await context.openNewThread();
  assert.equal(elements.newCwd.value, "");
  assert.equal(elements.newCwd.textContent, "new.noProject");
  remembered = null;
  await context.openNewThread();
  assert.equal(elements.newCwd.value, "project-a");
  fail = true;
  await context.openNewThread();
  assert.equal(elements.newCwd.value, "");
});

function browserFixture(api) {
  const node = (tag = "div") => ({
    tag, children: [], attributes: {}, textContent: "", value: "", disabled: false,
    classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const state = {
    threadClient: "codex", threads: [], pinnedThreadIds: [], threadsCursor: null,
    threadsLoading: false, threadsRequestVersion: 0, selected: { id: "selected" },
  };
  const elements = Object.fromEntries(["threadCount", "threadSearch", "threadList", "loadMoreThreads"].map((id) => [id, node()]));
  const context = vm.createContext({
    state, elements, api, URLSearchParams, THREAD_PAGE_SIZE: 30, document: { createElement: node },
    t, titleOf: (thread) => thread.name, dateOf: () => "date", isThreadActive: () => false,
    threadData: (result) => result?.data || [], hideBanner() {},
    showBanner: (message) => { throw new Error(message); }, errorInfo: (error) => ({ message: error.message }),
    selectThread: async (thread) => { state.selected = thread; }, listState: () => node(),
  });
  vm.runInContext(appSource.slice(appSource.indexOf("function renderThreads()"), appSource.indexOf("function renderThreadClientSwitch()")), context);
  return { context, state, elements };
}

test("mobile renders old pins first, deduplicates pagination, and replaces pins after desktop changes", async () => {
  const old = { id: "old", name: "Old pin" };
  const recent = { id: "recent", name: "Recent" };
  let pins = [old, recent];
  const calls = [];
  const { context, state, elements } = browserFixture(async (url) => {
    calls.push(url);
    if (url.startsWith("/api/pinned-threads?")) return { data: pins };
    if (url.includes("cursor=")) return { data: [old, { id: "older", name: "Older" }], nextCursor: null };
    return { data: [recent, { id: "normal", name: "Normal" }], nextCursor: "more" };
  });
  await context.loadThreads();
  assert.deepEqual(Array.from(state.threads, (thread) => thread.id), ["old", "recent", "normal"]);
  assert.deepEqual(elements.threadList.children.map((group) => group.attributes["aria-label"]), [t("threads.pinned"), t("threads.recent")]);
  assert.equal(elements.threadList.children[0].children[1].children[0].children[0].textContent, "Old pin");
  await context.loadThreads({ append: true });
  assert.deepEqual(Array.from(state.threads, (thread) => thread.id), ["old", "recent", "normal", "older"]);
  assert.equal(calls.filter((url) => url.startsWith("/api/pinned-threads?")).length, 1);
  pins = [recent];
  await context.loadThreads({ refresh: true });
  assert.deepEqual(Array.from(state.pinnedThreadIds), ["recent"]);
  assert.equal(state.threads.some((thread) => thread.id === "old"), false);
  assert.ok(calls.slice(-2).every((url) => url.includes("refresh=1")));
  assert.equal(state.selected.id, "selected");
  pins = [];
  await context.loadThreads({ refresh: true });
  assert.equal(elements.threadList.children[0].tag, "button");
});

test("search restricts both groups and a superseded request cannot restore stale pins", async () => {
  const pending = [];
  const { context, state, elements } = browserFixture((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const initial = context.loadThreads();
  elements.threadSearch.value = "Needle & value";
  const search = context.loadThreads();
  for (const request of pending.slice(2)) {
    assert.equal(new URL(request.url, "http://bridge").searchParams.get("search"), "Needle & value");
    request.resolve({ data: [], nextCursor: null });
  }
  await search;
  for (const request of pending.slice(0, 2)) request.resolve({ data: [{ id: "stale", name: "Stale" }] });
  await initial;
  assert.equal(state.threads.length, 0);
  assert.equal(state.pinnedThreadIds.length, 0);
  assert.equal(elements.threadList.children[0].textContent, t("threads.noMatches"));
});

test("a new page can still show history while the older bridge awaits restart", async () => {
  const { context, state } = browserFixture(async (url) => {
    if (url.startsWith("/api/pinned-threads?")) throw Object.assign(new Error("Not found"), { status: 404 });
    return { data: [{ id: "recent", name: "Recent" }], nextCursor: null };
  });
  await context.loadThreads();
  assert.deepEqual(Array.from(state.threads, (thread) => thread.id), ["recent"]);
  assert.equal(state.pinnedThreadIds.length, 0);
});

test("foreground return and reconnect reload both lists while preserving selection", async () => {
  const handlers = {};
  const calls = [];
  const context = vm.createContext({
    document: { hidden: false, addEventListener: (name, fn) => { handlers[name] = fn; } },
    window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    state: { eventStream: { stop() {}, start() {}, wake() {} } },
    refreshHealth() {}, syncSelectedThread() {}, pwaController: { checkForUpdate() {} },
    loadThreads: (options) => { calls.push(options); },
  });
  vm.runInContext(appSource.slice(appSource.indexOf('document.addEventListener("visibilitychange"'), appSource.indexOf('window.addEventListener("offline"')), context);
  handlers.visibilitychange();
  handlers.online();
  context.document.hidden = true;
  handlers.visibilitychange();
  assert.deepEqual(calls.map(({ preserveSelection, refresh }) => [preserveSelection, refresh]), [[true, true], [true, true]]);
});

test("event stream reconnect refreshes desktop pins without doubling the initial load", () => {
  const calls = [];
  const context = vm.createContext({
    state: { connection: "connecting", snapshot: null },
    EventStreamController: class {
      constructor(options) { this.options = options; }
      start() {}
    },
    setConnection(connection) { context.state.connection = connection; },
    loadThreads: (options) => { calls.push(options); }, syncSelectedThread() {}, handleEvent() {},
  });
  vm.runInContext(appSource.slice(appSource.indexOf("function connectEvents()"), appSource.indexOf('elements.menuButton.addEventListener')), context);
  context.connectEvents();
  context.state.eventStream.options.onOpen();
  assert.equal(calls.length, 0);
  context.state.connection = "offline";
  context.state.eventStream.options.onOpen();
  assert.deepEqual(calls.map(({ preserveSelection, refresh }) => [preserveSelection, refresh]), [[true, true]]);
});

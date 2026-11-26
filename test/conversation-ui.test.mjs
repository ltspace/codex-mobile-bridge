import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { compactTurnPage } from "../src/mobile-history.mjs";
import * as formatters from "../public/modules/formatters.js";
import { createMessageView } from "../public/modules/messages.js";
import { state as initialState } from "../public/modules/state.js";
import { t } from "../public/modules/i18n.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const messagesSource = (await readFile(new URL("../public/modules/messages.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export function", "function");

function navigation({ positions = [40, 400, 800], scrollTop = 500, onLoadOlder, state = {} } = {}) {
  const targets = [];
  const elements = {
    messages: {
      scrollTop, scrollHeight: 1600, clientHeight: 400,
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
      querySelectorAll(selector) {
        assert.equal(selector, ".message.user:not(.queued)");
        return positions.map((position) => ({
          getBoundingClientRect: () => ({ top: 100 + position - elements.messages.scrollTop }),
        }));
      },
      scrollTo(options) { targets.push(options); this.scrollTop = options.top; },
    },
    scrollBottom: { classList: { toggle() {} } },
    scrollQuestion: { classList: { toggle(_, hidden) { elements.scrollQuestion.hidden = hidden; } } },
  };
  return { elements, targets, view: createMessageView({ elements, state, onLoadOlder }) };
}

test("question navigation goes upward from the viewport and consecutive clicks reach earlier questions", async () => {
  const { view, targets, elements } = navigation();
  await view.scrollToPreviousQuestion();
  assert.equal(targets[0].top, 388, "select the question at 400, not the newest question at 800");
  await view.scrollToPreviousQuestion();
  assert.equal(targets[1].top, 28, "skip the question already aligned near the top");
  assert.equal(elements.scrollQuestion.hidden, true);
  await view.scrollToPreviousQuestion();
  assert.equal(targets.length, 2, "no forward jump when there is no earlier question");
});

test("question navigation handles a partly clipped question and never targets a question below the viewport top", async () => {
  for (const [scrollTop, target] of [[410, 388], [400, 28], [399, 28], [900, 788]]) {
    const { view, targets } = navigation({ scrollTop });
    await view.scrollToPreviousQuestion();
    assert.equal(targets[0].top, target);
  }
  for (const positions of [[], [500, 800]]) {
    const { view, targets, elements } = navigation({ positions, scrollTop: 500 });
    view.updateScrollControls();
    assert.equal(elements.scrollQuestion.hidden, true);
    await view.scrollToPreviousQuestion();
    assert.equal(targets.length, 0);
  }
});

test("question navigation loads older pages when necessary and stops on failed pagination or selection changes", async () => {
  for (const outcome of ["loaded", "failed", "switched"]) {
    const state = { historyCursor: "older", selectionVersion: 1 };
    const positions = [400, 800];
    let loads = 0;
    const { view, targets, elements } = navigation({ positions, scrollTop: 388, state, onLoadOlder: async () => {
      loads += 1;
      if (outcome === "failed") return;
      positions.unshift(40);
      state.historyCursor = null;
      if (outcome === "switched") state.selectionVersion += 1;
    } });
    view.updateScrollControls();
    assert.equal(elements.scrollQuestion.hidden, false, "earlier unloaded history keeps the button available");
    await view.scrollToPreviousQuestion();
    assert.equal(loads, 1);
    assert.equal(targets.length, outcome === "loaded" ? 1 : 0);
    if (outcome === "loaded") assert.equal(targets[0].top, 28);
  }
});

test("changing conversations allows a new jump while the previous jump waits for history", async () => {
  const state = { historyCursor: "older", selectionVersion: 1 };
  const positions = [400, 800];
  let finishOlder;
  const { view, targets } = navigation({ positions, scrollTop: 388, state, onLoadOlder: () => new Promise((resolve) => {
    finishOlder = resolve;
  }) });
  const stale = view.scrollToPreviousQuestion();
  state.selectionVersion += 1;
  state.historyCursor = null;
  positions.unshift(40);
  await view.scrollToPreviousQuestion();
  finishOlder();
  await stale;
  assert.deepEqual(targets.map(({ top }) => top), [28]);
});

test("loading older turns ignores a stale response and uses the current viewport for prepending", async () => {
  const state = { selected: { id: "first" }, selectionVersion: 1, historyCursor: "first-page", historyItems: [] };
  const messages = { scrollHeight: 1000, scrollTop: 100 };
  const requests = [];
  const viewports = [];
  const context = vm.createContext({
    state, elements: { messages }, TURN_PAGE_SIZE: 10,
    api: (url) => new Promise((resolve) => requests.push({ url, resolve })),
    entriesFromTurns: (result) => result.data,
    renderMessages: ({ previousHeight, previousTop }) => viewports.push([previousHeight, previousTop]),
  });
  vm.runInContext(app.slice(app.indexOf("async function loadOlderTurns()"), app.indexOf("async function loadItemDetail(")), context);
  const first = context.loadOlderTurns();

  state.selected = { id: "second" };
  state.selectionVersion += 1;
  state.historyLoading = false;
  state.historyCursor = "second-page";
  state.historyItems = [{ id: "newer" }];
  const second = context.loadOlderTurns();
  assert.match(requests[0].url, /\/first\/turns\?limit=10&cursor=first-page$/);
  assert.match(requests[1].url, /\/second\/turns\?limit=10&cursor=second-page$/);

  requests[0].resolve({ data: [{ id: "from-first" }], nextCursor: "stale" });
  await first;
  assert.equal(state.historyLoading, true);
  assert.equal(state.historyCursor, "second-page");

  messages.scrollHeight = 1400;
  messages.scrollTop = 225;
  requests[1].resolve({ data: [{ id: "older" }, { id: "newer" }], nextCursor: null });
  await second;
  assert.equal(state.historyLoading, false);
  assert.deepEqual(Array.from(state.historyItems, (entry) => entry.id), ["older", "newer"]);
  assert.deepEqual(viewports, [[1000, 100], [1000, 100], [1400, 225]]);
});

const failures = [
  { message: "You've hit your usage limit. Try again at 14:00.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null },
  { message: "This model is unavailable.", codexErrorInfo: "modelNotFound", additionalDetails: "Choose another model to continue." },
];

test("native failed and interrupted turn history renders the full error after its conversation messages", () => {
  for (const [index, error] of failures.entries()) {
    const page = compactTurnPage({ data: [
      { id: "newer", status: "completed", items: [{ id: "next", type: "userMessage", text: "Continue" }] },
      { id: "failed", status: index ? "interrupted" : "failed", error, items: [
        { id: "question", type: "userMessage", text: "Run the task" },
        { id: "partial", type: "agentMessage", text: "Starting..." },
      ] },
    ] });
    const entries = formatters.entriesFromTurns(page);
    assert.deepEqual(entries.map((entry) => entry.id), ["question", "partial", "turn-error:failed", "next"]);
    assert.equal(entries[2].role, "error");
    assert.equal(entries[2].pending, false);
    assert.equal(entries[2].text, error.message + (error.additionalDetails ? `\n\n${error.additionalDetails}` : ""));
  }
  assert.equal(formatters.turnErrorEntry({ id: "failed", status: "failed" }).text, t("turn.codexFailed"));
  assert.equal(formatters.turnErrorEntry({ id: "stopped", status: "interrupted" }), null);
});

function browser() {
  const state = structuredClone(initialState);
  state.selected = { id: "thread", status: { type: "active" } };
  state.threads = [state.selected];
  state.activeTurns.thread = "turn";
  state.activeTurnId = "turn";
  state.latestTurnId = "turn";
  state.busy = true;
  state.historyItems = [{ id: "partial", turnId: "turn", role: "agent", text: "Starting...", pending: true }];
  state.streaming.set("partial", state.historyItems[0]);
  let renders = 0;
  const context = vm.createContext({
    state, ...formatters, t,
    archivingThreadId: null,
    elements: { chatTitle: {}, messages: { scrollTop: 75 } },
    renderThreads() {}, updateTurnState() {}, syncSelectedThread() {}, loadThreads() {},
    isNearBottom: () => false, setTimeout() {},
    renderMessages() { renders += 1; context.elements.messages.scrollTop = 1000; },
  });
  vm.runInContext(app.slice(app.indexOf("function handleEvent("), app.indexOf("function renderRequests(")), context);
  vm.runInContext(app.slice(app.indexOf("function mergeTurnDelta("), app.indexOf("async function syncSelectedThread(")), context);
  return { context, state, renders: () => renders };
}

test("live terminal errors appear immediately, deduplicate completion events and survive automatic history reconciliation", () => {
  const { context, state, renders } = browser();
  context.handleEvent({ method: "error", params: { threadId: "thread", turnId: "turn", error: failures[0], willRetry: false } });
  assert.equal(state.historyItems.length, 2);
  assert.equal(state.historyItems[1].text, failures[0].message);
  assert.equal(state.historyItems[0].pending, false);
  assert.equal(context.elements.messages.scrollTop, 75, "a reader looking at older text keeps their position");
  assert.equal(renders(), 1);
  context.handleEvent({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "failed", error: null } } });
  assert.equal(state.historyItems.length, 2);
  assert.equal(state.historyItems[1].text, failures[0].message, "a sparse completion cannot replace the reason with a fallback");
  assert.equal(state.busy, false);
  assert.equal(state.streaming.size, 0);
  for (const resetRequired of [false, true]) {
    context.mergeTurnDelta({ resetRequired, data: [{ id: "turn", status: "failed", error: null, items: [] }] });
    assert.equal(state.historyItems.length, 1);
    assert.equal(state.historyItems[0].text, failures[0].message);
  }
  context.mergeTurnDelta({ data: [{ id: "turn", status: "failed", error: failures[1], items: [] }] });
  assert.equal(state.historyItems.length, 1);
  assert.match(state.historyItems[0].text, /Choose another model/);
});

test("completion-only failures are visible, while transient retries and other-thread errors do not enter this conversation", () => {
  const { context, state } = browser();
  for (const params of [
    { threadId: "other", turnId: "turn", error: failures[0], willRetry: false },
    { threadId: "thread", turnId: "turn", error: failures[0], willRetry: true },
    { turnId: "turn", error: failures[0], willRetry: false },
  ]) context.handleEvent({ method: "error", params });
  assert.equal(state.historyItems.length, 1);
  context.handleEvent({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted", error: failures[1] } } });
  assert.equal(state.historyItems.length, 2);
  assert.match(state.historyItems[1].text, /This model is unavailable/);
});

function node(tagName = "div") {
  return {
    tagName, children: [], dataset: {}, className: "", textContent: "",
    classList: { add() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, setAttribute() {}, querySelectorAll: () => [],
  };
}

test("failure cards show their text expanded and safely, and prepending history preserves the full scroll offset", () => {
  const elements = {
    messages: {
      ...node(), scrollTop: 50, scrollHeight: 1500, clientHeight: 400,
      getBoundingClientRect: () => ({ top: 100 }),
      scrollTo({ top, behavior }) {
        assert.equal(behavior, "instant");
        this.scrollTop = top;
      },
    },
    scrollBottom: node(), scrollQuestion: node(),
  };
  const state = { selected: { id: "thread" }, queuedMessages: [], historyItems: [
    formatters.turnErrorEntry({ id: "turn", error: { message: "<img src=x onerror=alert(1)>" } }),
    { id: "send-error", role: "error", type: "sendError", text: "Model unavailable" },
  ] };
  const context = vm.createContext({ document: { createElement: node }, elements, state, t });
  vm.runInContext(messagesSource, context);
  vm.runInContext("createMessageView({ elements, state }).renderMessages({ preserveTop: true, previousHeight: 1000, previousTop: 250 })", context);
  assert.equal(elements.messages.scrollTop, 750);
  for (const [index, label] of [t("turn.failed"), t("message.sendFailed")].entries()) {
    const card = elements.messages.children[index];
    assert.equal(card.tagName, "article", "error content is not collapsed tool details");
    assert.equal(card.className, "message error");
    assert.equal(card.children[0].children[0].textContent, label);
    assert.equal(card.children[1].children[0].tagName, "p");
    assert.equal(card.children[1].children[0].textContent, state.historyItems[index].text);
  }
});

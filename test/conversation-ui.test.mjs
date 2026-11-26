import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { compactTurnPage } from "../src/mobile-history.mjs";
import * as formatters from "../public/modules/formatters.js";
import { state as initialState } from "../public/modules/state.js";
import { t } from "../public/modules/i18n.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const messagesSource = (await readFile(new URL("../public/modules/messages.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export function", "function");

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

test("failure cards show their text expanded and safely", () => {
  const elements = {
    messages: { ...node(), scrollTop: 50, scrollHeight: 1500, clientHeight: 400, getBoundingClientRect: () => ({ top: 100 }) },
    scrollBottom: node(), scrollQuestion: node(),
  };
  const state = { selected: { id: "thread" }, queuedMessages: [], historyItems: [
    formatters.turnErrorEntry({ id: "turn", error: { message: "<img src=x onerror=alert(1)>" } }),
    { id: "send-error", role: "error", type: "sendError", text: "Model unavailable" },
  ] };
  const context = vm.createContext({ document: { createElement: node }, elements, state, t });
  vm.runInContext(messagesSource, context);
  vm.runInContext("createMessageView({ elements, state }).renderMessages({ preserveTop: true, previousHeight: 1500 })", context);
  for (const [index, label] of [t("turn.failed"), t("message.sendFailed")].entries()) {
    const card = elements.messages.children[index];
    assert.equal(card.tagName, "article", "error content is not collapsed tool details");
    assert.equal(card.className, "message error");
    assert.equal(card.children[0].children[0].textContent, label);
    assert.equal(card.children[1].children[0].tagName, "p");
    assert.equal(card.children[1].children[0].textContent, state.historyItems[index].text);
  }
});

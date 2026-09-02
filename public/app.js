import { api, errorInfo } from "./modules/api.js";
import { elements } from "./modules/elements.js";
import {
  dateOf,
  entriesFromTurns,
  eventThreadId,
  eventTurnId,
  latestTurnId,
  statusType,
  textFrom,
  threadData,
  threadObject,
  titleOf,
} from "./modules/formatters.js";
import { createMessageView } from "./modules/messages.js";
import { EventStreamController } from "./modules/event-stream.js";
import { state } from "./modules/state.js";
import { hasStoredLanguage, language, setLanguage, t, toggleLanguage, translateDocument } from "./modules/i18n.js";
import { createPwaController } from "./modules/pwa.js";

translateDocument(document);

const THEME_STORAGE_KEY = "codexBridge.theme";

function syncThemeButton() {
  const isLight = document.documentElement.dataset.theme === "light";
  const label = t(isLight ? "theme.useDark" : "theme.useLight");
  for (const button of [elements.themeButton, elements.drawerThemeButton]) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  elements.drawerThemeText.textContent = label;
}

function setTheme(theme, { persist = true } = {}) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#ffffff" : "#0b0d12");
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute("content", next === "light" ? "default" : "black-translucent");
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
  }
  syncThemeButton();
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

setTheme(document.documentElement.dataset.theme, { persist: false });

const THREAD_PAGE_SIZE = 30;
const TURN_PAGE_SIZE = 10;
const compactActionLayout = matchMedia("(max-width: 520px)");
let recentWorkspaces = [];
let activeWorkspaceIndex = -1;
let archivingThreadId = null;

const { emptyState, isNearBottom, renderMessages, renderEntryBody, scrollToBottom } = createMessageView({
  elements,
  state,
  toast,
  onLoadOlder: () => loadOlderTurns(),
  onLoadDetail: (entry) => loadItemDetail(entry),
});

const pendingStreamRenders = new Map();
let streamRenderFrame = null;

function scheduleStreamRender(body, entry) {
  pendingStreamRenders.set(body, entry);
  if (streamRenderFrame != null) return;
  streamRenderFrame = requestAnimationFrame(() => {
    streamRenderFrame = null;
    for (const [target, pendingEntry] of pendingStreamRenders) {
      if (target.isConnected) renderEntryBody(target, pendingEntry);
    }
    pendingStreamRenders.clear();
  });
}

function isThreadActive(thread) {
  return Boolean(state.activeTurns[thread?.id]) || statusType(thread) === "active";
}

function setConnection(connection, ready = state.ready) {
  state.connection = connection;
  state.ready = ready;
  elements.connectionButton.className = `connection-pill ${connection}`;
  elements.connectionText.textContent = connection === "online" ? t("connection.online") : connection === "offline" ? t("connection.offline") : t("connection.connecting");
  updateComposer();
}

function syncSnapshot(snapshot) {
  if (!snapshot) return;
  const previousInstanceId = state.snapshot?.eventStream?.instanceId;
  if (!hasStoredLanguage() && snapshot.uiLanguage && snapshot.uiLanguage !== language()) {
    setLanguage(snapshot.uiLanguage, { persist: false, notify: false });
  }
  state.snapshot = snapshot;
  state.ready = Boolean(snapshot.ready);
  state.activeTurns = snapshot.activeTurns || {};
  state.queuedByThread = snapshot.drafts?.queuedByThread || {};
  elements.bridgeVersion.textContent = snapshot.version ? `v${snapshot.version}` : t("app.subtitle");
  syncSelectedActivity();
  renderThreads();
  updateComposer();
  const resume = snapshot.eventStream?.resume;
  if (state.selected && (resume?.gap || (previousInstanceId && previousInstanceId !== snapshot.eventStream?.instanceId))) {
    void syncSelectedThread();
  }
}

function syncSelectedActivity() {
  const selectedId = state.selected?.id;
  const turnId = selectedId ? state.activeTurns[selectedId] || null : null;
  state.activeTurnId = turnId;
  state.busy = Boolean(turnId) || isThreadActive(state.selected);
  updateTurnState();
}

function updateTurnState(kind = null, label = null) {
  const active = kind || (state.busy ? "running" : "idle");
  const text = label || (state.busy ? (state.activeTurnId ? t("turn.running") : t("turn.runningElsewhere")) : t("turn.idle"));
  elements.turnState.className = `turn-state ${active}`;
  elements.turnState.querySelector("b").textContent = text;
  updateComposer();
}

function showBanner(message, { error = true, retry = null } = {}) {
  elements.banner.className = `banner${error ? " error" : ""}`;
  elements.bannerText.textContent = message;
  state.retryAction = retry;
  elements.bannerRetry.classList.toggle("hidden", typeof retry !== "function");
}

function hideBanner() {
  elements.banner.classList.add("hidden");
  state.retryAction = null;
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 1800);
}

const pwaController = createPwaController();

function openDrawer() {
  closeActionDrawer();
  document.body.classList.add("drawer-open");
  elements.drawerBackdrop.classList.remove("hidden");
  elements.menuButton.setAttribute("aria-expanded", "true");
}

function openActionDrawer() {
  if (!compactActionLayout.matches) return;
  closeDrawer();
  document.body.classList.add("action-drawer-open");
  elements.actionDrawer.inert = false;
  elements.actionDrawer.setAttribute("aria-hidden", "false");
  elements.actionDrawerBackdrop.classList.remove("hidden");
  elements.actionMenuButton.setAttribute("aria-expanded", "true");
}

function closeActionDrawer({ restoreFocus = false } = {}) {
  const wasOpen = document.body.classList.contains("action-drawer-open");
  document.body.classList.remove("action-drawer-open");
  elements.actionDrawer.inert = true;
  elements.actionDrawer.setAttribute("aria-hidden", "true");
  elements.actionDrawerBackdrop.classList.add("hidden");
  elements.actionMenuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus && wasOpen) elements.actionMenuButton.focus();
}

function closeDrawer() {
  document.body.classList.remove("drawer-open");
  elements.drawerBackdrop.classList.add("hidden");
  elements.menuButton.setAttribute("aria-expanded", "false");
}

function renderThreads() {
  elements.threadCount.textContent = t("threads.count", { count: state.threads.length });
  const nodes = state.threads.map((thread) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${state.selected?.id === thread.id ? " active" : ""}`;
    const line = document.createElement("span");
    line.className = "thread-line";
    const title = document.createElement("span");
    title.className = "thread-title";
    title.textContent = titleOf(thread);
    line.append(title);
    if (isThreadActive(thread)) {
      const activity = document.createElement("span");
      activity.className = "thread-activity";
      activity.title = t("threads.running");
      line.append(activity);
    }
    const meta = document.createElement("span");
    meta.className = "thread-meta";
    meta.textContent = dateOf(thread) || t("threads.unknownTime");
    const cwd = document.createElement("span");
    cwd.className = "thread-meta thread-cwd";
    cwd.textContent = thread.cwd || t("threads.noCwd");
    button.append(line, meta, cwd);
    button.addEventListener("click", () => selectThread(thread));
    return button;
  });
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "list-state";
    empty.textContent = elements.threadSearch.value.trim() ? t("threads.noMatches") : t("threads.none");
    nodes.push(empty);
  }
  elements.threadList.replaceChildren(...nodes);
  elements.loadMoreThreads.classList.toggle("hidden", !state.threadsCursor);
  elements.loadMoreThreads.disabled = state.threadsLoading;
  elements.loadMoreThreads.textContent = state.threadsLoading ? t("actions.loading") : t("actions.loadMore");
}

async function loadThreads({ append = false, preserveSelection = true } = {}) {
  if (state.threadsLoading) return;
  state.threadsLoading = true;
  if (!append) {
    state.threadsCursor = null;
    if (!state.threads.length) elements.threadList.replaceChildren(listState(t("threads.loading")));
  }
  renderThreads();
  try {
    const query = new URLSearchParams({ limit: String(THREAD_PAGE_SIZE) });
    const search = elements.threadSearch.value.trim();
    if (search) query.set("search", search);
    if (append && state.threadsCursor) query.set("cursor", state.threadsCursor);
    const result = await api(`/api/threads?${query}`);
    const incoming = threadData(result);
    const merged = append ? [...state.threads, ...incoming] : incoming;
    state.threads = [...new Map(merged.map((thread) => [thread.id, thread])).values()];
    state.threadsCursor = result.nextCursor || null;
    hideBanner();
    if (!preserveSelection || !state.selected) {
      if (state.threads[0]) await selectThread(state.threads[0]);
    } else {
      const fresh = state.threads.find((thread) => thread.id === state.selected.id);
      if (fresh) state.selected = { ...state.selected, ...fresh };
    }
  } catch (error) {
    const info = errorInfo(error);
    showBanner(info.message, { retry: info.retryable ? () => loadThreads({ append }) : null });
  } finally {
    state.threadsLoading = false;
    renderThreads();
  }
}

function listState(text) {
  const node = document.createElement("div");
  node.className = "list-state";
  node.textContent = text;
  return node;
}

async function selectThread(summary, { isNew = false, silent = false } = {}) {
  const version = ++state.selectionVersion;
  state.selected = summary;
  state.historyItems = [];
  state.historyCursor = null;
  state.latestTurnId = null;
  state.streaming.clear();
  syncSelectedActivity();
  renderThreads();
  renderRequests();
  closeDrawer();
  elements.chatTitle.textContent = titleOf(summary);
  elements.chatMeta.textContent = summary.cwd || t("threads.noCwd");
  elements.messageInput.value = localStorage.getItem(draftKey(summary.id)) || "";
  resizeComposer();
  if (isNew) {
    renderMessages();
    elements.messageInput.focus();
    updateComposer();
    return;
  }
  if (!silent) elements.messages.replaceChildren(emptyState(t("threads.reading"), t("threads.recentTurns"), "⋯"));
  try {
    const [turnsResult, threadResult] = await Promise.all([
      api(`/api/threads/${encodeURIComponent(summary.id)}/turns?limit=${TURN_PAGE_SIZE}`, { timeoutMs: 45_000 }),
      api(`/api/threads/${encodeURIComponent(summary.id)}`),
    ]);
    if (version !== state.selectionVersion) return;
    state.selected = { ...summary, ...threadObject(threadResult) };
    state.historyItems = entriesFromTurns(turnsResult);
    state.historyCursor = turnsResult.nextCursor || null;
    state.latestTurnId = latestTurnId(turnsResult);
    syncSelectedActivity();
    elements.chatTitle.textContent = titleOf(state.selected);
    elements.chatMeta.textContent = state.selected.cwd || t("threads.noCwd");
    hideBanner();
    renderMessages();
  } catch (error) {
    if (version !== state.selectionVersion) return;
    const info = errorInfo(error);
    showBanner(info.message, { retry: info.retryable ? () => selectThread(summary) : null });
    if (!silent) renderMessages();
  } finally {
    updateComposer();
  }
}

async function loadOlderTurns() {
  if (state.historyLoading || !state.historyCursor || !state.selected) return;
  state.historyLoading = true;
  const previousHeight = elements.messages.scrollHeight;
  renderMessages({ preserveTop: true, previousHeight });
  try {
    const cursor = encodeURIComponent(state.historyCursor);
    const result = await api(`/api/threads/${encodeURIComponent(state.selected.id)}/turns?limit=${TURN_PAGE_SIZE}&cursor=${cursor}`, { timeoutMs: 45_000 });
    const known = new Set(state.historyItems.map((entry) => entry.id));
    const older = entriesFromTurns(result).filter((entry) => !known.has(entry.id));
    state.historyItems = [...older, ...state.historyItems];
    state.historyCursor = result.nextCursor || null;
  } catch (error) {
    const info = errorInfo(error);
    showBanner(info.message, { retry: info.retryable ? loadOlderTurns : null });
  } finally {
    state.historyLoading = false;
    renderMessages({ preserveTop: true, previousHeight });
  }
}

async function loadItemDetail(entry) {
  if (!state.selected || !entry?.turnId || !entry?.id) return null;
  const threadId = encodeURIComponent(state.selected.id);
  const turnId = encodeURIComponent(entry.turnId);
  const itemId = encodeURIComponent(entry.id);
  const result = await api(`/api/threads/${threadId}/turns/${turnId}/items/${itemId}`, { timeoutMs: 45_000 });
  const text = textFrom(result?.item);
  if (text) entry.text = text;
  entry.detailAvailable = false;
  return text;
}

function mergeTurnDelta(result) {
  const incoming = entriesFromTurns(result);
  if (result.resetRequired || !state.latestTurnId) {
    state.historyItems = incoming;
    state.historyCursor = result.nextCursor || null;
  } else {
    const turnIds = new Set(incoming.map((entry) => entry.turnId).filter(Boolean));
    const preserved = state.historyItems.filter((entry) => !entry.turnId || !turnIds.has(entry.turnId));
    state.historyItems = [...preserved, ...incoming];
  }
  state.latestTurnId = latestTurnId(result) || state.latestTurnId;
  state.streaming.clear();
}

async function syncSelectedThread() {
  if (!state.selected) return;
  if (state.historySyncPromise) {
    state.historySyncQueued = true;
    return state.historySyncPromise;
  }
  const selectedId = state.selected.id;
  const version = state.selectionVersion;
  const knownTurnId = state.latestTurnId || "";
  state.historySyncPromise = (async () => {
    const query = new URLSearchParams({ limit: String(TURN_PAGE_SIZE) });
    if (knownTurnId) query.set("knownTurnId", knownTurnId);
    const result = await api(`/api/threads/${encodeURIComponent(selectedId)}/sync?${query}`, { timeoutMs: 45_000 });
    if (version !== state.selectionVersion || selectedId !== state.selected?.id) return;
    const nearBottom = isNearBottom();
    const previousHeight = elements.messages.scrollHeight;
    const previousTop = elements.messages.scrollTop;
    mergeTurnDelta(result);
    renderMessages();
    if (!nearBottom) elements.messages.scrollTop = previousTop + (elements.messages.scrollHeight - previousHeight);
  })().catch((error) => {
    const info = errorInfo(error);
    if (info.retryable) showBanner(info.message, { retry: () => syncSelectedThread() });
  }).finally(() => {
    state.historySyncPromise = null;
    if (state.historySyncQueued) {
      state.historySyncQueued = false;
      void syncSelectedThread();
    }
  });
  return state.historySyncPromise;
}

function draftKey(threadId) {
  return `codexBridge.draft.${threadId}`;
}

function updateComposer() {
  const selected = Boolean(state.selected);
  const canConnect = state.ready && state.connection !== "offline";
  elements.messageInput.disabled = !selected || !canConnect || state.submitting;
  elements.sendButton.disabled = elements.messageInput.disabled || !elements.messageInput.value.trim();
  elements.sendButton.textContent = state.busy ? t("actions.queue") : t("actions.send");
  elements.stopButton.classList.toggle("hidden", !state.busy || !state.activeTurnId);
  elements.stopButton.disabled = state.submitting;
  if (!selected) elements.composerHint.textContent = t("composer.select");
  else if (!canConnect) elements.composerHint.textContent = t("composer.disconnected");
  else if (state.busy && !state.activeTurnId) elements.composerHint.textContent = t("composer.otherClientQueue");
  else if (state.busy) elements.composerHint.textContent = t("composer.queueHint");
  else elements.composerHint.textContent = t("composer.keyboardHint");
  updateArchiveActions();
}

function updateArchiveActions() {
  const threadId = state.selected?.id;
  const queued = threadId ? Number(state.queuedByThread[threadId] || 0) : 0;
  const disabled = !threadId || state.busy || state.submitting || queued > 0;
  elements.archiveThreadButton.disabled = disabled;
  elements.drawerArchiveThreadButton.disabled = disabled;
}

function resizeComposer() {
  const input = elements.messageInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(180, Math.max(44, input.scrollHeight))}px`;
  updateComposer();
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.selected || state.submitting) return;
  const text = elements.messageInput.value.trim();
  if (!text) return;
  const threadId = state.selected.id;
  const mode = state.busy ? "queue" : "start";
  const entry = { id: `local:${Date.now()}`, turnId: null, role: "user", text, type: mode === "queue" ? t("message.queued") : "userMessage", pending: true };
  state.historyItems.push(entry);
  elements.messageInput.value = "";
  localStorage.removeItem(draftKey(threadId));
  resizeComposer();
  renderMessages();
  state.submitting = true;
  updateComposer();
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/send`, {
      method: "POST",
      body: JSON.stringify({ text, mode, expectedTurnId: state.activeTurnId }),
      timeoutMs: 45_000,
    });
    entry.pending = false;
    if (result?.mode === "start") {
      const turnId = result?.turn?.id || null;
      if (turnId) {
        entry.turnId = turnId;
        state.activeTurnId = turnId;
        state.activeTurns[threadId] = turnId;
      }
      state.busy = true;
      updateTurnState();
    } else if (result?.mode === "queue") {
      entry.type = t("message.queued");
      state.queuedByThread[threadId] = Math.max(Number(state.queuedByThread[threadId] || 0), Number(result.position || 1));
      toast(t("toast.queued", { position: result.position || 1 }));
    } else {
      toast(t("toast.steered"));
    }
    renderMessages();
  } catch (error) {
    const info = errorInfo(error);
    entry.pending = false;
    state.historyItems.push({ id: `error:${Date.now()}`, role: "tool", text: info.message, type: t("message.sendFailed"), pending: false });
    if (info.code === "turn_active" && info.details?.turnId) {
      state.activeTurnId = info.details.turnId;
      state.activeTurns[threadId] = info.details.turnId;
      state.busy = true;
      updateTurnState();
    }
    elements.messageInput.value = text;
    localStorage.setItem(draftKey(threadId), text);
    resizeComposer();
    showBanner(info.message, { retry: info.retryable ? () => elements.composer.requestSubmit() : null });
    renderMessages();
  } finally {
    state.submitting = false;
    updateComposer();
    elements.messageInput.focus();
  }
}

async function stopTurn() {
  if (!state.selected || !state.activeTurnId || state.submitting) return;
  state.submitting = true;
  updateComposer();
  try {
    await api(`/api/threads/${encodeURIComponent(state.selected.id)}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ turnId: state.activeTurnId }),
    });
    toast(t("toast.stopSent"));
  } catch (error) {
    showBanner(errorInfo(error).message);
  } finally {
    state.submitting = false;
    updateComposer();
  }
}

function clearSelectedThread() {
  state.selectionVersion += 1;
  state.selected = null;
  state.historyItems = [];
  state.historyCursor = null;
  state.latestTurnId = null;
  state.activeTurnId = null;
  state.busy = false;
  state.streaming.clear();
  elements.chatTitle.textContent = t("threads.select");
  elements.chatMeta.textContent = t("threads.selectHelp");
  renderMessages();
  renderRequests();
  updateTurnState();
}

async function archiveSelectedThread() {
  const selected = state.selected;
  if (!selected || elements.archiveThreadButton.disabled || archivingThreadId) return;
  if (!window.confirm(t("archive.confirm", { title: titleOf(selected) }))) return;
  const threadId = selected.id;
  archivingThreadId = threadId;
  state.submitting = true;
  closeActionDrawer();
  updateComposer();
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/archive`, { method: "POST" });
    state.threads = state.threads.filter((thread) => thread.id !== threadId);
    delete state.queuedByThread[threadId];
    try { localStorage.removeItem(draftKey(threadId)); } catch {}
    if (state.selected?.id === threadId) clearSelectedThread();
    renderThreads();
    toast(t("toast.archived"));
    await loadThreads({ preserveSelection: false });
  } catch (error) {
    const info = errorInfo(error);
    showBanner(info.message, { retry: info.retryable ? archiveSelectedThread : null });
  } finally {
    archivingThreadId = null;
    state.submitting = false;
    updateComposer();
  }
}

function handleEvent(event) {
  const { method, params = {} } = event;
  if (method === "bridge/snapshot" || method === "bridge/state") {
    syncSnapshot(params);
    setConnection(params.ready ? "online" : "connecting", Boolean(params.ready));
    return;
  }
  if (method === "bridge/request") {
    state.requests.set(params.requestId, params);
    renderRequests();
    return;
  }
  if (method === "bridge/requestResolved") {
    state.requests.delete(params.requestId);
    renderRequests();
    return;
  }

  const threadId = eventThreadId(params);
  const turnId = eventTurnId(params);
  if (method === "bridge/messageQueued" && threadId) {
    state.queuedByThread[threadId] = Math.max(Number(state.queuedByThread[threadId] || 0), Number(params.position || 1));
    updateArchiveActions();
    return;
  }
  if (method === "bridge/messageDequeued" && threadId) {
    state.queuedByThread[threadId] = Number(params.remaining || 0);
    updateArchiveActions();
    return;
  }
  if (method === "thread/archived" && threadId && threadId !== archivingThreadId) {
    state.threads = state.threads.filter((thread) => thread.id !== threadId);
    if (state.selected?.id === threadId) {
      clearSelectedThread();
      void loadThreads({ preserveSelection: false });
    } else {
      renderThreads();
    }
    return;
  }
  if (method === "turn/started" && threadId && turnId) {
    state.activeTurns[threadId] = turnId;
    if (threadId === state.selected?.id) {
      state.activeTurnId = turnId;
      state.busy = true;
      updateTurnState();
    }
    renderThreads();
  }
  if (method === "thread/status/changed" && threadId === state.selected?.id) {
    const type = params.status?.type || params.status;
    if (type === "active") {
      state.busy = true;
      updateTurnState();
    } else if (type === "idle" || type === "notLoaded") {
      state.busy = false;
      state.activeTurnId = null;
      updateTurnState();
    }
  }
  if (threadId && state.selected && threadId !== state.selected.id) return;

  if (method.includes("agentMessage") && method.endsWith("delta")) {
    const delta = textFrom(params.delta ?? params);
    if (!delta) return;
    const itemId = params.itemId || `stream:${turnId || "current"}`;
    let entry = state.streaming.get(itemId);
    if (!entry) {
      entry = { id: itemId, turnId, role: "agent", text: "", type: "agentMessage", pending: true };
      state.streaming.set(itemId, entry);
      state.historyItems.push(entry);
      renderMessages();
    }
    entry.text += delta;
    const body = elements.messages.querySelector(`[data-entry-id="${CSS.escape(entry.id)}"] .message-body`);
    if (body) scheduleStreamRender(body, entry);
    if (isNearBottom()) scrollToBottom(false);
  }

  if (method === "turn/completed") {
    if (threadId) delete state.activeTurns[threadId];
    state.activeTurnId = null;
    state.busy = false;
    state.streaming.clear();
    const status = params.turn?.status || "completed";
    if (status === "failed") {
      const message = params.turn?.error?.message || t("turn.codexFailed");
      showBanner(message);
      updateTurnState("error", t("turn.failed"));
    } else {
      updateTurnState("idle", status === "interrupted" ? t("turn.stopped") : t("turn.completed"));
    }
    renderThreads();
    if (state.selected) setTimeout(() => syncSelectedThread(), 350);
  }
}

function renderRequests() {
  const visible = [...state.requests.values()].filter((request) => !request.threadId || request.threadId === state.selected?.id);
  elements.requests.replaceChildren(...visible.map(requestCard));
}

function requestCard(request) {
  const card = document.createElement("section");
  card.className = "request-card";
  const title = document.createElement("h3");
  title.textContent = request.kind === "approval" ? t("request.approval") : request.kind === "userInput" ? t("request.userInput") : t("request.pending");
  card.append(title);

  if (request.kind === "approval") {
    const message = document.createElement("p");
    const command = Array.isArray(request.command) ? request.command.join(" ") : request.command;
    message.textContent = command || request.reason || t("request.allowPrompt");
    card.append(message, actionRow([
      [t("actions.allow"), () => respondRequest(request.requestId, { decision: "accept" })],
      [t("actions.allowSession"), () => respondRequest(request.requestId, { decision: "acceptForSession" })],
      [t("actions.decline"), () => respondRequest(request.requestId, { decision: "decline" })],
    ]));
  } else if (request.kind === "userInput") {
    const form = document.createElement("form");
    for (const question of request.questions || []) form.append(questionField(request.requestId, question));
    form.append(actionRow([[t("actions.submit"), () => submitUserInput(request, form)]]));
    form.addEventListener("submit", (event) => { event.preventDefault(); submitUserInput(request, form); });
    card.append(form);
  } else {
    const message = document.createElement("p");
    message.textContent = t("request.unsupported", { method: request.method });
    card.append(message);
  }
  return card;
}

function actionRow(actions) {
  const row = document.createElement("div");
  row.className = "request-actions";
  for (const [label, handler] of actions) {
    const button = document.createElement("button");
    button.type = label === t("actions.submit") ? "submit" : "button";
    button.textContent = label;
    if (label === t("actions.allow") || label === t("actions.submit")) button.className = "primary";
    button.addEventListener("click", (event) => {
      if (button.type === "submit") return;
      event.preventDefault();
      handler();
    });
    row.append(button);
  }
  return row;
}

function questionField(requestId, question) {
  const field = document.createElement("fieldset");
  field.className = "request-question";
  field.dataset.questionId = question.id;
  const legend = document.createElement("strong");
  legend.textContent = question.header || t("request.question");
  const detail = document.createElement("small");
  detail.textContent = question.question;
  field.append(legend, detail);
  if (question.options?.length) {
    for (const [index, option] of question.options.entries()) {
      const label = document.createElement("label");
      label.className = "option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${requestId}:${question.id}`;
      input.value = option.label;
      input.required = true;
      if (index === 0) input.checked = true;
      const text = document.createElement("span");
      const main = document.createElement("b");
      main.textContent = option.label;
      const description = document.createElement("em");
      description.textContent = option.description;
      text.append(main, description);
      label.append(input, text);
      field.append(label);
    }
  } else {
    const input = document.createElement("input");
    input.type = question.isSecret ? "password" : "text";
    input.name = `${requestId}:${question.id}`;
    input.required = true;
    input.autocomplete = question.isSecret ? "off" : "on";
    field.append(input);
  }
  return field;
}

async function submitUserInput(request, form) {
  if (!form.reportValidity()) return;
  const answers = {};
  for (const question of request.questions || []) {
    const name = `${request.requestId}:${question.id}`;
    const input = form.elements.namedItem(name);
    const value = input instanceof RadioNodeList ? input.value : input?.value;
    answers[question.id] = [String(value || "")];
  }
  await respondRequest(request.requestId, { answers });
}

async function respondRequest(requestId, body) {
  try {
    await api(`/api/requests/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify(body) });
    state.requests.delete(requestId);
    renderRequests();
    toast(t("toast.submitted"));
  } catch (error) {
    showBanner(errorInfo(error).message);
  }
}

function workspaceOptionsOpen() {
  return !elements.workspaceOptions.classList.contains("hidden");
}

function setWorkspaceOptionsOpen(open) {
  const next = Boolean(open && recentWorkspaces.length);
  elements.workspaceOptions.classList.toggle("hidden", !next);
  elements.newCwd.setAttribute("aria-expanded", String(next));
  elements.workspaceToggle.setAttribute("aria-expanded", String(next));
  if (!next) activeWorkspaceIndex = -1;
}

function renderWorkspaceOptions() {
  elements.workspaceOptions.replaceChildren(...recentWorkspaces.map(({ cwd }, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `workspace-option${index === activeWorkspaceIndex ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(cwd === elements.newCwd.value));
    option.textContent = cwd;
    option.addEventListener("click", () => {
      elements.newCwd.value = cwd;
      setWorkspaceOptionsOpen(false);
      elements.workspaceToggle.focus();
    });
    return option;
  }));
}

function toggleWorkspaceOptions() {
  if (!recentWorkspaces.length) return;
  const open = !workspaceOptionsOpen();
  if (open) renderWorkspaceOptions();
  setWorkspaceOptionsOpen(open);
}

function moveWorkspaceSelection(offset) {
  if (!recentWorkspaces.length) return;
  if (!workspaceOptionsOpen()) setWorkspaceOptionsOpen(true);
  activeWorkspaceIndex = Math.max(0, Math.min(recentWorkspaces.length - 1, activeWorkspaceIndex + offset));
  renderWorkspaceOptions();
  elements.workspaceOptions.children[activeWorkspaceIndex]?.scrollIntoView({ block: "nearest" });
}

async function openNewThread() {
  elements.newThreadModal.classList.remove("hidden");
  setWorkspaceOptionsOpen(false);
  elements.newThreadHint.className = "form-hint";
  elements.newThreadHint.textContent = t("new.loadingWorkspaces");
  const remembered = localStorage.getItem("codexBridge.lastCwd") || state.selected?.cwd || "";
  try {
    const result = await api("/api/workspaces");
    recentWorkspaces = result.data || [];
    elements.newCwd.value = remembered || recentWorkspaces[0]?.cwd || "";
    renderWorkspaceOptions();
    elements.workspaceToggle.disabled = recentWorkspaces.length === 0;
    elements.newThreadHint.textContent = recentWorkspaces.length ? t("new.workspacesFound", { count: recentWorkspaces.length }) : t("new.enterAbsolute");
  } catch (error) {
    recentWorkspaces = [];
    renderWorkspaceOptions();
    elements.workspaceToggle.disabled = true;
    elements.newCwd.value = remembered;
    elements.newThreadHint.className = "form-hint error";
    elements.newThreadHint.textContent = errorInfo(error).message;
  }
  if (matchMedia("(pointer: fine)").matches) setTimeout(() => elements.newCwd.focus(), 0);
}

function closeNewThread() {
  setWorkspaceOptionsOpen(false);
  elements.newThreadModal.classList.add("hidden");
}

async function createThread(event) {
  event.preventDefault();
  const cwd = elements.newCwd.value.trim();
  if (!cwd) return;
  elements.createThreadButton.disabled = true;
  elements.newThreadHint.className = "form-hint";
  elements.newThreadHint.textContent = t("new.creating");
  try {
    const result = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({ cwd, ephemeral: elements.ephemeralThread.checked }),
      timeoutMs: 45_000,
    });
    const thread = threadObject(result);
    if (!thread.id) throw new Error(t("new.missingId"));
    localStorage.setItem("codexBridge.lastCwd", cwd);
    state.threads = [thread, ...state.threads.filter((item) => item.id !== thread.id)];
    closeNewThread();
    await selectThread(thread, { isNew: true });
  } catch (error) {
    elements.newThreadHint.className = "form-hint error";
    elements.newThreadHint.textContent = errorInfo(error).message;
  } finally {
    elements.createThreadButton.disabled = false;
  }
}

function statusRows(snapshot) {
  const appServer = snapshot?.appServer || {};
  const http = snapshot?.metrics?.http || {};
  const rpc = snapshot?.metrics?.rpc || {};
  return [
    [t("status.bridge"), snapshot?.ready ? `v${snapshot.version} · ${t("status.ready")}` : `v${snapshot?.version || "?"} · ${t("status.notReady")}`, snapshot?.ready],
    [t("status.uptime"), snapshot ? t("status.seconds", { count: snapshot.uptimeSeconds }) : t("status.unknown"), true],
    [t("status.appServer"), `${appServer.status || t("status.unknown")}${appServer.pid ? ` · PID ${appServer.pid}` : ""}`, appServer.ready],
    [t("status.restarts"), t("status.times", { count: appServer.restartCount || 0 }), (appServer.restartCount || 0) === 0],
    [t("status.eventClients"), String(snapshot?.eventClients ?? 0), true],
    [t("status.activeTasks"), String(Object.keys(snapshot?.activeTurns || {}).length), true],
    [t("status.http"), t("status.metric", { count: http.requestsTotal || 0, average: http.averageDurationMs || 0, errors: http.errorsTotal || 0 }), (http.errorsTotal || 0) === 0],
    [t("status.rpc"), t("status.metric", { count: rpc.requestsTotal || 0, average: rpc.averageDurationMs || 0, errors: rpc.errorsTotal || 0 }), (rpc.errorsTotal || 0) === 0],
    [t("status.permissions"), `${snapshot?.permissions?.sandboxMode || t("status.unknown")} / ${snapshot?.permissions?.approvalPolicy || t("status.unknown")}`, false],
  ];
}

function renderConnectionDetails(snapshot) {
  const nodes = [];
  for (const [label, value, good] of statusRows(snapshot)) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.className = good ? "status-good" : "status-bad";
    nodes.push(dt, dd);
  }
  elements.connectionDetails.replaceChildren(...nodes);
}

async function refreshHealth({ show = false } = {}) {
  if (show) elements.connectionModal.classList.remove("hidden");
  try {
    const snapshot = await api("/api/health", { timeoutMs: 8000 });
    syncSnapshot(snapshot);
    setConnection("online", true);
    renderConnectionDetails(snapshot);
  } catch (error) {
    setConnection("offline", false);
    renderConnectionDetails(state.snapshot);
    if (show) showBanner(errorInfo(error).message, { retry: () => refreshHealth({ show: true }) });
  }
}

function connectEvents() {
  state.eventStream = new EventStreamController({
    onOpen: () => {
      setConnection("online", true);
      void syncSelectedThread();
    },
    onEvent: handleEvent,
    onOffline: () => setConnection("offline", false),
  });
  state.eventStream.start();
}

elements.menuButton.addEventListener("click", () => document.body.classList.contains("drawer-open") ? closeDrawer() : openDrawer());
elements.actionMenuButton.addEventListener("click", () => document.body.classList.contains("action-drawer-open") ? closeActionDrawer() : openActionDrawer());
elements.themeButton.addEventListener("click", toggleTheme);
elements.languageButton.addEventListener("click", toggleLanguage);
elements.drawerBackdrop.addEventListener("click", closeDrawer);
elements.actionDrawerBackdrop.addEventListener("click", () => closeActionDrawer({ restoreFocus: true }));
async function refreshAll() {
  elements.refreshButton.disabled = true;
  elements.drawerRefreshButton.disabled = true;
  await Promise.all([loadThreads({ preserveSelection: true }), refreshHealth()]);
  if (state.selected) await selectThread(state.selected, { silent: true });
  elements.refreshButton.disabled = false;
  elements.drawerRefreshButton.disabled = false;
  toast(t("toast.refreshed"));
}

elements.refreshButton.addEventListener("click", refreshAll);
elements.archiveThreadButton.addEventListener("click", archiveSelectedThread);
elements.drawerRefreshButton.addEventListener("click", () => {
  closeActionDrawer({ restoreFocus: true });
  void refreshAll();
});
elements.drawerArchiveThreadButton.addEventListener("click", archiveSelectedThread);
elements.drawerThemeButton.addEventListener("click", () => {
  toggleTheme();
  closeActionDrawer({ restoreFocus: true });
});
elements.drawerLanguageButton.addEventListener("click", () => {
  toggleLanguage();
  closeActionDrawer({ restoreFocus: true });
});
elements.drawerNewThreadButton.addEventListener("click", () => {
  closeActionDrawer({ restoreFocus: true });
  openNewThread();
});
elements.loadMoreThreads.addEventListener("click", () => loadThreads({ append: true }));
elements.threadSearch.addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadThreads({ preserveSelection: true }), 320);
});
elements.bannerClose.addEventListener("click", hideBanner);
elements.bannerRetry.addEventListener("click", () => state.retryAction?.());
elements.messages.addEventListener("scroll", () => elements.scrollBottom.classList.toggle("hidden", isNearBottom()));
elements.scrollBottom.addEventListener("click", () => scrollToBottom());
elements.messageInput.addEventListener("input", () => {
  resizeComposer();
  if (state.selected) localStorage.setItem(draftKey(state.selected.id), elements.messageInput.value);
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.composer.addEventListener("submit", sendMessage);
elements.stopButton.addEventListener("click", stopTurn);
elements.newThreadButton.addEventListener("click", openNewThread);
elements.newThreadForm.addEventListener("submit", createThread);
elements.workspaceToggle.addEventListener("click", toggleWorkspaceOptions);
elements.newCwd.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveWorkspaceSelection(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter" && workspaceOptionsOpen() && activeWorkspaceIndex >= 0) {
    event.preventDefault();
    elements.newCwd.value = recentWorkspaces[activeWorkspaceIndex].cwd;
    setWorkspaceOptionsOpen(false);
  } else if (event.key === "Escape" && workspaceOptionsOpen()) {
    event.preventDefault();
    setWorkspaceOptionsOpen(false);
  }
});
elements.closeNewThread.addEventListener("click", closeNewThread);
elements.cancelNewThread.addEventListener("click", closeNewThread);
elements.newThreadModal.addEventListener("click", (event) => { if (event.target === elements.newThreadModal) closeNewThread(); });
elements.connectionButton.addEventListener("click", () => {
  closeActionDrawer();
  refreshHealth({ show: true });
});
elements.closeConnection.addEventListener("click", () => elements.connectionModal.classList.add("hidden"));
elements.refreshConnection.addEventListener("click", () => refreshHealth({ show: true }));
elements.connectionModal.addEventListener("click", (event) => { if (event.target === elements.connectionModal) elements.connectionModal.classList.add("hidden"); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.eventStream?.stop();
  } else {
    state.eventStream?.start();
    refreshHealth();
    void syncSelectedThread();
    void pwaController.checkForUpdate();
  }
});
window.addEventListener("online", () => {
  state.eventStream?.wake();
  void refreshHealth();
  void syncSelectedThread();
});
window.addEventListener("offline", () => setConnection("offline", false));
compactActionLayout.addEventListener("change", (event) => {
  if (!event.matches) closeActionDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("action-drawer-open")) {
    closeActionDrawer({ restoreFocus: true });
  }
});
document.addEventListener("bridge:languagechange", () => {
  syncThemeButton();
  setConnection(state.connection, state.ready);
  renderThreads();
  renderMessages();
  renderRequests();
  updateTurnState();
  if (state.selected) {
    elements.chatTitle.textContent = titleOf(state.selected);
    elements.chatMeta.textContent = state.selected.cwd || t("threads.noCwd");
  }
  if (!elements.connectionModal.classList.contains("hidden")) renderConnectionDetails(state.snapshot);
});

setConnection(navigator.onLine ? "connecting" : "offline", false);
renderMessages();
connectEvents();
setInterval(() => state.eventStream?.checkLiveness(), 15_000);
void pwaController.start();

const launchUrl = new URL(window.location.href);
if (launchUrl.searchParams.get("action") === "new") {
  launchUrl.searchParams.delete("action");
  launchUrl.searchParams.delete("source");
  window.history.replaceState({}, "", `${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`);
  void openNewThread();
}
Promise.all([
  refreshHealth(),
  loadThreads({ preserveSelection: false }),
  api("/api/requests").then((result) => {
    for (const request of result.data || []) state.requests.set(request.requestId, request);
    renderRequests();
  }).catch(() => {}),
]);

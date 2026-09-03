import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { BridgeError } from "./errors.mjs";
import { compactTurnPage, deltaFromTurnPage, findThreadItem } from "./mobile-history.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const USER_INPUT_METHOD = "item/tool/requestUserInput";
const THREAD_CLIENTS = new Set(["codex", "openclaw"]);
const MAX_TAKEOVER_ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;
const OPENCLAW_PREVIEW_MARKERS = [
  /(?:^|\n)Conversation info:\s*⟦openclaw:ctx⟧/i,
  /(?:^|\n)OpenClaw runtime context for this turn:/i,
];

function threadIdFrom(params = {}) {
  return params.threadId || params.thread_id || params.thread?.id || params.turn?.threadId || null;
}

function turnIdFrom(params = {}) {
  return params.turnId || params.turn_id || params.turn?.id || null;
}

export function threadClient(thread = {}) {
  const preview = [thread.preview, thread.name, thread.title]
    .filter((value) => typeof value === "string")
    .join("\n");
  if (OPENCLAW_PREVIEW_MARKERS.some((marker) => marker.test(preview))) return "openclaw";

  const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
  return /(?:^|[\\/])\.openclaw(?:[\\/]|$)/i.test(cwd) ? "openclaw" : "codex";
}

function filterThreadPage(result, client) {
  const collectionKey = ["data", "threads", "items"].find((key) => Array.isArray(result?.[key]));
  if (!collectionKey) return result;
  return {
    ...result,
    [collectionKey]: result[collectionKey].filter((thread) => threadClient(thread) === client),
  };
}

export function rpcFailure(error) {
  if (error?.code === -32600 && /thread-store conflict|already has an active writer/i.test(String(error?.message || ""))) {
    return new BridgeError("此会话正在另一个 Codex 客户端中打开；请先在桌面端关闭该会话后重试，或在手机端新建会话", {
      status: 409,
      code: "thread_in_use",
      retryable: false,
    });
  }
  if (error?.code === -32001) {
    return new BridgeError("Codex 正忙，请稍后重试", {
      status: 503,
      code: "codex_overloaded",
      retryable: true,
    });
  }
  if (error?.code === "rpc_timeout") {
    return new BridgeError("Codex 响应超时", {
      status: 504,
      code: "codex_timeout",
      retryable: true,
    });
  }
  if (error?.code === "rpc_circuit_open") {
    const seconds = Math.max(1, Math.ceil(Number(error.retryAfterMs || 1) / 1000));
    return new BridgeError(`Codex 请求队列正在恢复，请在 ${seconds} 秒后重试`, {
      status: 503,
      code: "codex_recovering",
      retryable: true,
      details: { seconds },
    });
  }
  return error;
}

function rolloutRecordTurnId(record) {
  return record?.payload?.turn_id
    || record?.payload?.turn?.id
    || record?.payload?.internal_chat_message_metadata_passthrough?.turn_id
    || null;
}

async function persistedRolloutState(path) {
  if (typeof path !== "string" || !path.endsWith(".jsonl") || !isAbsolute(path)) {
    return { type: "unknown", evidence: "rollout_path_unavailable" };
  }
  let file;
  try {
    file = await open(path, "r");
    const stats = await file.stat();
    const length = Math.min(stats.size, MAX_TAKEOVER_ROLLOUT_TAIL_BYTES);
    if (length === 0) return { type: "unknown", evidence: "rollout_empty" };
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, stats.size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (stats.size > length) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]) continue;
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      const turnId = rolloutRecordTurnId(record);
      if (!turnId) continue;
      const completed = record.type === "event_msg"
        && record.payload?.type === "task_complete"
        && record.payload?.turn_id === turnId;
      return { type: completed ? "idle" : "active", evidence: "rollout_tail", turnId };
    }
    return { type: "unknown", evidence: "rollout_turn_unavailable" };
  } catch {
    return { type: "unknown", evidence: "rollout_unavailable" };
  } finally {
    await file?.close().catch(() => {});
  }
}

export class ThreadService {
  constructor({
    client,
    stateStore,
    eventHub,
    approvalPolicy = "never",
    sandboxMode = "danger-full-access",
    archiveClientFactory = null,
    archiveTimeoutMs = 20_000,
  }) {
    this.client = client;
    this.stateStore = stateStore;
    this.eventHub = eventHub;
    this.approvalPolicy = approvalPolicy;
    this.sandboxMode = sandboxMode;
    this.archiveClientFactory = archiveClientFactory;
    this.archiveTimeoutMs = archiveTimeoutMs;
    this.archiveOperation = null;
    this.activeTurns = new Map();
    this.releasePromises = new Map();
    this.queueDrains = new Map();
    this.queueDrainItems = new Map();
    this.queueRetryTimers = new Map();
    this.queueRetryCounts = new Map();
    this.serverRequests = new Map();
    this.threadListCache = new Map();
    this.threadListInflight = new Map();

    client.on("notification", (message) => this.#notification(message));
    client.on("serverRequest", (message) => this.#serverRequest(message));
    client.on("state", (snapshot) => {
      if (!snapshot.ready) {
        this.activeTurns.clear();
        this.serverRequests.clear();
      } else if (!snapshot.degraded) {
        this.#drainAllQueues();
      }
      eventHub.publish("bridge/state", this.snapshot());
    });
  }

  snapshot() {
    return {
      activeTurns: Object.fromEntries(this.activeTurns),
      pendingRequests: this.serverRequests.size,
      permissions: {
        approvalPolicy: this.approvalPolicy,
        sandboxMode: this.sandboxMode,
      },
      drafts: this.stateStore.snapshot(),
      archive: this.archiveOperation
        ? { busy: true, threadId: this.archiveOperation.threadId, startedAt: this.archiveOperation.startedAt }
        : { busy: false, threadId: null, startedAt: null },
      appServer: this.client.snapshot(),
    };
  }

  async listThreads({ limit = 50, cursor = null, searchTerm = null, client = "codex" } = {}) {
    if (!THREAD_CLIENTS.has(client)) {
      throw new BridgeError("会话来源无效", { status: 400, code: "invalid_thread_client" });
    }
    const cacheKey = !cursor && !searchTerm ? String(limit) : null;
    const cached = cacheKey ? this.threadListCache.get(cacheKey) : null;
    if (cached && cached.expiresAt > Date.now()) return filterThreadPage(cached.value, client);
    if (cacheKey && this.threadListInflight.has(cacheKey)) {
      return filterThreadPage(await this.threadListInflight.get(cacheKey), client);
    }

    const load = this.#listThreads({ limit, cursor, searchTerm });
    if (!cacheKey) return filterThreadPage(await load, client);
    this.threadListInflight.set(cacheKey, load);
    try {
      const value = await load;
      this.threadListCache.set(cacheKey, { value, expiresAt: Date.now() + 5_000 });
      return filterThreadPage(value, client);
    } finally {
      this.threadListInflight.delete(cacheKey);
    }
  }

  async #listThreads({ limit, cursor, searchTerm }) {
    try {
      const result = await this.client.request("thread/list", {
        limit,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["vscode", "appServer", "cli"],
        archived: false,
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
        ...(searchTerm ? { searchTerm } : {}),
      });
      return result;
    } catch (error) {
      throw rpcFailure(error);
    }
  }

  async workspaces() {
    const result = await this.listThreads({ limit: 100 });
    const threads = result.data || result.threads || result.items || [];
    const seen = new Set();
    const data = [];
    for (const thread of threads) {
      const cwd = typeof thread.cwd === "string" ? thread.cwd.trim() : "";
      const key = cwd.toLowerCase();
      if (!cwd || seen.has(key)) continue;
      seen.add(key);
      data.push({ cwd });
      if (data.length >= 30) break;
    }
    return { data };
  }

  async findThreadSummary(threadId, { maxPages = 20 } = {}) {
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.#listThreads({ limit: 100, cursor, searchTerm: null });
      const threads = result?.data || result?.threads || result?.items || [];
      const found = threads.find((thread) => thread?.id === threadId);
      if (found) return found;
      cursor = result?.nextCursor || null;
      if (!cursor) break;
    }
    throw new BridgeError("无法确认桌面会话是否仍在运行，已拒绝接管", {
      status: 409,
      code: "takeover_thread_state_unknown",
      retryable: true,
    });
  }

  async takeoverState(threadId) {
    const summary = await this.findThreadSummary(threadId);
    const threadStatus = summary?.status?.type;
    if (threadStatus === "active") return { type: "active", evidence: "thread_status" };
    if (threadStatus === "idle") return { type: "idle", evidence: "thread_status" };
    if (threadStatus !== "notLoaded") return { type: "unknown", evidence: "thread_status" };

    // `notLoaded` only describes this App Server process. Persisted turn pages
    // can lag an active external writer, so inspect the rollout tail and require
    // its latest turn-bearing record to be the matching task_complete event.
    return await persistedRolloutState(summary.path);
  }

  async createThread({ cwd, ephemeral = false }) {
    if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 1024 || !isAbsolute(cwd.trim())) {
      throw new BridgeError("请选择一个有效的绝对目录", { status: 400, code: "invalid_cwd" });
    }
    const resolvedCwd = resolve(cwd.trim());
    try {
      if (!statSync(resolvedCwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new BridgeError("目录不存在或无法访问", { status: 400, code: "cwd_unavailable" });
    }

    try {
      const result = await this.client.request("thread/start", {
        cwd: resolvedCwd,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandboxMode,
        ephemeral: ephemeral === true,
        threadSource: "codex_mobile_bridge",
      });
      const thread = result.thread || result;
      if (thread?.id) this.stateStore.addDraft(thread.id);
      this.#invalidateThreadList();
      return result;
    } catch (error) {
      throw rpcFailure(error);
    }
  }

  async getThread(threadId) {
    try {
      return await this.client.request("thread/read", { threadId, includeTurns: false });
    } catch (error) {
      throw rpcFailure(error);
    }
  }

  async archiveThread(threadId) {
    const activeTurnId = this.activeTurns.get(threadId);
    if (activeTurnId) {
      throw new BridgeError("当前会话仍在运行，完成或停止后才能归档", {
        status: 409,
        code: "turn_active",
        details: { turnId: activeTurnId },
      });
    }
    if (this.stateStore.queuedMessageCount(threadId) > 0) {
      throw new BridgeError("当前会话仍有排队消息，发送完成后才能归档", {
        status: 409,
        code: "thread_has_queued_messages",
      });
    }

    if (this.archiveOperation) {
      if (this.archiveOperation.threadId === threadId) return this.archiveOperation.promise;
      throw new BridgeError("已有会话正在归档，请完成后再试", {
        status: 409,
        code: "archive_busy",
        retryable: true,
      });
    }

    const promise = this.#performArchive(threadId);
    this.archiveOperation = { threadId, startedAt: new Date().toISOString(), promise };
    this.eventHub.publish("bridge/archiveState", { busy: true, threadId });
    try {
      return await promise;
    } finally {
      if (this.archiveOperation?.promise === promise) {
        this.archiveOperation = null;
        this.eventHub.publish("bridge/archiveState", { busy: false, threadId });
      }
    }
  }

  async #performArchive(threadId) {
    await this.#waitForRelease(threadId);
    const archiveClient = this.archiveClientFactory ? this.archiveClientFactory() : null;
    const rpcClient = archiveClient || this.client;
    const forwardNotification = (message) => this.#notification(message);
    if (archiveClient) archiveClient.on("notification", forwardNotification);
    try {
      if (archiveClient) await archiveClient.start();
      const result = await rpcClient.request("thread/archive", { threadId }, this.archiveTimeoutMs);
      this.stateStore.removeDraft(threadId);
      this.#invalidateThreadList();
      return result;
    } catch (error) {
      if (archiveClient && error?.code === "rpc_timeout") {
        throw new BridgeError("归档未在限定时间内确认；主连接未受影响，请刷新列表确认结果", {
          status: 504,
          code: "archive_timeout",
          retryable: true,
        });
      }
      if (archiveClient && !archiveClient.ready && !error?.code) {
        throw new BridgeError("独立归档服务启动失败，请稍后重试", {
          status: 503,
          code: "archive_unavailable",
          retryable: true,
        });
      }
      throw rpcFailure(error);
    } finally {
      if (archiveClient) {
        archiveClient.off("notification", forwardNotification);
        await archiveClient.stop().catch(() => {});
      }
    }
  }

  async getTurns(threadId, { limit = 10, cursor = null, compact = true } = {}) {
    try {
      const result = await this.client.request("thread/turns/list", {
        threadId,
        limit,
        sortDirection: "desc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      });
      return compact ? compactTurnPage(result) : result;
    } catch (error) {
      throw rpcFailure(error);
    }
  }

  async syncTurns(threadId, { knownTurnId = null, limit = 10 } = {}) {
    return deltaFromTurnPage(await this.getTurns(threadId, { limit, compact: true }), knownTurnId);
  }

  async getItemDetail(threadId, { turnId, itemId }) {
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      let result;
      try {
        result = await this.client.request("thread/items/list", {
          threadId,
          turnId,
          limit: 100,
          sortDirection: "asc",
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        throw rpcFailure(error);
      }
      const found = findThreadItem(result, itemId);
      if (found) return found;
      cursor = result?.nextCursor || null;
      if (!cursor) break;
    }
    throw new BridgeError("工具详情不存在或已过期", { status: 404, code: "item_not_found" });
  }

  async send(threadId, { text, mode = "start", expectedTurnId = null }) {
    const cleanText = typeof text === "string" ? text.trim() : "";
    if (!cleanText || cleanText.length > 20_000) {
      throw new BridgeError("消息长度必须在 1 到 20,000 字符之间", {
        status: 400,
        code: "invalid_message",
      });
    }
    if (!["start", "steer", "queue"].includes(mode)) {
      throw new BridgeError("不支持的消息发送模式", { status: 400, code: "invalid_send_mode" });
    }
    const input = [{ type: "text", text: cleanText }];

    try {
      if (mode === "queue") return this.#enqueueMessage(threadId, cleanText, "turn_active");

      if (mode === "steer") {
        const activeTurnId = expectedTurnId || this.activeTurns.get(threadId);
        if (!activeTurnId) {
          throw new BridgeError("没有可追加指令的运行中任务", {
            status: 409,
            code: "no_active_turn",
          });
        }
        const result = await this.client.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurnId,
          input,
        });
        return { mode: "steer", ...result };
      }

      const activeTurnId = this.activeTurns.get(threadId);
      if (activeTurnId) {
        throw new BridgeError("当前会话仍在运行；可选择追加指令或先停止", {
          status: 409,
          code: "turn_active",
          details: { turnId: activeTurnId },
        });
      }
      return await this.#startTurn(threadId, input);
    } catch (error) {
      const failure = rpcFailure(error);
      if (failure?.code === "thread_in_use") return this.#enqueueMessage(threadId, cleanText, "thread_in_use");
      throw failure;
    }
  }

  queuedMessages(threadId) {
    const data = this.stateStore.queuedMessagesForThread(threadId);
    return {
      data,
      blockedByExternalWriter: data.some((item) => item.reason === "thread_in_use"),
    };
  }

  cancelQueuedMessage(threadId, queueId) {
    if (this.queueDrainItems.get(threadId) === queueId) {
      throw new BridgeError("该消息正在尝试发送，请稍后再取消", {
        status: 409,
        code: "queue_dispatching",
        retryable: true,
      });
    }
    if (!this.stateStore.removeQueuedMessageForThread(threadId, queueId)) {
      throw new BridgeError("排队消息不存在或已经发送", { status: 404, code: "queued_message_not_found" });
    }
    const remaining = this.stateStore.queuedMessageCount(threadId);
    if (remaining === 0) {
      const timer = this.queueRetryTimers.get(threadId);
      if (timer) clearTimeout(timer);
      this.queueRetryTimers.delete(threadId);
      this.queueRetryCounts.delete(threadId);
    }
    this.eventHub.publish("bridge/messageQueueCancelled", { threadId, queueId, remaining });
    if (remaining > 0) this.#drainQueue(threadId);
    return { ok: true, queueId, remaining };
  }

  retryQueuedMessages(threadId) {
    const queued = this.stateStore.queuedMessageCount(threadId);
    if (queued === 0) return { queued: 0 };
    const timer = this.queueRetryTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.queueRetryTimers.delete(threadId);
    this.queueRetryCounts.delete(threadId);
    const currentDrain = this.queueDrains.get(threadId);
    if (currentDrain) currentDrain.finally(() => this.#drainQueue(threadId));
    else this.#drainQueue(threadId);
    return { queued };
  }

  async interrupt(threadId, turnId = null) {
    const activeTurnId = turnId || this.activeTurns.get(threadId);
    if (!activeTurnId) {
      throw new BridgeError("没有可停止的运行中任务", { status: 409, code: "no_active_turn" });
    }
    try {
      const result = await this.client.request("turn/interrupt", { threadId, turnId: activeTurnId });
      return result;
    } catch (error) {
      throw rpcFailure(error);
    }
  }

  pendingRequests() {
    return { data: [...this.serverRequests.values()].map((item) => item.public) };
  }

  respondToRequest(requestId, body = {}) {
    const stored = this.serverRequests.get(requestId);
    if (!stored) throw new BridgeError("该请求已失效", { status: 404, code: "request_expired" });

    if (stored.public.kind === "approval") {
      const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);
      if (!allowed.has(body.decision)) {
        throw new BridgeError("不支持的审批决定", { status: 400, code: "invalid_decision" });
      }
      this.client.reply(stored.message.id, { decision: body.decision });
    } else if (stored.public.kind === "userInput") {
      const answers = body.answers && typeof body.answers === "object" ? body.answers : null;
      if (!answers) throw new BridgeError("请填写问题答案", { status: 400, code: "invalid_answers" });
      const normalized = {};
      for (const question of stored.public.questions) {
        const values = answers[question.id];
        if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
          throw new BridgeError(`问题 ${question.header || question.id} 缺少答案`, {
            status: 400,
            code: "invalid_answers",
          });
        }
        normalized[question.id] = { answers: values };
      }
      this.client.reply(stored.message.id, { answers: normalized });
    } else {
      throw new BridgeError("移动端暂不支持响应此类请求", {
        status: 409,
        code: "unsupported_server_request",
      });
    }

    this.serverRequests.delete(requestId);
    this.eventHub.publish("bridge/requestResolved", { requestId });
    return { ok: true };
  }

  #notification(message) {
    const params = message.params || {};
    const threadId = threadIdFrom(params);
    const turnId = turnIdFrom(params);
    if (message.method === "turn/started" && threadId && turnId) this.activeTurns.set(threadId, turnId);
    if (message.method === "turn/completed" && threadId) {
      this.activeTurns.delete(threadId);
      this.#resolveServerRequestsForThread(threadId);
      void this.#releaseThread(threadId).finally(() => this.#drainQueue(threadId));
    }
    if (/^(thread\/|turn\/)/.test(message.method)) this.#invalidateThreadList();
    this.eventHub.publish(message.method, params);
  }

  #releaseThread(threadId) {
    const pending = this.releasePromises.get(threadId);
    if (pending) return pending;
    const release = this.client.request("thread/unsubscribe", { threadId })
      .catch((error) => {
        this.eventHub.publish("bridge/threadReleaseFailed", {
          threadId,
          error: String(error?.message || error),
        });
      })
      .finally(() => {
        if (this.releasePromises.get(threadId) === release) this.releasePromises.delete(threadId);
      });
    this.releasePromises.set(threadId, release);
    return release;
  }

  async #waitForRelease(threadId) {
    const pending = this.releasePromises.get(threadId);
    if (pending) await pending;
  }

  async #startTurn(threadId, input) {
    await this.#waitForRelease(threadId);
    let resumed = false;
    try {
      if (!this.stateStore.hasDraft(threadId)) {
        await this.client.request("thread/resume", { threadId });
        resumed = true;
      }
      const result = await this.client.request("turn/start", {
        threadId,
        input,
        approvalPolicy: this.approvalPolicy,
        sandboxPolicy: { type: this.#sandboxPolicyType() },
      });
      this.stateStore.removeDraft(threadId);
      this.#invalidateThreadList();
      const turnId = result?.turn?.id || null;
      if (turnId) this.activeTurns.set(threadId, turnId);
      return { mode: "start", ...result };
    } catch (error) {
      if (resumed) void this.#releaseThread(threadId);
      throw error;
    }
  }

  #enqueueMessage(threadId, text, reason) {
    const queued = this.stateStore.enqueueMessage(threadId, text, { reason });
    this.eventHub.publish("bridge/messageQueued", {
      threadId,
      queueId: queued.id,
      position: queued.position,
      item: queued,
    });
    this.#drainQueue(threadId);
    return {
      mode: "queue",
      queued: true,
      queueId: queued.id,
      position: queued.position,
      item: queued,
    };
  }

  #drainAllQueues() {
    for (const threadId of this.stateStore.queuedThreadIds()) this.#drainQueue(threadId);
  }

  #drainQueue(threadId) {
    if (!this.client.ready || this.activeTurns.has(threadId) || this.queueDrains.has(threadId)) return;
    const item = this.stateStore.peekQueuedMessage(threadId);
    if (!item) return;
    const timer = this.queueRetryTimers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.queueRetryTimers.delete(threadId);
    }

    const drain = this.#startTurn(threadId, [{ type: "text", text: item.text }])
      .then((result) => {
        this.stateStore.removeQueuedMessage(item.id);
        this.queueRetryCounts.delete(threadId);
        this.eventHub.publish("bridge/messageDequeued", {
          threadId,
          queueId: item.id,
          turnId: result?.turn?.id || null,
          remaining: this.stateStore.queuedMessageCount(threadId),
        });
      })
      .catch((error) => {
        const failure = rpcFailure(error);
        if (failure?.code === "thread_in_use") this.stateStore.updateQueuedMessage(item.id, { reason: "thread_in_use" });
        const attempt = (this.queueRetryCounts.get(threadId) || 0) + 1;
        this.queueRetryCounts.set(threadId, attempt);
        const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
        this.eventHub.publish("bridge/messageQueueWaiting", {
          threadId,
          queueId: item.id,
          code: failure?.code || "send_failed",
          retryInMs: delayMs,
        });
        const retry = setTimeout(() => {
          this.queueRetryTimers.delete(threadId);
          this.#drainQueue(threadId);
        }, delayMs);
        retry.unref();
        this.queueRetryTimers.set(threadId, retry);
      })
      .finally(() => {
        if (this.queueDrains.get(threadId) === drain) this.queueDrains.delete(threadId);
        if (this.queueDrainItems.get(threadId) === item.id) this.queueDrainItems.delete(threadId);
      });
    this.queueDrains.set(threadId, drain);
    this.queueDrainItems.set(threadId, item.id);
  }

  #invalidateThreadList() {
    this.threadListCache.clear();
  }

  #resolveServerRequestsForThread(threadId) {
    for (const [requestId, stored] of this.serverRequests) {
      if (stored.public.threadId !== threadId) continue;
      this.serverRequests.delete(requestId);
      this.eventHub.publish("bridge/requestResolved", {
        requestId,
        threadId: stored.public.threadId,
        turnId: stored.public.turnId,
        reason: "turn_completed",
      });
    }
  }

  #serverRequest(message) {
    const requestId = String(message.id);
    const params = message.params || {};
    let publicRequest;
    if (APPROVAL_METHODS.has(message.method)) {
      publicRequest = {
        requestId,
        kind: "approval",
        method: message.method,
        threadId: threadIdFrom(params),
        turnId: turnIdFrom(params),
        itemId: params.itemId || params.item?.id || null,
        reason: params.reason || params.message || null,
        command: params.command || params.cmd || params.item?.command || null,
        cwd: params.cwd || params.item?.cwd || null,
      };
    } else if (message.method === USER_INPUT_METHOD) {
      publicRequest = {
        requestId,
        kind: "userInput",
        method: message.method,
        threadId: threadIdFrom(params),
        turnId: turnIdFrom(params),
        itemId: params.itemId || null,
        isBlocking: Boolean(params.isBlocking),
        questions: (params.questions || []).slice(0, 3).map((question) => ({
          id: String(question.id),
          header: String(question.header || "问题"),
          question: String(question.question || ""),
          isOther: Boolean(question.isOther),
          isSecret: Boolean(question.isSecret),
          options: Array.isArray(question.options)
            ? question.options.slice(0, 10).map((option) => ({
                label: String(option.label || ""),
                description: String(option.description || ""),
              }))
            : null,
        })),
      };
    } else {
      publicRequest = {
        requestId,
        kind: "unsupported",
        method: message.method,
        threadId: threadIdFrom(params),
        turnId: turnIdFrom(params),
      };
    }
    this.serverRequests.set(requestId, { message, public: publicRequest });
    this.eventHub.publish("bridge/request", publicRequest);
  }

  #sandboxPolicyType() {
    if (this.sandboxMode === "danger-full-access") return "dangerFullAccess";
    if (this.sandboxMode === "read-only") return "readOnly";
    return "workspaceWrite";
  }
}

import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./src/codex-client.mjs";
import { EventHub } from "./src/event-hub.mjs";
import { BridgeError, publicError } from "./src/errors.mjs";
import { json, readJson, rejectCrossSiteMutation, requestId, serveStatic } from "./src/http-utils.mjs";
import { createLogger } from "./src/logger.mjs";
import { BridgeMetrics } from "./src/metrics.mjs";
import { BridgeStateStore } from "./src/state-store.mjs";
import { ThreadService } from "./src/thread-service.mjs";
import { ThreadTakeoverService } from "./src/thread-takeover.mjs";

const VERSION = "0.8.3";
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const STATE_FILE = process.env.BRIDGE_STATE_FILE || join(ROOT, "state", "bridge-state.json");
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const PORT = parseInteger(process.env.BRIDGE_PORT, 8765, 1, 65535);
const MAX_BODY_BYTES = parseInteger(process.env.BRIDGE_MAX_BODY_BYTES, 64 * 1024, 1024, 1024 * 1024);
const STARTED_AT = new Date().toISOString();
const APPROVAL_POLICY = process.env.BRIDGE_APPROVAL_POLICY || "never";
const SANDBOX_MODE = process.env.BRIDGE_SANDBOX_MODE || "danger-full-access";
const UI_LANGUAGE = ["en", "zh-CN"].includes(process.env.BRIDGE_UI_LANGUAGE) ? process.env.BRIDGE_UI_LANGUAGE : "en";
const CODEX_ARGS = parseCodexArgs(process.env.CODEX_ARGS_JSON);
const logger = createLogger("bridge");
const metrics = new BridgeMetrics();

if (!["127.0.0.1", "::1", "localhost"].includes(HOST) && process.env.BRIDGE_ALLOW_NON_LOOPBACK !== "1") {
  throw new Error("Refusing a non-loopback bind. Use Tailscale Serve or set BRIDGE_ALLOW_NON_LOOPBACK=1 explicitly.");
}

const eventHub = new EventHub();
const stateStore = new BridgeStateStore(STATE_FILE);
const client = new CodexClient({
  command: process.env.CODEX_COMMAND || "codex",
  args: CODEX_ARGS,
  cwd: process.env.CODEX_CWD || process.cwd(),
  logger: { error: (message) => logger.warn("app_server_stderr", { message }) },
});
function createArchiveClient() {
  const archiveClient = new CodexClient({
    command: process.env.CODEX_COMMAND || "codex",
    args: CODEX_ARGS,
    cwd: process.env.CODEX_CWD || process.cwd(),
    env: { ...process.env, CODEX_BRIDGE_CHANNEL: "archive" },
    initializeTimeoutMs: 5_000,
    logger: { error: (message) => logger.warn("archive_app_server_stderr", { message }) },
  });
  archiveClient.on("rpc", (observation) => {
    metrics.recordRpc(observation);
    if (observation.outcome !== "ok") logger.warn("archive_rpc_failed", observation);
  });
  archiveClient.on("rpcLate", (observation) => logger.warn("archive_rpc_late_response", observation));
  archiveClient.on("state", (snapshot) => logger.info("archive_app_server_state", {
    status: snapshot.status,
    pid: snapshot.pid,
    degraded: snapshot.degraded,
    error: snapshot.error,
  }));
  return archiveClient;
}
const threads = new ThreadService({
  client,
  stateStore,
  eventHub,
  approvalPolicy: APPROVAL_POLICY,
  sandboxMode: SANDBOX_MODE,
  archiveClientFactory: createArchiveClient,
});
const takeover = new ThreadTakeoverService({
  protectedPids: () => [process.pid, client.snapshot().pid].filter(Boolean),
});
client.on("rpc", (observation) => {
  metrics.recordRpc(observation);
  if (observation.outcome !== "ok") logger.warn("rpc_failed", observation);
});
client.on("rpcLate", (observation) => logger.warn("rpc_late_response", observation));
client.on("state", (snapshot) => logger.info("app_server_state", {
  status: snapshot.status,
  pid: snapshot.pid,
  restartCount: snapshot.restartCount,
  degraded: snapshot.degraded,
  degradedUntil: snapshot.degradedUntil,
  timeoutStreak: snapshot.timeoutStreak,
  error: snapshot.error,
}));

function parseInteger(raw, fallback, minimum, maximum) {
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid integer configuration value: ${raw}`);
  }
  return value;
}

function parseCodexArgs(raw) {
  if (!raw) return ["app-server", "--stdio"];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("CODEX_ARGS_JSON must be a JSON array");
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("CODEX_ARGS_JSON must be a JSON string array");
  }
  return value;
}

function bridgeSnapshot() {
  return {
    version: VERSION,
    uiLanguage: UI_LANGUAGE,
    startedAt: STARTED_AT,
    uptimeSeconds: Math.floor(process.uptime()),
    ready: client.ready,
    eventClients: eventHub.clients.size,
    eventStream: eventHub.snapshot(),
    metrics: metrics.snapshot(),
    ...threads.snapshot(),
  };
}

function routeName(method, pathname) {
  const key = `${method || "UNKNOWN"} ${pathname}`;
  const exact = {
    "GET /api/health": "health",
    "GET /api/metrics": "metrics",
    "GET /api/events": "events",
    "GET /api/threads": "thread_list",
    "POST /api/threads": "thread_create",
    "GET /api/workspaces": "workspace_list",
    "GET /api/requests": "request_list",
  };
  if (exact[key]) return exact[key];
  if (/^\/api\/threads\/[^/]+\/turns$/.test(pathname)) return "turn_list";
  if (/^\/api\/threads\/[^/]+\/sync$/.test(pathname)) return "turn_sync";
  if (/^\/api\/threads\/[^/]+\/queue\/[^/]+$/.test(pathname)) return "queue_cancel";
  if (/^\/api\/threads\/[^/]+\/queue$/.test(pathname)) return "queue_list";
  if (/^\/api\/threads\/[^/]+\/takeover$/.test(pathname)) return method === "GET" ? "takeover_inspect" : "takeover_execute";
  if (/^\/api\/threads\/[^/]+\/turns\/[^/]+\/items\/[^/]+$/.test(pathname)) return "item_detail";
  if (/^\/api\/threads\/[^/]+\/send$/.test(pathname)) return "turn_send";
  if (/^\/api\/threads\/[^/]+\/interrupt$/.test(pathname)) return "turn_interrupt";
  if (/^\/api\/threads\/[^/]+\/archive$/.test(pathname)) return "thread_archive";
  if (/^\/api\/threads\/[^/]+$/.test(pathname)) return "thread_read";
  if (/^\/api\/requests\/[^/]+$/.test(pathname)) return "request_response";
  return pathname.startsWith("/api/") ? "api_unknown" : "static";
}

function queryLimit(url, fallback, max) {
  const raw = Number(url.searchParams.get("limit") || fallback);
  return Number.isFinite(raw) ? Math.min(max, Math.max(1, Math.trunc(raw))) : fallback;
}

function pathId(match, index = 1) {
  try {
    const value = decodeURIComponent(match[index]);
    if (!value || value.length > 4096) throw new Error("invalid");
    return value;
  } catch {
    throw new BridgeError("资源标识无效", { status: 400, code: "invalid_id" });
  }
}

async function handleApi(request, response, url, id) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    const snapshot = bridgeSnapshot();
    json(response, snapshot.ready ? 200 : 503, snapshot, id);
    return true;
  }

  if (url.pathname === "/api/metrics" && request.method === "GET") {
    json(response, 200, metrics.snapshot(), id);
    return true;
  }

  if (url.pathname === "/api/events" && request.method === "GET") {
    if (!eventHub.attach(request, response, bridgeSnapshot())) {
      throw new BridgeError("事件连接数已达上限", { status: 503, code: "too_many_event_clients", retryable: true });
    }
    return true;
  }

  const queueItemMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/queue\/([^/]+)$/);
  if (queueItemMatch && request.method === "DELETE") {
    json(response, 200, threads.cancelQueuedMessage(pathId(queueItemMatch), pathId(queueItemMatch, 2)), id);
    return true;
  }

  const queueMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/queue$/);
  if (queueMatch && request.method === "GET") {
    json(response, 200, threads.queuedMessages(pathId(queueMatch)), id);
    return true;
  }

  const takeoverMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/takeover$/);
  if (takeoverMatch && ["GET", "POST"].includes(request.method)) {
    const threadId = pathId(takeoverMatch);
    const queue = threads.queuedMessages(threadId);
    if (!queue.blockedByExternalWriter) {
      throw new BridgeError("此会话当前没有被外部客户端阻塞", {
        status: 409,
        code: "takeover_not_needed",
      });
    }
    const threadState = await threads.takeoverState(threadId);
    if (threadState.type === "active") {
      if (request.method === "GET") {
        json(response, 200, { available: false, reason: "active_remote_turn", owner: null }, id);
        return true;
      }
      throw new BridgeError("电脑端任务仍在运行；为避免损坏会话历史，已拒绝强制接管", {
        status: 409,
        code: "takeover_active_remote_turn",
        retryable: true,
      });
    }
    if (threadState.type !== "idle") {
      if (request.method === "GET") {
        json(response, 200, { available: false, reason: "thread_state_unknown", owner: null }, id);
        return true;
      }
      throw new BridgeError("无法确认桌面会话已空闲，已拒绝接管", {
        status: 409,
        code: "takeover_thread_state_unknown",
        retryable: true,
      });
    }
    if (request.method === "GET") {
      json(response, 200, await takeover.inspect(threadId), id);
      return true;
    }
    const body = await readJson(request, MAX_BODY_BYTES);
    const result = await takeover.takeover(threadId, {
      token: body.token,
      pid: body.owner?.pid,
      startedAt: body.owner?.startedAt,
    });
    threads.retryQueuedMessages(threadId);
    logger.info("thread_takeover", {
      requestId: id,
      threadId,
      terminated: result.terminated,
      ownerPid: result.owner?.pid || null,
    });
    eventHub.publish("bridge/threadTakeover", {
      threadId,
      terminated: result.terminated,
      ownerPid: result.owner?.pid || null,
    });
    json(response, 200, result, id);
    return true;
  }

  if (!client.ready) {
    throw new BridgeError(client.error || "Codex app-server 正在启动", {
      status: 503,
      code: "app_server_unavailable",
      retryable: true,
    });
  }

  if (url.pathname === "/api/threads" && request.method === "GET") {
    const cursor = url.searchParams.get("cursor");
    const searchTerm = url.searchParams.get("search")?.trim() || null;
    const threadClient = url.searchParams.get("client") || "codex";
    if (cursor && cursor.length > 4096) throw new BridgeError("分页游标无效", { status: 400, code: "invalid_cursor" });
    if (searchTerm && searchTerm.length > 200) throw new BridgeError("搜索内容过长", { status: 400, code: "invalid_search" });
    json(response, 200, await threads.listThreads({ limit: queryLimit(url, 50, 100), cursor, searchTerm, client: threadClient }), id);
    return true;
  }

  if (url.pathname === "/api/threads" && request.method === "POST") {
    json(response, 201, await threads.createThread(await readJson(request, MAX_BODY_BYTES)), id);
    return true;
  }

  if (url.pathname === "/api/workspaces" && request.method === "GET") {
    json(response, 200, await threads.workspaces(), id);
    return true;
  }

  if (url.pathname === "/api/requests" && request.method === "GET") {
    json(response, 200, threads.pendingRequests(), id);
    return true;
  }

  const turnsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
  if (turnsMatch && request.method === "GET") {
    const cursor = url.searchParams.get("cursor");
    if (cursor && cursor.length > 4096) throw new BridgeError("分页游标无效", { status: 400, code: "invalid_cursor" });
    json(response, 200, await threads.getTurns(pathId(turnsMatch), { limit: queryLimit(url, 10, 50), cursor }), id);
    return true;
  }

  const syncMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/sync$/);
  if (syncMatch && request.method === "GET") {
    const knownTurnId = url.searchParams.get("knownTurnId");
    if (knownTurnId && knownTurnId.length > 4096) throw new BridgeError("资源标识无效", { status: 400, code: "invalid_id" });
    json(response, 200, await threads.syncTurns(pathId(syncMatch), {
      knownTurnId,
      limit: queryLimit(url, 10, 25),
    }), id);
    return true;
  }

  const itemMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/items\/([^/]+)$/);
  if (itemMatch && request.method === "GET") {
    json(response, 200, await threads.getItemDetail(pathId(itemMatch), {
      turnId: pathId(itemMatch, 2),
      itemId: pathId(itemMatch, 3),
    }), id);
    return true;
  }

  const sendMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/send$/);
  if (sendMatch && request.method === "POST") {
    json(response, 202, await threads.send(pathId(sendMatch), await readJson(request, MAX_BODY_BYTES)), id);
    return true;
  }

  const interruptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
  if (interruptMatch && request.method === "POST") {
    const body = await readJson(request, MAX_BODY_BYTES);
    json(response, 200, await threads.interrupt(pathId(interruptMatch), typeof body.turnId === "string" ? body.turnId : null), id);
    return true;
  }

  const archiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/archive$/);
  if (archiveMatch && request.method === "POST") {
    json(response, 200, await threads.archiveThread(pathId(archiveMatch)), id);
    return true;
  }

  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && request.method === "GET") {
    json(response, 200, await threads.getThread(pathId(threadMatch)), id);
    return true;
  }

  const requestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (requestMatch && request.method === "POST") {
    json(response, 200, threads.respondToRequest(pathId(requestMatch), await readJson(request, MAX_BODY_BYTES)), id);
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  const id = requestId(request);
  const startedAt = performance.now();
  const rawPath = (request.url || "/").split("?", 1)[0];
  const route = routeName(request.method, rawPath);
  metrics.beginHttp();
  let recorded = false;
  const recordRequest = (status = response.statusCode) => {
    if (recorded) return;
    recorded = true;
    const durationMs = performance.now() - startedAt;
    metrics.recordHttp({ route, status, durationMs });
    const isMutation = !["GET", "HEAD"].includes(request.method || "");
    if (status >= 400 || isMutation) {
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      logger[level]("http_request", { requestId: id, method: request.method, route, status, durationMs: Math.round(durationMs * 100) / 100 });
    }
  };
  response.once("finish", () => recordRequest());
  response.once("close", () => recordRequest(response.writableEnded ? response.statusCode : 499));
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    rejectCrossSiteMutation(request);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url, id);
      if (!handled) json(response, 404, { error: { code: "not_found", message: "接口不存在", retryable: false } }, id);
      return;
    }
    if (!["GET", "HEAD"].includes(request.method || "")) {
      json(response, 405, { error: { code: "method_not_allowed", message: "请求方法不支持", retryable: false } }, id);
      return;
    }
    if (!serveStatic(request, response, PUBLIC_DIR, url.pathname, id)) {
      json(response, 404, { error: { code: "not_found", message: "页面不存在", retryable: false } }, id);
    }
  } catch (error) {
    const failure = publicError(error);
    const level = failure.status >= 500 ? "error" : "warn";
    logger[level]("request_failed", { requestId: id, method: request.method, route, status: failure.status, error });
    if (!response.headersSent) json(response, failure.status, failure.body, id);
    else response.end();
  }
});

const heartbeat = setInterval(() => eventHub.heartbeat(), 20_000);
heartbeat.unref();
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info("bridge_stopping", { signal });
  clearInterval(heartbeat);
  eventHub.close();
  await new Promise((resolve) => server.close(resolve));
  await client.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal)
      .catch((error) => process.stderr.write(`[bridge] shutdown failed: ${error.stack || error}\n`))
      .finally(() => process.exit(0));
  });
}

server.on("clientError", (error, socket) => {
  logger.warn("client_error", { error });
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(PORT, HOST, async () => {
  logger.info("bridge_listening", { version: VERSION, host: HOST, port: PORT });
  try {
    await client.start();
  } catch (error) {
    logger.error("app_server_initial_start_failed", { error });
  }
});

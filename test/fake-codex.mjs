import readline from "node:readline";

const reader = readline.createInterface({ input: process.stdin });
let draftId = 0;
let turnId = 0;
const conflictThreads = new Set(String(process.env.FAKE_CODEX_CONFLICT_THREAD || "").split(",").filter(Boolean));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

reader.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  if (method === process.env.FAKE_CODEX_HANG_METHOD) return;
  if (method === process.env.FAKE_CODEX_DELAY_METHOD) {
    setTimeout(() => send({ id, result: { delayed: true } }), Number(process.env.FAKE_CODEX_DELAY_MS || 40));
    return;
  }

  if (method === "initialize") {
    send({ id, result: { userAgent: "fake-codex/1.0", platformFamily: "windows", platformOs: "windows" } });
  } else if (method === "thread/list") {
    if (params.useStateDbOnly !== true) {
      send({ id, error: { code: -32602, message: "thread/list must use the state DB fast path" } });
      return;
    }
    send({ id, result: { data: [
      { id: "thread-1", name: "Fixture thread", cwd: process.cwd(), updatedAt: 1_800_000_000, status: { type: "idle" } },
      { id: "thread-conflict", name: "Conflict fixture", cwd: process.cwd(), updatedAt: 1_799_999_998, status: { type: "idle" } },
      { id: "thread-active-conflict", name: "Active conflict fixture", cwd: process.cwd(), updatedAt: 1_799_999_997, status: { type: "active" } },
      { id: "thread-unknown-conflict", name: "Unknown conflict fixture", cwd: process.cwd(), updatedAt: 1_799_999_996, status: { type: "notLoaded" } },
      { id: "openclaw-1", preview: "Conversation info: ⟦openclaw:ctx⟧", cwd: "C:\\home\\fixture\\.openclaw\\workspace", updatedAt: 1_799_999_999, status: { type: "idle" } },
    ], nextCursor: null } });
  } else if (method === "thread/read") {
    send({ id, result: { thread: { id: params.threadId, name: "Fixture thread", cwd: process.cwd(), status: { type: "idle" }, turns: [] } } });
  } else if (method === "thread/turns/list") {
    send({
      id,
      result: {
        data: [{
          id: "turn-1",
          status: "completed",
          itemsView: "full",
          items: [
            { id: "item-user", type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { id: "item-agent", type: "agentMessage", text: "world" },
            { id: "item-tool", type: "commandExecution", command: "fixture --verbose", status: "completed", aggregatedOutput: "detail ".repeat(800) },
          ],
        }],
        nextCursor: null,
      },
    });
  } else if (method === "thread/items/list") {
    send({
      id,
      result: {
        data: [{
          turnId: params.turnId || "turn-1",
          item: { id: "item-tool", type: "commandExecution", command: "fixture --verbose", status: "completed", aggregatedOutput: "detail ".repeat(800) },
        }],
        nextCursor: null,
      },
    });
  } else if (method === "thread/start") {
    draftId += 1;
    send({ id, result: { thread: { id: `draft-${draftId}`, name: null, cwd: params.cwd, status: { type: "idle" } } } });
  } else if (method === "thread/resume") {
    if (conflictThreads.has(params.threadId)) {
      send({ id, error: { code: -32600, message: "thread-store conflict: thread already has an active writer" } });
      return;
    }
    send({ id, result: { thread: { id: params.threadId, status: { type: "idle" } } } });
  } else if (method === "thread/unsubscribe") {
    send({ id, result: { status: "unsubscribed" } });
  } else if (method === "thread/archive") {
    if (process.env.FAKE_CODEX_REQUIRE_ARCHIVE_CHANNEL === "1" && process.env.CODEX_BRIDGE_CHANNEL !== "archive") {
      send({ id, error: { code: -32600, message: "thread/archive must use the isolated channel" } });
      return;
    }
    const completeArchive = () => {
      send({ id, result: {} });
      send({ method: "thread/archived", params: { threadId: params.threadId } });
    };
    const delayMs = process.env.CODEX_BRIDGE_CHANNEL === "archive"
      ? Number(process.env.FAKE_CODEX_ARCHIVE_DELAY_MS || 0)
      : 0;
    if (delayMs > 0) setTimeout(completeArchive, delayMs);
    else completeArchive();
  } else if (method === "turn/start") {
    turnId += 1;
    const turn = { id: `turn-live-${turnId}`, status: "inProgress", items: [] };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: turn.id, itemId: "item-live", delta: "done" } });
      send({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed" } } });
    }, Number(process.env.FAKE_CODEX_TURN_DELAY_MS || 100));
  } else if (method === "turn/steer") {
    send({ id, result: { turnId: params.expectedTurnId } });
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
  }
});

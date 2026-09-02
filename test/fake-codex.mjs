import readline from "node:readline";

const reader = readline.createInterface({ input: process.stdin });
let draftId = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

reader.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (id === undefined) return;

  if (method === "initialize") {
    send({ id, result: { userAgent: "fake-codex/1.0", platformFamily: "windows", platformOs: "windows" } });
  } else if (method === "thread/list") {
    send({ id, result: { data: [{ id: "thread-1", name: "Fixture thread", cwd: process.cwd(), updatedAt: 1_800_000_000, status: { type: "idle" } }], nextCursor: null } });
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
    send({ id, result: { thread: { id: params.threadId, status: { type: "idle" } } } });
  } else if (method === "thread/unsubscribe") {
    send({ id, result: { status: "unsubscribed" } });
  } else if (method === "turn/start") {
    const turn = { id: "turn-live", status: "inProgress", items: [] };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: turn.id, itemId: "item-live", delta: "done" } });
      send({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed" } } });
    }, 15);
  } else if (method === "turn/steer") {
    send({ id, result: { turnId: params.expectedTurnId } });
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
  }
});

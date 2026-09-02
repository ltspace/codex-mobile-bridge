import { randomUUID } from "node:crypto";

export class EventHub {
  constructor({ replaySize = 256, maxClients = 16 } = {}) {
    this.replaySize = replaySize;
    this.maxClients = maxClients;
    this.sequence = 0;
    this.instanceId = randomUUID();
    this.history = [];
    this.clients = new Set();
  }

  snapshot() {
    return {
      instanceId: this.instanceId,
      latestEventId: this.sequence,
      oldestEventId: this.history[0]?.id || null,
      replaySize: this.replaySize,
    };
  }

  publish(method, params = {}) {
    const event = { id: ++this.sequence, method, params, at: new Date().toISOString() };
    this.history.push(event);
    if (this.history.length > this.replaySize) this.history.shift();
    const payload = this.#encode(event);
    for (const response of this.clients) response.write(payload);
    return event;
  }

  attach(request, response, readyPayload) {
    if (this.clients.size >= this.maxClients) return false;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 3000\n\n");

    const url = new URL(request.url || "/api/events", "http://localhost");
    const requestedInstanceId = url.searchParams.get("instanceId");
    const lastId = Number(request.headers["last-event-id"] || url.searchParams.get("lastEventId") || 0);
    const validLastId = Number.isSafeInteger(lastId) && lastId > 0;
    const sameInstance = !requestedInstanceId || requestedInstanceId === this.instanceId;
    const oldestEventId = this.history[0]?.id || null;
    const gap = Boolean(validLastId && (!sameInstance || (oldestEventId && lastId < oldestEventId - 1) || lastId > this.sequence));
    let replayedCount = 0;
    if (validLastId && sameInstance && !gap) {
      for (const event of this.history) {
        if (event.id > lastId) {
          response.write(this.#encode(event));
          replayedCount += 1;
        }
      }
    }
    response.write(this.#encode({
      id: this.sequence,
      method: "bridge/snapshot",
      params: {
        ...readyPayload,
        eventStream: {
          ...this.snapshot(),
          resume: {
            requestedEventId: validLastId ? lastId : null,
            requestedInstanceId,
            replayedCount,
            gap,
          },
        },
      },
      at: new Date().toISOString(),
    }));
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
    return true;
  }

  heartbeat() {
    const payload = JSON.stringify({ at: new Date().toISOString(), instanceId: this.instanceId });
    for (const response of this.clients) response.write(`event: bridge-ping\ndata: ${payload}\n\n`);
  }

  close() {
    for (const response of this.clients) response.end();
    this.clients.clear();
  }

  #encode(event) {
    return `id: ${event.id}\nevent: codex\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

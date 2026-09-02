import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_DRAFTS = 100;
const MAX_QUEUED_MESSAGES = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class BridgeStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.drafts = new Map();
    this.queuedMessages = [];
    this.#load();
  }

  hasDraft(threadId) {
    return this.drafts.has(threadId);
  }

  addDraft(threadId) {
    this.drafts.set(threadId, Date.now());
    this.#compact();
    this.#save();
  }

  removeDraft(threadId) {
    if (!this.drafts.delete(threadId)) return;
    this.#save();
  }

  enqueueMessage(threadId, text, { reason = "manual" } = {}) {
    const item = { id: randomUUID(), threadId, text, reason, createdAt: Date.now() };
    this.queuedMessages.push(item);
    this.#compact();
    this.#save();
    return { ...item, position: this.queuedMessages.filter((queued) => queued.threadId === threadId).length };
  }

  peekQueuedMessage(threadId) {
    return this.queuedMessages.find((item) => item.threadId === threadId) || null;
  }

  queuedMessagesForThread(threadId) {
    return this.queuedMessages
      .filter((item) => item.threadId === threadId)
      .map((item, index) => ({ ...item, position: index + 1 }));
  }

  queuedMessageCount(threadId) {
    return this.queuedMessages.filter((item) => item.threadId === threadId).length;
  }

  removeQueuedMessage(id) {
    const index = this.queuedMessages.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.queuedMessages.splice(index, 1);
    this.#save();
    return true;
  }

  removeQueuedMessageForThread(threadId, id) {
    const index = this.queuedMessages.findIndex((item) => item.threadId === threadId && item.id === id);
    if (index < 0) return false;
    this.queuedMessages.splice(index, 1);
    this.#save();
    return true;
  }

  updateQueuedMessage(id, changes = {}) {
    const item = this.queuedMessages.find((queued) => queued.id === id);
    if (!item) return null;
    if (typeof changes.reason === "string" && changes.reason) item.reason = changes.reason;
    this.#save();
    return { ...item };
  }

  queuedThreadIds() {
    return [...new Set(this.queuedMessages.map((item) => item.threadId))];
  }

  snapshot() {
    return {
      pendingFirstTurns: this.drafts.size,
      queuedMessages: this.queuedMessages.length,
      queuedByThread: Object.fromEntries(this.queuedThreadIds().map((threadId) => [
        threadId,
        this.queuedMessageCount(threadId),
      ])),
    };
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      for (const item of parsed.pendingFirstTurns || []) {
        if (typeof item?.threadId === "string" && Number.isFinite(item?.createdAt)) {
          this.drafts.set(item.threadId, item.createdAt);
        }
      }
      for (const item of parsed.queuedMessages || []) {
        if (
          typeof item?.id === "string"
          && typeof item?.threadId === "string"
          && typeof item?.text === "string"
          && item.text.length > 0
          && item.text.length <= 20_000
          && Number.isFinite(item?.createdAt)
        ) {
          this.queuedMessages.push({
            id: item.id,
            threadId: item.threadId,
            text: item.text,
            reason: typeof item.reason === "string" && item.reason ? item.reason : "manual",
            createdAt: item.createdAt,
          });
        }
      }
      this.#compact();
    } catch {
      // A missing or invalid state file is safe: app-server remains authoritative.
    }
  }

  #compact() {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [threadId, createdAt] of this.drafts) {
      if (createdAt < cutoff) this.drafts.delete(threadId);
    }
    while (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value);
    this.queuedMessages = this.queuedMessages.filter((item) => item.createdAt >= cutoff).slice(-MAX_QUEUED_MESSAGES);
  }

  #save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const payload = {
      version: 3,
      pendingFirstTurns: [...this.drafts].map(([threadId, createdAt]) => ({ threadId, createdAt })),
      queuedMessages: this.queuedMessages,
    };
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

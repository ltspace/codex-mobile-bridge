import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_DRAFTS = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class BridgeStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.drafts = new Map();
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

  snapshot() {
    return { pendingFirstTurns: this.drafts.size };
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      for (const item of parsed.pendingFirstTurns || []) {
        if (typeof item?.threadId === "string" && Number.isFinite(item?.createdAt)) {
          this.drafts.set(item.threadId, item.createdAt);
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
  }

  #save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const payload = {
      version: 1,
      pendingFirstTurns: [...this.drafts].map(([threadId, createdAt]) => ({ threadId, createdAt })),
    };
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

import { isAbsolute } from "node:path";
import { CodexClient } from "./src/codex-client.mjs";

const [codexCommand, threadId] = process.argv.slice(2);
if (!codexCommand || !isAbsolute(codexCommand)) throw new Error("Codex command path must be absolute");
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(threadId || "")) throw new Error("Invalid thread ID");

const client = new CodexClient({
  command: codexCommand,
  cwd: process.cwd(),
  logger: { info() {}, warn() {}, error() {} },
  initializeTimeoutMs: 30_000,
});
let resumed = false;
try {
  await client.start();
  await client.waitUntilReady(30_000);
  const result = await client.request("thread/resume", { threadId }, 60_000);
  resumed = true;
  const turns = await client.request("thread/turns/list", { threadId, limit: 100 }, 60_000);
  const released = await client.request("thread/unsubscribe", { threadId }, 30_000);
  resumed = false;
  process.stdout.write(`${JSON.stringify({
    threadId,
    status: result?.thread?.status?.type || null,
    turnIds: (turns?.data || []).map((turn) => turn.id),
    releaseStatus: released?.status || null,
  })}\n`);
} finally {
  if (resumed && client.ready) {
    try { await client.request("thread/unsubscribe", { threadId }, 30_000); } catch {}
  }
  await client.stop();
}

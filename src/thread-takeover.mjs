import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.mjs";

const execFileAsync = promisify(execFile);
const PROBE_SCRIPT = fileURLToPath(new URL("./find-thread-writer.ps1", import.meta.url));
const SAFE_THREAD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function normalizeOwner(owner) {
  if (!owner || !Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0) return null;
  return {
    pid: Number(owner.pid),
    startedAt: typeof owner.startedAt === "string" ? owner.startedAt : "",
    executablePath: typeof owner.executablePath === "string" ? owner.executablePath : "",
    commandLine: typeof owner.commandLine === "string" ? owner.commandLine : "",
    parentPid: Number(owner.parentPid) || null,
    ancestorPids: Array.isArray(owner.ancestorPids)
      ? owner.ancestorPids.map(Number).filter((value) => Number.isInteger(value) && value > 0)
      : [],
    threadIds: Array.isArray(owner.threadIds)
      ? owner.threadIds.map(String).filter((value) => SAFE_THREAD_ID.test(value))
      : [],
  };
}

export function isEligibleVsCodeOwner(owner) {
  const executable = String(owner?.executablePath || "").replaceAll("/", "\\").toLowerCase();
  const commandLine = String(owner?.commandLine || "");
  return win32.basename(executable).toLowerCase() === "codex.exe"
    && /\bapp-server\b/i.test(commandLine)
    && Number.isFinite(Date.parse(owner?.startedAt))
    && /\\\.vscode(?:-insiders)?\\extensions\\openai\.chatgpt-[^\\]+\\/.test(executable);
}

export function isProtectedOwner(owner, protectedPids) {
  const protectedSet = new Set((protectedPids || []).map(Number).filter((value) => Number.isInteger(value) && value > 0));
  return protectedSet.has(Number(owner?.pid)) || (owner?.ancestorPids || []).some((pid) => protectedSet.has(Number(pid)));
}

async function powershellProbe(lockPath, {
  command = process.env.BRIDGE_POWERSHELL_COMMAND || "powershell.exe",
  script = PROBE_SCRIPT,
} = {}) {
  const { stdout } = await execFileAsync(command, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-LockPath", lockPath,
  ], {
    windowsHide: true,
    timeout: 12_000,
    maxBuffer: 64 * 1024,
  });
  const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
  return (Array.isArray(parsed.owners) ? parsed.owners : []).map(normalizeOwner).filter(Boolean);
}

async function powershellTerminate(owner, lockPath, {
  command = process.env.BRIDGE_POWERSHELL_COMMAND || "powershell.exe",
  script = PROBE_SCRIPT,
} = {}) {
  try {
    const { stdout } = await execFileAsync(command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-LockPath", lockPath,
      "-Terminate",
      "-ExpectedPid", String(owner.pid),
      "-ExpectedStartedAt", owner.startedAt,
    ], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
    if (parsed.terminated !== true) throw new Error("writer process was not terminated");
  } catch (error) {
    const output = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
    if (/owner (?:PID|start time) changed|exactly one lock owner/i.test(output)) {
      throw new BridgeError("持锁进程已经变化，请重新确认", {
        status: 409,
        code: "takeover_owner_changed",
        retryable: true,
      });
    }
    if (/multiple thread locks/i.test(output)) {
      throw new BridgeError("该桌面 Codex 进程同时持有其他会话，不能安全停止", {
        status: 409,
        code: "takeover_shared_owner",
        retryable: false,
      });
    }
    throw error;
  }
}

function publicOwner(owner) {
  return {
    pid: owner.pid,
    startedAt: owner.startedAt,
    client: "vscode",
    application: "Codex App Server",
    lockedThreadCount: owner.threadIds.length,
  };
}

export class ThreadTakeoverService {
  constructor({
    platform = process.platform,
    codexHome = defaultCodexHome(),
    probeOwners = powershellProbe,
    terminate = powershellTerminate,
    protectedPids = () => [process.pid],
    secret = randomBytes(32),
  } = {}) {
    this.platform = platform;
    this.lockDirectory = resolve(codexHome, "thread-writer-locks");
    this.probeOwners = probeOwners;
    this.terminate = terminate;
    this.protectedPids = protectedPids;
    this.secret = secret;
    this.pending = new Set();
  }

  async inspect(threadId) {
    this.#validateThreadId(threadId);
    if (this.platform !== "win32") return { available: false, reason: "unsupported_platform", owner: null };

    let owners;
    try {
      owners = await this.#owners(threadId);
    } catch {
      throw new BridgeError("无法检查桌面端持锁进程", {
        status: 503,
        code: "takeover_failed",
        retryable: true,
      });
    }
    if (owners.length === 0) return { available: false, reason: "owner_missing", owner: null };
    if (owners.length !== 1) return { available: false, reason: "multiple_owners", owner: null };

    const [owner] = owners;
    if (isProtectedOwner(owner, this.protectedPids())) {
      return { available: false, reason: "protected_owner", owner: { ...publicOwner(owner), client: "bridge" } };
    }
    if (!isEligibleVsCodeOwner(owner)) {
      return { available: false, reason: "unsupported_owner", owner: { ...publicOwner(owner), client: "other" } };
    }
    if (owner.threadIds.length !== 1 || owner.threadIds[0] !== threadId) {
      return { available: false, reason: "shared_owner", owner: publicOwner(owner) };
    }
    return {
      available: true,
      reason: null,
      owner: publicOwner(owner),
      token: this.#token(threadId, owner),
    };
  }

  async takeover(threadId, { token, pid, startedAt } = {}) {
    this.#validateThreadId(threadId);
    if (this.pending.has(threadId)) {
      throw new BridgeError("会话接管正在进行", { status: 409, code: "takeover_busy", retryable: true });
    }
    this.pending.add(threadId);
    try {
      if (token == null) return { ok: true, terminated: false, owner: null };
      const expectedOwner = normalizeOwner({ pid, startedAt });
      if (!expectedOwner || !Number.isFinite(Date.parse(expectedOwner.startedAt))
        || !this.#sameToken(this.#token(threadId, expectedOwner), token)) {
        throw new BridgeError("持锁进程已经变化，请重新确认", {
          status: 409,
          code: "takeover_owner_changed",
          retryable: true,
        });
      }
      const owners = await this.#owners(threadId);
      const currentOwner = owners.length === 1 ? owners[0] : null;
      if (!currentOwner
        || currentOwner.pid !== expectedOwner.pid
        || currentOwner.startedAt !== expectedOwner.startedAt) {
        throw new BridgeError("持锁进程已经变化，请重新确认", {
          status: 409,
          code: "takeover_owner_changed",
          retryable: true,
        });
      }
      if (isProtectedOwner(currentOwner, this.protectedPids()) || !isEligibleVsCodeOwner(currentOwner)) {
        throw new BridgeError("持锁进程已经变化，请重新确认", {
          status: 409,
          code: "takeover_owner_changed",
          retryable: true,
        });
      }
      if (currentOwner.threadIds.length !== 1 || currentOwner.threadIds[0] !== threadId) {
        throw new BridgeError("该桌面 Codex 进程同时持有其他会话，不能安全停止", {
          status: 409,
          code: "takeover_shared_owner",
          retryable: false,
        });
      }
      await this.terminate(currentOwner, this.#lockPath(threadId));
      return { ok: true, terminated: true, owner: publicOwner(currentOwner) };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("无法检查或停止桌面端持锁进程", {
        status: 503,
        code: "takeover_failed",
        retryable: true,
      });
    } finally {
      this.pending.delete(threadId);
    }
  }

  async #owners(threadId) {
    const lockPath = this.#lockPath(threadId);
    if (dirname(lockPath) !== this.lockDirectory || !existsSync(lockPath)) return [];
    return await this.probeOwners(lockPath);
  }

  #lockPath(threadId) {
    return resolve(this.lockDirectory, `${threadId}.lock`);
  }

  #validateThreadId(threadId) {
    if (!SAFE_THREAD_ID.test(String(threadId || ""))) {
      throw new BridgeError("会话标识无效", { status: 400, code: "invalid_id" });
    }
  }

  #token(threadId, owner) {
    return createHmac("sha256", this.secret)
      .update(`${threadId}\0${owner.pid}\0${owner.startedAt}`)
      .digest("base64url");
  }

  #sameToken(expected, actual) {
    if (typeof actual !== "string" || actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }
}

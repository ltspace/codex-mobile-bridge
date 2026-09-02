import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";

export class RpcError extends Error {
  constructor(method, error) {
    super(error?.message || `${method} failed`);
    this.name = "RpcError";
    this.method = method;
    this.code = error?.code ?? "rpc_error";
    this.data = error?.data;
    this.retryable = error?.code === -32001;
  }
}

export function resolveSpawnSpec(command, args, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const codexJs = join(dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(codexJs)) return { command: process.execPath, args: [codexJs, ...args] };
  }
  return { command, args };
}

export class CodexClient extends EventEmitter {
  constructor({ command, args = ["app-server", "--stdio"], cwd, env = process.env, logger = console } = {}) {
    super();
    this.command = command || "codex";
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.env = env;
    this.logger = logger;
    this.rpcId = 0;
    this.pending = new Map();
    this.child = null;
    this.reader = null;
    this.restartTimer = null;
    this.desired = false;
    this.restartCount = 0;
    this.restartAttempts = 0;
    this.status = "stopped";
    this.error = null;
    this.lastReadyAt = null;
    this.lastExit = null;
  }

  get ready() {
    return this.status === "ready" && Boolean(this.child?.stdin?.writable);
  }

  snapshot() {
    return {
      status: this.status,
      ready: this.ready,
      pid: this.child?.pid || null,
      restartCount: this.restartCount,
      restartAttempts: this.restartAttempts,
      lastReadyAt: this.lastReadyAt,
      lastExit: this.lastExit,
      error: this.error,
      pendingRpc: this.pending.size,
    };
  }

  async start() {
    this.desired = true;
    if (this.child || this.status === "starting" || this.ready) return;
    await this.#launch();
  }

  async stop() {
    this.desired = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.#setStatus("stopped", null);
      return;
    }
    this.#setStatus("stopping", null);
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.ready) return Promise.reject(new Error(this.error || "Codex app-server is not ready"));
    return this.#requestRaw(method, params, timeoutMs);
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  reply(id, result) {
    this.#write({ id, result });
  }

  async waitUntilReady(timeoutMs = 30_000) {
    if (this.ready) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(this.error || "Codex app-server readiness timed out"));
      }, timeoutMs);
      const onState = (snapshot) => {
        if (snapshot.ready) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("state", onState);
      };
      this.on("state", onState);
    });
  }

  async #launch() {
    if (!this.desired || this.child) return;
    this.#setStatus("starting", null);
    const spec = resolveSpawnSpec(this.command, this.args);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#failedLaunch(error);
      return;
    }
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.logger.error(`[app-server] ${String(chunk).trimEnd()}`));
    child.once("error", (error) => this.#failedLaunch(error));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.#handleLine(line));

    try {
      await this.#requestRaw("initialize", {
        clientInfo: { name: "codex_mobile_bridge", title: "Codex Mobile Bridge", version: "0.5.0" },
        capabilities: { experimentalApi: true },
      }, 30_000);
      this.#write({ method: "initialized", params: {} });
      this.restartAttempts = 0;
      this.lastReadyAt = new Date().toISOString();
      this.#setStatus("ready", null);
    } catch (error) {
      this.error = `Initialization failed: ${error.message}`;
      this.logger.error(`[bridge] ${this.error}`);
      child.kill("SIGTERM");
    }
  }

  #requestRaw(method, params, timeoutMs) {
    const id = ++this.rpcId;
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      let observed = false;
      const observe = (outcome) => {
        if (observed) return;
        observed = true;
        this.emit("rpc", { method, outcome, durationMs: performance.now() - startedAt });
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method} timed out after ${timeoutMs}ms`);
        error.code = "rpc_timeout";
        error.retryable = true;
        observe("timeout");
        reject(error);
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); observe("ok"); resolve(value); },
        reject: (error) => { clearTimeout(timer); observe("error"); reject(error); },
      });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        observe("error");
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error(this.error || "Codex app-server is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.error("[bridge] Ignored non-JSON app-server output");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new RpcError(waiter.method, message.error));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.reader?.close();
    this.reader = null;
    this.child = null;
    this.lastExit = { at: new Date().toISOString(), code, signal };
    const message = `Codex app-server exited (${code ?? signal ?? "unknown"})`;
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
    if (!this.desired) {
      this.#setStatus("stopped", null);
      return;
    }
    this.restartCount += 1;
    this.restartAttempts += 1;
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(this.restartAttempts - 1, 5)));
    this.#setStatus("restarting", `${message}; retrying in ${delayMs}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.#launch();
    }, delayMs);
    this.restartTimer.unref();
  }

  #failedLaunch(error) {
    if (this.child && this.child.exitCode == null) return;
    this.child = null;
    this.error = `Unable to start Codex app-server: ${error.message}`;
    this.#setStatus("restarting", this.error);
    if (this.desired && !this.restartTimer) {
      this.restartCount += 1;
      this.restartAttempts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.#launch();
      }, Math.min(30_000, this.restartAttempts * 2_000));
      this.restartTimer.unref();
    }
  }

  #setStatus(status, error) {
    this.status = status;
    this.error = error;
    this.emit("state", this.snapshot());
  }
}

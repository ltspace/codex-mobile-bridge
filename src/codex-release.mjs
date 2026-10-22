import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveSpawnSpec } from "./codex-client.mjs";

export function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Refusing non-stable version: ${String(value).slice(0, 100)}`);
  }
  return value;
}

export function isNewer(candidate, current) {
  const a = stableVersion(candidate).split(".").map(BigInt);
  const b = stableVersion(current).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function run(command, args, { timeout = 30_000, env = process.env } = {}) {
  const spec = resolveSpawnSpec(command, args);
  return new Promise((resolveRun, reject) => {
    const child = spawn(spec.command, spec.args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-256_000); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-16_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Command exited ${code}: ${stderr.slice(-2000)}`));
      else resolveRun(stdout.trim());
    });
  });
}

async function commandVersion(command) {
  const output = await run(command, ["--version"]);
  const match = /^codex-cli (\d+\.\d+\.\d+)$/m.exec(output);
  if (!match) throw new Error("Cannot determine installed stable Codex CLI version; refusing automatic replacement.");
  return stableVersion(match[1]);
}

export async function prepareRelease({ root, currentCommand, npmCli, checkOnly = false }) {
  if (!existsSync(npmCli)) throw new Error(`npm CLI not found: ${npmCli}`);
  const fromVersion = await commandVersion(currentCommand);
  // Use npm's registry/proxy support, but always verify TLS and the public registry.
  const npmEnv = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "1", npm_config_strict_ssl: "true" };
  const registry = ["--registry=https://registry.npmjs.org", "--strict-ssl=true", "--fetch-retries=1", "--fetch-timeout=30000"];
  const version = stableVersion(JSON.parse(await run(process.execPath, [npmCli, "view", "@openai/codex@latest", "version", "--json", ...registry], { env: npmEnv, timeout: 90_000 })));
  if (!isNewer(version, fromVersion)) return { status: "up_to_date", fromVersion, version };
  if (checkOnly) return { status: "available", fromVersion, version };
  const runtimes = join(root, "state", "codex-runtimes");
  const destination = join(runtimes, version);
  const command = join(destination, "codex.cmd");
  if (existsSync(destination)) {
    if (await commandVersion(command) !== version) throw new Error("Previously staged runtime failed version validation.");
  } else {
    await mkdir(runtimes, { recursive: true });
    const staging = join(runtimes, `.install-${version}-${randomUUID()}`);
    await run(process.execPath, [npmCli, "install", "--global", "--prefix", staging, `@openai/codex@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", ...registry], { env: npmEnv, timeout: 300_000 });
    if (await commandVersion(join(staging, "codex.cmd")) !== version) throw new Error("Downloaded runtime version mismatch.");
    await rename(staging, destination);
    if (await commandVersion(command) !== version) throw new Error("Staged runtime failed relocation validation.");
  }
  return { status: "prepared", fromVersion, version, command };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = await prepareRelease({ root, currentCommand: process.argv[3], npmCli: process.argv[2], checkOnly: process.argv.includes("--check-only") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

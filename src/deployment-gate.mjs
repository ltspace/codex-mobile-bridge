import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// The config selects the only writer. The short lease freezes that writer while
// a candidate loads its persisted state. A crashed updater cannot freeze it forever.
export class DeploymentGate {
  constructor(stateFile, port) {
    this.configPath = join(dirname(stateFile), "config.json");
    this.leasePath = join(dirname(stateFile), "deployment-lease.json");
    this.port = port;
    this.inFlight = 0;
  }

  snapshot() {
    try {
      const config = readJson(this.configPath);
      const lease = readJson(this.leasePath);
      const standby = Boolean(config?.localPort && Number(config.localPort) !== this.port);
      const draining = Boolean(lease && Date.parse(lease.expiresAt) > Date.now());
      return { supported: true, blocked: standby || draining, standby, draining, inFlight: this.inFlight };
    } catch {
      return { supported: true, blocked: true, error: "deployment_state_unreadable", inFlight: this.inFlight };
    }
  }
}

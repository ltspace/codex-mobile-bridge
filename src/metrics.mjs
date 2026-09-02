function rounded(value) {
  return Math.round(value * 100) / 100;
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

export class BridgeMetrics {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.http = {
      requestsTotal: 0,
      activeRequests: 0,
      errorsTotal: 0,
      durationCount: 0,
      durationTotalMs: 0,
      durationMaxMs: 0,
      byStatus: {},
      byRoute: {},
    };
    this.rpc = {
      requestsTotal: 0,
      errorsTotal: 0,
      timeoutsTotal: 0,
      durationCount: 0,
      durationTotalMs: 0,
      durationMaxMs: 0,
      byMethod: {},
    };
  }

  beginHttp() {
    this.http.activeRequests += 1;
  }

  recordHttp({ route, status, durationMs }) {
    this.http.activeRequests = Math.max(0, this.http.activeRequests - 1);
    this.http.requestsTotal += 1;
    this.http.durationCount += 1;
    this.http.durationTotalMs += durationMs;
    this.http.durationMaxMs = Math.max(this.http.durationMaxMs, durationMs);
    if (status >= 400) this.http.errorsTotal += 1;
    increment(this.http.byStatus, String(status));
    increment(this.http.byRoute, route);
  }

  recordRpc({ method, outcome, durationMs }) {
    this.rpc.requestsTotal += 1;
    this.rpc.durationCount += 1;
    this.rpc.durationTotalMs += durationMs;
    this.rpc.durationMaxMs = Math.max(this.rpc.durationMaxMs, durationMs);
    if (outcome !== "ok") this.rpc.errorsTotal += 1;
    if (outcome === "timeout") this.rpc.timeoutsTotal += 1;
    increment(this.rpc.byMethod, method);
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      http: {
        requestsTotal: this.http.requestsTotal,
        activeRequests: this.http.activeRequests,
        errorsTotal: this.http.errorsTotal,
        averageDurationMs: this.http.durationCount ? rounded(this.http.durationTotalMs / this.http.durationCount) : 0,
        maxDurationMs: rounded(this.http.durationMaxMs),
        byStatus: { ...this.http.byStatus },
        byRoute: { ...this.http.byRoute },
      },
      rpc: {
        requestsTotal: this.rpc.requestsTotal,
        errorsTotal: this.rpc.errorsTotal,
        timeoutsTotal: this.rpc.timeoutsTotal,
        averageDurationMs: this.rpc.durationCount ? rounded(this.rpc.durationTotalMs / this.rpc.durationCount) : 0,
        maxDurationMs: rounded(this.rpc.durationMaxMs),
        byMethod: { ...this.rpc.byMethod },
      },
    };
  }
}

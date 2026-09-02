export function reconnectDelay(attempt, random = Math.random) {
  const base = Math.min(15_000, 1_000 * (2 ** Math.min(Math.max(0, attempt), 4)));
  return Math.round(base * (0.8 + random() * 0.4));
}

export function eventStreamUrl({ lastEventId = null, instanceId = null } = {}) {
  const query = new URLSearchParams();
  if (lastEventId) query.set("lastEventId", String(lastEventId));
  if (instanceId) query.set("instanceId", String(instanceId));
  const suffix = query.toString();
  return `/api/events${suffix ? `?${suffix}` : ""}`;
}

export class EventStreamController {
  constructor({
    onEvent,
    onOpen,
    onOffline,
    onPing,
    eventSourceFactory = (url) => new EventSource(url),
    now = () => Date.now(),
    random = Math.random,
  }) {
    this.onEvent = onEvent;
    this.onOpen = onOpen;
    this.onOffline = onOffline;
    this.onPing = onPing;
    this.eventSourceFactory = eventSourceFactory;
    this.now = now;
    this.random = random;
    this.source = null;
    this.timer = null;
    this.attempt = 0;
    this.lastEventAt = 0;
    this.lastEventId = null;
    this.instanceId = null;
    this.running = false;
  }

  start() {
    this.running = true;
    this.#open();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.source?.close();
    this.source = null;
  }

  wake() {
    if (!this.running) this.running = true;
    if (this.source && this.now() - this.lastEventAt <= 45_000) return;
    this.#restart(0);
  }

  checkLiveness() {
    if (!this.running || !this.source || this.now() - this.lastEventAt <= 45_000) return true;
    this.#restart(0);
    return false;
  }

  #open() {
    if (!this.running || this.source || globalThis.navigator?.onLine === false) return;
    const source = this.eventSourceFactory(eventStreamUrl(this));
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.attempt = 0;
      this.lastEventAt = this.now();
      this.onOpen?.();
    };
    source.addEventListener("codex", (message) => {
      if (this.source !== source) return;
      this.lastEventAt = this.now();
      if (message.lastEventId) this.lastEventId = message.lastEventId;
      try {
        const event = JSON.parse(message.data);
        const instanceId = event?.params?.eventStream?.instanceId;
        if (instanceId) this.instanceId = instanceId;
        this.onEvent?.(event);
      } catch {
        // Ignore malformed event frames; a later snapshot reconciles state.
      }
    });
    source.addEventListener("bridge-ping", (message) => {
      if (this.source !== source) return;
      this.lastEventAt = this.now();
      this.onPing?.(message);
    });
    source.onerror = () => {
      if (this.source !== source) return;
      source.close();
      this.source = null;
      this.onOffline?.();
      this.#schedule();
    };
  }

  #schedule() {
    if (!this.running || this.timer || globalThis.navigator?.onLine === false) return;
    const delay = reconnectDelay(this.attempt++, this.random);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#open();
    }, delay);
  }

  #restart(delay) {
    clearTimeout(this.timer);
    this.timer = null;
    this.source?.close();
    this.source = null;
    if (!this.running) return;
    if (delay > 0) this.#schedule();
    else this.#open();
  }
}

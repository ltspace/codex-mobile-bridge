const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function createPwaController({
  navigatorRef = globalThis.navigator,
  onError = () => {},
} = {}) {
  const serviceWorker = navigatorRef?.serviceWorker;
  let registration = null;
  let lastUpdateCheck = 0;
  let started = false;

  async function start() {
    if (started) return registration;
    started = true;

    if (!serviceWorker?.register) return null;

    try {
      registration = await serviceWorker.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none",
      });
      return registration;
    } catch (error) {
      onError(error);
      return null;
    }
  }

  async function checkForUpdate({ force = false } = {}) {
    if (!registration?.update) return false;
    const now = Date.now();
    if (!force && now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return false;
    lastUpdateCheck = now;
    try {
      await registration.update();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  return { start, checkForUpdate };
}

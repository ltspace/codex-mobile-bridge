import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createPwaController } from "../public/modules/pwa.js";

const ROOT = resolve(import.meta.dirname, "..");

test("PWA controller registers once and checks for updates without UI", async () => {
  let registrations = 0;
  let updateChecks = 0;
  const registration = { update: async () => { updateChecks += 1; } };
  const serviceWorker = {
    register: async (path, options) => {
      registrations += 1;
      assert.equal(path, "/service-worker.js");
      assert.deepEqual(options, { scope: "/", updateViaCache: "none" });
      return registration;
    },
  };
  const controller = createPwaController({
    navigatorRef: { serviceWorker },
  });

  await controller.start();
  await controller.start();
  assert.equal(registrations, 1);
  assert.equal(await controller.checkForUpdate({ force: true }), true);
  assert.equal(updateChecks, 1);
});

test("PWA behavior remains background-only without custom bars or install prompts", async () => {
  const [controllerSource, appSource, pageSource] = await Promise.all([
    readFile(resolve(ROOT, "public", "modules", "pwa.js"), "utf8"),
    readFile(resolve(ROOT, "public", "app.js"), "utf8"),
    readFile(resolve(ROOT, "public", "index.html"), "utf8"),
  ]);
  assert.doesNotMatch(controllerSource, /beforeinstallprompt|\.prompt\(\)/);
  assert.doesNotMatch(appSource, /pwaNotice|installAvailable|manualInstall/);
  assert.doesNotMatch(pageSource, /pwaNotice/);
});

test("service worker shell is complete, versioned, and excludes private API data", async () => {
  const [source, packageSource] = await Promise.all([
    readFile(resolve(ROOT, "public", "service-worker.js"), "utf8"),
    readFile(resolve(ROOT, "package.json"), "utf8"),
  ]);
  const shellBlock = source.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] || "";
  const shellPaths = [...shellBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const packageVersion = JSON.parse(packageSource).version;
  assert.match(source, new RegExp(`const APP_VERSION = "${packageVersion.replaceAll(".", "\\.")}"`));
  assert.equal(shellPaths.some((path) => path.startsWith("/api/")), false);
  for (const path of shellPaths.filter((path) => path !== "/")) {
    assert.equal(existsSync(resolve(ROOT, "public", path.slice(1))), true, `missing shell asset ${path}`);
  }
  const installBlock = source.slice(source.indexOf('self.addEventListener("install"'), source.indexOf('self.addEventListener("activate"'));
  assert.doesNotMatch(installBlock, /skipWaiting/);
  assert.doesNotMatch(source, /skipWaiting/);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /request\.mode === "navigate"/);
});

import { readFileSync } from "node:fs";

// Applied only to Codex children; the bridge's local HTTP and Tailscale traffic
// must not inherit an upstream proxy. Never modify the machine/user environment.
export function codexEnvironment(configPath, env = process.env) {
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const proxy = env.BRIDGE_CODEX_PROXY_URL ?? config.codexProxyUrl;
  if (!proxy) return { ...env };
  const url = new URL(proxy);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("codexProxyUrl must be an HTTP(S) proxy URL without embedded credentials");
  }
  const bypass = env.BRIDGE_CODEX_NO_PROXY ?? config.codexNoProxy
    ?? env.NO_PROXY ?? env.no_proxy ?? "localhost,127.0.0.1,::1,.local";
  return {
    ...env,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NO_PROXY: bypass, no_proxy: bypass,
  };
}

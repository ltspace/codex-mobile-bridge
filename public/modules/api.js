import { t } from "./i18n.js";

export function errorInfo(error) {
  const info = error?.bridgeError || { code: "network_error", message: error?.message, retryable: true };
  const key = `errors.${info.code}`;
  const localized = t(key, info.details || {});
  return { ...info, message: localized === key ? (info.message || t("errors.network_error")) : localized };
}

export async function api(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const info = typeof value.error === "object"
        ? value.error
        : { code: `http_${response.status}`, message: value.error || `HTTP ${response.status}`, retryable: response.status >= 500 };
      const error = new Error(info.message);
      error.bridgeError = info;
      error.status = response.status;
      throw error;
    }
    return value;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error(t("errors.timeout"));
      timeout.bridgeError = { code: "timeout", message: timeout.message, retryable: true };
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

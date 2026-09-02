const CONVERSATION_TYPES = new Set([
  "usermessage",
  "agentmessage",
  "assistantmessage",
]);

function clipped(value, limit) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function textFrom(value, depth = 0) {
  if (value == null || depth > 5) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => textFrom(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  for (const key of ["text", "message", "command", "query", "name", "tool", "summary", "output", "aggregatedOutput", "content"]) {
    const text = textFrom(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function statusText(item) {
  const status = typeof item?.status === "string" ? item.status : item?.status?.type;
  return status ? ` · ${status}` : "";
}

export function compactThreadItem(item, { summaryLimit = 320 } = {}) {
  if (!item || typeof item !== "object") return item;
  const type = String(item.type || item.kind || "item");
  if (CONVERSATION_TYPES.has(type.toLowerCase())) return item;

  const label = item.tool || item.name || item.server || type;
  const detail = clipped(textFrom(item), summaryLimit);
  const summary = clipped(`${label}${statusText(item)}${detail && detail !== label ? `\n${detail}` : ""}`, summaryLimit);
  return {
    id: item.id || null,
    type,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.role ? { role: item.role } : {}),
    ...(item.status ? { status: item.status } : {}),
    text: summary || type,
    compact: true,
    detailAvailable: Boolean(item.id),
  };
}

export function compactTurnPage(result, options = {}) {
  const data = Array.isArray(result?.data) ? result.data : [];
  return {
    ...result,
    data: data.map((turn) => ({
      ...turn,
      items: Array.isArray(turn?.items)
        ? turn.items.map((item) => compactThreadItem(item, options))
        : [],
    })),
    compact: true,
  };
}

export function deltaFromTurnPage(result, knownTurnId) {
  const data = Array.isArray(result?.data) ? result.data : [];
  if (!knownTurnId) return { ...result, resetRequired: false };
  const knownIndex = data.findIndex((turn) => turn?.id === knownTurnId);
  if (knownIndex < 0) return { ...result, resetRequired: true };
  return {
    ...result,
    data: data.slice(0, knownIndex + 1),
    nextCursor: null,
    resetRequired: false,
  };
}

export function findThreadItem(result, itemId) {
  for (const entry of result?.data || []) {
    const item = entry?.item || entry;
    if (item?.id === itemId) return { turnId: entry?.turnId || null, item };
  }
  return null;
}

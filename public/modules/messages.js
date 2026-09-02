import { t } from "./i18n.js";
import { markdownToHtml } from "./markdown.js";

export function createMessageView({ elements, state, toast, onLoadOlder, onLoadDetail, onCancelQueued }) {
  function emptyState(title, detail, symbol = "⌁") {
    const node = document.createElement("div");
    node.className = "empty-state";
    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = symbol;
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = detail;
    node.append(icon, strong, small);
    return node;
  }

  function appendTextBlock(container, text) {
    if (!text) return;
    for (const paragraph of text.split(/\n{2,}/)) {
      if (!paragraph) continue;
      const node = document.createElement("p");
      node.textContent = paragraph;
      container.append(node);
    }
  }

  function renderRichText(container, text, markdown = false) {
    container.replaceChildren();
    if (markdown) {
      container.innerHTML = markdownToHtml(text);
      for (const button of container.querySelectorAll("[data-copy-code]")) {
        button.title = t("message.copyCode");
        button.setAttribute("aria-label", t("message.copyCode"));
        button.addEventListener("click", () => copyText(button.closest(".code-block")?.querySelector("code")?.textContent || "", button));
      }
      return;
    }
    const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let cursor = 0;
    let match;
    while ((match = fence.exec(text))) {
      appendTextBlock(container, text.slice(cursor, match.index));
      const pre = document.createElement("pre");
      if (match[1].trim()) {
        const language = document.createElement("span");
        language.className = "code-language";
        language.textContent = match[1].trim();
        pre.append(language);
      }
      const code = document.createElement("code");
      code.textContent = match[2].replace(/\n$/, "");
      pre.append(code);
      container.append(pre);
      cursor = fence.lastIndex;
    }
    appendTextBlock(container, text.slice(cursor));
  }

  async function copyText(text, button) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const helper = document.createElement("textarea");
        helper.value = text;
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.append(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      button.textContent = "✓";
      button.classList.add("copied");
      setTimeout(() => { button.textContent = "⧉"; button.classList.remove("copied"); }, 1200);
    } catch {
      toast(t("message.copyFailed"));
    }
  }

  function messageNode(entry) {
    if (entry.role === "tool") {
      const details = document.createElement("details");
      details.className = "tool-message";
      const summary = document.createElement("summary");
      summary.textContent = entry.type || t("message.toolEvent");
      const content = document.createElement("pre");
      content.textContent = entry.text;
      details.append(summary, content);
      if (entry.detailAvailable) {
        const load = document.createElement("button");
        load.type = "button";
        load.className = "tool-detail-button";
        load.textContent = t("message.loadDetail");
        load.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          load.disabled = true;
          load.textContent = t("actions.loading");
          try {
            const text = await onLoadDetail?.(entry);
            if (text) content.textContent = text;
            entry.detailAvailable = false;
            load.remove();
            details.open = true;
          } catch {
            load.disabled = false;
            load.textContent = t("message.loadDetail");
            toast(t("message.detailFailed"));
          }
        });
        details.append(load);
      }
      return details;
    }

    const box = document.createElement("article");
    box.className = `message ${entry.role}${entry.pending ? " pending" : ""}${entry.queueId ? " queued" : ""}`;
    box.dataset.entryId = entry.id;
    const head = document.createElement("div");
    head.className = "message-head";
    const label = document.createElement("span");
    label.textContent = entry.queueId
      ? `${t("message.you")} · ${t("message.queued")}`
      : entry.role === "user" ? t("message.you") : "Codex";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-copy";
    copy.textContent = "⧉";
    copy.title = t("message.copy");
    copy.setAttribute("aria-label", t("message.copy"));
    copy.addEventListener("click", () => copyText(entry.text, copy));
    head.append(label);
    if (entry.queueId) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "message-cancel";
      cancel.textContent = t("actions.cancelQueued");
      cancel.disabled = Boolean(entry.cancelling);
      cancel.addEventListener("click", () => onCancelQueued?.(entry));
      head.append(cancel);
    }
    head.append(copy);
    const body = document.createElement("div");
    body.className = "message-body";
    renderRichText(body, entry.text, entry.role === "agent");
    box.append(head, body);
    return box;
  }

  function isNearBottom() {
    return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 100;
  }

  function scrollToBottom(smooth = true) {
    elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    elements.scrollBottom.classList.add("hidden");
  }

  function renderMessages({ preserveTop = false, previousHeight = 0 } = {}) {
    const nodes = [];
    if (state.historyCursor) {
      const older = document.createElement("button");
      older.type = "button";
      older.className = "load-older";
      older.textContent = state.historyLoading ? t("actions.loading") : t("actions.loadOlder");
      older.disabled = state.historyLoading;
      older.addEventListener("click", onLoadOlder);
      nodes.push(older);
    }
    const entries = [...state.historyItems, ...state.queuedMessages];
    for (const entry of entries) nodes.push(messageNode(entry));
    if (!entries.length && state.selected) nodes.push(emptyState(t("threads.empty"), t("threads.emptyHelp"), "＋"));
    if (!state.selected) nodes.push(emptyState(t("threads.noneSelected"), t("threads.selectHelp"), "⌁"));
    elements.messages.replaceChildren(...nodes);
    if (preserveTop) elements.messages.scrollTop = elements.messages.scrollHeight - previousHeight;
    else scrollToBottom(false);
  }

  return {
    emptyState,
    isNearBottom,
    renderMessages,
    scrollToBottom,
    renderEntryBody: (container, entry) => renderRichText(container, entry.text, entry.role === "agent"),
  };
}

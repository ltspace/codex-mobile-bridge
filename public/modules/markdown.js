function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(value) {
  const href = String(value || "").replaceAll("&amp;", "&").trim();
  if (/^(https?:|mailto:)/i.test(href) || /^(?:[./?#]|\.\.\/)/.test(href)) return href;
  return null;
}

function isLocalFileHref(value) {
  const href = String(value || "").replaceAll("&amp;", "&").trim();
  return /^(?:file:\/{2,3}|[a-z]:[\\/])/i.test(href);
}

function restoreTokens(value, tokens) {
  return value.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] || "");
}

export function renderInlineMarkdown(source) {
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return `\uE000${tokens.length - 1}\uE001`;
  };
  let value = escapeHtml(source);

  value = value.replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => stash(`<code>${code.replace(/^ | $/g, "")}</code>`));
  value = value.replace(/\[([^\]\n]+)]\(\s*([^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g, (_, label, target) => {
    const href = safeHref(target);
    if (!href) return stash(`<span class="${isLocalFileHref(target) ? "file-reference" : "invalid-link"}">${label}</span>`);
    return stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  value = value.replace(/&lt;((?:https?:\/\/|mailto:)[^&\s]+)&gt;/gi, (_, target) => {
    const href = safeHref(target);
    return href ? stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${target}</a>`) : target;
  });
  value = value.replace(/(^|[\s(])((?:https?:\/\/)[^\s<\uE000]+)/gi, (match, prefix, rawTarget) => {
    const trailing = rawTarget.match(/[),.;!?]+$/)?.[0] || "";
    const target = trailing ? rawTarget.slice(0, -trailing.length) : rawTarget;
    const href = safeHref(target);
    return href ? `${prefix}${stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${target}</a>`)}${trailing}` : match;
  });

  value = value
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/ {2}\n/g, "<br>")
    .replace(/\n/g, "<br>");

  return restoreTokens(value, tokens);
}

function splitTableRow(line) {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of source) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      if (character !== "\\" || escaped) cell += character;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableDivider(line) {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length < 2 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left");
}

function fenceAt(line) {
  return line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
}

function listAt(line) {
  return line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
}

function beginsBlock(lines, index) {
  const line = lines[index] || "";
  return Boolean(
    fenceAt(line)
    || line.trim() === "<skill-citation>"
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || listAt(line)
    || (index + 1 < lines.length && line.includes("|") && tableDivider(lines[index + 1])),
  );
}

function skillCitationAt(lines, index) {
  if (lines[index]?.trim() !== "<skill-citation>") return null;
  const paths = [];
  let cursor = index + 1;
  while (cursor < lines.length && lines[cursor].trim() !== "</skill-citation>") {
    const path = lines[cursor].trim();
    if (path) paths.push(path);
    cursor += 1;
  }
  if (cursor >= lines.length) return null;
  return { paths, nextIndex: cursor + 1 };
}

function skillName(path) {
  const parts = String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "skill.md") parts.pop();
  return parts.at(-1) || "Skill";
}

function renderSkillCitations(paths) {
  return paths.map((path) => `<details class="citation-card skill-citation"><summary><span class="citation-kind">Skill</span><span class="citation-name">${escapeHtml(skillName(path))}</span></summary><code>${escapeHtml(path)}</code></details>`).join("");
}

export function markdownToHtml(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const skillCitation = skillCitationAt(lines, index);
    if (skillCitation) {
      output.push(renderSkillCitations(skillCitation.paths));
      index = skillCitation.nextIndex;
      continue;
    }

    const fence = fenceAt(lines[index]);
    if (fence) {
      const marker = fence[1];
      const language = fence[2] || "";
      const code = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(`<div class="code-block"><div class="code-block-bar"><span>${escapeHtml(language)}</span><button type="button" data-copy-code>⧉</button></div><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
      continue;
    }

    const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(lines[index])) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s{0,3}> ?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const list = listAt(lines[index]);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const start = ordered ? Number.parseInt(list[1], 10) : 1;
      const items = [];
      while (index < lines.length) {
        const item = listAt(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        let body = item[2];
        index += 1;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !listAt(lines[index])) {
          body += `\n${lines[index].trim()}`;
          index += 1;
        }
        const task = body.match(/^\[([ xX])]\s+(.+)$/);
        items.push(task
          ? `<li class="task-item"><input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> <span>${renderInlineMarkdown(task[2])}</span></li>`
          : `<li>${renderInlineMarkdown(body)}</li>`);
      }
      const tag = ordered ? "ol" : "ul";
      const startAttribute = ordered && start !== 1 ? ` start="${start}"` : "";
      output.push(`<${tag}${startAttribute}>${items.join("")}</${tag}>`);
      continue;
    }

    const alignment = index + 1 < lines.length ? tableDivider(lines[index + 1]) : null;
    if (alignment && lines[index].includes("|")) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const cells = (values, tag) => values.map((value, cellIndex) => `<${tag} class="align-${alignment[cellIndex] || "left"}">${renderInlineMarkdown(value)}</${tag}>`).join("");
      output.push(`<div class="table-wrap"><table><thead><tr>${cells(headers, "th")}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const paragraph = [lines[index]];
    index += 1;
    while (index < lines.length && lines[index].trim() && !beginsBlock(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
  }

  return output.join("");
}

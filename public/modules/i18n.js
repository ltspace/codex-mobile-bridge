const STORAGE_KEY = "codexBridge.language";
const SUPPORTED = new Set(["en", "zh-CN"]);

const messages = {
  en: {
    "app.subtitle": "Mobile console",
    "language.switch": "Switch to Chinese",
    "theme.useLight": "Switch to light mode",
    "theme.useDark": "Switch to dark mode",
    "connection.inspect": "View connection status",
    "connection.connecting": "Connecting",
    "connection.online": "Online",
    "connection.offline": "Disconnected",
    "connection.initialTitle": "Connecting to Codex",
    "connection.initialHelp": "The first connection may take a few seconds",
    "actions.new": "New",
    "actions.refresh": "Refresh",
    "actions.retry": "Retry",
    "actions.close": "Close",
    "actions.cancel": "Cancel",
    "actions.create": "Create conversation",
    "actions.stop": "Stop",
    "actions.send": "Send",
    "actions.steer": "Add instruction",
    "actions.allow": "Allow",
    "actions.allowSession": "Allow for session",
    "actions.decline": "Decline",
    "actions.submit": "Submit answer",
    "actions.recheck": "Check again",
    "actions.loadMore": "Load more conversations",
    "actions.loading": "Loading…",
    "actions.loadOlder": "Load 10 older turns",
    "menu.open": "Open conversation list",
    "menu.close": "Close conversation list",
    "menu.actions": "More actions",
    "menu.closeActions": "Close actions",
    "threads.list": "Conversation list",
    "threads.search": "Search conversations",
    "threads.count": "{count} conversations",
    "threads.recentFirst": "Recently updated first",
    "threads.loading": "Loading conversations…",
    "threads.noMatches": "No matching conversations",
    "threads.none": "No Codex conversations found",
    "threads.untitled": "Untitled conversation",
    "threads.running": "Running",
    "threads.unknownTime": "Time unknown",
    "threads.noCwd": "Working directory not recorded",
    "threads.select": "Select a Codex conversation",
    "threads.selectHelp": "Open one from the list or create a new one",
    "threads.reading": "Loading conversation",
    "threads.recentTurns": "Loading the latest 10 turns…",
    "threads.empty": "This conversation is empty",
    "threads.emptyHelp": "Send the first message to begin",
    "threads.noneSelected": "No conversation selected",
    "turn.idle": "Idle",
    "turn.running": "Working",
    "turn.runningElsewhere": "Running in another client",
    "turn.failed": "Failed",
    "turn.stopped": "Stopped",
    "turn.completed": "Complete",
    "turn.codexFailed": "Codex task failed",
    "composer.placeholder": "Send a message to Codex…",
    "composer.select": "Select a conversation first",
    "composer.disconnected": "Bridge is disconnected",
    "composer.otherClient": "This conversation is running in another client",
    "composer.steerHint": "Your message will be added to the active task",
    "composer.keyboardHint": "Enter to send · Shift + Enter for a new line",
    "message.you": "You",
    "message.copy": "Copy message",
    "message.copyCode": "Copy code",
    "message.copyFailed": "Copy failed; touch and hold the text to copy",
    "message.toolEvent": "Tool event",
    "message.steer": "Additional instruction",
    "message.sendFailed": "Send failed",
    "message.jumpLatest": "Jump to newest message",
    "message.loadDetail": "Load full details",
    "message.detailFailed": "Could not load full details",
    "toast.steered": "Instruction added",
    "toast.stopSent": "Stop request sent",
    "toast.submitted": "Submitted",
    "toast.refreshed": "Refreshed",
    "trust.fullAccess": "Full access",
    "trust.tailnetOnly": "Trusted Tailscale devices only",
    "request.approval": "Codex requests approval",
    "request.userInput": "Codex needs your answer",
    "request.pending": "Pending request",
    "request.allowPrompt": "Allow this action?",
    "request.unsupported": "This mobile client does not support {method}. Handle it on the computer.",
    "request.question": "Question",
    "new.title": "New conversation",
    "new.description": "Choose a working directory on this computer.",
    "new.cwd": "Working directory",
    "new.cwdPlaceholder": "C:\\path\\to\\project",
    "new.chooseRecent": "Choose a recent directory",
    "new.ephemeral": "Temporary conversation (do not retain after closing)",
    "new.loadingWorkspaces": "Loading recent directories…",
    "new.workspacesFound": "Found {count} recently used directories",
    "new.enterAbsolute": "Enter an absolute directory on this computer",
    "new.creating": "Creating conversation…",
    "new.missingId": "The conversation was created but no ID was returned",
    "status.title": "Connection status",
    "status.description": "Live status for the computer, bridge, and Codex App Server.",
    "status.bridge": "Bridge",
    "status.ready": "ready",
    "status.notReady": "not ready",
    "status.uptime": "Uptime",
    "status.seconds": "{count} seconds",
    "status.unknown": "unknown",
    "status.appServer": "App Server",
    "status.restarts": "Automatic restarts",
    "status.times": "{count}",
    "status.eventClients": "Event connections",
    "status.activeTasks": "Active tasks",
    "status.http": "HTTP requests",
    "status.rpc": "App Server RPC",
    "status.metric": "{count} · avg {average} ms · {errors} errors",
    "status.permissions": "Execution permissions",
    "date.now": "just now",
    "date.minutesAgo": "{count} minutes ago",
    "date.hoursAgo": "{count} hours ago",
    "errors.network_error": "Network request failed",
    "errors.timeout": "Connection timed out; try again",
    "errors.invalid_cwd": "Choose a valid absolute directory",
    "errors.cwd_unavailable": "The directory does not exist or cannot be accessed",
    "errors.invalid_message": "Messages must contain 1 to 20,000 characters",
    "errors.turn_active": "This conversation is still running; add an instruction or stop it first",
    "errors.thread_in_use": "This conversation is open in another Codex client. Close it there and try again, or create a new mobile conversation.",
    "errors.no_active_turn": "There is no active task for this action",
    "errors.app_server_unavailable": "Codex App Server is starting",
    "errors.codex_overloaded": "Codex is busy; try again shortly",
    "errors.codex_timeout": "Codex response timed out",
    "errors.request_expired": "This request has expired",
    "errors.cross_site_request": "Cross-site actions are not allowed",
    "errors.body_too_large": "The request is too large",
    "errors.invalid_json": "The JSON payload is invalid",
    "errors.unsupported_media_type": "Requests must use application/json",
    "errors.invalid_id": "The resource identifier is invalid",
    "errors.invalid_cursor": "The pagination cursor is invalid",
    "errors.invalid_search": "The search text is too long",
    "errors.too_many_event_clients": "The event connection limit has been reached",
    "errors.not_found": "The requested resource was not found",
    "errors.method_not_allowed": "This request method is not supported",
    "errors.invalid_decision": "This approval decision is not supported",
    "errors.invalid_answers": "Complete all required answers",
    "errors.unsupported_server_request": "This mobile client cannot respond to that request",
    "errors.invalid_path": "The URL path is invalid",
  },
  "zh-CN": {
    "app.subtitle": "移动控制台",
    "language.switch": "切换到英文",
    "theme.useLight": "切换到白色模式",
    "theme.useDark": "切换到深色模式",
    "connection.inspect": "查看连接状态",
    "connection.connecting": "连接中",
    "connection.online": "在线",
    "connection.offline": "已断开",
    "connection.initialTitle": "正在连接 Codex",
    "connection.initialHelp": "首次加载可能需要几秒",
    "actions.new": "新建",
    "actions.refresh": "刷新",
    "actions.retry": "重试",
    "actions.close": "关闭",
    "actions.cancel": "取消",
    "actions.create": "创建会话",
    "actions.stop": "停止",
    "actions.send": "发送",
    "actions.steer": "追加",
    "actions.allow": "允许",
    "actions.allowSession": "本会话允许",
    "actions.decline": "拒绝",
    "actions.submit": "提交回答",
    "actions.recheck": "重新检测",
    "actions.loadMore": "加载更多会话",
    "actions.loading": "正在加载…",
    "actions.loadOlder": "加载更早 10 轮",
    "menu.open": "打开会话列表",
    "menu.close": "关闭会话列表",
    "menu.actions": "更多操作",
    "menu.closeActions": "关闭操作菜单",
    "threads.list": "会话列表",
    "threads.search": "搜索会话",
    "threads.count": "{count} 个会话",
    "threads.recentFirst": "最近更新优先",
    "threads.loading": "正在加载会话…",
    "threads.noMatches": "没有匹配的会话",
    "threads.none": "没有找到 Codex 会话",
    "threads.untitled": "未命名会话",
    "threads.running": "运行中",
    "threads.unknownTime": "时间未知",
    "threads.noCwd": "未记录工作目录",
    "threads.select": "选择一个 Codex 会话",
    "threads.selectHelp": "从会话列表打开，或新建一个",
    "threads.reading": "正在读取会话",
    "threads.recentTurns": "加载最近 10 轮…",
    "threads.empty": "这是一个空会话",
    "threads.emptyHelp": "发送第一条消息开始工作",
    "threads.noneSelected": "还没有选择会话",
    "turn.idle": "空闲",
    "turn.running": "处理中",
    "turn.runningElsewhere": "其他客户端运行中",
    "turn.failed": "失败",
    "turn.stopped": "已停止",
    "turn.completed": "完成",
    "turn.codexFailed": "Codex 任务失败",
    "composer.placeholder": "给 Codex 发送消息…",
    "composer.select": "请先选择会话",
    "composer.disconnected": "Bridge 未连接",
    "composer.otherClient": "此会话正在其他客户端运行",
    "composer.steerHint": "当前输入将追加到正在执行的任务",
    "composer.keyboardHint": "Enter 发送 · Shift + Enter 换行",
    "message.you": "你",
    "message.copy": "复制消息",
    "message.copyCode": "复制代码",
    "message.copyFailed": "复制失败，请长按文本复制",
    "message.toolEvent": "工具事件",
    "message.steer": "追加指令",
    "message.sendFailed": "发送失败",
    "message.jumpLatest": "回到最新消息",
    "message.loadDetail": "加载完整详情",
    "message.detailFailed": "完整详情加载失败",
    "toast.steered": "指令已追加",
    "toast.stopSent": "已发送停止请求",
    "toast.submitted": "已提交",
    "toast.refreshed": "已刷新",
    "trust.fullAccess": "完全访问",
    "trust.tailnetOnly": "仅限受信任的 Tailscale 设备",
    "request.approval": "Codex 请求授权",
    "request.userInput": "Codex 需要你的回答",
    "request.pending": "待处理请求",
    "request.allowPrompt": "是否允许这项操作？",
    "request.unsupported": "当前移动端不支持 {method}，请回到电脑处理。",
    "request.question": "问题",
    "new.title": "新建会话",
    "new.description": "选择电脑上的工作目录。",
    "new.cwd": "工作目录",
    "new.cwdPlaceholder": "C:\\path\\to\\project",
    "new.chooseRecent": "选择最近使用的目录",
    "new.ephemeral": "临时会话（关闭后不保留）",
    "new.loadingWorkspaces": "正在读取常用目录…",
    "new.workspacesFound": "已找到 {count} 个最近使用的目录",
    "new.enterAbsolute": "请输入电脑上的绝对目录",
    "new.creating": "正在创建会话…",
    "new.missingId": "创建成功，但没有返回会话 ID",
    "status.title": "连接状态",
    "status.description": "电脑、bridge 与 Codex App Server 的实时状态。",
    "status.bridge": "Bridge",
    "status.ready": "就绪",
    "status.notReady": "未就绪",
    "status.uptime": "运行时间",
    "status.seconds": "{count} 秒",
    "status.unknown": "未知",
    "status.appServer": "App Server",
    "status.restarts": "自动重启",
    "status.times": "{count} 次",
    "status.eventClients": "事件连接",
    "status.activeTasks": "活动任务",
    "status.http": "HTTP 请求",
    "status.rpc": "App Server RPC",
    "status.metric": "{count} 次 · 平均 {average} ms · {errors} 错误",
    "status.permissions": "执行权限",
    "date.now": "刚刚",
    "date.minutesAgo": "{count} 分钟前",
    "date.hoursAgo": "{count} 小时前",
    "errors.network_error": "网络请求失败",
    "errors.timeout": "连接超时，请稍后重试",
    "errors.invalid_cwd": "请选择一个有效的绝对目录",
    "errors.cwd_unavailable": "目录不存在或无法访问",
    "errors.invalid_message": "消息长度必须在 1 到 20,000 字符之间",
    "errors.turn_active": "当前会话仍在运行；可选择追加指令或先停止",
    "errors.thread_in_use": "此会话正在另一个 Codex 客户端中打开，请先在桌面端关闭后重试，或在手机端新建会话",
    "errors.no_active_turn": "没有可执行这项操作的运行中任务",
    "errors.app_server_unavailable": "Codex App Server 正在启动",
    "errors.codex_overloaded": "Codex 正忙，请稍后重试",
    "errors.codex_timeout": "Codex 响应超时",
    "errors.request_expired": "该请求已失效",
    "errors.cross_site_request": "拒绝跨站操作",
    "errors.body_too_large": "请求内容过大",
    "errors.invalid_json": "JSON 格式无效",
    "errors.unsupported_media_type": "请求必须使用 application/json",
    "errors.invalid_id": "资源标识无效",
    "errors.invalid_cursor": "分页游标无效",
    "errors.invalid_search": "搜索内容过长",
    "errors.too_many_event_clients": "事件连接数已达上限",
    "errors.not_found": "请求的资源不存在",
    "errors.method_not_allowed": "请求方法不支持",
    "errors.invalid_decision": "不支持的审批决定",
    "errors.invalid_answers": "请填写所有必填答案",
    "errors.unsupported_server_request": "移动端暂不支持响应此类请求",
    "errors.invalid_path": "URL 路径无效",
  },
};

function normalizeLanguage(value) {
  if (SUPPORTED.has(value)) return value;
  return String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function hasStoredLanguage() {
  try { return SUPPORTED.has(localStorage.getItem(STORAGE_KEY)); } catch { return false; }
}

function detectedLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED.has(stored)) return stored;
  } catch {}
  return normalizeLanguage(typeof navigator === "undefined" ? "en" : navigator.language);
}

let currentLanguage = detectedLanguage();

export function language() {
  return currentLanguage;
}

export function t(key, replacements = {}) {
  const template = messages[currentLanguage]?.[key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(replacements[name] ?? `{${name}}`));
}

export function hasTranslation(key, value) {
  return typeof messages[normalizeLanguage(value)]?.[key] === "string";
}

export function translateDocument(root = document) {
  if (!root) return;
  document.documentElement.lang = currentLanguage;
  for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const attribute of ["placeholder", "title", "aria-label"]) {
    const dataName = `i18n${attribute.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}`;
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) node.setAttribute(attribute, t(node.dataset[dataName]));
  }
  const toggle = root.getElementById?.("languageButton");
  if (toggle) {
    toggle.textContent = currentLanguage === "en" ? "中" : "EN";
    toggle.title = t("language.switch");
    toggle.setAttribute("aria-label", t("language.switch"));
  }
}

export function setLanguage(value, { persist = true, notify = true } = {}) {
  const next = normalizeLanguage(value);
  const changed = next !== currentLanguage;
  currentLanguage = next;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }
  if (typeof document !== "undefined") translateDocument(document);
  if (changed && notify && typeof document !== "undefined") document.dispatchEvent(new CustomEvent("bridge:languagechange"));
  return currentLanguage;
}

export function toggleLanguage() {
  return setLanguage(currentLanguage === "en" ? "zh-CN" : "en");
}

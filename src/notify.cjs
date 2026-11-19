"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_SERVER_URL = "https://api.day.app";
const DEFAULT_DEVICE_NAME = "Dev";
const DEFAULT_GROUP = "AGY";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TITLE_LENGTH = 160;
const MAX_ERROR_LENGTH = 100;
const MAX_DEVICE_NAME_LENGTH = 40;

/**
 * 映射 AGY Stop 结束原因到对应的状态标题后缀与文案。
 * 返回 null 表示该场景（如用户手动取消）无需推送通知。
 */
const REASON_PROFILES = {
  NO_TOOL_CALL: {
    suffix: "agy Task Completed",
    status: "本轮运行已正常结束。",
  },
  TERMINAL_STEP_TYPE: {
    suffix: "agy Task Completed",
    status: "本轮运行已正常结束。",
  },
  INJECTED_RESPONSE: {
    suffix: "agy Task Completed",
    status: "本轮运行已正常结束。",
  },
  ERROR: {
    suffix: "agy Task Failed",
    status: "本轮运行因错误中止。",
  },
  MAX_INVOCATIONS: {
    suffix: "agy Task Stopped",
    status: "本轮运行因达到调用次数上限而停止。",
  },
  MAX_FORCED_INVOCATIONS: {
    suffix: "agy Task Stopped",
    status: "本轮运行因达到连续继续次数上限而停止。",
  },
  MAX_TOKEN_BUDGET_EXCEEDED: {
    suffix: "agy Task Stopped",
    status: "本轮运行因超出 Token 预算而停止。",
  },
  TERMINAL_CUSTOM_HOOK: {
    suffix: "agy Task Stopped",
    status: "本轮运行被自定义钩子终止。",
  },
  USER_CANCELED: null,
};

/**
 * 折叠多余空白并按上限截断文本，保持手机锁屏通知简洁可读。
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function compactText(value, maxLength) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

/**
 * 规范化设备显示名，缺省时回退为 Dev。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDeviceName(value) {
  return compactText(value, MAX_DEVICE_NAME_LENGTH) || DEFAULT_DEVICE_NAME;
}

/**
 * 拼接 Bark 通知标题，例如 `[Dev · agy Task Completed]`。
 * @param {string} deviceName
 * @param {string} suffix
 * @returns {string}
 */
function formatNotificationTitle(deviceName, suffix) {
  return `[${normalizeDeviceName(deviceName)} · ${suffix}]`;
}

/**
 * 根据 Stop 事件中的文件路径推断对应的 AGY conversation_summaries.db 路径。
 * 兼容 CLI（antigravity-cli）、桌面端（antigravity）和 IDE（antigravity-ide）。
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function resolveSummariesDbPath(event) {
  for (const candidate of [event?.transcriptPath, event?.artifactDirectoryPath]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const match = candidate.trim().match(/^(.*?)[\\/]+brain[\\/]+/i);
    if (match && match[1]) {
      return join(match[1], "conversation_summaries.db");
    }
  }
  return join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");
}

/**
 * 从 AGY 本地摘要库只读查询当前会话标题；查不到或异常时返回空串，绝不阻断发信。
 * @param {Record<string, unknown>} event
 * @param {string} [summariesDbPath]
 * @returns {string}
 */
function readConversationTitle(event, summariesDbPath = resolveSummariesDbPath(event)) {
  const conversationId = typeof event?.conversationId === "string"
    ? event.conversationId.trim()
    : "";
  if (!conversationId || !summariesDbPath || !existsSync(summariesDbPath)) {
    return "";
  }

  let db;
  try {
    db = new DatabaseSync(summariesDbPath, { readOnly: true, timeout: 1000 });
    const row = db
      .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
      .get(conversationId);
    return compactText(row?.title, MAX_TITLE_LENGTH);
  } catch {
    return "";
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors on read-only fallback.
    }
  }
}

/**
 * 获取本地 Bark 配置文件路径（默认 ~/.gemini/config/bark-completion/config.json）。
 * 可通过环境变量 AGY_BARK_CONFIG_PATH 覆盖。
 * @returns {string}
 */
function getBarkConfigPath() {
  if (typeof process.env.AGY_BARK_CONFIG_PATH === "string" && process.env.AGY_BARK_CONFIG_PATH.trim()) {
    return process.env.AGY_BARK_CONFIG_PATH.trim();
  }
  return join(homedir(), ".gemini", "config", "bark-completion", "config.json");
}

/**
 * 读取并校验本地 Bark 配置文件。
 * serverUrl 缺省时默认使用官方 API（https://api.day.app），deviceName 缺省时默认 Dev。
 * @param {string} [configPath]
 * @returns {{ serverUrl: string, deviceKey: string, deviceName: string }}
 */
function readBarkConfig(configPath = getBarkConfigPath()) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error("未找到 Bark 配置文件，请先运行安装配置脚本。");
    }
    throw new Error("Bark 配置文件无法解析。");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Bark 配置格式不正确。");
  }
  if (typeof raw.deviceKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw.deviceKey)) {
    throw new Error("Bark Device Key 格式无效。");
  }

  const rawServerUrl =
    typeof raw.serverUrl === "string" && raw.serverUrl.trim()
      ? raw.serverUrl.trim()
      : DEFAULT_SERVER_URL;

  let server;
  try {
    server = new URL(rawServerUrl);
  } catch {
    throw new Error("Bark 服务器地址无效。");
  }
  if (server.protocol !== "https:" || server.username || server.password || server.search || server.hash) {
    throw new Error("Bark 服务器必须是无凭据和参数的 HTTPS 地址。");
  }

  return {
    deviceKey: raw.deviceKey,
    serverUrl: server.href.replace(/\/$/, ""),
    deviceName: normalizeDeviceName(raw.deviceName),
  };
}

/**
 * 根据 AGY Stop 事件构造 Bark 通知标题与正文；返回 null 表示跳过通知。
 * @param {Record<string, unknown>} event
 * @param {{ summariesDbPath?: string, sessionTitle?: string, deviceName?: string }} [options]
 * @returns {{ title: string, body: string } | null}
 */
function buildNotification(event, options = {}) {
  if (!event || event.hookEventName !== "Stop") return null;

  const reason = typeof event.terminationReason === "string" ? event.terminationReason : "";
  if (reason === "USER_CANCELED") return null;

  const hasError = typeof event.error === "string" && event.error.trim().length > 0;
  let profile;
  if (hasError && reason !== "ERROR") {
    profile = REASON_PROFILES.ERROR;
  } else if (Object.prototype.hasOwnProperty.call(REASON_PROFILES, reason)) {
    profile = REASON_PROFILES[reason];
  } else {
    profile = {
      suffix: "agy Task Completed",
      status: reason ? `本轮运行已结束（${reason}）。` : "本轮运行已结束。",
    };
  }
  if (!profile) return null;

  const statusLine = event.fullyIdle === false
    ? `${profile.status}（后台仍有任务运行）`
    : profile.status;

  const lines = [statusLine];
  if (hasError) {
    lines.push(`错误：${compactText(event.error, MAX_ERROR_LENGTH)}`);
  }

  const sessionTitle = typeof options.sessionTitle === "string"
    ? compactText(options.sessionTitle, MAX_TITLE_LENGTH)
    : readConversationTitle(event, options.summariesDbPath);
  lines.push(`会话：${sessionTitle || "未命名会话"}`);

  return {
    title: formatNotificationTitle(options.deviceName, profile.suffix),
    body: lines.join("\n"),
  };
}

/**
 * 调用 Bark HTTPS 推送接口，不回显凭据或完整请求地址。
 * @param {{ serverUrl: string, deviceKey: string }} config
 * @param {string} title
 * @param {string} body
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 */
async function sendBarkPush(
  config,
  title,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  let response;
  try {
    response = await fetchImpl(`${config.serverUrl}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        device_key: config.deviceKey,
        title,
        body,
        group: DEFAULT_GROUP,
        isArchive: "1",
      }),
    });
  } catch {
    throw new Error("Bark 推送请求失败或超时。");
  }
  if (!response.ok) {
    throw new Error(`Bark 返回异常状态码（HTTP ${response.status}）。`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Bark 返回了无法解析的响应。");
  }
  if (result?.code !== 200) {
    throw new Error("Bark 服务未确认接收通知。");
  }
}

/**
 * 处理单次 Stop 钩子调用（支持依赖注入以便离线单元测试）。
 * @param {string} rawStdin
 * @param {{ configPath?: string, summariesDbPath?: string, sessionTitle?: string, fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ sent: boolean, title?: string, body?: string }>}
 */
async function handleStopPayload(rawStdin, options = {}) {
  const trimmed = rawStdin.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { sent: false };

  const event = JSON.parse(trimmed);
  if (!event || event.hookEventName !== "Stop" || event.terminationReason === "USER_CANCELED") {
    return { sent: false };
  }

  const config = readBarkConfig(options.configPath);
  const notification = buildNotification(event, {
    summariesDbPath: options.summariesDbPath,
    sessionTitle: options.sessionTitle,
    deviceName: config.deviceName,
  });
  if (!notification) return { sent: false };

  await sendBarkPush(
    config,
    notification.title,
    notification.body,
    options.fetchImpl,
    options.timeoutMs,
  );
  return { sent: true, ...notification };
}

/**
 * CLI 入口：支持 Stop 钩子标准输入模式，以及 --status / --test 手动排查参数。
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    const config = readBarkConfig();
    process.stdout.write(
      `Bark 配置正常，设备：${config.deviceName}，服务器：${config.serverUrl}\n`,
    );
    return;
  }
  if (args.includes("--test")) {
    const config = readBarkConfig();
    await sendBarkPush(
      config,
      formatNotificationTitle(config.deviceName, "agy Task Completed"),
      "这是一条测试通知。\n会话：手动连通性测试",
    );
    process.stdout.write("Bark 测试通知已发出，请查看手机。\n");
    return;
  }

  let sentDecision = false;
  try {
    const rawStdin = readFileSync(0, "utf8");
    await handleStopPayload(rawStdin);
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : "未知错误。";
    process.stderr.write(`agy bark-completion skipped: ${reason}\n`);
  } finally {
    if (!sentDecision) {
      sentDecision = true;
      process.stdout.write(JSON.stringify({ decision: "stop" }) + "\n");
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    const reason = error instanceof Error && error.message ? error.message : "未知错误。";
    process.stderr.write(`agy bark-completion failed: ${reason}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_DEVICE_NAME,
  DEFAULT_SERVER_URL,
  buildNotification,
  compactText,
  formatNotificationTitle,
  getBarkConfigPath,
  handleStopPayload,
  normalizeDeviceName,
  readBarkConfig,
  readConversationTitle,
  resolveSummariesDbPath,
  sendBarkPush,
};

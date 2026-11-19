"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const NOTIFY_PATH = join(__dirname, "notify.cjs");
const {
  buildNotification,
  handleStopPayload,
  readBarkConfig,
  readConversationTitle,
  resolveSummariesDbPath,
  sendBarkPush,
} = require(NOTIFY_PATH);

function withTempConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), "agy-bark-test-"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  try {
    return fn(cfgPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempSummariesDb(rows, fn) {
  const dir = mkdtempSync(join(tmpdir(), "agy-bark-db-"));
  const dbPath = join(dir, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '');",
  );
  const insert = db.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, preview) VALUES (?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.conversation_id, row.title ?? "", row.preview ?? "");
  }
  try {
    return fn(dbPath, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveSummariesDbPath derives db path across CLI, Desktop, and IDE", () => {
  assert.equal(
    resolveSummariesDbPath({
      transcriptPath:
        "C:\\Users\\Alice\\.gemini\\antigravity-cli\\brain\\abc\\.system_generated\\logs\\transcript.jsonl",
    }),
    "C:\\Users\\Alice\\.gemini\\antigravity-cli\\conversation_summaries.db",
  );
  assert.equal(
    resolveSummariesDbPath({
      artifactDirectoryPath: "/home/u/.gemini/antigravity/brain/abc",
    }),
    join("/home/u/.gemini/antigravity", "conversation_summaries.db"),
  );
});

test("readConversationTitle reads title from WAL db and never uses preview or prompt", () => {
  withTempSummariesDb(
    [
      {
        conversation_id: "conv-1",
        title: "  对齐需求与目标分析\n",
        preview: "很长的首条 Prompt 内容",
      },
      {
        conversation_id: "conv-empty-title",
        title: "",
        preview: "不应该拿来做标题的长 Prompt",
      },
    ],
    (dbPath) => {
      assert.equal(
        readConversationTitle({ conversationId: "conv-1" }, dbPath),
        "对齐需求与目标分析",
      );
      assert.equal(
        readConversationTitle({ conversationId: "conv-empty-title" }, dbPath),
        "",
      );
      assert.equal(
        readConversationTitle({ conversationId: "missing" }, dbPath),
        "",
      );
    },
  );
});

test("NO_TOOL_CALL produces Dev title by default with only session title", () => {
  withTempSummariesDb(
    [{ conversation_id: "conv-1", title: "对齐需求与目标分析", preview: "原始 Prompt" }],
    (dbPath) => {
      const result = buildNotification(
        {
          hookEventName: "Stop",
          terminationReason: "NO_TOOL_CALL",
          fullyIdle: true,
          conversationId: "conv-1",
          cwd: "C:\\Users\\Alice\\repo",
          lastUserInput: "不应该出现在正文里的用户 Prompt",
        },
        { summariesDbPath: dbPath },
      );
      assert.deepEqual(result, {
        title: "[Dev · agy Task Completed]",
        body: "本轮运行已正常结束。\n会话：对齐需求与目标分析",
      });
    },
  );
});

test("custom deviceName is reflected in title prefix", () => {
  const result = buildNotification(
    {
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
    },
    { sessionTitle: "测试标题", deviceName: "Work" },
  );
  assert.equal(result.title, "[Work · agy Task Completed]");
});

test("missing title falls back to 未命名会话 without leaking prompt", () => {
  withTempSummariesDb(
    [{ conversation_id: "conv-2", title: "", preview: "首条超长 Prompt" }],
    (dbPath) => {
      const result = buildNotification(
        {
          hookEventName: "Stop",
          terminationReason: "NO_TOOL_CALL",
          conversationId: "conv-2",
          lastUserInput: "这句 Prompt 不应出现",
        },
        { summariesDbPath: dbPath },
      );
      assert.deepEqual(result, {
        title: "[Dev · agy Task Completed]",
        body: "本轮运行已正常结束。\n会话：未命名会话",
      });
    },
  );
});

test("fullyIdle=false still notifies and notes running background tasks", () => {
  const result = buildNotification(
    {
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: false,
    },
    { sessionTitle: "后台任务会话" },
  );
  assert.equal(result.title, "[Dev · agy Task Completed]");
  assert.equal(
    result.body,
    "本轮运行已正常结束。（后台仍有任务运行）\n会话：后台任务会话",
  );
});

test("ERROR produces Failed title and sanitized error line with session title", () => {
  const result = buildNotification(
    {
      hookEventName: "Stop",
      terminationReason: "ERROR",
      error: "Upstream timeout\nretrying failed",
    },
    { sessionTitle: "报错会话" },
  );
  assert.equal(result.title, "[Dev · agy Task Failed]");
  assert.equal(
    result.body,
    "本轮运行因错误中止。\n错误：Upstream timeout retrying failed\n会话：报错会话",
  );
});

test("non-empty error overrides NO_TOOL_CALL into Failed title", () => {
  const result = buildNotification(
    {
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      error: "Tool crashed",
    },
    { sessionTitle: "测试标题" },
  );
  assert.equal(result.title, "[Dev · agy Task Failed]");
  assert.match(result.body, /错误：Tool crashed/);
});

test("limit and custom hook reasons produce Stopped title with specific reason", () => {
  const cases = [
    ["MAX_INVOCATIONS", /调用次数上限/],
    ["MAX_FORCED_INVOCATIONS", /连续继续次数上限/],
    ["MAX_TOKEN_BUDGET_EXCEEDED", /Token 预算/],
    ["TERMINAL_CUSTOM_HOOK", /自定义钩子终止/],
  ];
  for (const [reason, pattern] of cases) {
    const result = buildNotification(
      {
        hookEventName: "Stop",
        terminationReason: reason,
      },
      { sessionTitle: "超限会话" },
    );
    assert.equal(result.title, "[Dev · agy Task Stopped]");
    assert.match(result.body, pattern);
    assert.match(result.body, /会话：超限会话$/);
  }
});

test("USER_CANCELED and non-Stop events are skipped", () => {
  assert.equal(
    buildNotification({ hookEventName: "Stop", terminationReason: "USER_CANCELED" }),
    null,
  );
  assert.equal(
    buildNotification({ hookEventName: "PostToolUse", terminationReason: "NO_TOOL_CALL" }),
    null,
  );
});

test("readBarkConfig supports UTF-8 BOM and defaults serverUrl and deviceName", () => {
  withTempConfig("\uFEFF" + JSON.stringify({ deviceKey: "FakeKey_123" }), (cfgPath) => {
    const cfg = readBarkConfig(cfgPath);
    assert.deepEqual(cfg, {
      deviceKey: "FakeKey_123",
      serverUrl: "https://api.day.app",
      deviceName: "Dev",
    });
  });
});

test("readBarkConfig rejects invalid urls and keys without leaking deviceKey", () => {
  withTempConfig({ serverUrl: "http://api.day.app", deviceKey: "Secret_XYZ_999" }, (cfgPath) => {
    assert.throws(() => readBarkConfig(cfgPath), (err) => !err.message.includes("Secret_XYZ_999"));
  });
  withTempConfig({ serverUrl: "https://api.day.app?foo=bar", deviceKey: "Secret_XYZ_999" }, (cfgPath) => {
    assert.throws(() => readBarkConfig(cfgPath), (err) => !err.message.includes("Secret_XYZ_999"));
  });
  withTempConfig({ serverUrl: "https://api.day.app", deviceKey: "bad key!" }, (cfgPath) => {
    assert.throws(() => readBarkConfig(cfgPath), (err) => !err.message.includes("bad key!"));
  });
});

test("handleStopPayload sends expected Bark JSON payload with configured deviceName", async () => {
  await withTempConfig(
    { deviceName: "Dev", serverUrl: "https://api.day.app", deviceKey: "TestKey_01" },
    async (cfgPath) => {
      await withTempSummariesDb(
        [{ conversation_id: "conv-xyz", title: "测试会话标题" }],
        async (dbPath) => {
          let captured = null;
          const mockFetch = async (url, init) => {
            captured = { url, init, parsedBody: JSON.parse(init.body) };
            return {
              ok: true,
              status: 200,
              json: async () => ({ code: 200, message: "success" }),
            };
          };

          const res = await handleStopPayload(
            JSON.stringify({
              hookEventName: "Stop",
              terminationReason: "NO_TOOL_CALL",
              fullyIdle: true,
              conversationId: "conv-xyz",
              lastUserInput: "这条 Prompt 不该出现在通知里",
            }),
            { configPath: cfgPath, summariesDbPath: dbPath, fetchImpl: mockFetch },
          );

          assert.equal(res.sent, true);
          assert.equal(captured.url, "https://api.day.app/push");
          assert.equal(captured.init.method, "POST");
          assert.equal(captured.init.redirect, "error");
          assert.deepEqual(captured.parsedBody, {
            device_key: "TestKey_01",
            title: "[Dev · agy Task Completed]",
            body: "本轮运行已正常结束。\n会话：测试会话标题",
            group: "AGY",
            isArchive: "1",
          });
        },
      );
    },
  );
});

test("sendBarkPush fails cleanly on non-200 HTTP or non-200 Bark code without leaking key", async () => {
  const cfg = { serverUrl: "https://bark.example.test", deviceKey: "NeverLeakKey999" };

  await assert.rejects(
    () => sendBarkPush(cfg, "t", "b", async () => ({ ok: false, status: 502 })),
    (err) => err.message.includes("HTTP 502") && !err.message.includes("NeverLeakKey999"),
  );

  await assert.rejects(
    () =>
      sendBarkPush(cfg, "t", "b", async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 400 }),
      })),
    (err) => err.message.includes("未确认接收") && !err.message.includes("NeverLeakKey999"),
  );
});

test("cmd /c invocation with missing config still exits 0 and emits decision stop", () => {
  const cmd = /\s/.test(NOTIFY_PATH)
    ? `node --no-warnings "${NOTIFY_PATH}"`
    : `node --no-warnings ${NOTIFY_PATH}`;
  const run = spawnSync("cmd.exe", ["/c", cmd], {
    windowsVerbatimArguments: true,
    env: { ...process.env, AGY_BARK_CONFIG_PATH: join(tmpdir(), "nonexistent-agy-bark-cfg.json") },
    input: JSON.stringify({
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
    }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { decision: "stop" });
  assert.match(run.stderr, /未找到 Bark 配置文件/);
});

test("--status prints deviceName and server url without leaking deviceKey", () => {
  withTempConfig(
    { deviceName: "Dev", serverUrl: "https://api.day.app", deviceKey: "SecretKey_NoLeak_123" },
    (cfgPath) => {
      const stdout = execFileSync(process.execPath, ["--no-warnings", NOTIFY_PATH, "--status"], {
        env: { ...process.env, AGY_BARK_CONFIG_PATH: cfgPath },
        encoding: "utf8",
      });
      assert.match(stdout, /^Bark 配置正常，设备：Dev，服务器：https:\/\/api\.day\.app/);
      assert.ok(!stdout.includes("SecretKey_NoLeak_123"));
    },
  );
});

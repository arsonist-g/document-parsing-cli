/**
 * 账号管理命令测试：account test 的凭证探活判定与 doctor 的账号检查。
 *
 * 关键回归点：上游 JSON 信封里的 code 是数字（如 -60012），判定必须按数值语义比较；
 * 用字符串常量比较会把「能鉴权、只是任务不存在」误判成坏凭证并让命令以退出码 5 结束。
 * 上游由 test/stub-upstream.ts 扮演，全程无外网、无真实用户目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { quotaTable, runAccountTest, runQuota } from "../src/commands/admin.js";
import { buildContext, type CliContext } from "../src/context.js";

import { StubUpstream } from "./stub-upstream.js";

const MANAGED_ENV = [
  "DOCPARSE_HOME",
  "DOCPARSE_CONFIG",
  "DOCPARSE_BASE_URL",
  "DOCPARSE_TOKENS",
  "DOCPARSE_TOKEN",
  "MINERU_TOKEN",
] as const;

let savedEnv: Array<[string, string | undefined]> = [];
let tmpDir = "";
let tmpHome = "";

beforeEach(() => {
  savedEnv = MANAGED_ENV.map((key) => [key, process.env[key]]);
  for (const key of MANAGED_ENV) delete process.env[key];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-admin-"));
  tmpHome = path.join(tmpDir, "home");
  fs.mkdirSync(tmpHome, { recursive: true });
  process.env.DOCPARSE_HOME = tmpHome;
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 用真实装配（loadConfig + AccountPool + 客户端工厂）建上下文，base_url 指向 stub。 */
function makeContext(upstream: StubUpstream, tokens: string[] = ["token-a"]): CliContext {
  const configPath = path.join(tmpHome, "config.toml");
  const toml = [
    `base_url = "${upstream.baseUrl}"`,
    "",
    ...tokens.flatMap((value, index) => [
      "[[account]]",
      `name = "acct-${index}"`,
      `token = "${value}"`,
      "",
    ]),
    "",
  ].join("\n");
  fs.writeFileSync(configPath, toml, "utf8");
  const ctx = buildContext({ configPath, outputMode: "json" });
  ctx.log = () => {};
  return ctx;
}

/** 让所有账号的探活请求返回同一个响应体；handler 可自行检查 Authorization。 */
function probeScript(
  upstream: StubUpstream,
  handler: (authorization: string | undefined) => { status?: number; json: unknown },
): void {
  upstream.route("GET", "/api/v4/extract/task/docparse-credential-probe", (request) =>
    handler(request.authorization),
  );
}

describe("runAccountTest 凭证探活", () => {
  it("上游返回数字 -60012（任务不存在）时判为鉴权通过，而不是坏凭证", async () => {
    const upstream = await StubUpstream.start("");
    try {
      probeScript(upstream, () => ({ json: { code: -60012, msg: "task not found or expire" } }));
      const ctx = makeContext(upstream);

      const results = await runAccountTest(ctx);

      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, true);
      assert.equal(results[0]!.message, "鉴权通过（-60012 表示任务不存在，属预期）");
    } finally {
      await upstream.close();
    }
  });

  it("上游返回数字 -60013（无权访问他人任务）同样判为鉴权通过", async () => {
    const upstream = await StubUpstream.start("");
    try {
      probeScript(upstream, () => ({ json: { code: -60013, msg: "no permission" } }));
      const ctx = makeContext(upstream);

      const results = await runAccountTest(ctx);

      assert.equal(results[0]!.ok, true);
    } finally {
      await upstream.close();
    }
  });

  it("探活命中真实任务（code 0）时也是鉴权通过", async () => {
    const upstream = await StubUpstream.start("");
    try {
      probeScript(upstream, () => ({
        json: { code: 0, data: { task_id: "docparse-credential-probe", state: "done" } },
      }));
      const ctx = makeContext(upstream);

      const results = await runAccountTest(ctx);

      assert.equal(results[0]!.ok, true);
      assert.equal(results[0]!.message, "鉴权通过");
    } finally {
      await upstream.close();
    }
  });

  it("凭证被拒（A0202）判为失败，并给出上游错误码释义", async () => {
    const upstream = await StubUpstream.start("expected-token");
    try {
      upstream.protectedRoute("GET", "/api/v4/extract/task/docparse-credential-probe", () => ({
        json: { code: 0, data: {} },
      }));
      const ctx = makeContext(upstream, ["wrong-token"]);

      const results = await runAccountTest(ctx);

      assert.equal(results[0]!.ok, false);
      assert.match(results[0]!.message, /A0202/);
    } finally {
      await upstream.close();
    }
  });

  it("多账号逐一出结论：坏账号不影响其他账号判定", async () => {
    const upstream = await StubUpstream.start("token-good");
    try {
      upstream.protectedRoute("GET", "/api/v4/extract/task/docparse-credential-probe", () => ({
        json: { code: -60012, msg: "task not found or expire" },
      }));
      const ctx = makeContext(upstream, ["token-bad", "token-good"]);

      const results = await runAccountTest(ctx);

      assert.deepEqual(
        results.map((r) => [r.name, r.ok]),
        [
          ["acct-0", false],
          ["acct-1", true],
        ],
      );
    } finally {
      await upstream.close();
    }
  });

  it("指定不存在的账号名时报参数错误，而不是静默成功", async () => {
    const upstream = await StubUpstream.start("");
    try {
      const ctx = makeContext(upstream);
      await assert.rejects(() => runAccountTest(ctx, "nope"), /找不到账号/);
    } finally {
      await upstream.close();
    }
  });
});

describe("runQuota 额度查询", () => {
  it("透出上游 /api/v4/extract/status 的额度与用量，文本表按「今日已用/上限」呈现", async () => {
    const upstream = await StubUpstream.start("");
    try {
      upstream.route("GET", "/api/v4/extract/status", () => ({
        json: {
          code: 0,
          msg: "",
          data: {
            daily: { used: 0, left: 1000, allow_file_num: 5000, used_file_num: 1 },
            total: { used: 10991, left: 0 },
            version: { pipeline: "pipeline3.4.4", vlm: "vlm3.4.4" },
            is_pro: false,
          },
        },
      }));
      const ctx = makeContext(upstream);

      const rows = await runQuota(ctx);

      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.ok, true);
      assert.equal(rows[0]!.status?.daily?.left, 1000);

      const table = quotaTable(rows);
      assert.match(table, /pages_today/);
      assert.match(table, /0\/1000/);
      assert.match(table, /1\/5000/);
      assert.match(table, /\bfree\b/);
    } finally {
      await upstream.close();
    }
  });

  it("凭证被拒时该行标失败并带上退出码建议，不抛出中断整个查询", async () => {
    const upstream = await StubUpstream.start("expected-token");
    try {
      upstream.protectedRoute("GET", "/api/v4/extract/status", () => ({ json: { code: 0, data: {} } }));
      const ctx = makeContext(upstream, ["wrong-token"]);

      const rows = await runQuota(ctx);

      assert.equal(rows[0]!.ok, false);
      assert.equal(rows[0]!.exit_code, 5);
      assert.match(quotaTable(rows), /查询失败/);
    } finally {
      await upstream.close();
    }
  });

  it("多账号逐一出结论：坏账号不影响其他账号的额度读取", async () => {
    const upstream = await StubUpstream.start("token-good");
    try {
      upstream.protectedRoute("GET", "/api/v4/extract/status", () => ({
        json: { code: 0, msg: "", data: { daily: { used: 3, left: 997 } } },
      }));
      const ctx = makeContext(upstream, ["token-bad", "token-good"]);

      const rows = await runQuota(ctx);

      assert.deepEqual(
        rows.map((r) => [r.name, r.ok]),
        [
          ["acct-0", false],
          ["acct-1", true],
        ],
      );
      assert.equal(rows[1]!.status?.daily?.left, 997);
    } finally {
      await upstream.close();
    }
  });

  it("指定不存在的账号名时报参数错误", async () => {
    const upstream = await StubUpstream.start("");
    try {
      const ctx = makeContext(upstream);
      await assert.rejects(() => runQuota(ctx, "nope"), /找不到账号/);
    } finally {
      await upstream.close();
    }
  });
});

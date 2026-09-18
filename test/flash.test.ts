/**
 * flash（Agent 轻量解析通道）编排测试：URL 与本地文件两条路径。
 *
 * 上游由 test/stub-upstream.ts 扮演；Agent 通道按设计不带 Authorization，用例对此做断言。
 * 全程无外网、无真实用户目录（DOCPARSE_HOME 指向临时目录，用例结束清理）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runFlash } from "../src/commands/flash.js";
import { buildContext, type CliContext } from "../src/context.js";
import { UpstreamError } from "../src/errors.js";

import { StubUpstream } from "./stub-upstream.js";

const MARKDOWN = "# 轻量解析结果\n\n正文。\n";

const MANAGED_ENV = [
  "DOCPARSE_HOME",
  "DOCPARSE_CONFIG",
  "DOCPARSE_BASE_URL",
  "DOCPARSE_TOKENS",
  "DOCPARSE_TOKEN",
  "MINERU_TOKEN",
  "DOCPARSE_MODEL_VERSION",
  "DOCPARSE_LANGUAGE",
  "DOCPARSE_OUTPUT_ROOT",
] as const;

let savedEnv: Array<[string, string | undefined]> = [];
let tmpDir = "";
let tmpHome = "";
let outParent = "";

beforeEach(() => {
  savedEnv = MANAGED_ENV.map((key) => [key, process.env[key]]);
  for (const key of MANAGED_ENV) delete process.env[key];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-flash-"));
  tmpHome = path.join(tmpDir, "home");
  outParent = path.join(tmpDir, "out");
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

/** 用真实装配（loadConfig + 客户端工厂）建上下文，base_url 指向 stub。 */
function makeContext(upstream: StubUpstream): CliContext {
  const configPath = path.join(tmpHome, "config.toml");
  const toml = [
    `base_url = "${upstream.baseUrl}"`,
    "",
    "[parse]",
    "poll_interval_sec = 1",
    "",
    "[output]",
    `root = '${path.join(tmpDir, "out-root")}'`,
    "",
  ].join("\n");
  fs.writeFileSync(configPath, toml, "utf8");
  const ctx = buildContext({ configPath, outputMode: "json" });
  ctx.log = () => {};
  return ctx;
}

/** Agent 轮询脚本：第 1 次 running，之后 done 并给出 markdown 地址。 */
function agentPollScript(upstream: StubUpstream, taskId: string): void {
  let polls = 0;
  upstream.route("GET", `/api/v1/agent/parse/${taskId}`, () => {
    polls += 1;
    const data =
      polls === 1
        ? { task_id: taskId, state: "running" }
        : { task_id: taskId, state: "done", markdown_url: `${upstream.baseUrl}/full.md` };
    return { json: { code: 0, data } };
  });
}

describe("runFlash URL 路径", () => {
  it("提交 URL → 轮询 → 下载 markdown 落盘，且 Agent 通道不带鉴权头", async () => {
    // oracle: specified（提交/轮询/落盘契约 + 通道免 token）+ derived（markdown 文本由 stub 提供）
    const upstream = await StubUpstream.start("");
    try {
      upstream.route("POST", "/api/v1/agent/parse/url", () => ({
        json: { code: 0, data: { task_id: "t1" } },
      }));
      agentPollScript(upstream, "t1");
      upstream.route("GET", "/full.md", () => ({ text: MARKDOWN }));

      const ctx = makeContext(upstream);
      const outcome = await runFlash(ctx, {
        input: "https://example.com/docs/page.html",
        params: {},
        out: outParent,
        timeoutSec: 6,
      });

      assert.equal(outcome.kind, "url");
      assert.equal(outcome.state, "done");
      assert.equal(outcome.taskId, "t1");
      const mdPath = outcome.mdPath;
      const outDir = outcome.outDir;
      assert.ok(mdPath);
      assert.ok(outDir);
      assert.equal(fs.existsSync(mdPath), true);
      assert.equal(path.basename(mdPath), "example-com-page.md");
      assert.equal(fs.readFileSync(mdPath, "utf8"), MARKDOWN);
      assert.equal(path.dirname(outDir), outParent);
      assert.match(path.basename(outDir), /^parse-example-com-page-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/);

      assert.ok(upstream.count("GET", "/api/v1/agent/parse/t1") >= 2);
      const submit = upstream.find("POST", "/api/v1/agent/parse/url");
      assert.ok(submit);
      assert.equal(submit.authorization, undefined);
    } finally {
      await upstream.close();
    }
  });
});

describe("runFlash 本地文件路径", () => {
  it("申请上传链接 → PUT 原始字节 → 轮询 → 落盘", async () => {
    // oracle: specified（文件通道同样落盘并返回路径）+ derived（上传字节与源文件对比）
    const upstream = await StubUpstream.start("");
    try {
      upstream.route("POST", "/api/v1/agent/parse/file", () => ({
        json: { code: 0, data: { task_id: "t2", file_url: `${upstream.baseUrl}/agent-upload/0` } },
      }));
      upstream.route("PUT", "/agent-upload/0", () => ({ json: { ok: true } }));
      agentPollScript(upstream, "t2");
      upstream.route("GET", "/full.md", () => ({ text: MARKDOWN }));

      const source = path.join(tmpDir, "note.md");
      const content = "AGENT-FILE-BYTES-0123456789";
      fs.writeFileSync(source, content, "utf8");

      const ctx = makeContext(upstream);
      const outcome = await runFlash(ctx, { input: source, params: {}, out: outParent, timeoutSec: 6 });

      assert.equal(outcome.kind, "file");
      assert.equal(outcome.state, "done");
      assert.equal(outcome.taskId, "t2");
      assert.equal(outcome.bytes, Buffer.byteLength(content));
      assert.equal(outcome.outDir !== undefined, true);
      assert.equal(path.dirname(outcome.outDir ?? ""), outParent);
      const mdPath = outcome.mdPath;
      assert.ok(mdPath);
      assert.equal(path.basename(mdPath), "note.md");
      assert.equal(fs.readFileSync(mdPath, "utf8"), MARKDOWN);

      const upload = upstream.find("PUT", "/agent-upload/0");
      assert.ok(upload);
      assert.equal(upload.body.toString("utf8"), content);
    } finally {
      await upstream.close();
    }
  });
});

describe("runFlash 失败路径", () => {
  it("Agent 返回 failed：抛 UpstreamError 并带上游错误码", async () => {
    // oracle: specified（上游错误码原样透出；-30001 为 stub 给定值）
    const upstream = await StubUpstream.start("");
    try {
      upstream.route("POST", "/api/v1/agent/parse/url", () => ({
        json: { code: 0, data: { task_id: "t3" } },
      }));
      upstream.route("GET", "/api/v1/agent/parse/t3", () => ({
        json: { code: 0, data: { task_id: "t3", state: "failed", err_code: -30001, err_msg: "超过 10MB 上限" } },
      }));

      const ctx = makeContext(upstream);
      await assert.rejects(
        runFlash(ctx, { input: "https://example.com/big.pdf", params: {}, out: outParent, timeoutSec: 5 }),
        (error: unknown) => {
          if (!(error instanceof UpstreamError)) throw new Error(`期望 UpstreamError，实际 ${String(error)}`);
          assert.equal(error.upstreamCode, -30001);
          return true;
        },
      );
      assert.equal(fs.existsSync(outParent), false);
    } finally {
      await upstream.close();
    }
  });
});

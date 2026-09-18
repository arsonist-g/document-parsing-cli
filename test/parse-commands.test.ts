/**
 * 精准解析编排（runParse）与轮询收敛的端到端测试。
 *
 * 上游由 test/stub-upstream.ts 提供的本机 HTTP stub 扮演，base_url 指向它；
 * 全程无外网、无真实用户目录（DOCPARSE_HOME 指向临时目录，用例结束清理）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strToU8 } from "fflate";

import { runParse } from "../src/commands/parse.js";
import { runTask } from "../src/commands/task.js";
import { runBatch } from "../src/commands/batch.js";
import { buildContext, type CliContext } from "../src/context.js";
import { AuthError, UpstreamError } from "../src/errors.js";
import { pollBatchResults } from "../src/poll.js";
import type { BatchItemResult, MineruClient } from "../src/mineru.js";

import { StubUpstream, makeResultZip } from "./stub-upstream.js";

const TOKEN = "test-token-abc";
const MARKDOWN = "# 解析结果\n\n正文第一段。\n";
const IMAGE_BYTES = strToU8("\x89PNG-fake-bytes");
const FILE_BODY = "PDF-BYTES-0123456789";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-parse-"));
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

/** 用真实装配（loadConfig + AccountPool + MineruClient 工厂）建上下文，base_url 指向 stub。 */
function makeContext(
  upstream: StubUpstream,
  token: string | string[] = TOKEN,
): { ctx: CliContext; logs: string[] } {
  // 传数组即多账号；token 必须各不相同，否则会算出同一个指纹、被当成同一个账号
  const tokens = Array.isArray(token) ? token : [token];
  const configPath = path.join(tmpHome, "config.toml");
  const toml = [
    `base_url = "${upstream.baseUrl}"`,
    "",
    ...tokens.flatMap((value, index) => [
      "[[account]]",
      `name = "stub-${index}"`,
      `token = "${value}"`,
      "",
    ]),
    "[parse]",
    "poll_interval_sec = 1",
    "",
    "[output]",
    `root = '${path.join(tmpDir, "out-root")}'`,
    "",
  ].join("\n");
  fs.writeFileSync(configPath, toml, "utf8");
  const ctx = buildContext({ configPath, outputMode: "json" });
  const logs: string[] = [];
  ctx.log = (message: string) => {
    logs.push(message);
  };
  return { ctx, logs };
}

function makeSourceFile(name: string, content: string = FILE_BODY): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

describe("runParse 本地文件（精准解析上传编排）", () => {
  it("上传原始字节 → 轮询收敛 → 解压落盘，且凭证被送上上游", async () => {
    // oracle: specified（任务书逐条契约）+ derived（zip 内容、上传字节由本测试构造，是独立真值源）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      let polls = 0;
      upstream.protectedRoute("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b1", file_urls: [`${upstream.baseUrl}/upload/0`] } },
      }));
      upstream.route("PUT", "/upload/0", () => ({ json: { ok: true } }));
      upstream.protectedRoute("GET", "/api/v4/extract-results/batch/b1", () => {
        polls += 1;
        const state = polls === 1 ? "running" : "done";
        const item: BatchItemResult =
          state === "running"
            ? { file_name: "quarterly report.pdf", data_id: "docparse-0", state: "running", extract_progress: { extracted_pages: 1, total_pages: 3 } }
            : { file_name: "quarterly report.pdf", data_id: "docparse-0", state: "done", full_zip_url: `${upstream.baseUrl}/result.zip` };
        return { json: { code: 0, data: { extract_result: [item] } } };
      });
      upstream.route("GET", "/result.zip", () => ({
        bytes: makeResultZip(MARKDOWN, IMAGE_BYTES),
        contentType: "application/zip",
      }));

      const { ctx } = makeContext(upstream);
      const source = makeSourceFile("quarterly report.pdf");
      const started = Date.now();
      const outcome = await runParse(ctx, {
        inputs: [source],
        params: {},
        out: outParent,
        wait: true,
        timeoutSec: 8,
      });
      const elapsedMs = Date.now() - started;

      assert.equal(outcome.failed, 0);
      assert.equal(outcome.batchIds.length, 1);
      const job = outcome.results[0];
      assert.ok(job);
      assert.equal(job.state, "done");
      assert.equal(job.batchId, "b1");

      // mdPath 存在、内容等于 zip 里的 full.md、文件名为 <slug>.md
      const mdPath = job.mdPath;
      assert.ok(mdPath);
      assert.equal(fs.existsSync(mdPath), true);
      assert.equal(path.basename(mdPath), "quarterly-report.md");
      assert.equal(fs.readFileSync(mdPath, "utf8"), MARKDOWN);

      // 落盘位置：<parent>/parse-<slug>-<HH-MM-SS>-<rand>/
      const outDir = path.dirname(mdPath);
      assert.equal(outDir, job.outDir);
      assert.equal(path.dirname(outDir), outParent);
      assert.match(path.basename(outDir), /^parse-quarterly-report-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/);

      // 同目录里的 images/x.png 与 zip 内二进制一致
      const imagePath = path.join(outDir, "images", "x.png");
      assert.equal(fs.existsSync(imagePath), true);
      assert.deepEqual(new Uint8Array(fs.readFileSync(imagePath)), IMAGE_BYTES);

      // 上传的字节 = 源文件字节
      const upload = upstream.find("PUT", "/upload/0");
      assert.ok(upload);
      assert.equal(upload.body.toString("utf8"), FILE_BODY);

      // 账号池把配置里的 token 送到了上游
      const submit = upstream.find("POST", "/api/v4/file-urls/batch");
      assert.ok(submit);
      assert.equal(submit.authorization, `Bearer ${TOKEN}`);

      // 轮询：≥2 次结果查询，且确实等过 poll_interval_sec（1s）
      assert.ok(upstream.count("GET", "/api/v4/extract-results/batch/b1") >= 2);
      assert.ok(elapsedMs >= 900, `elapsed=${elapsedMs}ms，应至少等过一个轮询周期`);
    } finally {
      await upstream.close();
    }
  });
});

describe("runParse URL（按 data_id 认领结果）", () => {
  it("提交 URL 任务 → 轮询 → 落盘，结果为 URL 记录", async () => {
    // oracle: specified（URL 走 /extract/task/batch 并落盘）+ derived（zip 由本测试构造）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.protectedRoute("POST", "/api/v4/extract/task/batch", () => ({
        json: { code: 0, data: { batch_id: "b2" } },
      }));
      let polls = 0;
      upstream.protectedRoute("GET", "/api/v4/extract-results/batch/b2", () => {
        polls += 1;
        const item: BatchItemResult =
          polls === 1
            ? { file_name: "remote-page.html", data_id: "docparse-0", state: "running" }
            : { file_name: "remote-page.html", data_id: "docparse-0", state: "done", full_zip_url: `${upstream.baseUrl}/result.zip` };
        return { json: { code: 0, data: { extract_result: [item] } } };
      });
      upstream.route("GET", "/result.zip", () => ({ bytes: makeResultZip(MARKDOWN, IMAGE_BYTES) }));

      const { ctx } = makeContext(upstream);
      const outcome = await runParse(ctx, {
        inputs: ["https://example.com/docs/report.pdf"],
        params: {},
        out: outParent,
        wait: true,
        timeoutSec: 8,
      });

      assert.equal(outcome.failed, 0);
      const job = outcome.results[0];
      assert.ok(job);
      assert.equal(job.kind, "url");
      assert.equal(job.state, "done");
      assert.equal(job.batchId, "b2");
      const mdPath = job.mdPath;
      assert.ok(mdPath);
      assert.equal(path.basename(mdPath), "example-com-report.md");
      assert.equal(fs.readFileSync(mdPath, "utf8"), MARKDOWN);
    } finally {
      await upstream.close();
    }
  });
});

describe("runParse 失败与异常路径", () => {
  it("上游 state=failed：结果是 error 而非 mdPath，failed 计数为 1，error 带上游错误码", async () => {
    // oracle: specified（failed 计数、error 字段与「带错误码」契约）+ derived（err_msg / err_code 文本来自 stub）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.protectedRoute("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b1", file_urls: [`${upstream.baseUrl}/upload/0`] } },
      }));
      upstream.route("PUT", "/upload/0", () => ({ json: { ok: true } }));
      upstream.protectedRoute("GET", "/api/v4/extract-results/batch/b1", () => ({
        json: {
          code: 0,
          data: {
            extract_result: [
              {
                file_name: "broken.pdf",
                data_id: "docparse-0",
                state: "failed",
                err_code: "-60010",
                err_msg: "解析器内部错误",
              },
            ],
          },
        },
      }));

      const { ctx } = makeContext(upstream);
      const source = makeSourceFile("broken.pdf");
      const outcome = await runParse(ctx, {
        inputs: [source],
        params: {},
        out: outParent,
        wait: true,
        timeoutSec: 8,
      });

      assert.equal(outcome.failed, 1);
      const job = outcome.results[0];
      assert.ok(job);
      assert.equal(job.state, "failed");
      assert.equal(job.mdPath, undefined);
      assert.equal(job.error?.includes("解析器内部错误"), true);
      assert.equal(job.error?.includes("-60010"), true);
      assert.equal(fs.existsSync(outParent), false);
    } finally {
      await upstream.close();
    }
  });

  it("上游拒绝凭证（A0202）：抛 AuthError 且退出码为 5，请求带的是配置里的 token", async () => {
    // oracle: specified（A0202 → AuthError）+ derived（stub 期望另一个 token，故必然拒绝）
    const upstream = await StubUpstream.start("some-other-token");
    try {
      upstream.protectedRoute("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b1", file_urls: [`${upstream.baseUrl}/upload/0`] } },
      }));
      const { ctx } = makeContext(upstream);
      const source = makeSourceFile("rejected.pdf");

      await assert.rejects(
        runParse(ctx, { inputs: [source], params: {}, out: outParent, wait: true, timeoutSec: 5 }),
        (error: unknown) => {
          if (!(error instanceof AuthError)) throw new Error(`期望 AuthError，实际 ${String(error)}`);
          assert.equal(error.exitCode, 5);
          return true;
        },
      );

      const submit = upstream.find("POST", "/api/v4/file-urls/batch");
      assert.ok(submit);
      assert.equal(submit.authorization, `Bearer ${TOKEN}`);
    } finally {
      await upstream.close();
    }
  });

  it("多个账号全部被 A0202 拒绝：每个账号各试一次后抛 AuthError（退出码 5）", async () => {
    // oracle: specified（凭证类错误统一归到 auth，多账号下同样成立）
    const upstream = await StubUpstream.start("some-other-token");
    try {
      upstream.protectedRoute("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b1", file_urls: [`${upstream.baseUrl}/upload/0`] } },
      }));
      const { ctx } = makeContext(upstream, ["token-1", "token-2", "token-3"]);
      const source = makeSourceFile("rejected-all.pdf");

      await assert.rejects(
        runParse(ctx, { inputs: [source], params: {}, out: outParent, wait: true, timeoutSec: 5 }),
        (error: unknown) => {
          if (!(error instanceof AuthError)) throw new Error(`期望 AuthError，实际 ${String(error)}`);
          assert.equal(error.exitCode, 5);
          assert.equal(String(error.upstreamCode), "A0202");
          return true;
        },
      );

      // 三个账号各被调用一次：账号用尽即收口，不重复选号
      assert.equal(upstream.count("POST", "/api/v4/file-urls/batch"), 3);
    } finally {
      await upstream.close();
    }
  });

  it("轮询超时且无号可换：抛 UpstreamError（退出码 6）并保留 batch_id", async () => {
    // oracle: specified —— batch_id 是调用方唯一的重查线索，不能被「候选耗尽」的选号错误顶替
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.protectedRoute("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b-timeout", file_urls: [`${upstream.baseUrl}/upload/0`] } },
      }));
      upstream.route("PUT", "/upload/0", () => ({ json: { ok: true } }));
      upstream.protectedRoute("GET", "/api/v4/extract-results/batch/b-timeout", () => ({
        json: {
          code: 0,
          data: { extract_result: [{ file_name: "stuck.pdf", data_id: "docparse-0", state: "running" }] },
        },
      }));
      const { ctx } = makeContext(upstream);
      const source = makeSourceFile("stuck.pdf");

      await assert.rejects(
        runParse(ctx, { inputs: [source], params: {}, out: outParent, wait: true, timeoutSec: 1 }),
        (error: unknown) => {
          if (!(error instanceof UpstreamError)) throw new Error(`期望 UpstreamError，实际 ${String(error)}`);
          assert.equal(error.exitCode, 6);
          assert.match(error.message, /b-timeout/);
          return true;
        },
      );
    } finally {
      await upstream.close();
    }
  });

  it("网关账号（ak_sk）按账号级 base_url 出网，并带上 Bearer accessKey + X-Secret-Key", async () => {
    // oracle: specified（DEC-005：ak_sk 默认发 Authorization: Bearer <access_key> + X-Secret-Key；
    // 账号级 base_url 覆盖全局）。摆两个 stub，才能区分「用了全局地址」和「用了账号地址」
    const globalStub = await StubUpstream.start(TOKEN);
    const gatewayStub = await StubUpstream.start(TOKEN);
    try {
      gatewayStub.route("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b-gw", file_urls: [`${gatewayStub.baseUrl}/upload/0`] } },
      }));
      gatewayStub.route("PUT", "/upload/0", () => ({ json: { ok: true } }));
      gatewayStub.route("GET", "/api/v4/extract-results/batch/b-gw", () => ({
        json: {
          code: 0,
          data: {
            extract_result: [
              {
                file_name: "gw.pdf",
                data_id: "docparse-0",
                state: "done",
                full_zip_url: `${gatewayStub.baseUrl}/result.zip`,
              },
            ],
          },
        },
      }));
      gatewayStub.route("GET", "/result.zip", () => ({
        bytes: makeResultZip(MARKDOWN, IMAGE_BYTES),
        contentType: "application/zip",
      }));

      const configPath = path.join(tmpHome, "config.toml");
      fs.writeFileSync(
        configPath,
        [
          `base_url = "${globalStub.baseUrl}"`,
          "",
          "[[account]]",
          'name = "gw"',
          'auth = "ak_sk"',
          'access_key = "AK-TEST-1"',
          'secret_key = "SK-TEST-1"',
          `base_url = "${gatewayStub.baseUrl}"`,
          "",
          "[parse]",
          "poll_interval_sec = 1",
          "",
          "[output]",
          `root = '${path.join(tmpDir, "out-root")}'`,
          "",
        ].join("\n"),
        "utf8",
      );
      const ctx = buildContext({ configPath, outputMode: "json" });
      ctx.log = () => {};
      const source = makeSourceFile("gw.pdf");

      const outcome = await runParse(ctx, { inputs: [source], params: {}, out: outParent, wait: true, timeoutSec: 8 });

      assert.equal(outcome.failed, 0);
      assert.ok(outcome.results[0]?.mdPath);
      const submit = gatewayStub.find("POST", "/api/v4/file-urls/batch");
      assert.ok(submit, "账号级 base_url 未生效：请求没到网关 stub");
      assert.equal(submit.headers.authorization, "Bearer AK-TEST-1");
      assert.equal(submit.headers["x-secret-key"], "SK-TEST-1");
      assert.equal(globalStub.requests.length, 0, "全局 base_url 不应被用上");
    } finally {
      await globalStub.close();
      await gatewayStub.close();
    }
  });

  it("自定义 headers 模板按 ${access_key}/${secret_key}/${token} 替换后落到请求上", async () => {
    // oracle: specified（DEC-005：未知网关用 headers 模板兜住），且必须真的出现在出网请求里，
    // 而不只是 buildAuthHeaders 的返回值
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.route("POST", "/api/v4/file-urls/batch", () => ({
        json: { code: 0, data: { batch_id: "b-hd", file_urls: [`${upstream.baseUrl}/upload/0`] } },
      }));
      upstream.route("PUT", "/upload/0", () => ({ json: { ok: true } }));
      upstream.route("GET", "/api/v4/extract-results/batch/b-hd", () => ({
        json: {
          code: 0,
          data: {
            extract_result: [
              {
                file_name: "hd.pdf",
                data_id: "docparse-0",
                state: "done",
                full_zip_url: `${upstream.baseUrl}/result.zip`,
              },
            ],
          },
        },
      }));
      upstream.route("GET", "/result.zip", () => ({
        bytes: makeResultZip(MARKDOWN, IMAGE_BYTES),
        contentType: "application/zip",
      }));

      const configPath = path.join(tmpHome, "config.toml");
      fs.writeFileSync(
        configPath,
        [
          `base_url = "${upstream.baseUrl}"`,
          "",
          "[[account]]",
          'name = "custom"',
          'auth = "ak_sk"',
          'access_key = "AK-CUSTOM"',
          'secret_key = "SK-CUSTOM"',
          'token = "TOKEN-CUSTOM"',
          "",
          "[account.headers]",
          'X-Custom-Ak = "${access_key}"',
          'X-Custom-Sk = "${secret_key}"',
          'X-Custom-Token = "${token}"',
          'X-Custom-Static = "fixed"',
          "",
          "[parse]",
          "poll_interval_sec = 1",
          "",
          "[output]",
          `root = '${path.join(tmpDir, "out-root")}'`,
          "",
        ].join("\n"),
        "utf8",
      );
      const ctx = buildContext({ configPath, outputMode: "json" });
      ctx.log = () => {};
      const source = makeSourceFile("hd.pdf");

      const outcome = await runParse(ctx, { inputs: [source], params: {}, out: outParent, wait: true, timeoutSec: 8 });

      assert.equal(outcome.failed, 0);
      const submit = upstream.find("POST", "/api/v4/file-urls/batch");
      assert.ok(submit, "没有发出提交请求");
      assert.equal(submit.headers["x-custom-ak"], "AK-CUSTOM");
      assert.equal(submit.headers["x-custom-sk"], "SK-CUSTOM");
      assert.equal(submit.headers["x-custom-token"], "TOKEN-CUSTOM");
      assert.equal(submit.headers["x-custom-static"], "fixed");
      // 自定义模板存在时不再发默认的 ak_sk 头
      assert.equal(submit.headers.authorization, undefined);
    } finally {
      await upstream.close();
    }
  });

  it("task 查询不存在的任务（-60012）：错误消息带上厂商给的上游错误码", async () => {
    // oracle: specified（DEC-011：调用级失败也要把厂商给的码写进消息，不能只留在 --verbose 日志里）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.protectedRoute("GET", "/api/v4/extract/task/t-missing", () => ({
        json: { code: -60012, msg: "task not found or expire" },
      }));
      const { ctx } = makeContext(upstream);

      await assert.rejects(
        runTask(ctx, { taskId: "t-missing", download: false, wait: false }),
        (error: unknown) => {
          if (!(error instanceof UpstreamError)) throw new Error(`期望 UpstreamError，实际 ${String(error)}`);
          assert.equal(error.message.includes("-60012"), true);
          assert.equal(error.message.includes("task not found or expire"), true);
          return true;
        },
      );
    } finally {
      await upstream.close();
    }
  });

  it("batch：按 batch_id 续查，不下载时逐条给出文件名与状态", async () => {
    // oracle: specified（--no-wait 打印的 batch_id 要有命令能续查）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.protectedRoute("GET", "/api/v4/extract-results/batch/b-resume", () => ({
        json: {
          code: 0,
          data: {
            batch_id: "b-resume",
            extract_result: [
              { file_name: "a.pdf", data_id: "docparse-0", state: "done", full_zip_url: `${upstream.baseUrl}/zip/0` },
              { file_name: "b.pdf", data_id: "docparse-1", state: "running" },
            ],
          },
        },
      }));
      const { ctx } = makeContext(upstream);

      const outcome = await runBatch(ctx, { batchId: "b-resume", download: false, wait: false });
      assert.equal(outcome.batchId, "b-resume");
      assert.equal(outcome.failed, 0);
      assert.deepEqual(
        outcome.items.map((item) => [item.fileName, item.state]),
        [
          ["a.pdf", "done"],
          ["b.pdf", "running"],
        ],
      );
    } finally {
      await upstream.close();
    }
  });

  it("batch --download：已完成的文档落盘，返回可打开的 Markdown 路径", async () => {
    // oracle: specified（续查的最终目的是拿回文件，而不是只看状态）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.protectedRoute("GET", "/api/v4/extract-results/batch/b-download", () => ({
        json: {
          code: 0,
          data: {
            batch_id: "b-download",
            extract_result: [
              { file_name: "report.pdf", data_id: "docparse-0", state: "done", full_zip_url: `${upstream.baseUrl}/zip/one` },
            ],
          },
        },
      }));
      upstream.route("GET", "/zip/one", () => ({ bytes: makeResultZip(MARKDOWN, IMAGE_BYTES) }));
      const { ctx } = makeContext(upstream);

      const outcome = await runBatch(ctx, { batchId: "b-download", download: true, wait: false });
      const item = outcome.items[0];
      assert.ok(item);
      assert.equal(outcome.failed, 0);
      assert.ok(item.mdPath);
      assert.equal(fs.existsSync(item.mdPath!), true);
      assert.equal(fs.readFileSync(item.mdPath!, "utf8"), MARKDOWN);
      assert.equal(item.state, "done");
    } finally {
      await upstream.close();
    }
  });

  it("batch：批次不属于第一个账号（-60012）时换下一个账号查到结果", async () => {
    // oracle: specified（批次归属于提交它的账号，与 task 同一套换号规则）
    const upstream = await StubUpstream.start(TOKEN);
    try {
      upstream.route("GET", "/api/v4/extract-results/batch/b-other", (request) =>
        request.authorization === `Bearer ${TOKEN}`
          ? { json: { code: -60012, msg: "task not found or expire" } }
          : {
              json: {
                code: 0,
                data: { extract_result: [{ file_name: "x.pdf", state: "done" }] },
              },
            },
      );
      const { ctx } = makeContext(upstream, [TOKEN, `${TOKEN}-second`]);

      const outcome = await runBatch(ctx, { batchId: "b-other", download: false, wait: false });
      assert.deepEqual(
        outcome.items.map((item) => item.fileName),
        ["x.pdf"],
      );
      assert.equal(
        upstream.requests.some((request) => request.authorization === `Bearer ${TOKEN}-second`),
        true,
      );
    } finally {
      await upstream.close();
    }
  });
});

describe("pollBatchResults 收敛", () => {
  it("任务一直 running 时按 timeoutMs 抛 UpstreamError", async () => {
    // oracle: derived（poll.ts 自述三态：完成 / 失败 / 超时）+ specified（消息里带 batch_id）
    const calls: number[] = [];
    const client = {
      getBatchResults: async (): Promise<BatchItemResult[]> => {
        calls.push(Date.now());
        return [{ file_name: "never.pdf", data_id: "docparse-0", state: "running" }];
      },
    } as unknown as MineruClient;

    await assert.rejects(
      pollBatchResults(client, "b-timeout", 1, { intervalMs: 20, timeoutMs: 60 }),
      (error: unknown) => {
        if (!(error instanceof UpstreamError)) throw new Error(`期望 UpstreamError，实际 ${String(error)}`);
        assert.equal(error.message.includes("b-timeout"), true);
        return true;
      },
    );
    assert.ok(calls.length >= 2);
  });
});

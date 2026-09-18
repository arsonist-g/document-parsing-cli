/** `docparse flash`：Agent 轻量解析 API（免 token，≤10MB / ≤20 页，只出 Markdown）。 */

import fs from "node:fs";
import path from "node:path";

import { type CliContext } from "../context.js";
import { type AccountConfig } from "../config.js";
import { ArgsError, UpstreamError, describeUpstreamCode } from "../errors.js";
import { type ParseParams, downloadText } from "../mineru.js";
import { MineruClient } from "../mineru.js";
import { allocateOutputDir, outputParent, writeMarkdown } from "../output.js";
import { pollAgentResult } from "../poll.js";
import { formatBytes, isUrl, slugify } from "../util.js";

/** Agent 轻量解析的官方上限。 */
export const FLASH_MAX_BYTES = 10 * 1024 * 1024;
export const FLASH_MAX_PAGES = 20;

export interface FlashOptions {
  input: string;
  params: ParseParams;
  out?: string;
  timeoutSec?: number;
}

export interface FlashOutcome {
  input: string;
  kind: "file" | "url";
  state: string;
  mdPath?: string;
  outDir?: string;
  taskId?: string;
  bytes?: number;
}

function agentAccount(): AccountConfig {
  return {
    name: "agent",
    auth: "bearer",
    token: "",
    accessKey: "",
    secretKey: "",
    baseUrl: "",
    headers: {},
    weight: 1,
    enabled: true,
    source: "config",
  };
}

export async function runFlash(ctx: CliContext, options: FlashOptions): Promise<FlashOutcome> {
  const input = options.input;
  const kind: "file" | "url" = isUrl(input) ? "url" : "file";
  const slug = slugify(input);
  const parent = outputParent(ctx.config.output.root, options.out);
  const intervalMs = ctx.config.parse.pollIntervalSec * 1000;
  const timeoutMs = (options.timeoutSec ?? ctx.config.parse.pollTimeoutSec) * 1000;
  const client = new MineruClient({
    baseUrl: ctx.config.baseUrl,
    account: agentAccount(),
    timeoutMs: 60_000,
    verbose: ctx.verbose,
    log: ctx.log,
  });

  let sizeBytes: number | undefined;
  let taskId: string;
  if (kind === "file") {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new ArgsError(`文件不存在：${input}`);
    const stat = fs.statSync(resolved);
    sizeBytes = stat.size;
    if (stat.size === 0) throw new ArgsError(`空文件：${input}`);
    if (stat.size > FLASH_MAX_BYTES) {
      throw new ArgsError(
        `轻量解析上限 10MB，当前 ${formatBytes(stat.size)}：改用 docparse parse（精准解析）`,
      );
    }
    const created = await client.agentParseFile(path.basename(input), options.params);
    taskId = created.taskId;
    ctx.log(`↑ 上传文件（Agent 轻量解析）task_id=${taskId}`);
    await client.uploadFile(created.fileUrl, new Uint8Array(fs.readFileSync(resolved)));
  } else {
    const created = await client.agentParseUrl(input, options.params);
    taskId = created.taskId;
    ctx.log(`↑ 提交 URL（Agent 轻量解析）task_id=${taskId}`);
  }

  const result = await pollAgentResult(client, taskId, {
    intervalMs,
    timeoutMs,
    onTick: (message) => ctx.log(`… ${message}`),
  });

  if (result.state === "failed") {
    const hint =
      result.err_code === -30001 || result.err_code === -30003
        ? "：改用 docparse parse（精准解析，上限 200MB / 200 页）"
        : "";
    throw new UpstreamError(
      `轻量解析失败 [${describeUpstreamCode(result.err_code ?? "unknown")}] ${result.err_msg ?? ""}${hint}`,
      { upstreamCode: result.err_code ?? "unknown" },
    );
  }
  if (!result.markdown_url) throw new UpstreamError("任务完成但上游未返回 markdown 地址");

  const markdown = await downloadText(result.markdown_url, 120_000, ctx.verbose);
  const outDir = allocateOutputDir(parent, slug);
  const mdPath = writeMarkdown(outDir, slug, markdown);
  return { input, kind, state: result.state, mdPath, outDir, taskId, bytes: sizeBytes };
}


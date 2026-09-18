/** `docparse batch`：按 batch_id 续查一次批量解析任务，可选轮询与下载。 */

import { type CliContext } from "../context.js";
import { ArgsError, UpstreamError } from "../errors.js";
import { type BatchItemResult, describeTaskFailure } from "../mineru.js";
import { pollBatchResults } from "../poll.js";
import { outputParent } from "../output.js";
import { slugify } from "../util.js";
import { downloadAndExtractAsync } from "./parse.js";

export interface BatchOptions {
  batchId: string;
  download: boolean;
  out?: string;
  wait: boolean;
  timeoutSec?: number;
  slug?: string;
}

export interface BatchItemOutcome {
  fileName: string;
  dataId?: string;
  state: string;
  mdPath?: string;
  outDir?: string;
  error?: string;
}

export interface BatchOutcome {
  batchId: string;
  items: BatchItemOutcome[];
  failed: number;
}

const TERMINAL = new Set(["done", "failed"]);

/**
 * 批次归属于提交它的账号，与 `task` 同一套做法：按顺序尝试池内账号，
 * 命中「找不到 / 无权访问 / token 失效」就换下一个，其余错误直接浮出。
 */
export async function runBatch(ctx: CliContext, options: BatchOptions): Promise<BatchOutcome> {
  const accounts = ctx.pool.usableAccounts();
  if (accounts.length === 0) throw new ArgsError("未配置任何解析账号，无法查询批量任务（docparse account add）");

  let lastError: unknown;
  for (const account of accounts) {
    const client = ctx.clientFor(account);
    try {
      let items = await client.getBatchResults(options.batchId);
      if (options.wait && items.length > 0) {
        items = await pollBatchResults(client, options.batchId, items.length, {
          intervalMs: ctx.config.parse.pollIntervalSec * 1000,
          timeoutMs: (options.timeoutSec ?? ctx.config.parse.pollTimeoutSec) * 1000,
          onTick: (message) => ctx.log(`… ${message}`),
        });
      }
      if (options.slug && items.length > 1) {
        throw new ArgsError(`--slug 只适用于单文档批次（该批次有 ${items.length} 个文档）`);
      }
      return await collect(ctx, options, items);
    } catch (error) {
      lastError = error;
      const code = codeOf(error);
      if (code === "-60012" || code === "-60013" || code === "A0202" || code === "A0211") {
        ctx.log(`… 账号 ${account.name} 不匹配该批次（${code}），换下一个账号`);
        continue;
      }
      throw error;
    }
  }
  throw new UpstreamError(
    `所有账号都无法查询该批次：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function collect(
  ctx: CliContext,
  options: BatchOptions,
  items: BatchItemResult[],
): Promise<BatchOutcome> {
  const parent = outputParent(ctx.config.output.root, options.out);
  const out: BatchItemOutcome[] = [];
  for (const item of items) {
    const base: BatchItemOutcome = {
      fileName: item.file_name || item.data_id || options.batchId,
      state: item.state,
      ...(item.data_id ? { dataId: item.data_id } : {}),
    };
    if (item.state === "failed") {
      out.push({ ...base, error: describeTaskFailure(item.state, item.err_msg, item.err_code) });
      continue;
    }
    if (!options.download) {
      out.push(base);
      continue;
    }
    if (!TERMINAL.has(item.state) || !item.full_zip_url) {
      out.push({ ...base, error: `尚未完成（state=${item.state}），无法下载结果` });
      continue;
    }
    const slug = options.slug ?? slugify(base.fileName);
    const { mdPath, outDir } = await downloadAndExtractAsync(ctx, item.full_zip_url, slug, parent);
    out.push({ ...base, mdPath, outDir });
  }
  return { batchId: options.batchId, items: out, failed: out.filter((item) => item.error).length };
}

function codeOf(error: unknown): string {
  const value = (error as { upstreamCode?: string | number }).upstreamCode;
  return value === undefined ? "" : String(value);
}

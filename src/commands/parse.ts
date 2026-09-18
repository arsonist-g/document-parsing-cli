/** `docparse parse`：本地文件 / URL → Markdown（精准解析 API，需要账号）。 */

import fs from "node:fs";
import path from "node:path";

import { type CliContext } from "../context.js";
import { ArgsError, DocparseError, UpstreamError, describeUpstreamCode } from "../errors.js";
import { type AccountConfig } from "../config.js";
import {
  type BatchItemResult,
  type ParseParams,
  type TaskState,
  describeTaskFailure,
  downloadBytes,
} from "../mineru.js";
import { pollBatchResults } from "../poll.js";
import { allocateOutputDir, extractZipTo, outputParent, renameMarkdown } from "../output.js";
import { withAccount } from "../pool.js";
import { formatBytes, isUrl, slugify } from "../util.js";

/** 单次申请上传链接的官方上限（文档：≤50 个）。 */
const CHUNK_SIZE = 50;

export interface ParseCommandOptions {
  inputs: string[];
  params: ParseParams;
  out?: string;
  wait: boolean;
  timeoutSec?: number;
}

export interface JobOutcome {
  input: string;
  kind: "file" | "url";
  state: TaskState | "submitted";
  mdPath?: string;
  outDir?: string;
  taskId?: string;
  batchId?: string;
  error?: string;
  bytes?: number;
}

export interface ParseOutcome {
  results: JobOutcome[];
  batchIds: string[];
  failed: number;
}

interface Job {
  input: string;
  kind: "file" | "url";
  dataId: string;
  slug: string;
  sizeBytes?: number;
}

function makeJobs(ctx: CliContext, inputs: string[]): Job[] {
  const maxBytes = ctx.config.parse.maxUploadMb * 1024 * 1024;
  return inputs.map((input, index) => {
    const kind: Job["kind"] = isUrl(input) ? "url" : "file";
    const job: Job = {
      input,
      kind,
      dataId: `docparse-${index}`,
      slug: slugify(input),
    };
    if (kind === "file") {
      const resolved = path.resolve(input);
      if (!fs.existsSync(resolved)) throw new ArgsError(`文件不存在：${input}`);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new ArgsError(`不是文件：${input}`);
      if (stat.size === 0) throw new ArgsError(`空文件：${input}`);
      if (stat.size > maxBytes) {
        throw new ArgsError(
          `文件超过 ${ctx.config.parse.maxUploadMb}MB 上限：${input}（${formatBytes(stat.size)}）`,
        );
      }
      job.sizeBytes = stat.size;
    }
    return job;
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function pickResult(results: BatchItemResult[], job: Job): BatchItemResult | undefined {
  const byDataId = results.find((item) => item.data_id === job.dataId);
  if (byDataId) return byDataId;
  const fileName = job.kind === "file" ? path.basename(job.input) : undefined;
  if (fileName) {
    const byName = results.find((item) => item.file_name === fileName);
    if (byName) return byName;
  }
  return undefined;
}

/** 下载结果压缩包、解压、定位 markdown。返回最终 markdown 路径。 */
export async function downloadAndExtractAsync(
  ctx: CliContext,
  zipUrl: string,
  slug: string,
  parentDir: string,
): Promise<{ mdPath: string; outDir: string }> {
  ctx.log(`↓ 下载解析结果 ${zipUrl}`);
  const bytes = await downloadBytes(zipUrl, Math.max(120_000, ctx.config.parse.pollTimeoutSec * 1000), ctx.verbose);
  const outDir = allocateOutputDir(parentDir, slug);
  extractZipTo(bytes, outDir);
  const mdPath = renameMarkdown(outDir, slug);
  return { mdPath, outDir };
}

export async function runParse(ctx: CliContext, options: ParseCommandOptions): Promise<ParseOutcome> {
  if (options.inputs.length === 0) throw new ArgsError("parse 至少需要一个文件路径或 URL");
  const jobs = makeJobs(ctx, options.inputs);
  const parent = outputParent(ctx.config.output.root, options.out);
  const intervalMs = ctx.config.parse.pollIntervalSec * 1000;
  const timeoutMs = (options.timeoutSec ?? ctx.config.parse.pollTimeoutSec) * 1000;
  const outcomes = new Map<Job, JobOutcome>();
  const batchIds: string[] = [];

  for (const job of jobs) {
    outcomes.set(job, { input: job.input, kind: job.kind, state: "submitted" });
  }

  const submitGroup = async (group: Job[]): Promise<void> => {
    const { result, account } = await withAccount(
      ctx.pool,
      async (acct: AccountConfig) => {
        const client = ctx.clientFor(acct);
        let batchId: string;
        if (group[0]!.kind === "file") {
          const created = await client.createUploadBatch(
            group.map((job) => ({
              name: path.basename(job.input),
              dataId: job.dataId,
              pageRanges: options.params.pageRanges,
            })),
            options.params,
          );
          batchId = created.batchId;
          ctx.log(`↑ 上传 ${group.length} 个文件（${accountLabel(acct)}）`);
          for (let i = 0; i < group.length; i += 1) {
            const job = group[i]!;
            const uploadUrl = created.fileUrls[i];
            if (!uploadUrl) throw new UpstreamError("上游返回的上传链接数量少于文件数");
            await client.uploadFile(uploadUrl, new Uint8Array(fs.readFileSync(path.resolve(job.input))));
          }
        } else {
          const created = await client.createUrlBatch(
            group.map((job) => ({ url: job.input, dataId: job.dataId, pageRanges: options.params.pageRanges })),
            options.params,
          );
          batchId = created;
          ctx.log(`↑ 提交 ${group.length} 个 URL 解析任务（${accountLabel(acct)}）`);
        }

        for (const job of group) {
          const outcome = outcomes.get(job)!;
          outcome.batchId = batchId;
        }

        if (!options.wait) return { batchId, results: [] as BatchItemResult[] };

        const results = await pollBatchResults(client, batchId, group.length, {
          intervalMs,
          timeoutMs,
          onTick: (message) => ctx.log(`… ${message}`),
        });
        return { batchId, results };
      },
      { maxAttempts: 4, onRetry: (acct, error) => ctx.log(`! ${accountLabel(acct)} 调用失败，换号重试：${messageOf(error)}`) },
    );

    batchIds.push(result.batchId);
    if (!options.wait) return;

    for (const job of group) {
      const outcome = outcomes.get(job)!;
      const item = pickResult(result.results, job);
      if (!item) {
        outcome.state = "failed";
        outcome.error = "上游结果里没有该文件的条目";
        continue;
      }
      outcome.state = item.state;
      if (item.state === "failed") {
        outcome.error = describeTaskFailure(item.state, item.err_msg, item.err_code);
        continue;
      }
      if (!item.full_zip_url) {
        outcome.state = "failed";
        outcome.error = "任务已完成但上游未返回结果压缩包地址";
        continue;
      }
      const { mdPath, outDir } = await downloadAndExtractAsync(ctx, item.full_zip_url, job.slug, parent);
      outcome.mdPath = mdPath;
      outcome.outDir = outDir;
    }
  };

  for (const kind of ["file", "url"] as const) {
    const group = jobs.filter((job) => job.kind === kind);
    for (const chunk of chunks(group, CHUNK_SIZE)) {
      await submitGroup(chunk);
    }
  }

  const results = jobs.map((job) => outcomes.get(job)!);
  const failed = results.filter((item) => item.error !== undefined).length;
  return { results, batchIds, failed };
}

function accountLabel(account: AccountConfig): string {
  return `账号 ${account.name}`;
}

function messageOf(error: unknown): string {
  if (error instanceof DocparseError) {
    return error.upstreamCode !== undefined
      ? describeUpstreamCode(error.upstreamCode)
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}




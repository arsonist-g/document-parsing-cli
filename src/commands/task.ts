/** `docparse task`：按 task_id 查询精准解析任务，可选下载结果。 */

import { type CliContext } from "../context.js";
import { ArgsError, UpstreamError } from "../errors.js";
import { describeTaskFailure } from "../mineru.js";
import { downloadAndExtractAsync } from "./parse.js";
import { outputParent } from "../output.js";
import { slugify } from "../util.js";
import { pollTask } from "../poll.js";

export interface TaskOptions {
  taskId: string;
  download: boolean;
  out?: string;
  wait: boolean;
  timeoutSec?: number;
  slug?: string;
}

export interface TaskOutcome {
  taskId: string;
  state: string;
  mdPath?: string;
  outDir?: string;
}

/**
 * 任务归属于提交它的账号，因此按顺序尝试池内账号：
 * 命中「无权访问 / 找不到任务」说明不是这个账号，换下一个；
 * 命中 token 类错误说明该账号已失效，同样换下一个。
 */
export async function runTask(ctx: CliContext, options: TaskOptions): Promise<TaskOutcome> {
  const accounts = ctx.pool.usableAccounts();
  if (accounts.length === 0) throw new ArgsError("未配置任何解析账号，无法查询任务（docparse account add）");

  let lastError: unknown;
  for (const account of accounts) {
    const client = ctx.clientFor(account);
    try {
      const first = options.wait
        ? await pollTask(client, options.taskId, {
            intervalMs: ctx.config.parse.pollIntervalSec * 1000,
            timeoutMs: (options.timeoutSec ?? ctx.config.parse.pollTimeoutSec) * 1000,
            onTick: (message) => ctx.log(`… ${message}`),
          })
        : await client.getTask(options.taskId);

      if (first.state === "failed") {
        throw new UpstreamError(describeTaskFailure(first.state, first.err_msg, first.err_code));
      }
      if (!options.download) {
        return { taskId: first.task_id, state: first.state };
      }
      if (!first.full_zip_url) {
        throw new UpstreamError(`任务尚未完成（state=${first.state}），无法下载结果`);
      }
      const slug = options.slug ?? slugify(options.taskId);
      const { mdPath, outDir } = await downloadAndExtractAsync(
        ctx,
        first.full_zip_url,
        slug,
        outputParent(ctx.config.output.root, options.out),
      );
      return { taskId: first.task_id, state: first.state, mdPath, outDir };
    } catch (error) {
      lastError = error;
      const code = codeOf(error);
      if (code === "-60012" || code === "-60013" || code === "A0202" || code === "A0211") {
        ctx.log(`… 账号 ${account.name} 不匹配该任务（${code}），换下一个账号`);
        continue;
      }
      throw error;
    }
  }
  throw new UpstreamError(
    `所有账号都无法查询该任务：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function codeOf(error: unknown): string {
  const value = (error as { upstreamCode?: string | number }).upstreamCode;
  return value === undefined ? "" : String(value);
}



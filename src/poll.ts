/** 轮询工具：把上游的异步任务状态机收敛成「完成 / 失败 / 超时」三态。 */

import { UpstreamError } from "./errors.js";
import { type AgentResult, type BatchItemResult, type MineruClient, type TaskResult } from "./mineru.js";
import { sleep } from "./util.js";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  onTick?: (message: string) => void;
}

const TERMINAL = new Set(["done", "failed"]);

function deadline(options: PollOptions): number {
  return Date.now() + options.timeoutMs;
}

/** 轮询精准解析的批量任务，直到全部进入终态。 */
export async function pollBatchResults(
  client: MineruClient,
  batchId: string,
  expected: number,
  options: PollOptions,
): Promise<BatchItemResult[]> {
  const until = deadline(options);
  let last: BatchItemResult[] = [];
  for (;;) {
    last = await client.getBatchResults(batchId);
    const settled = last.filter((item) => TERMINAL.has(item.state)).length;
    const running = last.filter((item) => item.state === "running" || item.state === "converting");
    const pages = running
      .map((item) => item.extract_progress)
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => `${p.extracted_pages ?? "?"}/${p.total_pages ?? "?"}`);
    options.onTick?.(`已提交 ${expected} 个，完成 ${settled} 个${pages.length > 0 ? `（解析中 ${pages.join(" ")} 页）` : ""}`);
    if (expected > 0 && last.length >= expected && settled >= expected) return last;
    if (last.length > 0 && settled === last.length && last.length >= expected) return last;
    if (Date.now() >= until) {
      throw new UpstreamError(
        `等待解析结果超时（${Math.round(options.timeoutMs / 1000)}s），任务仍在上游解析，batch_id：${batchId}（用 docparse batch ${batchId} 续查）`,
      );
    }
    await sleep(options.intervalMs);
  }
}

/** 轮询单个精准解析任务。 */
export async function pollTask(client: MineruClient, taskId: string, options: PollOptions): Promise<TaskResult> {
  const until = deadline(options);
  for (;;) {
    const task = await client.getTask(taskId);
    options.onTick?.(`任务 ${taskId}：${task.state}`);
    if (TERMINAL.has(task.state)) return task;
    if (Date.now() >= until) {
      throw new UpstreamError(`等待任务结果超时，可用 task_id 稍后重查：${taskId}`);
    }
    await sleep(options.intervalMs);
  }
}

/** 轮询 Agent 轻量解析任务。 */
export async function pollAgentResult(
  client: MineruClient,
  taskId: string,
  options: PollOptions,
): Promise<AgentResult> {
  const until = deadline(options);
  for (;;) {
    const result = await client.agentGetResult(taskId);
    options.onTick?.(`任务 ${taskId}：${result.state}`);
    if (TERMINAL.has(result.state)) return result;
    if (Date.now() >= until) {
      throw new UpstreamError(`等待解析结果超时，可用 task_id 稍后重查：${taskId}`);
    }
    await sleep(options.intervalMs);
  }
}

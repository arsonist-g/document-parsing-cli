/**
 * 账号池：多账号之间的负载均衡与故障隔离。
 *
 * 选择策略：先过滤掉「已禁用 / 冷却中 / 本轮已试过」的账号，再按
 * 「在途请求数少 → 最久未使用 → 权重高」排序取最优，避免单账号被压满或被风控。
 * 失败按错误码分类冷却：凭证错误长时间冷却、额度用尽冷却到次日、服务抖动短冷却。
 */

import fs from "node:fs";
import path from "node:path";

import {
  accountBaseUrl,
  accountKey,
  isAccountUsable,
  type AccountConfig,
  type Config,
} from "./config.js";
import { AuthError, DocparseError, UpstreamError, isAccountFault, isRetryableUpstreamCode } from "./errors.js";
import { ensureDir, maskSecret } from "./util.js";

const STATE_VERSION = 1;

/** 从未使用过的账号在选号时按「已空闲一整天」计，保证首轮一定排在用过的账号前面。 */
const NEVER_USED_IDLE_MS = 24 * 3600_000;

export interface AccountRuntime {
  cooldownUntil: number;
  cooldownReason: string;
  failures: number;
  successes: number;
  lastUsedAt: number;
}

interface StateFile {
  version: number;
  accounts: Record<string, AccountRuntime>;
}

function emptyRuntime(): AccountRuntime {
  return { cooldownUntil: 0, cooldownReason: "", failures: 0, successes: 0, lastUsedAt: 0 };
}

function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 5, 0, 0);
  return d.getTime();
}

/** 按错误类型决定冷却时长（毫秒）。0 表示不冷却。 */
function cooldownFor(error: unknown, failures: number): { ms: number; reason: string } {
  const code =
    error instanceof DocparseError && error.upstreamCode !== undefined ? String(error.upstreamCode) : "";
  if (code === "A0202" || code === "A0211") {
    return { ms: 24 * 3600_000, reason: `凭证失效（${code}）` };
  }
  if (code === "-60018" || code === "-60019") {
    return { ms: Math.max(60_000, nextLocalMidnight(Date.now()) - Date.now()), reason: `额度用尽（${code}）` };
  }
  if (code === "-60009" || code === "429") {
    const ms = Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
    return { ms, reason: `上游限流（${code}）` };
  }
  if (error instanceof DocparseError && (error.kind === "network" || error.kind === "upstream")) {
    const ms = Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
    return { ms, reason: error.kind === "network" ? "网络异常" : `上游异常（${code || "unknown"}）` };
  }
  return { ms: 0, reason: "" };
}

export class AccountPool {
  readonly config: Config;
  private readonly stateFile: string;
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly inflight = new Map<string, number>();

  private constructor(config: Config, stateFile: string, state: StateFile) {
    this.config = config;
    this.stateFile = stateFile;
    for (const [key, value] of Object.entries(state.accounts)) {
      this.runtimes.set(key, { ...emptyRuntime(), ...value });
    }
  }

  static load(config: Config, stateFile: string): AccountPool {
    let state: StateFile = { version: STATE_VERSION, accounts: {} };
    try {
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as StateFile;
        if (parsed && typeof parsed === "object" && parsed.accounts) {
          state = { version: STATE_VERSION, accounts: parsed.accounts };
        }
      }
    } catch {
      // 状态文件损坏不应阻断主流程：按空状态继续，后续覆盖写回
    }
    return new AccountPool(config, stateFile, state);
  }

  /** 所有「配置齐全」的账号（含冷却中的，供 account list 展示）。 */
  usableAccounts(): AccountConfig[] {
    return this.config.accounts.filter(isAccountUsable);
  }

  /** 剔除冷却中账号后仍可调用的账号；全在冷却中时返回全部可用账号（宁可试也不放弃）。 */
  candidates(exclude: ReadonlySet<string> = new Set()): AccountConfig[] {
    const now = Date.now();
    const usable = this.usableAccounts().filter(
      (account) => !exclude.has(this.label(account)) && !exclude.has(accountKey(account)),
    );
    const ready = usable.filter((account) => this.runtime(account).cooldownUntil <= now);
    return ready.length > 0 ? ready : usable;
  }

  label(account: AccountConfig): string {
    return `${account.name}@${accountBaseUrl(this.config, account)}`;
  }

  runtime(account: AccountConfig): AccountRuntime {
    const key = accountKey(account);
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = emptyRuntime();
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  /** 选一个账号：在途少 → 最久未用 → 权重大。 */
  pick(exclude: ReadonlySet<string> = new Set()): AccountConfig {
    const candidates = this.candidates(exclude);
    if (candidates.length === 0) {
      if (this.config.accounts.length === 0) {
        throw new AuthError(
          `未配置任何解析账号：在 ${this.config.path} 里加 [[account]] token，或设置环境变量 DOCPARSE_TOKEN`,
        );
      }
      throw new AuthError("所有账号都不可用：检查 token 是否填写完整且未全部失效（docparse account list）");
    }

    const now = Date.now();
    const inflightOf = (account: AccountConfig): number => this.inflight.get(accountKey(account)) ?? 0;
    // 第一级：在途请求数最少者优先，并发批量时把请求摊到空闲账号上
    const minInflight = Math.min(...candidates.map(inflightOf));
    const shortlist = candidates.filter((account) => inflightOf(account) === minInflight);
    // 第二级：取「已空闲时长 × 权重」最大者 —— 刚用过的账号空闲时长短会排到队尾，
    // 从未使用的账号按一整天计因而排最前；权重越大越容易被选中
    let best = shortlist[0]!;
    let bestScore = -1;
    for (const account of shortlist) {
      const runtime = this.runtime(account);
      const idleMs =
        runtime.lastUsedAt === 0 ? NEVER_USED_IDLE_MS : Math.max(0, now - runtime.lastUsedAt);
      const weight = account.weight > 0 ? account.weight : 1;
      const score = idleMs * weight;
      if (score > bestScore) {
        bestScore = score;
        best = account;
      }
    }
    return best;
  }

  acquire(account: AccountConfig): void {
    const key = accountKey(account);
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    this.runtime(account).lastUsedAt = Date.now();
  }

  release(account: AccountConfig): void {
    const key = accountKey(account);
    const next = (this.inflight.get(key) ?? 1) - 1;
    if (next <= 0) this.inflight.delete(key);
    else this.inflight.set(key, next);
  }

  markSuccess(account: AccountConfig): void {
    const runtime = this.runtime(account);
    runtime.successes += 1;
    runtime.failures = 0;
    runtime.cooldownUntil = 0;
    runtime.cooldownReason = "";
    this.save();
  }

  markFailure(account: AccountConfig, error: unknown): { cooled: boolean; reason: string; ms: number } {
    const runtime = this.runtime(account);
    runtime.failures += 1;
    const { ms, reason } = cooldownFor(error, runtime.failures);
    if (ms > 0) {
      runtime.cooldownUntil = Math.max(runtime.cooldownUntil, Date.now() + ms);
      runtime.cooldownReason = reason;
    }
    this.save();
    return { cooled: ms > 0, reason, ms };
  }

  /** 判断某个失败是否值得换账号重试。 */
  static shouldRetry(error: unknown): boolean {
    if (!(error instanceof DocparseError)) return false;
    if (error.kind === "network") return true;
    if (error.kind === "upstream") {
      if (error.upstreamCode === undefined) return true;
      return isRetryableUpstreamCode(error.upstreamCode) || isAccountFault(error.upstreamCode);
    }
    return false;
  }

  save(): void {
    try {
      ensureDir(path.dirname(this.stateFile));
      const accounts: Record<string, AccountRuntime> = {};
      for (const [key, value] of this.runtimes) accounts[key] = value;
      const payload: StateFile = { version: STATE_VERSION, accounts };
      fs.writeFileSync(this.stateFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // 状态写不进去只是丢失调度记忆，不影响本次解析，静默降级
    }
  }

  /** `account list` / `doctor` 用的只读快照。 */
  describe(): Array<{
    name: string;
    auth: string;
    baseUrl: string;
    credential: string;
    state: string;
    cooldownRemainSec: number;
    successes: number;
    failures: number;
    source: string;
  }> {
    const now = Date.now();
    return this.config.accounts.map((account) => {
      const runtime = this.runtime(account);
      const cooldownRemainSec = Math.max(0, Math.round((runtime.cooldownUntil - now) / 1000));
      const usable = isAccountUsable(account);
      let state: string;
      if (!usable) state = "未配置完整";
      else if (cooldownRemainSec > 0) state = `冷却中(${runtime.cooldownReason})`;
      else state = "可用";
      const credential =
        account.auth === "ak_sk"
          ? `AK ${maskSecret(account.accessKey)} / SK ${maskSecret(account.secretKey)}`
          : maskSecret(account.token);
      return {
        name: account.name,
        auth: account.auth,
        baseUrl: accountBaseUrl(this.config, account),
        credential,
        state,
        cooldownRemainSec,
        successes: runtime.successes,
        failures: runtime.failures,
        source: account.source,
      };
    });
  }
}

/** 在账号池上执行一次调用，失败自动换账号重试。 */
export async function withAccount<T>(
  pool: AccountPool,
  run: (account: AccountConfig) => Promise<T>,
  options: { maxAttempts?: number; onRetry?: (account: AccountConfig, error: unknown) => void } = {},
): Promise<{ result: T; account: AccountConfig }> {
  const tried = new Set<string>();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = pool.pick(tried);
    tried.add(pool.label(account));
    tried.add(accountKey(account));
    pool.acquire(account);
    try {
      const result = await run(account);
      pool.markSuccess(account);
      return { result, account };
    } catch (error) {
      lastError = error;
      pool.markFailure(account, error);
      // 请求本身有问题的错误换账号也没用，立即收口
      if (!AccountPool.shouldRetry(error)) break;
      // 已经没有别的账号可换时同样收口，并保留这个真实错误：若继续下一轮，
      // pick() 会因为候选耗尽抛 AuthError，把上游错误码 / 轮询超时里的 batch_id 顶掉
      if (pool.candidates(tried).length === 0) break;
      options.onRetry?.(account, error);
    } finally {
      pool.release(account);
    }
  }
  throw normalizeExhaustedError(lastError);
}

/** 换号重试都没能成功时的收口：凭证类错误统一归到 auth，便于调用方用退出码区分。 */
function normalizeExhaustedError(lastError: unknown): unknown {
  if (lastError instanceof DocparseError) {
    const code = lastError.upstreamCode === undefined ? "" : String(lastError.upstreamCode);
    if (code === "A0202" || code === "A0211") {
      return new AuthError(`账号凭证不可用：${lastError.message}（docparse account test 可逐个探活）`, {
        upstreamCode: code,
        cause: lastError,
      });
    }
    return lastError;
  }
  return new UpstreamError(lastError instanceof Error ? lastError.message : "全部账号均调用失败");
}




/** 运行上下文：配置 + 账号池 + 日志 + 客户端工厂。 */

import { loadConfig, accountBaseUrl, type AccountConfig, type Config, type LoadOptions } from "./config.js";
import { AccountPool } from "./pool.js";
import { MineruClient } from "./mineru.js";
import { statePath } from "./config.js";

export type OutputMode = "text" | "json";

export interface CliContext {
  config: Config;
  pool: AccountPool;
  verbose: boolean;
  outputMode: OutputMode;
  /** 进度/诊断信息一律走 stderr，stdout 只留给结果。 */
  log: (message: string) => void;
  clientFor: (account: AccountConfig, timeoutMs?: number) => MineruClient;
}

export function buildContext(options: LoadOptions & { verbose?: boolean; outputMode?: OutputMode }): CliContext {
  const config = loadConfig(options);
  const pool = AccountPool.load(config, statePath());
  const verbose = options.verbose ?? false;
  const log = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };
  return {
    config,
    pool,
    verbose,
    outputMode: options.outputMode ?? "text",
    log,
    clientFor: (account: AccountConfig, timeoutMs: number = 60_000) =>
      new MineruClient({
        baseUrl: accountBaseUrl(config, account),
        account,
        timeoutMs,
        verbose,
        log,
      }),
  };
}

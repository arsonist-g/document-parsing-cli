/** 管理类命令：config / account / skills / doctor。 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseToml } from "smol-toml";

import { type CliContext } from "../context.js";
import { configDir, configTemplate, writeConfig } from "../config.js";
import {
  ArgsError,
  DocparseError,
  EXIT_CODE,
  NetworkError,
  UpstreamError,
  describeUpstreamCode,
} from "../errors.js";
import { MineruClient, type ExtractStatus } from "../mineru.js";
import { renderTable } from "../report.js";
import { installSkill, parseTargets, skillStatus } from "../skills.js";

type RawConfig = Record<string, unknown>;

function readRaw(filePath: string): RawConfig {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = parseToml(text);
  return parsed && typeof parsed === "object" ? (parsed as RawConfig) : {};
}

function section(raw: RawConfig, name: string): RawConfig {
  const value = raw[name];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawConfig) : {};
}

function accountsOf(raw: RawConfig): RawConfig[] {
  const value = raw.account ?? raw.accounts;
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as RawConfig[];
  if (value && typeof value === "object") return [value as RawConfig];
  return [];
}

// ------------------------------------------------------------------ config

export function runConfigPath(ctx: CliContext): void {
  process.stdout.write(`${ctx.config.path}\n`);
}

export interface ConfigSummary {
  config_path: string;
  exists: boolean;
  base_url: string;
  model_version: string;
  language: string;
  output_root: string;
  accounts: Array<Record<string, string>>;
}

export function configSummary(ctx: CliContext): ConfigSummary {
  return {
    config_path: ctx.config.path,
    exists: ctx.config.exists,
    base_url: ctx.config.baseUrl,
    model_version: ctx.config.parse.modelVersion,
    language: ctx.config.parse.language,
    output_root: ctx.config.output.root,
    accounts: ctx.pool.describe().map((item) => ({
      name: item.name,
      auth: item.auth,
      base_url: item.baseUrl,
      credential: item.credential,
      state: item.state,
    })),
  };
}

export function runConfigShow(ctx: CliContext): void {
  const summary = configSummary(ctx);
  const header = [
    `config: ${summary.config_path}${summary.exists ? "" : "（尚不存在）"}`,
    `base_url: ${summary.base_url}`,
    `model: ${summary.model_version}  language: ${summary.language}`,
    `output root: ${summary.output_root}`,
    "",
    "accounts:",
    renderTable(summary.accounts, ["name", "auth", "base_url", "credential", "state"]),
  ];
  process.stdout.write(`${header.join("\n")}\n`);
}

export function runConfigInit(ctx: CliContext, force: boolean): { path: string; created: boolean } {
  const target = ctx.config.path;
  if (fs.existsSync(target) && !force) {
    return { path: target, created: false };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, configTemplate(), "utf8");
  return { path: target, created: true };
}

const SETTABLE_KEYS = new Set([
  "base_url",
  "output.root",
  "parse.model_version",
  "parse.language",
  "parse.is_ocr",
  "parse.enable_formula",
  "parse.enable_table",
  "parse.poll_interval_sec",
  "parse.poll_timeout_sec",
  "parse.max_upload_mb",
]);

const NUMERIC_KEYS = new Set([
  "parse.poll_interval_sec",
  "parse.poll_timeout_sec",
  "parse.max_upload_mb",
]);

const BOOLEAN_KEYS = new Set(["parse.is_ocr", "parse.enable_formula", "parse.enable_table"]);

export function runConfigSet(ctx: CliContext, key: string, value: string): { key: string; value: string } {
  if (!SETTABLE_KEYS.has(key)) {
    throw new ArgsError(`不支持配置的键「${key}」，可选：${[...SETTABLE_KEYS].join(", ")}`);
  }
  const raw = readRaw(ctx.config.path);
  let converted: unknown = value;
  if (BOOLEAN_KEYS.has(key)) {
    if (!["true", "false"].includes(value)) throw new ArgsError(`${key} 只接受 true/false`);
    converted = value === "true";
  } else if (NUMERIC_KEYS.has(key)) {
    if (!Number.isFinite(Number(value))) throw new ArgsError(`${key} 只接受数字`);
    converted = Number(value);
  }

  if (key === "base_url") {
    raw.base_url = converted;
  } else {
    const [sectionName, field] = key.split(".") as [string, string];
    raw[sectionName] = { ...section(raw, sectionName), [field]: converted };
  }
  writeConfig(ctx.config.path, raw as never);
  process.stderr.write(`已写入 ${key} = ${value}（${ctx.config.path}）\n`);
  return { key, value };
}

// ------------------------------------------------------------------ account

export interface AddAccountOptions {
  name?: string;
  token?: string;
  baseUrl?: string;
  weight?: number;
}

export function runAccountAdd(ctx: CliContext, options: AddAccountOptions): RawConfig {
  if (!options.token) throw new ArgsError("请提供 --token");

  const raw = readRaw(ctx.config.path);
  const accounts = accountsOf(raw);
  const index = accounts.length + 1;
  const entry: RawConfig = { name: options.name ?? `account-${index}` };
  entry.token = options.token;
  if (options.baseUrl) entry.base_url = options.baseUrl;
  if (options.weight !== undefined) entry.weight = options.weight;
  accounts.push(entry);

  const { account: _drop, accounts: _drop2, ...rest } = raw;
  writeConfig(ctx.config.path, { ...rest, account: accounts } as never);
  return entry;
}

export function runAccountRemove(ctx: CliContext, nameOrIndex: string): RawConfig {
  const raw = readRaw(ctx.config.path);
  const accounts = accountsOf(raw);
  const byName = accounts.findIndex((item) => String(item.name ?? "") === nameOrIndex);
  const index = byName >= 0 ? byName : Number(nameOrIndex) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= accounts.length) {
    throw new ArgsError(`找不到账号「${nameOrIndex}」：可用 docparse account list 查看`);
  }
  const [removed] = accounts.splice(index, 1);
  const { account: _drop, accounts: _drop2, ...rest } = raw;
  writeConfig(ctx.config.path, { ...rest, account: accounts } as never);
  return removed ?? {};
}

export interface AccountRow {
  name: string;
  auth: string;
  base_url: string;
  credential: string;
  state: string;
  ok: string;
  fail: string;
  source: string;
}

export function accountRows(ctx: CliContext): AccountRow[] {
  return ctx.pool.describe().map((item) => ({
    name: item.name,
    auth: item.auth,
    base_url: item.baseUrl,
    credential: item.credential,
    state: item.state,
    ok: String(item.successes),
    fail: String(item.failures),
    source: item.source,
  }));
}

export function runAccountList(ctx: CliContext): void {
  process.stdout.write(`${renderTable(accountRows(ctx), ["name", "auth", "base_url", "credential", "state", "ok", "fail", "source"])}\n`);
  process.stdout.write(`\n配置：${ctx.config.path}\n`);
}

export interface AccountTestResult {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * 凭证探活：查询一个不存在 task_id。
 * 返回「找不到任务 / 无权访问」说明鉴权已通过；返回 A0202/A0211 才是凭证问题。
 */
export async function runAccountTest(ctx: CliContext, name?: string): Promise<AccountTestResult[]> {
  const accounts = name
    ? ctx.pool.usableAccounts().filter((account) => account.name === name)
    : ctx.pool.usableAccounts();
  if (accounts.length === 0) {
    throw new ArgsError(name ? `找不到账号「${name}」` : "未配置任何可用账号（docparse account add）");
  }

  const results: AccountTestResult[] = [];
  for (const account of accounts) {
    const client = ctx.clientFor(account, 30_000);
    try {
      await client.getTask("docparse-credential-probe");
      results.push({ name: account.name, ok: true, message: "鉴权通过" });
    } catch (error) {
      const code = (error as { upstreamCode?: string | number }).upstreamCode;
      // 上游 JSON 信封里的 code 是数字，统一转字符串再比对，避免 number/string 严格比较恒不成立
      const codeText = code === undefined ? "" : String(code);
      if (codeText === "-60012" || codeText === "-60013") {
        results.push({ name: account.name, ok: true, message: `鉴权通过（${code} 表示任务不存在，属预期）` });
      } else if (error instanceof NetworkError) {
        results.push({ name: account.name, ok: false, message: `网络不可达：${error.message}` });
      } else if (error instanceof DocparseError) {
        results.push({
          name: account.name,
          ok: false,
          message: code !== undefined ? describeUpstreamCode(code) : error.message,
        });
      } else {
        results.push({ name: account.name, ok: false, message: String(error) });
      }
    }
  }
  return results;
}

// ------------------------------------------------------------------ quota

/** 凭证类上游错误码：应报成「账号/鉴权错误」(5)，而不是泛化的上游失败。 */
const AUTH_UPSTREAM_CODES = new Set(["A0202", "A0211"]);

function failureExitCode(error: unknown, code: string | number | undefined): number {
  if (!(error instanceof DocparseError)) return EXIT_CODE.internal;
  if (code !== undefined && AUTH_UPSTREAM_CODES.has(String(code))) return EXIT_CODE.auth;
  return error.exitCode;
}

export interface QuotaRow {
  name: string;
  ok: boolean;
  message: string;
  /** 上游 /api/v4/extract/status 的 data，原样透出（--output json 时可见全部字段）。 */
  status?: ExtractStatus;
  /** 查询失败时建议的进程退出码。 */
  exit_code?: number;
}

/**
 * 查询账号池的额度与用量（不消耗解析额度）。
 * 逐账号查询，单个账号失败不影响其他账号的结论。
 */
export async function runQuota(ctx: CliContext, name?: string): Promise<QuotaRow[]> {
  const accounts = name
    ? ctx.pool.usableAccounts().filter((account) => account.name === name)
    : ctx.pool.usableAccounts();
  if (accounts.length === 0) {
    throw new ArgsError(name ? `找不到账号「${name}」` : "未配置任何可用账号（docparse account add）");
  }

  const rows: QuotaRow[] = [];
  for (const account of accounts) {
    const client = ctx.clientFor(account, 30_000);
    try {
      rows.push({ name: account.name, ok: true, message: "", status: await client.getExtractStatus() });
    } catch (error) {
      const code = (error as { upstreamCode?: string | number }).upstreamCode;
      const message = error instanceof NetworkError
        ? `网络不可达：${error.message}`
        : error instanceof DocparseError
          ? code !== undefined ? describeUpstreamCode(code) : error.message
          : String(error);
      rows.push({
        name: account.name,
        ok: false,
        message,
        exit_code: failureExitCode(error, code),
      });
    }
  }
  return rows;
}

/** 「已用/上限」；两侧都拿到才成对显示，缺数据时留空，不编造 0。 */
function usage(used: number | undefined, limit: number | undefined): string {
  if (used === undefined || limit === undefined) return "";
  return `${used}/${limit}`;
}

/** 额度文本报告：与官方「API 数据总览」面板同义（今日已用/上限、累计用量、套餐）。 */
export function quotaTable(rows: QuotaRow[]): string {
  const display = rows.map((row) => {
    const daily = row.status?.daily;
    // 官方只给「今日已用」与「今日剩余」，面板显示的分母是两者之和
    const pageLimit = daily?.used === undefined || daily?.left === undefined ? undefined : daily.used + daily.left;
    return {
      name: row.name,
      pages_today: usage(daily?.used, pageLimit),
      files_today: usage(daily?.used_file_num, daily?.allow_file_num),
      total_used: row.status?.total?.used,
      total_left: row.status?.total?.left,
      plan: row.status === undefined ? "" : row.status.is_pro ? "pro" : "free",
      note: row.ok ? "" : `查询失败：${row.message}`,
    };
  });
  const table = renderTable(display, [
    "name",
    "pages_today",
    "files_today",
    "total_used",
    "total_left",
    "plan",
    "note",
  ]);
  return [
    table,
    "",
    "pages_today / files_today 是「今日已用/上限」；页数上限即官方说的最高优先级解析额度，用完后当天仍可解析，只是优先级降低。",
    "total_left 为 0 表示免费额度已用尽，不影响日常解析。",
  ].join("\n");
}

// ------------------------------------------------------------------ skills

export interface SkillsOptions {
  target?: string | string[];
  skillsRoot?: string;
  home?: string;
}

export function runSkillsInstall(options: SkillsOptions): ReturnType<typeof installSkill> {
  return installSkill({
    targets: parseTargets(options.target),
    ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
}

export function runSkillsStatus(options: SkillsOptions): ReturnType<typeof skillStatus> {
  return skillStatus({
    targets: parseTargets(options.target),
    ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
}

// ------------------------------------------------------------------ doctor

export interface DoctorReport {
  node: string;
  platform: string;
  configPath: string;
  configExists: boolean;
  baseUrl: string;
  accounts: Array<Record<string, string>>;
  skills: Array<Record<string, string>>;
  checks: Array<{ name: string; status: string; detail: string }>;
}

export async function runDoctor(ctx: CliContext, options: SkillsOptions): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];

  checks.push({
    name: "node",
    status: "ok",
    detail: `${process.version}（要求 >=18.17）`,
  });

  checks.push({
    name: "config",
    status: ctx.config.exists ? "ok" : "warn",
    detail: ctx.config.exists ? ctx.config.path : `${ctx.config.path} 不存在，可执行 docparse config init`,
  });

  const accounts = ctx.pool.describe();
  const usable = ctx.pool.usableAccounts().length;
  checks.push({
    name: "accounts",
    status: usable > 0 ? "ok" : "error",
    detail:
      usable > 0
        ? `可用账号 ${usable}/${accounts.length} 个`
        : "没有可用账号：docparse account add --token <TOKEN>",
  });

  // Agent 轻量解析 API 免鉴权，用它判断 base_url 是否可达
  const probeClient = new MineruClient({
    baseUrl: ctx.config.baseUrl,
    account: {
      name: "probe",
      auth: "bearer",
      token: "",
      accessKey: "",
      secretKey: "",
      baseUrl: "",
      headers: {},
      weight: 1,
      enabled: true,
      source: "config",
    },
    timeoutMs: 20_000,
    verbose: ctx.verbose,
    log: ctx.log,
  });
  try {
    await probeClient.agentGetResult("docparse-reachability-probe");
    checks.push({ name: "upstream", status: "ok", detail: `${ctx.config.baseUrl} 可达` });
  } catch (error) {
    if (error instanceof NetworkError) {
      checks.push({ name: "upstream", status: "error", detail: `${ctx.config.baseUrl} 不可达：${error.message}` });
    } else if (error instanceof UpstreamError) {
      checks.push({ name: "upstream", status: "ok", detail: `${ctx.config.baseUrl} 可达（探针返回 ${describeUpstreamCode(error.upstreamCode ?? "unknown")}）` });
    } else {
      checks.push({ name: "upstream", status: "warn", detail: String(error) });
    }
  }

  for (const item of runSkillsStatus(options)) {
    checks.push({
      name: `skill:${item.target}`,
      status: item.state === "up-to-date" ? "ok" : item.state === "stale" ? "warn" : "warn",
      detail:
        item.state === "up-to-date"
          ? item.path
          : `${item.path}（${item.state === "missing" ? "未安装" : "内容已过期"}，执行 docparse skills install）`,
    });
  }

  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    configPath: ctx.config.path,
    configExists: ctx.config.exists,
    baseUrl: ctx.config.baseUrl,
    accounts: accounts.map((item) => ({
      name: item.name,
      auth: item.auth,
      base_url: item.baseUrl,
      state: item.state,
    })),
    skills: runSkillsStatus(options).map((item) => ({
      target: item.target,
      path: item.path,
      state: item.state,
    })),
    checks,
  };
}

/** doctor 的文本渲染。 */
export function renderDoctor(report: DoctorReport): string {
  const lines = [
    `node      : ${report.node} (${report.platform})`,
    `config    : ${report.configPath}${report.configExists ? "" : "（不存在）"}`,
    `base_url  : ${report.baseUrl}`,
    `home      : ${os.homedir()}`,
    `data dir  : ${configDir()}`,
    "",
    renderTable(report.checks.map((c) => ({ check: c.name, status: c.status, detail: c.detail })), [
      "check",
      "status",
      "detail",
    ]),
  ];
  return lines.join("\n");
}





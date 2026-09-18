/**
 * 配置存储：默认 `~/.docparse/config.toml`（可用 DOCPARSE_HOME / --config 覆盖）。
 *
 * 关键约束：真实密钥只从配置文件或环境变量读取，源码与状态文件里都不出现明文
 * （状态文件只存密钥指纹，用于按账号记录冷却与用量）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { ConfigError } from "./errors.js";
import { ensureDir, expandPath, shortHash } from "./util.js";

export const SCHEMA_VERSION = 1;
export const DEFAULT_BASE_URL = "https://mineru.net";

export const ENV = {
  home: "DOCPARSE_HOME",
  config: "DOCPARSE_CONFIG",
  baseUrl: "DOCPARSE_BASE_URL",
  tokens: "DOCPARSE_TOKENS",
  token: "DOCPARSE_TOKEN",
  mineruToken: "MINERU_TOKEN",
  modelVersion: "DOCPARSE_MODEL_VERSION",
  language: "DOCPARSE_LANGUAGE",
  outputRoot: "DOCPARSE_OUTPUT_ROOT",
} as const;

export type AuthScheme = "bearer" | "ak_sk";

export interface AccountConfig {
  /** 账号名，仅用于人读日志与 state 记录。 */
  name: string;
  /** 鉴权方式：bearer=官方 MinerU Token；ak_sk=自建/第三方网关的 Access Key + Secret Key。 */
  auth: AuthScheme;
  token: string;
  accessKey: string;
  secretKey: string;
  /** 空 = 跟随全局 base_url。 */
  baseUrl: string;
  /** 自定义鉴权请求头（模板变量 ${token}/${access_key}/${secret_key}），用于对接鉴权方式不同的网关。 */
  headers: Record<string, string>;
  /** 负载均衡权重，越大越优先被选中。 */
  weight: number;
  enabled: boolean;
  source: "config" | "env" | "cli";
}

export interface ParseSettings {
  modelVersion: string;
  language: string;
  isOcr: boolean;
  enableFormula: boolean;
  enableTable: boolean;
  pollIntervalSec: number;
  pollTimeoutSec: number;
  maxUploadMb: number;
}

export interface OutputSettings {
  /** 落盘根目录，相对调用方 CWD。 */
  root: string;
}

export interface Config {
  schemaVersion: number;
  baseUrl: string;
  accounts: AccountConfig[];
  parse: ParseSettings;
  output: OutputSettings;
  /** 实际加载到的配置文件路径（不存在时也返回默认路径）。 */
  path: string;
  dir: string;
  exists: boolean;
}

export const DEFAULT_PARSE: ParseSettings = {
  modelVersion: "vlm",
  language: "ch",
  isOcr: false,
  enableFormula: true,
  enableTable: true,
  pollIntervalSec: 5,
  pollTimeoutSec: 1800,
  maxUploadMb: 200,
};

export const DEFAULT_OUTPUT: OutputSettings = { root: "tmp-doc" };

export function configDir(): string {
  const fromEnv = process.env[ENV.home];
  if (fromEnv) return expandPath(fromEnv);
  return path.join(os.homedir(), ".docparse");
}

export function defaultConfigPath(): string {
  return path.join(configDir(), "config.toml");
}

export function statePath(): string {
  return path.join(configDir(), "state.json");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function normalizeAccount(raw: unknown, index: number, source: AccountConfig["source"]): AccountConfig {
  const rec = asRecord(raw);
  const auth = asString(rec.auth, "bearer") === "ak_sk" ? "ak_sk" : "bearer";
  return {
    name: asString(rec.name, `account-${index + 1}`),
    auth,
    token: asString(rec.token),
    accessKey: asString(rec.access_key ?? rec.accessKey),
    secretKey: asString(rec.secret_key ?? rec.secretKey),
    baseUrl: asString(rec.base_url ?? rec.baseUrl),
    headers: normalizeHeaders(rec.headers),
    weight: asNumber(rec.weight, 1),
    enabled: asBool(rec.enabled, true),
    source,
  };
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const rec = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (typeof val === "string" && val.trim() !== "") out[key] = val;
  }
  return out;
}

/** 账号是否具备可用凭证（按鉴权方式判断）。 */
export function isAccountUsable(account: AccountConfig): boolean {
  if (!account.enabled) return false;
  if (account.auth === "ak_sk") return Boolean(account.accessKey && account.secretKey);
  return Boolean(account.token);
}

/** 账号指纹：日志与 state 用它标识账号，避免密钥明文落任何文件。 */
export function accountKey(account: AccountConfig): string {
  const material =
    account.auth === "ak_sk"
      ? `ak_sk:${account.accessKey}:${account.secretKey}`
      : `bearer:${account.token}`;
  return `sha256:${shortHash(material, 12)}`;
}

export interface LoadOptions {
  configPath?: string;
  baseUrl?: string;
  /** 命令行 --token（可多次）；给出的账号排在最前，与配置文件账号一起进池。 */
  tokens?: string[];
}

export function loadConfig(options: LoadOptions = {}): Config {
  const explicitPath = options.configPath ?? process.env[ENV.config];
  const filePath = explicitPath ? expandPath(explicitPath) : defaultConfigPath();
  const exists = fs.existsSync(filePath);

  let raw: Record<string, unknown> = {};
  if (exists) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new ConfigError(`无法读取配置文件 ${filePath}`, { cause: error });
    }
    try {
      raw = asRecord(parseToml(text));
    } catch (error) {
      throw new ConfigError(`配置文件不是合法 TOML：${filePath}`, { cause: error, details: String(error) });
    }
  } else if (explicitPath) {
    throw new ConfigError(`配置文件不存在：${filePath}`);
  }

  const parseSection = asRecord(raw.parse);
  const outputSection = asRecord(raw.output);

  const parseSettings: ParseSettings = {
    modelVersion: asString(parseSection.model_version ?? parseSection.modelVersion, DEFAULT_PARSE.modelVersion),
    language: asString(parseSection.language, DEFAULT_PARSE.language),
    isOcr: asBool(parseSection.is_ocr ?? parseSection.isOcr, DEFAULT_PARSE.isOcr),
    enableFormula: asBool(parseSection.enable_formula ?? parseSection.enableFormula, DEFAULT_PARSE.enableFormula),
    enableTable: asBool(parseSection.enable_table ?? parseSection.enableTable, DEFAULT_PARSE.enableTable),
    pollIntervalSec: Math.max(1, asNumber(parseSection.poll_interval_sec ?? parseSection.pollIntervalSec, DEFAULT_PARSE.pollIntervalSec)),
    pollTimeoutSec: Math.max(5, asNumber(parseSection.poll_timeout_sec ?? parseSection.pollTimeoutSec, DEFAULT_PARSE.pollTimeoutSec)),
    maxUploadMb: Math.max(1, asNumber(parseSection.max_upload_mb ?? parseSection.maxUploadMb, DEFAULT_PARSE.maxUploadMb)),
  };

  const outputSettings: OutputSettings = {
    root: asString(outputSection.root, DEFAULT_OUTPUT.root) || DEFAULT_OUTPUT.root,
  };

  const accounts: AccountConfig[] = [];
  const rawAccounts = raw.account ?? raw.accounts;
  if (Array.isArray(rawAccounts)) {
    rawAccounts.forEach((item, index) => accounts.push(normalizeAccount(item, index, "config")));
  } else if (rawAccounts && typeof rawAccounts === "object") {
    accounts.push(normalizeAccount(rawAccounts, 0, "config"));
  }

  const globalBaseUrl =
    options.baseUrl || process.env[ENV.baseUrl] || asString(raw.base_url ?? raw.baseUrl, "") || DEFAULT_BASE_URL;

  // 环境变量 / 命令行提供的 token 视为独立账号：命令行 > 环境变量 > 配置文件（同池共存，前者靠前）
  const envTokens = (process.env[ENV.tokens] || process.env[ENV.token] || process.env[ENV.mineruToken] || "")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const cliTokens = (options.tokens ?? []).map((t) => t.trim()).filter(Boolean);

  const envAccounts: AccountConfig[] = envTokens.map((token, index) => ({
    name: `env-${index + 1}`,
    auth: "bearer" as AuthScheme,
    token,
    accessKey: "",
    secretKey: "",
    baseUrl: "",
    headers: {},
    weight: 1,
    enabled: true,
    source: "env" as const,
  }));

  const cliAccounts: AccountConfig[] = cliTokens.map((token, index) => ({
    name: `cli-${index + 1}`,
    auth: "bearer" as AuthScheme,
    token,
    accessKey: "",
    secretKey: "",
    baseUrl: "",
    headers: {},
    weight: 1,
    enabled: true,
    source: "cli" as const,
  }));

  const merged = [...cliAccounts, ...envAccounts, ...accounts];

  return {
    schemaVersion: asNumber(raw.schema_version ?? raw.schemaVersion, SCHEMA_VERSION),
    baseUrl: globalBaseUrl.replace(/\/+$/, ""),
    accounts: merged,
    parse: {
      ...parseSettings,
      modelVersion: process.env[ENV.modelVersion] || parseSettings.modelVersion,
      language: process.env[ENV.language] || parseSettings.language,
    },
    output: { root: process.env[ENV.outputRoot] || outputSettings.root },
    path: filePath,
    dir: path.dirname(filePath),
    exists,
  };
}

/** 账号实际生效的上游地址（账号级覆盖优先）。 */
export function accountBaseUrl(config: Config, account: AccountConfig): string {
  const base = account.baseUrl || config.baseUrl;
  return base.replace(/\/+$/, "");
}

export interface PersistedConfig {
  base_url?: string;
  account?: Array<Record<string, unknown>>;
  parse?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export function writeConfig(filePath: string, data: PersistedConfig): void {
  ensureDir(path.dirname(filePath));
  const body = stringifyToml({ schema_version: SCHEMA_VERSION, ...data } as Record<string, unknown>);
  fs.writeFileSync(filePath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

/** 带注释的配置模板（`docparse config init` 用）。 */
export function configTemplate(): string {
  return `# docparse 配置
# 密钥只存在本文件（或环境变量）里；请勿提交到版本库。

schema_version = ${SCHEMA_VERSION}

# 上游地址：官方 https://mineru.net；自建/私有化部署时改成自己的地址。
base_url = "${DEFAULT_BASE_URL}"

# 精准解析 API 的账号池。填多个 [[account]] 即自动负载均衡。
# 官方 Token 写法：
# [[account]]
# name = "main"
# token = "在 https://mineru.net/apiManage/token 创建"

[parse]
model_version = "${DEFAULT_PARSE.modelVersion}"
language = "${DEFAULT_PARSE.language}"
is_ocr = ${DEFAULT_PARSE.isOcr}
enable_formula = ${DEFAULT_PARSE.enableFormula}
enable_table = ${DEFAULT_PARSE.enableTable}
poll_interval_sec = ${DEFAULT_PARSE.pollIntervalSec}
poll_timeout_sec = ${DEFAULT_PARSE.pollTimeoutSec}
max_upload_mb = ${DEFAULT_PARSE.maxUploadMb}

[output]
root = "${DEFAULT_OUTPUT.root}"
`;
}




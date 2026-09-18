/**
 * MinerU API 客户端（精准解析 /api/v4 + Agent 轻量解析 /api/v1/agent）。
 *
 * 只做协议层：拼 URL、套鉴权头、判响应信封、抛结构化错误。
 * 账号选择、冷却、重试由 AccountPool 负责；落盘与目录布局由 output.ts 负责。
 */

import { type AccountConfig } from "./config.js";
import { NetworkError, UpstreamError, describeUpstreamCode } from "./errors.js";

export type TaskState =
  | "pending"
  | "running"
  | "converting"
  | "uploading"
  | "waiting-file"
  | "done"
  | "failed";

export interface ExtractProgress {
  extracted_pages?: number;
  total_pages?: number;
  start_time?: string;
}

export interface TaskResult {
  task_id: string;
  state: TaskState;
  err_code?: string | number;
  err_msg?: string;
  full_zip_url?: string;
  extract_progress?: ExtractProgress;
}

export interface BatchItemResult {
  file_name: string;
  data_id?: string;
  state: TaskState;
  err_code?: string | number;
  err_msg?: string;
  full_zip_url?: string;
  extract_progress?: ExtractProgress;
}

export interface AgentResult {
  task_id: string;
  state: TaskState;
  markdown_url?: string;
  err_code?: number;
  err_msg?: string;
}

export interface ParseParams {
  modelVersion?: string;
  isOcr?: boolean;
  enableFormula?: boolean;
  enableTable?: boolean;
  language?: string;
  pageRanges?: string;
  extraFormats?: string[];
  noCache?: boolean;
}

/** 账号额度与用量（GET /api/v4/extract/status）与官方「API 数据总览」面板同源。 */
export interface ExtractStatus {
  daily?: {
    /** 今日已用的优先解析页数 */
    used?: number;
    /** 今日剩余的优先解析页数 */
    left?: number;
    /** 今日允许解析的文件数上限 */
    allow_file_num?: number;
    /** 今日已解析的文件数 */
    used_file_num?: number;
  };
  total?: {
    used?: number;
    left?: number;
  };
  version?: Record<string, string>;
  is_pro?: boolean;
  file_num_pro_expire?: string;
}

export interface MineruClientOptions {
  baseUrl: string;
  account: AccountConfig;
  timeoutMs: number;
  verbose?: boolean;
  log?: (message: string) => void;
}

interface ApiEnvelope {
  code?: number;
  msg?: string;
  msgCode?: string;
  success?: boolean;
  data?: unknown;
  trace_id?: string;
  traceId?: string;
}

/** 把账号凭证渲染成请求头；headers 自定义时做 ${token}/${access_key}/${secret_key} 变量替换。 */
export function buildAuthHeaders(account: AccountConfig): Record<string, string> {
  const custom = Object.entries(account.headers ?? {});
  if (custom.length > 0) {
    const vars: Record<string, string> = {
      token: account.token,
      access_key: account.accessKey,
      secret_key: account.secretKey,
      accessKey: account.accessKey,
      secretKey: account.secretKey,
    };
    const out: Record<string, string> = {};
    for (const [key, value] of custom) {
      out[key] = value.replace(/\$\{(\w+)\}/g, (_m, name: string) => vars[name] ?? "");
    }
    return out;
  }
  if (account.auth === "ak_sk") {
    return {
      Authorization: `Bearer ${account.accessKey}`,
      "X-Secret-Key": account.secretKey,
    };
  }
  return { Authorization: `Bearer ${account.token}` };
}

function paramsToBody(params: ParseParams, version: "v4" | "agent"): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.modelVersion) body.model_version = params.modelVersion;
  if (params.isOcr !== undefined) body.is_ocr = params.isOcr;
  if (params.enableFormula !== undefined) body.enable_formula = params.enableFormula;
  if (params.enableTable !== undefined) body.enable_table = params.enableTable;
  if (params.language) body.language = params.language;
  if (params.extraFormats && params.extraFormats.length > 0 && version === "v4") {
    body.extra_formats = params.extraFormats;
  }
  if (params.noCache !== undefined && version === "v4") body.no_cache = params.noCache;
  if (params.pageRanges) body[version === "agent" ? "page_range" : "page_ranges"] = params.pageRanges;
  return body;
}

export class MineruClient {
  private readonly base: string;
  private readonly account: AccountConfig;
  private readonly timeoutMs: number;
  private readonly verbose: boolean;
  private readonly log: (message: string) => void;

  constructor(options: MineruClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.account = options.account;
    this.timeoutMs = options.timeoutMs;
    this.verbose = options.verbose ?? false;
    this.log = options.log ?? (() => {});
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...buildAuthHeaders(this.account), ...extra };
  }

  private async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    options: { auth?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = `${this.base}${urlPath}`;
    const withAuth = options.auth ?? true;
    const headers: Record<string, string> = withAuth
      ? this.headers(options.headers)
      : { ...(options.headers ?? {}) };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (this.verbose) this.log(`→ ${method} ${url}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(`请求失败：${method} ${url} — ${message}`, { cause: error });
    }

    const text = await response.text();
    if (this.verbose) this.log(`← ${response.status} ${text.slice(0, 500)}`);

    let envelope: ApiEnvelope | undefined;
    try {
      envelope = JSON.parse(text) as ApiEnvelope;
    } catch {
      envelope = undefined;
    }

    if (envelope && typeof envelope === "object") {
      // 网关层错误信封：{success:false, msgCode, msg}
      if (envelope.success === false) {
        const code = envelope.msgCode ?? envelope.code ?? response.status;
        throw new UpstreamError(`上游拒绝：[${describeUpstreamCode(code)}] ${envelope.msg ?? "unknown"}`, {
          upstreamCode: code,
          details: { status: response.status, traceId: envelope.traceId ?? envelope.trace_id },
        });
      }
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        throw new UpstreamError(
          `上游返回错误：[${describeUpstreamCode(envelope.code)}] ${envelope.msg ?? "unknown"}`,
          {
          upstreamCode: envelope.code,
          details: { status: response.status, traceId: envelope.trace_id },
          },
        );
      }
      if (envelope.code === 0) return envelope.data as T;
    }

    if (!response.ok) {
      throw new UpstreamError(
        `HTTP ${response.status} ${method} ${urlPath}：${text.slice(0, 200) || "(空响应体)"}`,
        { upstreamCode: response.status, retryable: response.status >= 500 || response.status === 429 },
      );
    }
    throw new UpstreamError(`响应不是预期的 JSON 信封：${text.slice(0, 200)}`);
  }

  // ---------------------------------------------------------------- 精准解析 API

  /** 提交 URL 批量解析任务，返回 batch_id。 */
  async createUrlBatch(
    files: Array<{ url: string; dataId: string; isOcr?: boolean; pageRanges?: string }>,
    params: ParseParams,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      files: files.map((f) => {
        const item: Record<string, unknown> = { url: f.url, data_id: f.dataId };
        if (f.isOcr !== undefined) item.is_ocr = f.isOcr;
        if (f.pageRanges) item.page_ranges = f.pageRanges;
        return item;
      }),
      ...paramsToBody(params, "v4"),
    };
    const data = await this.request<{ batch_id: string }>("POST", "/api/v4/extract/task/batch", body);
    if (!data?.batch_id) throw new UpstreamError("上游未返回 batch_id");
    return data.batch_id;
  }

  /** 申请本地文件上传链接（不超过 50 个/次）。 */
  async createUploadBatch(
    files: Array<{ name: string; dataId: string; isOcr?: boolean; pageRanges?: string }>,
    params: ParseParams,
  ): Promise<{ batchId: string; fileUrls: string[] }> {
    const body: Record<string, unknown> = {
      files: files.map((f) => {
        const item: Record<string, unknown> = { name: f.name, data_id: f.dataId };
        if (f.isOcr !== undefined) item.is_ocr = f.isOcr;
        if (f.pageRanges) item.page_ranges = f.pageRanges;
        return item;
      }),
      ...paramsToBody(params, "v4"),
    };
    const data = await this.request<{ batch_id: string; file_urls: string[] }>(
      "POST",
      "/api/v4/file-urls/batch",
      body,
    );
    if (!data?.batch_id || !Array.isArray(data.file_urls)) throw new UpstreamError("上游未返回上传链接");
    return { batchId: data.batch_id, fileUrls: data.file_urls };
  }

  /** PUT 上传文件字节（签名 URL 自带鉴权，不带 Content-Type）。 */
  async uploadFile(uploadUrl: string, bytes: Uint8Array): Promise<void> {
    if (this.verbose) this.log(`→ PUT ${uploadUrl}`);
    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: "PUT",
        body: bytes,
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)),
      });
    } catch (error) {
      throw new NetworkError(`上传文件失败：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new UpstreamError(`上传文件失败：HTTP ${response.status}`, {
        upstreamCode: response.status,
        retryable: response.status >= 500,
      });
    }
  }

  async getBatchResults(batchId: string): Promise<BatchItemResult[]> {
    const data = await this.request<{ extract_result?: BatchItemResult[] }>(
      "GET",
      `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
    );
    return data?.extract_result ?? [];
  }

  async getTask(taskId: string): Promise<TaskResult> {
    const data = await this.request<TaskResult>(
      "GET",
      `/api/v4/extract/task/${encodeURIComponent(taskId)}`,
    );
    if (!data) throw new UpstreamError("上游未返回任务详情");
    return data;
  }

  /** 查询当前账号的额度与用量（GET /api/v4/extract/status）。 */
  async getExtractStatus(): Promise<ExtractStatus> {
    const data = await this.request<ExtractStatus>("GET", "/api/v4/extract/status");
    if (!data) throw new UpstreamError("上游未返回额度信息");
    return data;
  }

  // ---------------------------------------------------------------- Agent 轻量解析 API

  async agentParseUrl(
    url: string,
    params: ParseParams,
    fileName?: string,
  ): Promise<{ taskId: string }> {
    const body: Record<string, unknown> = { url, ...paramsToBody(params, "agent") };
    if (fileName) body.file_name = fileName;
    const data = await this.request<{ task_id: string }>("POST", "/api/v1/agent/parse/url", body, {
      auth: false,
    });
    if (!data?.task_id) throw new UpstreamError("上游未返回 task_id");
    return { taskId: data.task_id };
  }

  async agentParseFile(fileName: string, params: ParseParams): Promise<{ taskId: string; fileUrl: string }> {
    const body: Record<string, unknown> = { file_name: fileName, ...paramsToBody(params, "agent") };
    const data = await this.request<{ task_id: string; file_url: string }>(
      "POST",
      "/api/v1/agent/parse/file",
      body,
      { auth: false },
    );
    if (!data?.task_id || !data.file_url) throw new UpstreamError("上游未返回上传链接");
    return { taskId: data.task_id, fileUrl: data.file_url };
  }

  async agentGetResult(taskId: string): Promise<AgentResult> {
    const data = await this.request<AgentResult>(
      "GET",
      `/api/v1/agent/parse/${encodeURIComponent(taskId)}`,
      undefined,
      { auth: false },
    );
    if (!data) throw new UpstreamError("上游未返回任务详情");
    return data;
  }
}

/** 下载结果产物（zip / markdown），走 CDN 无需鉴权。 */
export async function downloadBytes(url: string, timeoutMs: number, verbose = false): Promise<Uint8Array> {
  if (verbose) process.stderr.write(`→ GET ${url}\n`);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new NetworkError(`下载结果失败：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new UpstreamError(`下载结果失败：HTTP ${response.status}`, {
      upstreamCode: response.status,
      retryable: response.status >= 500,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadText(url: string, timeoutMs: number, verbose = false): Promise<string> {
  return new TextDecoder("utf-8").decode(await downloadBytes(url, timeoutMs, verbose));
}

/** 生成失败任务的错误信息（统一带上错误码释义）。 */
export function describeTaskFailure(state: TaskState, errMsg?: string, errCode?: string | number): string {
  const codePart = errCode !== undefined && errCode !== "" ? `[${describeUpstreamCode(errCode)}] ` : "";
  return `${codePart}${errMsg && errMsg.trim() !== "" ? errMsg : `任务状态 ${state}`}`;
}

/**
 * 错误体系：错误分类 → 进程退出码 + 上游错误码释义。
 *
 * 约定：stdout 只承载「结果」；失败一律只往 stderr 写一行 `error: <消息>`，类别由退出码承载，
 * 设了 DOCPARSE_DEBUG 时再往 stderr 附一段上游 details。
 */

export type ErrorKind =
  | "args"
  | "config"
  | "network"
  | "auth"
  | "upstream"
  | "partial"
  | "internal";

export const EXIT_CODE: Record<ErrorKind, number> = {
  args: 2,
  config: 3,
  network: 4,
  auth: 5,
  upstream: 6,
  partial: 7,
  internal: 1,
};

export interface DocparseErrorOptions {
  upstreamCode?: string | number;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class DocparseError extends Error {
  readonly kind: ErrorKind;
  readonly upstreamCode?: string | number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(kind: ErrorKind, message: string, options: DocparseErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.upstreamCode = options.upstreamCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  get exitCode(): number {
    return EXIT_CODE[this.kind];
  }
}

export class ArgsError extends DocparseError {
  constructor(message: string, options: DocparseErrorOptions = {}) {
    super("args", message, options);
  }
}

export class ConfigError extends DocparseError {
  constructor(message: string, options: DocparseErrorOptions = {}) {
    super("config", message, options);
  }
}

export class NetworkError extends DocparseError {
  constructor(message: string, options: DocparseErrorOptions = {}) {
    super("network", message, { retryable: true, ...options });
  }
}

export class AuthError extends DocparseError {
  constructor(message: string, options: DocparseErrorOptions = {}) {
    super("auth", message, options);
  }
}

export class UpstreamError extends DocparseError {
  constructor(message: string, options: DocparseErrorOptions = {}) {
    super("upstream", message, options);
  }
}

export class PartialError extends DocparseError {
  constructor(message: string, options: DocparseErrorOptions = {}) {
    super("partial", message, options);
  }
}

/** 上游错误码 → 人话释义与处置建议（官方文档「常见错误码」表）。 */
export const UPSTREAM_HINTS: Record<string, string> = {
  A0202: "Token 错误：检查 Token 是否为 API 管理页创建的完整字符串",
  A0211: "Token 已过期：到 Token 管理页续期或更换",
  "-500": "传参错误：检查参数类型与 Content-Type",
  "-10001": "上游服务异常，稍后重试",
  "-10002": "请求参数错误，检查参数格式",
  "-60001": "生成上传 URL 失败，稍后重试",
  "-60002": "文件格式不支持：仅支持 pdf/doc/docx/ppt/pptx/xls/xlsx/png/jpg/jpeg 等",
  "-60003": "文件读取失败：检查文件是否损坏",
  "-60004": "空文件",
  "-60005": "文件超过 200MB 上限",
  "-60006": "文件页数超过 200 页上限",
  "-60007": "上游模型服务暂不可用，稍后重试",
  "-60008": "上游读取源文件超时：确认 URL 公网可达（github/aws 等海外地址易超时）",
  "-60009": "任务提交队列已满，稍后重试",
  "-60010": "解析失败，稍后重试",
  "-60011": "获取有效文件失败：确认文件已成功上传",
  "-60012": "找不到任务：检查 task_id 是否有效",
  "-60013": "无权访问该任务：只能查询自己提交的任务",
  "-60015": "文件转换失败：可先手动转 PDF 再上传",
  "-60016": "导出格式转换失败：换个导出格式或重试",
  "-60018": "当日解析额度已用完，明日再来",
  "-60019": "HTML 解析额度不足",
  "-60021": "读取文件页数失败，稍后重试",
  "-60022": "网页读取失败：可能被限频，稍后重试",
  "-30001": "超过 Agent 轻量解析 10MB 上限：改用 parse（精准解析）",
  "-30002": "Agent 轻量解析不支持该文件类型",
  "-30003": "超过 Agent 轻量解析 20 页上限：改用 parse（精准解析）",
  "-30004": "Agent 轻量解析请求参数非法",
};

export function describeUpstreamCode(code: string | number): string {
  const hint = UPSTREAM_HINTS[String(code)];
  return hint ? `${code}（${hint}）` : String(code);
}

/** 该上游错误码换一个账号重试是否有意义。 */
export function isRetryableUpstreamCode(code: string | number): boolean {
  const c = String(code);
  if (c === "A0202" || c === "A0211") return true;
  const n = Number(c);
  if (!Number.isFinite(n)) return false;
  // 额度类错误不重试（换号即可由上层处理），服务瞬时错误可重试
  return [-10001, -60001, -60007, -60009, -60010, -60020, -60021, -60022].includes(n) || n >= 500;
}

/** 该错误是否属于「这个账号坏了」，需要冷却该账号。 */
export function isAccountFault(code: string | number): boolean {
  const c = String(code);
  if (c === "A0202" || c === "A0211") return true;
  const n = Number(c);
  return [-60018, -60019].includes(n);
}

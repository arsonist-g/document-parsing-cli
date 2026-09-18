/**
 * 测试用本地 MinerU 上游 stub：node:http 监听 127.0.0.1 随机端口。
 *
 * 只服务测试进程内的本机回环请求，不访问外网；每个用例注册自己需要的路由，
 * 所有请求（含 Authorization 头与请求体）都会被记录下来供断言使用。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { strToU8, zipSync } from "fflate";

export interface StubRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface StubReply {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  contentType?: string;
}

export type StubHandler = (request: StubRequest) => StubReply | Promise<StubReply>;

/** 网关鉴权失败信封（与真实上游一致），调用方据此抛出 A0202。 */
export const AUTH_FAILED_ENVELOPE = {
  success: false,
  msgCode: "A0202",
  msg: "user authenticate failed",
};

/** 构造解析结果压缩包：full.md + images/x.png。 */
export function makeResultZip(markdown: string, imageBytes: Uint8Array): Uint8Array {
  return zipSync({ "full.md": strToU8(markdown), "images/x.png": imageBytes });
}

export class StubUpstream {
  readonly requests: StubRequest[] = [];
  baseUrl = "";
  /** /api 路由要求携带的 bearer token；配成别的值即可模拟凭证被拒。 */
  expectedToken = "";

  private readonly handlers = new Map<string, StubHandler>();
  private readonly server: http.Server;

  private constructor(server: http.Server) {
    this.server = server;
  }

  static async start(expectedToken: string): Promise<StubUpstream> {
    let stub: StubUpstream;
    const server = http.createServer((req, res) => {
      void stub.handle(req, res);
    });
    stub = new StubUpstream(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    stub.baseUrl = `http://127.0.0.1:${address.port}`;
    stub.expectedToken = expectedToken;
    return stub;
  }

  route(method: string, path: string, handler: StubHandler): this {
    this.handlers.set(`${method.toUpperCase()} ${path}`, handler);
    return this;
  }

  /** 校验 Authorization: Bearer <expectedToken>，不匹配则回 A0202 信封。 */
  protectedRoute(method: string, path: string, handler: StubHandler): this {
    return this.route(method, path, (request) => {
      if (request.authorization !== `Bearer ${this.expectedToken}`) {
        return { status: 401, json: AUTH_FAILED_ENVELOPE };
      }
      return handler(request);
    });
  }

  count(method: string, path: string): number {
    return this.requests.filter((item) => item.method === method.toUpperCase() && item.path === path).length;
  }

  find(method: string, path: string): StubRequest | undefined {
    return this.requests.find((item) => item.method === method.toUpperCase() && item.path === path);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const request: StubRequest = {
      method: (req.method ?? "GET").toUpperCase(),
      path: url.pathname,
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    this.requests.push(request);

    const handler = this.handlers.get(`${request.method} ${request.path}`);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, msg: `stub 未注册路由：${request.method} ${request.path}` }));
      return;
    }

    let reply: StubReply;
    try {
      reply = await handler(request);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, msg: `stub handler 抛错：${String(error)}` }));
      return;
    }

    const status = reply.status ?? 200;
    if (reply.bytes !== undefined) {
      res.writeHead(status, {
        "content-type": reply.contentType ?? "application/octet-stream",
        "content-length": String(reply.bytes.length),
      });
      res.end(Buffer.from(reply.bytes));
      return;
    }
    if (reply.text !== undefined) {
      res.writeHead(status, { "content-type": reply.contentType ?? "text/markdown; charset=utf-8" });
      res.end(reply.text);
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.json ?? {}));
  }
}

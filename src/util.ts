/** 通用小工具：时间戳、随机后缀、slug、文件写入。 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时区的 YYYY-MM-DD。 */
export function dateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时区的 HH-MM-SS（文件名安全）。 */
export function timeStamp(d: Date = new Date()): string {
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 6 位随机十六进制后缀，避免同秒并发落盘撞名。 */
export function randomSuffix(bytes: number = 3): string {
  return randomBytes(bytes).toString("hex");
}

/** 短哈希：用于给密钥生成「指纹」，状态文件里只存指纹不存密钥原文。 */
export function shortHash(value: string, length: number = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** 密钥脱敏展示：保留首尾少量字符。 */
export function maskSecret(value: string): string {
  if (!value) return "(未设置)";
  // 短密钥不再回显任何字符：截到两个字符就暴露了大半
  if (value.length <= 4) return "****";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * 由输入（本地文件路径或 URL）生成文件名 slug。
 * URL 取 主机名 + 路径段；本地文件取去掉扩展名的文件名。只保留 [A-Za-z0-9-]。
 */
export function slugify(input: string, maxLength: number = 48): string {
  let raw: string;
  if (isUrl(input)) {
    try {
      const u = new URL(input);
      const host = u.hostname.replace(/\./g, "-");
      const segs = u.pathname.split("/").filter(Boolean);
      const last = segs[segs.length - 1] ?? "";
      const stem = last.replace(/\.[^.]+$/, "");
      raw = stem ? `${host}-${stem}` : host;
    } catch {
      raw = input;
    }
  } else {
    raw = path.basename(input).replace(/\.[^.]+$/, "");
  }
  const cleaned = raw.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const out = cleaned || "document";
  return out.length > maxLength ? out.slice(0, maxLength).replace(/-+$/, "") : out;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileBytes(file: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data);
}

export function readFileBytes(file: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(file));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)}${units[i]}`;
}

/** 展开 ~ 并转绝对路径。 */
export function expandPath(p: string): string {
  if (p === "~") return path.resolve(process.env.HOME || process.env.USERPROFILE || p);
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(path.join(home, p.slice(2)));
  }
  return path.resolve(p);
}



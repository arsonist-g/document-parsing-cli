/**
 * 落盘布局：`<root>/<YYYY-MM-DD>/parse-<slug>-<HH-MM-SS>-<rand>/`。
 *
 * 与 research-assistant CLI 的 `tmp-doc/<日期>/` 约定保持一致：按日期分目录、
 * 文件名带时间与随机后缀、绝不覆盖既有文件。差别只在单文档会独占一个子目录，
 * 用来保存解析产物里的 images/ 与 json，保证 markdown 中的相对图片链接可用。
 * 命令只把 markdown 的路径写到 stdout。
 */

import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

import { ConfigError } from "./errors.js";
import { dateStamp, ensureDir, randomSuffix, timeStamp } from "./util.js";

/** 计算落盘根目录（相对调用方 CWD）。 */
export function resolveOutputRoot(root: string, cwd: string = process.cwd()): string {
  return path.isAbsolute(root) ? root : path.resolve(cwd, root);
}

/** 申请一个不冲突的文档输出目录：同名已存在则追加 -1/-2/... */
export function allocateOutputDir(parentDir: string, slug: string, now: Date = new Date()): string {
  ensureDir(parentDir);
  const base = `parse-${slug}-${timeStamp(now)}-${randomSuffix()}`;
  let candidate = path.join(parentDir, base);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDir, `${base}-${i}`);
    i += 1;
  }
  ensureDir(candidate);
  return candidate;
}

/** 结果目录的父目录：显式 --out 直接使用，否则用 <root>/<YYYY-MM-DD>/。 */
export function outputParent(root: string, out: string | undefined, now: Date = new Date()): string {
  return out ? path.resolve(out) : path.join(resolveOutputRoot(root), dateStamp(now));
}

/**
 * 解压解析结果 zip 到目标目录。
 * 逐条校验解压后的绝对路径仍位于目标目录内，阻断 zip-slip 路径穿越。
 */
export function extractZipTo(bytes: Uint8Array, destDir: string): string[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new ConfigError(`解析结果压缩包无法解压：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const root = path.resolve(destDir);
  const written: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new ConfigError(`解析结果压缩包内含越界路径，已中止解压：${name}`);
    }
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, data);
    written.push(target);
  }
  return written;
}

/** 在解压结果里定位 markdown 正文（官方产物固定叫 full.md）。 */
export function findMarkdown(destDir: string): string | undefined {
  const preferred = path.join(destDir, "full.md");
  if (fs.existsSync(preferred)) return preferred;
  const candidates = fs
    .readdirSync(destDir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort();
  const first = candidates[0];
  return first ? path.join(destDir, first) : undefined;
}

/** 把 markdown 正文写进目标目录，命名统一为 <slug>.md，返回最终路径。 */
export function writeMarkdown(destDir: string, slug: string, content: string): string {
  const target = path.join(destDir, `${slug}.md`);
  fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return target;
}

/** zip 里的 full.md 改名成 <slug>.md（images/ 相对引用不受影响）。 */
export function renameMarkdown(destDir: string, slug: string): string {
  const found = findMarkdown(destDir);
  if (!found) throw new ConfigError("解析结果压缩包里没有 markdown 文件（full.md 缺失）");
  const target = path.join(destDir, `${slug}.md`);
  if (found !== target) fs.renameSync(found, target);
  return target;
}




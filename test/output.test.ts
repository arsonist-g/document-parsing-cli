/** output.ts：输出目录分配、zip 解压（含 zip-slip 防护）、markdown 定位与落盘。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";

import { ConfigError } from "../src/errors.js";
import {
  allocateOutputDir,
  extractZipTo,
  findMarkdown,
  outputParent,
  renameMarkdown,
  writeMarkdown,
} from "../src/output.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-output-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("allocateOutputDir", () => {
  it("按 parse-<slug>-<HH-MM-SS>-<rand> 创建全新目录", () => {
    // oracle: specified（目录命名与创建）
    const dir = allocateOutputDir(tmpDir, "report", new Date(2026, 0, 5, 13, 4, 9));
    assert.equal(path.dirname(dir), tmpDir);
    assert.match(path.basename(dir), /^parse-report-13-04-09-[0-9a-f]{6}$/);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });

  it("同名目录已存在时追加 -1", (t) => {
    // oracle: derived（契约：绝不覆盖既有目录，同名追加 -1/-2）
    let calls = 0;
    t.mock.method(fs, "existsSync", ((_target: string) => {
      calls += 1;
      return calls === 1; // 第一次判定为已存在，迫使走追加分支
    }) as typeof fs.existsSync);
    const dir = allocateOutputDir(tmpDir, "report", new Date(2026, 0, 5, 13, 4, 9));
    assert.match(path.basename(dir), /^parse-report-13-04-09-[0-9a-f]{6}-1$/);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });

  it("连续冲突时继续追加 -2", (t) => {
    // oracle: derived
    let calls = 0;
    t.mock.method(fs, "existsSync", ((_target: string) => {
      calls += 1;
      return calls <= 2;
    }) as typeof fs.existsSync);
    const dir = allocateOutputDir(tmpDir, "report", new Date(2026, 0, 5, 13, 4, 9));
    assert.match(path.basename(dir), /^parse-report-13-04-09-[0-9a-f]{6}-2$/);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });
});

describe("outputParent", () => {
  it("给定 --out 时直接使用该目录", () => {
    // oracle: specified
    const out = outputParent("tmp-doc", path.join("docs", "out"), new Date(2026, 0, 5, 12, 0, 0));
    assert.equal(out, path.resolve(path.join("docs", "out")));
  });

  it("未给定 --out 时用 <相对 root>/<YYYY-MM-DD>", () => {
    // oracle: specified
    const out = outputParent("tmp-doc", undefined, new Date(2026, 0, 5, 12, 0, 0));
    assert.equal(out, path.join(path.resolve("tmp-doc"), "2026-01-05"));
  });

  it("未给定 --out 时用 <绝对 root>/<YYYY-MM-DD>", () => {
    // oracle: specified
    const root = path.join(tmpDir, "out-root");
    assert.equal(outputParent(root, undefined, new Date(2026, 0, 5, 12, 0, 0)), path.join(root, "2026-01-05"));
  });
});

describe("extractZipTo", () => {
  it("把包内文件解到目标目录（含子目录）", () => {
    // oracle: derived（zip 输入与期望内容均由测试自造）
    const dest = makeDir("unzip-ok");
    const bytes = zipSync({
      "full.md": strToU8("# 标题\n"),
      "images/figure.png": strToU8("fake-png-bytes"),
    });
    const written = extractZipTo(bytes, dest);
    assert.equal(written.length, 2);
    assert.equal(fs.readFileSync(path.join(dest, "full.md"), "utf8"), "# 标题\n");
    assert.equal(fs.readFileSync(path.join(dest, "images", "figure.png"), "utf8"), "fake-png-bytes");
  });

  it("拒绝 zip-slip 越界路径且不写到目标目录之外", () => {
    // oracle: specified（契约：拒绝越界路径）
    const dest = makeDir("unzip-slip");
    const escaped = path.join(tmpDir, "evil.txt");
    const bytes = zipSync({
      "../evil.txt": strToU8("pwned"),
      "full.md": strToU8("# ok\n"),
    });
    assert.throws(
      () => extractZipTo(bytes, dest),
      (error: unknown) => error instanceof ConfigError,
    );
    assert.equal(fs.existsSync(escaped), false);
  });
});

describe("findMarkdown", () => {
  it("优先返回 full.md", () => {
    // oracle: specified
    const dest = makeDir("find-preferred");
    fs.writeFileSync(path.join(dest, "full.md"), "# full\n");
    fs.writeFileSync(path.join(dest, "aaa.md"), "# aaa\n");
    assert.equal(findMarkdown(dest), path.join(dest, "full.md"));
  });

  it("没有 full.md 时回退到其它 markdown", () => {
    // oracle: derived
    const dest = makeDir("find-fallback");
    fs.writeFileSync(path.join(dest, "result.md"), "# result\n");
    assert.equal(findMarkdown(dest), path.join(dest, "result.md"));
  });

  it("没有 markdown 时返回 undefined", () => {
    // oracle: derived
    const dest = makeDir("find-none");
    assert.equal(findMarkdown(dest), undefined);
  });
});

describe("renameMarkdown", () => {
  it("把 full.md 改名为 <slug>.md 且保留内容", () => {
    // oracle: specified
    const dest = makeDir("rename");
    fs.writeFileSync(path.join(dest, "full.md"), "# 正文\n", "utf8");
    const target = renameMarkdown(dest, "report-final");
    assert.equal(target, path.join(dest, "report-final.md"));
    assert.equal(fs.readFileSync(target, "utf8"), "# 正文\n");
    assert.equal(fs.existsSync(path.join(dest, "full.md")), false);
  });
});

describe("writeMarkdown", () => {
  it("内容缺末尾换行时补一个", () => {
    // oracle: specified
    const dest = makeDir("write-missing-newline");
    const file = writeMarkdown(dest, "doc", "# 正文");
    assert.equal(path.basename(file), "doc.md");
    assert.equal(fs.readFileSync(file, "utf8"), "# 正文\n");
  });

  it("已带末尾换行时不重复补", () => {
    // oracle: specified
    const dest = makeDir("write-with-newline");
    const file = writeMarkdown(dest, "doc", "# 正文\n");
    assert.equal(fs.readFileSync(file, "utf8"), "# 正文\n");
  });
});

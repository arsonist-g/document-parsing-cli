/** util.ts 纯函数测试：时间戳 / slug / 密钥脱敏 / 体积格式化 / 路径展开。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { dateStamp, expandPath, formatBytes, maskSecret, slugify, timeStamp } from "../src/util.js";

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let tmpHome = "";

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-util-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("dateStamp", () => {
  it("按本地时区输出 YYYY-MM-DD 并补零", () => {
    // oracle: specified（契约规定格式；入参用本地时间构造，故与运行时时区无关）
    assert.equal(dateStamp(new Date(2026, 0, 5, 23, 59, 58)), "2026-01-05");
    assert.equal(dateStamp(new Date(2026, 10, 20, 0, 0, 0)), "2026-11-20");
    assert.equal(dateStamp(new Date(2026, 8, 9, 12, 0, 0)), "2026-09-09");
  });
});

describe("timeStamp", () => {
  it("按本地时区输出 HH-MM-SS 并补零", () => {
    // oracle: specified
    assert.equal(timeStamp(new Date(2026, 0, 5, 13, 4, 9)), "13-04-09");
    assert.equal(timeStamp(new Date(2026, 0, 5, 0, 0, 0)), "00-00-00");
    assert.equal(timeStamp(new Date(2026, 0, 5, 23, 59, 59)), "23-59-59");
  });
});

describe("slugify", () => {
  it("本地路径取去掉扩展名的文件名", () => {
    // oracle: specified（本地路径取去扩展名文件名；非法字符转 -）
    assert.equal(slugify("docs/quarterly report.pdf"), "quarterly-report");
    assert.equal(slugify("notes.md"), "notes");
    assert.equal(slugify(path.join("a", "b", "archive-v2")), "archive-v2");
  });

  it("多段扩展名只去掉最后一段", () => {
    // oracle: derived（「去掉扩展名」+「非法字符转 -」两条规则的组合）
    assert.equal(slugify("report.final.pdf"), "report-final");
  });

  it("URL 取主机名 + 路径末段", () => {
    // oracle: specified
    assert.equal(slugify("https://example.com/docs/my-file.pdf"), "example-com-my-file");
    assert.equal(slugify("https://example.com"), "example-com");
  });

  it("非法字符统一转成短横线", () => {
    // oracle: specified
    assert.equal(slugify("a b@c.pdf"), "a-b-c");
  });

  it("纯中文或空输入回退为 document", () => {
    // oracle: specified
    assert.equal(slugify("报告.pdf"), "document");
    assert.equal(slugify(""), "document");
  });
});

describe("maskSecret", () => {
  it("不回显完整的长密钥", () => {
    // oracle: specified（不泄露完整密钥）
    const secret = "sk-abcdefghijklmnopqrst";
    const masked = maskSecret(secret);
    assert.notEqual(masked, secret);
    assert.equal(masked.includes(secret), false);
    assert.equal(masked.includes(secret.slice(4, -4)), false);
    assert.equal(masked.includes("****"), true);
  });

  it("短密钥也不整串回显", () => {
    // oracle: specified
    const secret = "abcde";
    const masked = maskSecret(secret);
    assert.notEqual(masked, secret);
    assert.equal(masked.includes(secret), false);
  });
});

describe("formatBytes", () => {
  it("按 1024 进制换算并保留一位小数", () => {
    // oracle: derived（1024 进制单位阶梯的常规定义）
    assert.equal(formatBytes(0), "0B");
    assert.equal(formatBytes(1023), "1023B");
    assert.equal(formatBytes(1024), "1.0KB");
    assert.equal(formatBytes(1536), "1.5KB");
    assert.equal(formatBytes(1024 * 1024), "1.0MB");
    assert.equal(formatBytes(1024 ** 3), "1.0GB");
  });
});

describe("expandPath", () => {
  it("展开 ~/ 与 ~\\ 到 HOME", () => {
    // oracle: specified
    const expected = path.resolve(path.join(tmpHome, "docs"));
    assert.equal(expandPath("~/docs"), expected);
    assert.equal(expandPath("~\\docs"), expected);
  });

  it("裸 ~ 展开为 HOME 本身", () => {
    // oracle: derived（~ 即家目录）
    assert.equal(expandPath("~"), path.resolve(tmpHome));
  });
});

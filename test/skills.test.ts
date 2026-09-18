/** skills.ts：目标解析、安装动作与状态判定。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ArgsError } from "../src/errors.js";
import { SKILL_TARGETS, bundledSkillFiles, installSkill, parseTargets, skillStatus } from "../src/skills.js";

/** 直接从仓库里的内置资产读取期望内容，不经被测模块。 */
const BUNDLED_SKILL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "document-parsing",
  "SKILL.md",
);
const BUNDLED_ROOT = path.dirname(BUNDLED_SKILL);

/** 直接从仓库资产读期望内容，不经被测模块。 */
function asset(relative: string): string {
  return fs.readFileSync(path.join(BUNDLED_ROOT, ...relative.split("/")), "utf8");
}

let tmpDir = "";
let tmpHome = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-skills-"));
  tmpHome = path.join(tmpDir, "home");
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function names(targets: Array<{ name: string }>): string[] {
  return targets.map((target) => target.name);
}

describe("parseTargets", () => {
  it("缺省返回 codex", () => {
    // oracle: specified
    assert.deepEqual(names(parseTargets(undefined)), ["codex"]);
  });

  it("解析逗号分隔的多目标", () => {
    // oracle: specified
    assert.deepEqual(names(parseTargets("codex,claude")), ["codex", "claude"]);
  });

  it("接受数组形式", () => {
    // oracle: derived（CLI 以数组传入）
    assert.deepEqual(names(parseTargets(["codex", "cursor"])), ["codex", "cursor"]);
  });

  it("all 返回全部目标", () => {
    // oracle: specified（「全部」= SKILL_TARGETS 的全部条目）
    assert.deepEqual(names(parseTargets("all")).sort(), Object.keys(SKILL_TARGETS).sort());
  });

  it("未知目标抛 ArgsError", () => {
    // oracle: specified
    assert.throws(
      () => parseTargets("no-such-agent"),
      (error: unknown) => error instanceof ArgsError,
    );
  });
});

describe("installSkill", () => {
  it("安装到 home 下对应 agent 的 skills 目录", () => {
    // oracle: specified
    const actions = installSkill({ targets: parseTargets("claude"), home: tmpHome });
    const action = actions[0];
    assert.ok(action);
    const expected = path.join(tmpHome, ".claude", "skills", "document-parsing", "SKILL.md");
    assert.equal(action.action, "installed");
    assert.equal(action.path, expected);
    assert.equal(fs.readFileSync(expected, "utf8"), fs.readFileSync(BUNDLED_SKILL, "utf8"));
  });

  it("skillsRoot 覆盖 skills 根目录", () => {
    // oracle: specified
    const root = path.join(tmpDir, "skills-root");
    const action = installSkill({ targets: parseTargets("codex"), skillsRoot: root, home: tmpHome })[0];
    assert.ok(action);
    assert.equal(action.path, path.join(root, "document-parsing", "SKILL.md"));
    assert.equal(fs.existsSync(action.path), true);
  });

  it("重复安装同一内容报 up-to-date", () => {
    // oracle: specified
    const options = { targets: parseTargets("codex"), home: tmpHome };
    installSkill(options);
    const action = installSkill(options)[0];
    assert.ok(action);
    assert.equal(action.action, "up-to-date");
  });

  it("内容不同时重新写入并报 updated", () => {
    // oracle: specified
    const options = { targets: parseTargets("codex"), home: tmpHome };
    const first = installSkill(options)[0];
    assert.ok(first);
    fs.writeFileSync(first.path, "# 旧版本\n", "utf8");
    const second = installSkill(options)[0];
    assert.ok(second);
    assert.equal(second.action, "updated");
    assert.equal(fs.readFileSync(second.path, "utf8"), fs.readFileSync(BUNDLED_SKILL, "utf8"));
  });

  it("连 references/ 与译本一起复制，不只复制入口", () => {
    // oracle: specified（skill 包布局 = 入口 + references/ + 译本）
    const action = installSkill({ targets: parseTargets("codex"), home: tmpHome })[0];
    assert.ok(action);
    const dir = path.dirname(action.path);
    for (const relative of [
      "references/errors.md",
      "references/install-and-config.md",
      "references/errors-zh.md",
      "references/install-and-config-zh.md",
      "skill-zh.md",
    ]) {
      const installed = path.join(dir, ...relative.split("/"));
      assert.equal(fs.existsSync(installed), true, `缺少 ${relative}`);
      assert.equal(fs.readFileSync(installed, "utf8"), asset(relative));
    }
  });

  it("references/ 漂移时重装并报 updated", () => {
    // oracle: derived（状态按整包比对，不只看入口）
    const options = { targets: parseTargets("codex"), home: tmpHome };
    const action = installSkill(options)[0];
    assert.ok(action);
    const reference = path.join(path.dirname(action.path), "references", "errors.md");
    fs.writeFileSync(reference, "# 改动\n", "utf8");
    const second = installSkill(options)[0];
    assert.ok(second);
    assert.equal(second.action, "updated");
    assert.equal(fs.readFileSync(reference, "utf8"), asset("references/errors.md"));
  });
});

describe("skillStatus", () => {
  it("未安装时返回 missing", () => {
    // oracle: specified
    const status = skillStatus({ targets: parseTargets("codex"), home: tmpHome })[0];
    assert.ok(status);
    assert.equal(status.state, "missing");
  });

  it("安装后返回 up-to-date", () => {
    // oracle: derived
    const options = { targets: parseTargets("codex"), home: tmpHome };
    installSkill(options);
    const status = skillStatus(options)[0];
    assert.ok(status);
    assert.equal(status.state, "up-to-date");
  });

  it("内容被改动后返回 stale", () => {
    // oracle: derived
    const options = { targets: parseTargets("codex"), home: tmpHome };
    const action = installSkill(options)[0];
    assert.ok(action);
    fs.writeFileSync(action.path, "# 改动\n", "utf8");
    const status = skillStatus(options)[0];
    assert.ok(status);
    assert.equal(status.state, "stale");
  });

  it("只有 references/ 里的文件被改动时也报 stale", () => {
    // oracle: derived（状态按整包比对，不只看入口）
    const options = { targets: parseTargets("codex"), home: tmpHome };
    const action = installSkill(options)[0];
    assert.ok(action);
    const reference = path.join(path.dirname(action.path), "references", "errors.md");
    fs.writeFileSync(reference, "# 改动\n", "utf8");
    const status = skillStatus(options)[0];
    assert.ok(status);
    assert.equal(status.state, "stale");
  });
});

describe("内置 skill 资产布局", () => {
  const ENTRY = "SKILL.md";
  const REQUIRED = [
    "references/errors.md",
    "references/errors-zh.md",
    "references/install-and-config.md",
    "references/install-and-config-zh.md",
    "skill-zh.md",
  ];

  it("入口、references 与译本齐备", () => {
    // oracle: specified（skill-writing-guide 的 cli-many-options 布局）
    const files = bundledSkillFiles().map((file) => file.relative);
    for (const relative of [ENTRY, ...REQUIRED]) {
      assert.equal(files.includes(relative), true, `缺少 ${relative}`);
    }
  });

  it("references/ 下没有入口不指向的孤儿文件", () => {
    // oracle: specified（三个钩子：没有步骤加载的 reference 是死重；译本跟随它的母本）
    const entry = asset(ENTRY);
    const orphans = bundledSkillFiles()
      .map((file) => file.relative)
      .filter((relative) => relative.startsWith("references/") && !relative.endsWith("-zh.md"))
      .filter((relative) => !entry.includes(relative));
    assert.deepEqual(orphans, []);
  });
});

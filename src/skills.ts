/**
 * skill 安装：把内置 skill 目录（入口、references/、译本）整体复制到各家 AI Agent 的 skills 目录。
 *
 * 默认目标 codex → `~/.agents/skills/document-parsing`（PI-Desktop 共用同一目录）；
 * 其余家按各自约定路径安装，`--skills-root` 可整体替换 skills 根目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ArgsError, ConfigError } from "./errors.js";
import { ensureDir } from "./util.js";

export const SKILL_NAME = "document-parsing";

export interface SkillTarget {
  name: string;
  label: string;
  /** 相对 HOME 的 skills 根目录。 */
  skillsRootRelative: string;
}

export const SKILL_TARGETS: Record<string, SkillTarget> = {
  codex: { name: "codex", label: "Codex", skillsRootRelative: ".agents/skills" },
  pidesktop: { name: "pidesktop", label: "PI-Desktop", skillsRootRelative: ".agents/skills" },
  claude: { name: "claude", label: "Claude Code", skillsRootRelative: ".claude/skills" },
  cursor: { name: "cursor", label: "Cursor", skillsRootRelative: ".cursor/skills" },
  hermes: { name: "hermes", label: "Hermes Agent", skillsRootRelative: ".hermes/skills" },
};

export const DEFAULT_TARGETS = ["codex"];

/** skill 入口文件名；其余文件按目录结构相对复制。 */
export const SKILL_ENTRY = "SKILL.md";

export interface SkillFile {
  /** 相对 skill 目录的路径，始终用 `/` 分隔。 */
  relative: string;
  content: Buffer;
}

/** 内置 skill 目录（随 npm 包一起发布）。 */
export function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "skills", SKILL_NAME),
    path.resolve(here, "..", "..", "skills", SKILL_NAME),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, SKILL_ENTRY))) return candidate;
  }
  throw new ConfigError(`内置 skill 资产缺失，查找路径：${candidates.join(" | ")}`);
}

/** 列出内置 skill 的全部文件：入口、references/ 与译本。 */
export function bundledSkillFiles(): SkillFile[] {
  const root = bundledSkillDir();
  const files: SkillFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.push({
          relative: path.relative(root, full).split(path.sep).join("/"),
          content: fs.readFileSync(full),
        });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

export function parseTargets(raw: string | string[] | undefined): SkillTarget[] {
  const names =
    raw === undefined
      ? DEFAULT_TARGETS
      : (Array.isArray(raw) ? raw.join(",") : raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (names.includes("all")) return Object.values(SKILL_TARGETS);
  const targets: SkillTarget[] = [];
  for (const name of names) {
    const target = SKILL_TARGETS[name.toLowerCase()];
    if (!target) {
      throw new ArgsError(
        `未知的 skill 目标「${name}」，可选：${Object.keys(SKILL_TARGETS).join(", ")}, all`,
      );
    }
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

export interface SkillAction {
  target: string;
  label: string;
  path: string;
  action: "installed" | "updated" | "up-to-date";
}

function targetDir(target: SkillTarget, skillsRoot?: string, home?: string): string {
  const base = skillsRoot
    ? path.resolve(skillsRoot)
    : path.join(home ?? os.homedir(), target.skillsRootRelative);
  return path.join(base, SKILL_NAME);
}

/** 目标目录里的内置文件是否与资产逐字节一致（不比较、也不清理目标目录里多出来的文件）。 */
function filesUpToDate(dir: string, files: SkillFile[]): boolean {
  return files.every((file) => {
    const destination = path.join(dir, ...file.relative.split("/"));
    return fs.existsSync(destination) && fs.readFileSync(destination).equals(file.content);
  });
}

export function installSkill(options: {
  targets: SkillTarget[];
  skillsRoot?: string;
  home?: string;
}): SkillAction[] {
  const files = bundledSkillFiles();
  return options.targets.map((target) => {
    const dir = targetDir(target, options.skillsRoot, options.home);
    const entry = path.join(dir, SKILL_ENTRY);
    const action: SkillAction["action"] = filesUpToDate(dir, files)
      ? "up-to-date"
      : fs.existsSync(entry)
        ? "updated"
        : "installed";
    if (action !== "up-to-date") {
      for (const file of files) {
        const destination = path.join(dir, ...file.relative.split("/"));
        ensureDir(path.dirname(destination));
        fs.writeFileSync(destination, file.content);
      }
    }
    return { target: target.name, label: target.label, path: entry, action };
  });
}

export type SkillState = "missing" | "stale" | "up-to-date";

export interface SkillStatus {
  target: string;
  label: string;
  path: string;
  state: SkillState;
}

export function skillStatus(options: {
  targets: SkillTarget[];
  skillsRoot?: string;
  home?: string;
}): SkillStatus[] {
  const files = bundledSkillFiles();
  return options.targets.map((target) => {
    const dir = targetDir(target, options.skillsRoot, options.home);
    const entry = path.join(dir, SKILL_ENTRY);
    let state: SkillState = "up-to-date";
    if (!fs.existsSync(entry)) state = "missing";
    else if (!filesUpToDate(dir, files)) state = "stale";
    return { target: target.name, label: target.label, path: entry, state };
  });
}


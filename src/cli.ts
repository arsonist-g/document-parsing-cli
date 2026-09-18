#!/usr/bin/env node
/** CLI 入口：全局参数预解析 + 命令分发 + 统一结果/错误输出。 */

import fs from "node:fs";

import { getBool, getList, getString, has, parseArgs, type FlagSpec, type ParsedArgs } from "./args.js";
import { buildContext, type CliContext } from "./context.js";
import { ArgsError, DocparseError, EXIT_CODE } from "./errors.js";
import { COMMAND_HELP, USAGE } from "./help.js";
import {
  accountRows,
  configSummary,
  runAccountAdd,
  runAccountList,
  runAccountRemove,
  runAccountTest,
  runConfigInit,
  runConfigPath,
  runConfigSet,
  runConfigShow,
  runDoctor,
  runQuota,
  quotaTable,
  runSkillsInstall,
  runSkillsStatus,
  renderDoctor,
} from "./commands/admin.js";
import { runParse, type JobOutcome } from "./commands/parse.js";
import { runFlash } from "./commands/flash.js";
import { runTask } from "./commands/task.js";
import { runBatch } from "./commands/batch.js";

const SPECS: FlagSpec[] = [
  { name: "config", kind: "string" },
  { name: "base-url", kind: "string" },
  { name: "token", kind: "string", repeatable: true },
  { name: "output", kind: "string" },
  { name: "timeout", kind: "string" },
  { name: "verbose", kind: "boolean", alias: ["v"] },
  { name: "help", kind: "boolean", alias: ["h"] },
  { name: "version", kind: "boolean" },
  { name: "model", kind: "string" },
  { name: "language", kind: "string" },
  { name: "pages", kind: "string" },
  { name: "ocr", kind: "boolean" },
  { name: "formula", kind: "boolean" },
  { name: "table", kind: "boolean" },
  { name: "extra-formats", kind: "string" },
  { name: "out", kind: "string" },
  { name: "no-wait", kind: "boolean" },
  { name: "wait", kind: "boolean" },
  { name: "download", kind: "boolean" },
  { name: "slug", kind: "string" },
  { name: "force", kind: "boolean" },
  { name: "name", kind: "string" },
  { name: "weight", kind: "string" },
  { name: "target", kind: "string" },
  { name: "skills-root", kind: "string" },
];

function readVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function outputMode(parsed: ParsedArgs): "text" | "json" {
  const raw = getString(parsed, "output") ?? "text";
  if (raw !== "text" && raw !== "json") throw new ArgsError(`--output 只接受 text 或 json，收到「${raw}」`);
  return raw;
}

function buildContextFromArgs(parsed: ParsedArgs): CliContext {
  const configPath = getString(parsed, "config");
  const baseUrl = getString(parsed, "base-url");
  return buildContext({
    ...(configPath ? { configPath } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    tokens: getList(parsed, "token"),
    verbose: getBool(parsed, "verbose"),
    outputMode: outputMode(parsed),
  });
}

function parseParams(parsed: ParsedArgs, ctx: CliContext): {
  modelVersion?: string;
  language?: string;
  isOcr?: boolean;
  enableFormula?: boolean;
  enableTable?: boolean;
  pageRanges?: string;
  extraFormats?: string[];
} {
  const extra = getString(parsed, "extra-formats");
  return {
    modelVersion: getString(parsed, "model") ?? ctx.config.parse.modelVersion,
    language: getString(parsed, "language") ?? ctx.config.parse.language,
    isOcr: has(parsed, "ocr") ? getBool(parsed, "ocr") : ctx.config.parse.isOcr,
    enableFormula: has(parsed, "formula") ? getBool(parsed, "formula") : ctx.config.parse.enableFormula,
    enableTable: has(parsed, "table") ? getBool(parsed, "table") : ctx.config.parse.enableTable,
    ...(getString(parsed, "pages") ? { pageRanges: getString(parsed, "pages") } : {}),
    ...(extra ? { extraFormats: extra.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

function timeoutSec(parsed: ParsedArgs, ctx: CliContext): number | undefined {
  const raw = getString(parsed, "timeout");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ArgsError(`--timeout 需要正数秒，收到「${raw}」`);
  return value;
}

function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function jobPayload(item: JobOutcome): Record<string, unknown> {
  return {
    input: item.input,
    kind: item.kind,
    state: item.state,
    ...(item.mdPath ? { md_path: item.mdPath } : {}),
    ...(item.outDir ? { out_dir: item.outDir } : {}),
    ...(item.taskId ? { task_id: item.taskId } : {}),
    ...(item.batchId ? { batch_id: item.batchId } : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

function skillPayload(action: { target: string; label: string; path: string; action: string }): Record<string, string> {
  return { target: action.target, label: action.label, path: action.path, result: action.action };
}

async function dispatch(ctx: CliContext, parsed: ParsedArgs): Promise<void> {
  const [command, sub, ...rest] = parsed.positionals;

  if (!command) {
    process.stdout.write(USAGE);
    return;
  }
  if (getBool(parsed, "help") && !COMMAND_HELP[command]) {
    process.stdout.write(COMMAND_HELP[command] ?? USAGE);
    return;
  }

  switch (command) {
    case "parse": {
      const inputs = parsed.positionals.slice(1);
      const outcome = await runParse(ctx, {
        inputs,
        params: parseParams(parsed, ctx),
        ...(getString(parsed, "out") ? { out: getString(parsed, "out")! } : {}),
        wait: !getBool(parsed, "no-wait"),
        ...(timeoutSec(parsed, ctx) !== undefined ? { timeoutSec: timeoutSec(parsed, ctx)! } : {}),
      });
      if (ctx.outputMode === "json") {
        emitJson({ results: outcome.results.map(jobPayload), batch_ids: outcome.batchIds, failed: outcome.failed });
      } else if (!getBool(parsed, "no-wait")) {
        for (const item of outcome.results) if (item.mdPath) process.stdout.write(`${item.mdPath}\n`);
      } else {
        for (const id of outcome.batchIds) process.stdout.write(`${id}\n`);
      }
      for (const item of outcome.results) {
        if (item.error) ctx.log(`error: ${item.input}: ${item.error}`);
      }
      if (outcome.failed > 0) {
        process.exitCode = outcome.failed === outcome.results.length ? EXIT_CODE.upstream : EXIT_CODE.partial;
      }
      return;
    }

    case "flash": {
      const flashInputs = parsed.positionals.slice(1);
      if (flashInputs.length === 0) throw new ArgsError("flash 需要一个文件路径或 URL");
      if (flashInputs.length > 1) {
        throw new ArgsError(
          `flash 只接受一个输入（收到 ${flashInputs.length} 个）：批量解析请改用 docparse parse`,
        );
      }
      const input = flashInputs[0]!;
      const outcome = await runFlash(ctx, {
        input,
        params: parseParams(parsed, ctx),
        ...(getString(parsed, "out") ? { out: getString(parsed, "out")! } : {}),
        ...(timeoutSec(parsed, ctx) !== undefined ? { timeoutSec: timeoutSec(parsed, ctx)! } : {}),
      });
      if (ctx.outputMode === "json") {
        emitJson({
          input: outcome.input,
          kind: outcome.kind,
          state: outcome.state,
          md_path: outcome.mdPath,
          out_dir: outcome.outDir,
          task_id: outcome.taskId,
        });
      } else if (outcome.mdPath) {
        process.stdout.write(`${outcome.mdPath}\n`);
      }
      return;
    }

    case "task": {
      const taskId = parsed.positionals[1];
      if (!taskId) throw new ArgsError("task 需要一个 task_id");
      const outcome = await runTask(ctx, {
        taskId,
        download: getBool(parsed, "download"),
        wait: getBool(parsed, "wait"),
        ...(getString(parsed, "out") ? { out: getString(parsed, "out")! } : {}),
        ...(getString(parsed, "slug") ? { slug: getString(parsed, "slug")! } : {}),
        ...(timeoutSec(parsed, ctx) !== undefined ? { timeoutSec: timeoutSec(parsed, ctx)! } : {}),
      });
      if (ctx.outputMode === "json") {
        emitJson({
          task_id: outcome.taskId,
          state: outcome.state,
          ...(outcome.mdPath ? { md_path: outcome.mdPath } : {}),
          ...(outcome.outDir ? { out_dir: outcome.outDir } : {}),
        });
      } else if (outcome.mdPath) {
        process.stdout.write(`${outcome.mdPath}\n`);
      } else {
        process.stdout.write(`${outcome.taskId} ${outcome.state}\n`);
      }
      return;
    }

    case "batch": {
      const batchId = parsed.positionals[1];
      if (!batchId) throw new ArgsError("batch 需要一个 batch_id");
      const outcome = await runBatch(ctx, {
        batchId,
        download: getBool(parsed, "download"),
        wait: getBool(parsed, "wait"),
        ...(getString(parsed, "out") ? { out: getString(parsed, "out")! } : {}),
        ...(getString(parsed, "slug") ? { slug: getString(parsed, "slug")! } : {}),
        ...(timeoutSec(parsed, ctx) !== undefined ? { timeoutSec: timeoutSec(parsed, ctx)! } : {}),
      });
      if (ctx.outputMode === "json") {
        emitJson({
          batch_id: outcome.batchId,
          failed: outcome.failed,
          items: outcome.items.map((item) => ({
            file_name: item.fileName,
            ...(item.dataId ? { data_id: item.dataId } : {}),
            state: item.state,
            ...(item.mdPath ? { md_path: item.mdPath } : {}),
            ...(item.outDir ? { out_dir: item.outDir } : {}),
            ...(item.error ? { error: item.error } : {}),
          })),
        });
      } else {
        for (const item of outcome.items) {
          if (item.mdPath) process.stdout.write(`${item.mdPath}\n`);
          else process.stdout.write(`${item.fileName} ${item.state}\n`);
        }
      }
      for (const item of outcome.items) {
        if (item.error) ctx.log(`error: ${item.fileName}: ${item.error}`);
      }
      if (outcome.failed > 0) {
        process.exitCode =
          outcome.failed === outcome.items.length ? EXIT_CODE.upstream : EXIT_CODE.partial;
      }
      return;
    }

    case "config": {
      if (!sub || sub === "show") {
        if (ctx.outputMode === "json") emitJson(configSummary(ctx));
        else runConfigShow(ctx);
        return;
      }
      if (sub === "path") {
        if (ctx.outputMode === "json") emitJson({ config_path: ctx.config.path });
        else runConfigPath(ctx);
        return;
      }
      if (sub === "init") {
        const result = runConfigInit(ctx, getBool(parsed, "force"));
        if (ctx.outputMode === "json") emitJson(result);
        else {
          process.stdout.write(
            result.created ? `${result.path}\n` : `${result.path}（已存在，未覆盖；需要覆盖加 --force）\n`,
          );
        }
        return;
      }
      if (sub === "set") {
        const key = rest[0];
        const value = rest[1];
        if (!key || value === undefined) throw new ArgsError("用法：docparse config set <键> <值>");
        const updated = runConfigSet(ctx, key, value);
        if (ctx.outputMode === "json") emitJson({ ...updated, config_path: ctx.config.path });
        return;
      }
      throw new ArgsError(`未知的 config 子命令「${sub}」，可选：path, show, init, set`);
    }

    case "account": {
      if (!sub || sub === "list") {
        if (ctx.outputMode === "json") emitJson({ accounts: accountRows(ctx), config_path: ctx.config.path });
        else runAccountList(ctx);
        return;
      }
      if (sub === "add") {
        const weight = getString(parsed, "weight");
        const entry = runAccountAdd(ctx, {
          ...(getString(parsed, "name") ? { name: getString(parsed, "name")! } : {}),
          ...(getString(parsed, "token") ? { token: getString(parsed, "token")! } : {}),
          ...(getString(parsed, "base-url") ? { baseUrl: getString(parsed, "base-url")! } : {}),
          ...(weight ? { weight: Number(weight) } : {}),
        });
        if (ctx.outputMode === "json") emitJson({ added: entry, config: ctx.config.path });
        else process.stdout.write(`已添加账号「${String(entry.name)}」到 ${ctx.config.path}\n`);
        return;
      }
      if (sub === "remove") {
        const target = rest[0];
        if (!target) throw new ArgsError("用法：docparse account remove <名称或序号>");
        const removed = runAccountRemove(ctx, target);
        if (ctx.outputMode === "json") emitJson({ removed, config: ctx.config.path });
        else process.stdout.write(`已删除账号「${String(removed.name ?? target)}」\n`);
        return;
      }
      if (sub === "test") {
        const results = await runAccountTest(ctx, getString(parsed, "name"));
        if (ctx.outputMode === "json") emitJson({ results });
        else {
          process.stdout.write(
            `${results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.message}`).join("\n")}\n`,
          );
        }
        if (results.some((r) => !r.ok)) process.exitCode = EXIT_CODE.auth;
        return;
      }
      throw new ArgsError(`未知的 account 子命令「${sub}」，可选：list, add, remove, test`);
    }

    case "quota": {
      const rows = await runQuota(ctx, getString(parsed, "name"));
      if (ctx.outputMode === "json") emitJson({ accounts: rows });
      else process.stdout.write(`${quotaTable(rows)}\n`);
      const failure = rows.find((row) => !row.ok);
      if (failure?.exit_code !== undefined) process.exitCode = failure.exit_code;
      return;
    }

    case "skills": {
      const options = {
        ...(getString(parsed, "target") ? { target: getString(parsed, "target")! } : {}),
        ...(getString(parsed, "skills-root") ? { skillsRoot: getString(parsed, "skills-root")! } : {}),
      };
      if (!sub || sub === "status") {
        const status = runSkillsStatus(options);
        if (ctx.outputMode === "json") emitJson({ skills: status });
        else process.stdout.write(`${status.map((s) => `${s.state.padEnd(11)} ${s.target.padEnd(10)} ${s.path}`).join("\n")}\n`);
        return;
      }
      if (sub === "install" || sub === "update") {
        const actions = runSkillsInstall(options);
        if (ctx.outputMode === "json") emitJson({ skills: actions.map(skillPayload) });
        else process.stdout.write(`${actions.map((a) => `${a.action.padEnd(11)} ${a.target.padEnd(10)} ${a.path}`).join("\n")}\n`);
        return;
      }
      throw new ArgsError(`未知的 skills 子命令「${sub}」，可选：status, install, update`);
    }

    case "doctor": {
      const report = await runDoctor(ctx, {
        ...(getString(parsed, "target") ? { target: getString(parsed, "target")! } : {}),
        ...(getString(parsed, "skills-root") ? { skillsRoot: getString(parsed, "skills-root")! } : {}),
      });
      if (ctx.outputMode === "json") emitJson(report);
      else process.stdout.write(`${renderDoctor(report)}\n`);
      const hasError = report.checks.some((c) => c.status === "error");
      if (hasError) process.exitCode = EXIT_CODE.config;
      return;
    }

    default:
      throw new ArgsError(`未知命令「${command}」。可用命令见 docparse --help`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), SPECS);

  if (getBool(parsed, "version")) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const command = parsed.positionals[0];
  if ((getBool(parsed, "help") && !command) || (!command && getList(parsed, "token").length === 0)) {
    process.stdout.write(USAGE);
    return;
  }
  if (getBool(parsed, "help")) {
    process.stdout.write(`${COMMAND_HELP[command ?? ""] ?? USAGE}\n`);
    return;
  }

  const ctx = buildContextFromArgs(parsed);
  if (has(parsed, "verbose") && ctx.config.path) ctx.log(`配置：${ctx.config.path}`);
  await dispatch(ctx, parsed);
}

main().catch((error: unknown) => {
  const docparseError =
    error instanceof DocparseError
      ? error
      : new DocparseError("internal", error instanceof Error ? error.message : String(error));
  process.stderr.write(`error: ${docparseError.message}\n`);
  if (docparseError.details !== undefined && process.env.DOCPARSE_DEBUG) {
    process.stderr.write(`${JSON.stringify(docparseError.details, null, 2)}\n`);
  }
  process.exitCode = docparseError.exitCode;
});


/** 极简参数解析：支持 `--k v` / `--k=v` / `--flag` / `--no-flag` / `-x` / `--` 分隔。 */

import { ArgsError } from "./errors.js";

export interface FlagSpec {
  name: string;
  kind?: "string" | "boolean";
  repeatable?: boolean;
  alias?: string[];
}

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  flags: Map<string, FlagValue>;
  positionals: string[];
}

export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  const byAlias = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    for (const alias of spec.alias ?? []) byAlias.set(alias, spec);
  }

  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  let onlyPositionals = false;

  const assign = (spec: FlagSpec, value: FlagValue): void => {
    if (spec.kind === "string" && typeof value === "string" && spec.repeatable) {
      const current = flags.get(spec.name);
      flags.set(spec.name, Array.isArray(current) ? [...current, value] : [value]);
      return;
    }
    flags.set(spec.name, value);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (onlyPositionals) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }

    let spec: FlagSpec | undefined;
    let inlineValue: string | undefined;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const name = eq >= 0 ? body.slice(0, eq) : body;
      if (eq >= 0) inlineValue = body.slice(eq + 1);
      spec = byName.get(name);
      if (!spec && name.startsWith("no-")) {
        spec = byName.get(name.slice(3));
        if (spec && (spec.kind ?? "boolean") === "boolean") {
          assign(spec, false);
          continue;
        }
        spec = undefined;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      spec = byAlias.get(arg.slice(1));
    } else {
      positionals.push(arg);
      continue;
    }

    if (!spec) throw new ArgsError(`未知参数：${arg}`);

    const kind = spec.kind ?? "boolean";
    if (kind === "boolean") {
      if (inlineValue !== undefined) {
        assign(spec, inlineValue !== "false" && inlineValue !== "0");
      } else {
        assign(spec, true);
      }
      continue;
    }

    if (inlineValue !== undefined) {
      assign(spec, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-" && !/^-\d/.test(next))) {
      throw new ArgsError(`${arg} 缺少取值`);
    }
    assign(spec, next);
    i += 1;
  }

  return { flags, positionals };
}

export function getString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return undefined;
}

export function getBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

export function getList(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

export function has(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name);
}

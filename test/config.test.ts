/** config.ts：DOCPARSE_HOME、来源合并优先级、base_url 优先级、账号可用性与指纹。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_BASE_URL,
  accountBaseUrl,
  accountKey,
  configDir,
  isAccountUsable,
  loadConfig,
  statePath,
  type AccountConfig,
} from "../src/config.js";

const MANAGED_ENV = [
  "DOCPARSE_HOME",
  "DOCPARSE_CONFIG",
  "DOCPARSE_BASE_URL",
  "DOCPARSE_TOKENS",
  "DOCPARSE_TOKEN",
  "MINERU_TOKEN",
  "DOCPARSE_MODEL_VERSION",
  "DOCPARSE_LANGUAGE",
  "DOCPARSE_OUTPUT_ROOT",
] as const;

let savedEnv: Array<[string, string | undefined]> = [];
let tmpHome = "";

beforeEach(() => {
  savedEnv = MANAGED_ENV.map((key) => [key, process.env[key]]);
  for (const key of MANAGED_ENV) delete process.env[key];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-config-"));
  process.env.DOCPARSE_HOME = tmpHome;
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** 直接落一份 TOML 作为输入，不经过被测模块的写入逻辑。 */
function writeConfigToml(toml: string): string {
  const file = path.join(tmpHome, "config.toml");
  fs.writeFileSync(file, toml, "utf8");
  return file;
}

function makeAccount(partial: Partial<AccountConfig>): AccountConfig {
  return {
    name: "acct",
    auth: "bearer",
    token: "",
    accessKey: "",
    secretKey: "",
    baseUrl: "",
    headers: {},
    weight: 1,
    enabled: true,
    source: "config",
    ...partial,
  };
}

describe("DOCPARSE_HOME", () => {
  it("决定配置目录与配置文件/状态文件路径", () => {
    // oracle: specified
    assert.equal(configDir(), path.resolve(tmpHome));
    assert.equal(statePath(), path.join(path.resolve(tmpHome), "state.json"));
    const config = loadConfig();
    assert.equal(config.path, path.join(path.resolve(tmpHome), "config.toml"));
    assert.equal(config.dir, path.resolve(tmpHome));
    assert.equal(config.exists, false);
  });
});

describe("账号来源合并优先级", () => {
  it("--token 选项 > 环境变量 > 配置文件 [[account]]", () => {
    // oracle: specified
    writeConfigToml(`
[[account]]
name = "cfg-1"
token = "cfg-token-1"
`);
    process.env.DOCPARSE_TOKEN = "env-token-1";
    const config = loadConfig({ tokens: ["cli-token-1", "cli-token-2"] });
    assert.deepEqual(
      config.accounts.map((account) => [account.source, account.token]),
      [
        ["cli", "cli-token-1"],
        ["cli", "cli-token-2"],
        ["env", "env-token-1"],
        ["config", "cfg-token-1"],
      ],
    );
  });

  it("DOCPARSE_TOKENS 支持逗号与空白分隔", () => {
    // oracle: specified
    process.env.DOCPARSE_TOKENS = "tok-a, tok-b  tok-c";
    const config = loadConfig();
    assert.deepEqual(
      config.accounts.map((account) => account.token),
      ["tok-a", "tok-b", "tok-c"],
    );
    assert.deepEqual(
      config.accounts.map((account) => account.source),
      ["env", "env", "env"],
    );
  });

  it("三种来源都没有时账号列表为空", () => {
    // oracle: derived
    assert.deepEqual(loadConfig().accounts, []);
  });
});

describe("base_url 优先级", () => {
  it("默认使用官方地址", () => {
    // oracle: specified
    assert.equal(DEFAULT_BASE_URL, "https://mineru.net");
    assert.equal(loadConfig().baseUrl, DEFAULT_BASE_URL);
  });

  it("配置文件 base_url 生效", () => {
    // oracle: specified
    writeConfigToml('base_url = "https://cfg.example.com"\n');
    assert.equal(loadConfig().baseUrl, "https://cfg.example.com");
  });

  it("DOCPARSE_BASE_URL 覆盖配置文件", () => {
    // oracle: specified
    writeConfigToml('base_url = "https://cfg.example.com"\n');
    process.env.DOCPARSE_BASE_URL = "https://env.example.com";
    assert.equal(loadConfig().baseUrl, "https://env.example.com");
  });

  it("--baseUrl 选项覆盖环境变量与配置文件", () => {
    // oracle: specified
    writeConfigToml('base_url = "https://cfg.example.com"\n');
    process.env.DOCPARSE_BASE_URL = "https://env.example.com";
    assert.equal(loadConfig({ baseUrl: "https://opt.example.com" }).baseUrl, "https://opt.example.com");
  });
});

describe("accountBaseUrl", () => {
  it("账号级 base_url 覆盖全局，缺省时回落到全局", () => {
    // oracle: specified
    writeConfigToml(`
base_url = "https://cfg.example.com"

[[account]]
name = "gateway"
auth = "ak_sk"
access_key = "AK"
secret_key = "SK"
base_url = "https://gw.example.com"

[[account]]
name = "official"
token = "tok"
`);
    const config = loadConfig();
    const [gateway, official] = config.accounts;
    assert.ok(gateway);
    assert.ok(official);
    assert.equal(accountBaseUrl(config, gateway), "https://gw.example.com");
    assert.equal(accountBaseUrl(config, official), "https://cfg.example.com");
  });
});

describe("isAccountUsable", () => {
  it("bearer 账号必须有 token", () => {
    // oracle: specified
    assert.equal(isAccountUsable(makeAccount({ auth: "bearer", token: "tok" })), true);
    assert.equal(isAccountUsable(makeAccount({ auth: "bearer", token: "" })), false);
  });

  it("ak_sk 账号必须同时有 access_key 与 secret_key", () => {
    // oracle: specified
    assert.equal(isAccountUsable(makeAccount({ auth: "ak_sk", accessKey: "AK", secretKey: "SK" })), true);
    assert.equal(isAccountUsable(makeAccount({ auth: "ak_sk", accessKey: "AK", secretKey: "" })), false);
    assert.equal(isAccountUsable(makeAccount({ auth: "ak_sk", accessKey: "", secretKey: "SK" })), false);
  });

  it("enabled=false 的账号不可用", () => {
    // oracle: derived（配置语义：disabled 账号不参与调度）
    assert.equal(isAccountUsable(makeAccount({ token: "tok", enabled: false })), false);
  });
});

describe("accountKey", () => {
  it("返回 sha256: 前缀的 12 位十六进制指纹", () => {
    // oracle: specified
    assert.match(accountKey(makeAccount({ token: "SUPERSECRET-TOKEN" })), /^sha256:[0-9a-f]{12}$/);
  });

  it("同一凭证稳定、不同凭证不同", () => {
    // oracle: derived
    assert.equal(
      accountKey(makeAccount({ name: "x", token: "T1" })),
      accountKey(makeAccount({ name: "y", token: "T1" })),
    );
    assert.notEqual(accountKey(makeAccount({ token: "T1" })), accountKey(makeAccount({ token: "T2" })));
  });

  it("绝不包含密钥明文", () => {
    // oracle: specified
    const token = "SUPERSECRET-TOKEN-VALUE";
    const bearerKey = accountKey(makeAccount({ auth: "bearer", token }));
    assert.equal(bearerKey.includes(token), false);
    const accessKey = "ACCESS-KEY-PLAINTEXT";
    const secretKey = "SECRET-KEY-PLAINTEXT";
    const akSkKey = accountKey(makeAccount({ auth: "ak_sk", accessKey, secretKey }));
    assert.equal(akSkKey.includes(accessKey), false);
    assert.equal(akSkKey.includes(secretKey), false);
  });
});

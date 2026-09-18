/** pool.ts：候选过滤、冷却与解除、选择策略、重试判定与 withAccount 换号。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_OUTPUT, DEFAULT_PARSE, accountKey, type AccountConfig, type Config } from "../src/config.js";
import { AuthError, NetworkError, UpstreamError } from "../src/errors.js";
import { AccountPool, withAccount } from "../src/pool.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docparse-pool-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAccount(partial: Partial<AccountConfig> & { name: string }): AccountConfig {
  return {
    auth: "bearer",
    token: `token-${partial.name}`,
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

function makePool(accounts: AccountConfig[]): AccountPool {
  const config: Config = {
    schemaVersion: 1,
    baseUrl: "https://mineru.net",
    accounts,
    parse: { ...DEFAULT_PARSE },
    output: { ...DEFAULT_OUTPUT },
    path: path.join(tmpDir, "config.toml"),
    dir: tmpDir,
    exists: false,
  };
  return AccountPool.load(config, path.join(tmpDir, "state.json"));
}

function names(accounts: AccountConfig[]): string[] {
  return accounts.map((account) => account.name);
}

describe("AccountPool.candidates", () => {
  it("过滤掉未配置完整的账号", () => {
    // oracle: specified
    const pool = makePool([
      makeAccount({ name: "bearer-ok", token: "t1" }),
      makeAccount({ name: "bearer-missing", token: "" }),
      makeAccount({ name: "aksk-partial", auth: "ak_sk", token: "", accessKey: "AK", secretKey: "" }),
      makeAccount({ name: "disabled", token: "t2", enabled: false }),
      makeAccount({ name: "bearer-ok-2", token: "t3" }),
    ]);
    assert.deepEqual(names(pool.candidates()), ["bearer-ok", "bearer-ok-2"]);
  });

  it("跳过冷却中的账号", () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const [accountA] = pool.candidates();
    assert.ok(accountA);
    const outcome = pool.markFailure(accountA, new NetworkError("连接被重置"));
    assert.equal(outcome.cooled, true);
    assert.deepEqual(names(pool.candidates()), ["b"]);
  });

  it("全部冷却时仍返回可用账号（不空转）", () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    for (const account of pool.candidates()) pool.markFailure(account, new NetworkError("超时"));
    assert.deepEqual(names(pool.candidates()).sort(), ["a", "b"]);
  });

  it("exclude 中的账号被排除（label 与指纹两种键）", () => {
    // oracle: specified（withAccount 依赖该语义）
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const [first] = pool.candidates();
    assert.ok(first);
    assert.deepEqual(names(pool.candidates(new Set([pool.label(first)]))), ["b"]);
    assert.deepEqual(names(pool.candidates(new Set([accountKey(first)]))), ["b"]);
  });
});

describe("AccountPool.pick", () => {
  it("在途请求多的账号评分更差", () => {
    // oracle: derived（契约：在途多的账号评分更差）
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const [first] = pool.candidates();
    assert.ok(first);
    pool.acquire(first);
    pool.acquire(first);
    const picked = pool.pick();
    assert.notEqual(picked.name, first.name);
  });

  it("weight 更大的账号更易被选中", () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "light", weight: 1 }), makeAccount({ name: "heavy", weight: 4 })]);
    assert.equal(pool.pick().name, "heavy");
  });
});

describe("AccountPool.markFailure 冷却时长", () => {
  it("A0202/A0211 凭证失效冷却 24 小时", () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const [accountA, accountB] = pool.candidates();
    assert.ok(accountA);
    assert.ok(accountB);
    const outcomeA = pool.markFailure(accountA, new UpstreamError("token 无效", { upstreamCode: "A0202" }));
    const outcomeB = pool.markFailure(accountB, new UpstreamError("token 过期", { upstreamCode: "A0211" }));
    assert.equal(outcomeA.cooled, true);
    assert.equal(outcomeA.ms, 24 * 3600_000);
    assert.equal(outcomeB.cooled, true);
    assert.equal(outcomeB.ms, 24 * 3600_000);
  });

  it("-60018 额度用尽冷却到次日（>0 且不超过约 24 小时）", () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "a" })]);
    const [account] = pool.candidates();
    assert.ok(account);
    const outcome = pool.markFailure(account, new UpstreamError("额度用尽", { upstreamCode: "-60018" }));
    assert.equal(outcome.cooled, true);
    assert.ok(outcome.ms > 0);
    assert.ok(outcome.ms <= 24 * 3600_000 + 5 * 60_000);
  });

  it("网络类错误只做短冷却（不超过 10 分钟）", () => {
    // oracle: specified（短冷却）+ derived（显式上界）
    const pool = makePool([makeAccount({ name: "a" })]);
    const [account] = pool.candidates();
    assert.ok(account);
    const outcome = pool.markFailure(account, new NetworkError("连接超时"));
    assert.equal(outcome.cooled, true);
    assert.ok(outcome.ms > 0);
    assert.ok(outcome.ms <= 10 * 60_000);
    assert.ok(outcome.ms < 24 * 3600_000);
  });
});

describe("AccountPool.markSuccess", () => {
  it("清零 failures 并解除冷却", () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const [accountA] = pool.candidates();
    assert.ok(accountA);
    pool.markFailure(accountA, new NetworkError("超时"));
    assert.deepEqual(names(pool.candidates()), ["b"]);
    pool.markSuccess(accountA);
    const runtime = pool.runtime(accountA);
    assert.equal(runtime.failures, 0);
    assert.equal(runtime.cooldownUntil, 0);
    assert.equal(runtime.successes, 1);
    assert.deepEqual(names(pool.candidates()).sort(), ["a", "b"]);
  });
});

describe("AccountPool.shouldRetry", () => {
  it("网络错误值得换账号重试", () => {
    // oracle: specified
    assert.equal(AccountPool.shouldRetry(new NetworkError("连接重置")), true);
  });

  it("A0202 值得换账号重试", () => {
    // oracle: specified
    assert.equal(AccountPool.shouldRetry(new UpstreamError("token 无效", { upstreamCode: "A0202" })), true);
  });

  it("业务类上游错误不换账号重试", () => {
    // oracle: derived（文件格式不支持属于请求本身的问题，换账号无意义）
    assert.equal(AccountPool.shouldRetry(new UpstreamError("文件格式不支持", { upstreamCode: "-60002" })), false);
  });

  it("-60001（生成上传 URL 失败）可重试", () => {
    // oracle: derived —— errors.ts 的释义表把 -60001 标为「稍后重试」，
    // 换一个账号再试一次是零成本的，故与释义表保持一致（不做成不可重试）
    assert.equal(
      AccountPool.shouldRetry(new UpstreamError("生成上传 URL 失败", { upstreamCode: "-60001" })),
      true,
    );
  });

  it("非上游/网络错误不重试", () => {
    // oracle: derived
    assert.equal(AccountPool.shouldRetry(new Error("boom")), false);
  });
});

describe("withAccount", () => {
  it("首个账号失败后换下一个账号，第二个成功时返回结果", async () => {
    // oracle: specified
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const attempts: string[] = [];
    const outcome = await withAccount(pool, async (account) => {
      attempts.push(account.name);
      if (account.name === "a") throw new NetworkError("上游连接被重置");
      return `ok:${account.name}`;
    });
    assert.deepEqual(attempts, ["a", "b"]);
    assert.equal(outcome.result, "ok:b");
    assert.equal(outcome.account.name, "b");
    assert.equal(pool.runtime(outcome.account).successes, 1);
    assert.equal(pool.runtime(outcome.account).failures, 0);
  });

  it("不可重试的错误立即抛出，不换账号", async () => {
    // oracle: derived（shouldRetry=false 即不再尝试其它账号）
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const attempts: string[] = [];
    await assert.rejects(
      withAccount(pool, async (account) => {
        attempts.push(account.name);
        throw new UpstreamError("文件格式不支持", { upstreamCode: "-60002" });
      }),
      (error: unknown) => error instanceof UpstreamError,
    );
    assert.deepEqual(attempts, ["a"]);
  });

  it("多个账号全部被 A0202 拒绝：收口为 AuthError（退出码 5）", async () => {
    // oracle: specified（凭证类错误统一归到 auth，便于调用方用退出码区分）
    const pool = makePool([makeAccount({ name: "a" }), makeAccount({ name: "b" })]);
    const attempts: string[] = [];
    await assert.rejects(
      withAccount(pool, async (account) => {
        attempts.push(account.name);
        throw new UpstreamError("上游拒绝：user authenticate failed", { upstreamCode: "A0202" });
      }),
      (error: unknown) => {
        assert.ok(error instanceof AuthError, `期望 AuthError，实际 ${String(error)}`);
        assert.equal(error.exitCode, 5);
        assert.equal(String(error.upstreamCode), "A0202");
        return true;
      },
    );
    // 每个账号只试一次：账号用尽即收口，不做重复选号
    assert.deepEqual(attempts, ["a", "b"]);
  });

  it("单账号被 A0202 拒绝：AuthError 保留上游错误码与原因", async () => {
    // oracle: specified（换号无望时也不能被「候选耗尽」的选号错误顶替真相）
    const pool = makePool([makeAccount({ name: "only" })]);
    await assert.rejects(
      withAccount(pool, async () => {
        throw new UpstreamError("上游拒绝：user authenticate failed", { upstreamCode: "A0202" });
      }),
      (error: unknown) => {
        assert.ok(error instanceof AuthError, `期望 AuthError，实际 ${String(error)}`);
        assert.equal(String(error.upstreamCode), "A0202");
        assert.match(error.message, /上游拒绝/);
        return true;
      },
    );
  });

  it("账号用尽且最后一个是非凭证类错误：抛出原始错误（退出码 6）", async () => {
    // oracle: derived —— 轮询超时里的 batch_id 是调用方唯一的重查线索，不能被选号错误吞掉
    const pool = makePool([makeAccount({ name: "only" })]);
    await assert.rejects(
      withAccount(pool, async () => {
        throw new UpstreamError("等待解析结果超时，可用 batch_id 稍后重查：b-123");
      }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError, `期望 UpstreamError，实际 ${String(error)}`);
        assert.equal(error.exitCode, 6);
        assert.match(error.message, /b-123/);
        return true;
      },
    );
  });
});

describe("AccountPool.pick 轮转与权重", () => {
  it("无在途请求时按「最久未使用」轮转，而不是反复挑同一个账号", () => {
    // oracle: specified —— 契约是「在途少 → 最久未用 → 权重高」，等权账号应按空闲时长依次轮转
    // 空闲时长用公开的 runtime() 显式播种，避免依赖 Date.now() 的毫秒精度：
    // 连续 pick 落在同一毫秒时三个账号空闲时长完全相等，实现只能按配置顺序取第一个，用例会假红。
    const accountA = makeAccount({ name: "a" });
    const accountB = makeAccount({ name: "b" });
    const accountC = makeAccount({ name: "c" });
    const pool = makePool([accountA, accountB, accountC]);
    const now = Date.now();
    pool.runtime(accountA).lastUsedAt = now - 30_000;
    pool.runtime(accountB).lastUsedAt = now - 20_000;
    pool.runtime(accountC).lastUsedAt = now - 10_000;

    const order: string[] = [];
    for (const expected of [accountA, accountB, accountC]) {
      const account = pool.pick();
      assert.equal(account.name, expected.name);
      pool.acquire(account);
      pool.markSuccess(account);
      pool.release(account);
      order.push(account.name);
    }
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("全新账号池的第一次选择偏向权重更大的账号", () => {
    // oracle: derived —— 两个账号都从未使用（空闲时长相同），权重差异决定胜负
    const pool = makePool([
      makeAccount({ name: "light", weight: 1 }),
      makeAccount({ name: "heavy", weight: 3 }),
    ]);
    assert.equal(pool.pick().name, "heavy");
  });

  it("多轮选择中权重大的账号获得的次数不少于权重小的", () => {
    // oracle: derived —— 权重参与选号评分，长期分布不应反向
    const pool = makePool([
      makeAccount({ name: "light", weight: 1 }),
      makeAccount({ name: "heavy", weight: 3 }),
    ]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 20; i += 1) {
      const account = pool.pick();
      pool.acquire(account);
      pool.markSuccess(account);
      pool.release(account);
      counts.set(account.name, (counts.get(account.name) ?? 0) + 1);
    }
    const heavy = counts.get("heavy") ?? 0;
    const light = counts.get("light") ?? 0;
    assert.ok(heavy >= light, `权重 3 的账号应不少于权重 1 的账号，实际 heavy=${heavy} light=${light}`);
  });
});

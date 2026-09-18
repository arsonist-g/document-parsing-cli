/** mineru.ts 的 buildAuthHeaders：bearer / ak_sk / 自定义 headers 模板替换。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AccountConfig } from "../src/config.js";
import { buildAuthHeaders } from "../src/mineru.js";

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

describe("buildAuthHeaders", () => {
  it("bearer 账号只发 Authorization: Bearer <token>", () => {
    // oracle: specified
    const headers = buildAuthHeaders(makeAccount({ auth: "bearer", token: "tok-abc" }));
    assert.deepEqual(headers, { Authorization: "Bearer tok-abc" });
  });

  it("ak_sk 账号默认发 accessKey + X-Secret-Key", () => {
    // oracle: specified
    const headers = buildAuthHeaders(makeAccount({ auth: "ak_sk", accessKey: "AK-1", secretKey: "SK-1" }));
    assert.deepEqual(headers, { Authorization: "Bearer AK-1", "X-Secret-Key": "SK-1" });
  });

  it("自定义 headers 按 ${token}/${access_key}/${secret_key} 模板替换", () => {
    // oracle: specified
    const headers = buildAuthHeaders(
      makeAccount({
        auth: "bearer",
        token: "tok-abc",
        accessKey: "AK-1",
        secretKey: "SK-1",
        headers: {
          "X-Token": "${token}",
          "X-AK": "${access_key}",
          "X-SK": "${secret_key}",
          "X-Literal": "plain",
        },
      }),
    );
    assert.deepEqual(headers, {
      "X-Token": "tok-abc",
      "X-AK": "AK-1",
      "X-SK": "SK-1",
      "X-Literal": "plain",
    });
  });

  it("存在自定义 headers 时不再附加默认鉴权头", () => {
    // oracle: derived（自定义 headers 即该账号的鉴权方式）
    const headers = buildAuthHeaders(
      makeAccount({ auth: "ak_sk", accessKey: "AK-1", secretKey: "SK-1", headers: { "X-AK": "${access_key}" } }),
    );
    assert.deepEqual(headers, { "X-AK": "AK-1" });
  });
});

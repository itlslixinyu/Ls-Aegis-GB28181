import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPassword, hashPassword } from "./lib/store.mjs";
import { loadEnvironment } from "./lib/environment.mjs";
import { createPlatformRuntime } from "./lib/platform-runtime.mjs";
import { readJsonBody } from "./lib/http.mjs";
import { Readable } from "node:stream";

test("损坏密码哈希安全拒绝，合法旧账号仍可校验", () => {
  for (const hash of [
    null,
    undefined,
    "",
    "broken",
    "salt:ff",
    "salt:" + "x".repeat(128),
    "a:b:c",
  ])
    assert.equal(checkPassword("test-password", hash), false);
  const hash = hashPassword("test-password");
  assert.equal(checkPassword("test-password", hash), true);
  assert.equal(checkPassword("wrong", hash), false);
});
test("环境显式隔离，不回退本机配置，不覆盖部署注入变量", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "aegis-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env"), "MEDIA_SECRET=local-secret\nPORT=3000");
  assert.throws(() => loadEnvironment("test", { cwd, env: {} }), /缺少/);
  assert.throws(
    () => loadEnvironment("../production", { cwd, env: {} }),
    /环境/,
  );
  await writeFile(
    join(cwd, ".env.test"),
    "PORT=3006\nSIP_ENABLED=0\nPLATFORM_DATABASE=data/test/platform.db",
  );
  const env = { PORT: "3999" };
  loadEnvironment("test", { cwd, env });
  assert.equal(env.PORT, "3999");
  assert.equal(env.MEDIA_SECRET, undefined);
  assert.equal(env.APP_ENV, "test");
  assert.equal(env.SIP_ENABLED, "0");
});
test("运行入口拒绝无效监听地址与端口", () => {
  const createServer = () => {
    throw Error("不应启动");
  };
  for (const port of [-1, 65536, NaN, 1.5])
    assert.throws(() => createPlatformRuntime({ createServer, port }), /PORT/);
  assert.throws(
    () => createPlatformRuntime({ createServer, host: "https://example.com" }),
    /HTTP_HOST/,
  );
});
test("统一JSON请求校验拒绝空值、数组、非法JSON和超限请求", async () => {
  for (const text of ["null", "[]", "broken", ""])
    await assert.rejects(
      readJsonBody(Readable.from([Buffer.from(text)])),
      (e) => e.status === 400 && e.code === "INVALID_JSON",
    );
  await assert.rejects(
    readJsonBody(Readable.from([Buffer.alloc(16385)])),
    (e) => e.status === 413,
  );
  assert.deepEqual(
    await readJsonBody(Readable.from([Buffer.from('{"name":"摄像机"}')])),
    { name: "摄像机" },
  );
});

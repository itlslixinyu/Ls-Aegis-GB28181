import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "./server.mjs";
import { createPlatformRuntime } from "./lib/platform-runtime.mjs";
import { loadConfig } from "./lib/config.mjs";
import { hashPassword, openStore } from "./lib/store.mjs";

async function fixture(t, { managed = false, restartPlatform, config } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "aegis-restart-"));
  const database = join(dir, "platform.db");
  const { db } = openStore(database);
  for (const role of ["admin", "viewer"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      role,
      role,
      hashPassword("restart-test-password"),
      role,
    );
  db.close();
  const options = {
    database,
    legacy: null,
    config: config || loadConfig({ SIP_ENABLED: "0" }),
  };
  let runtime, app;
  if (managed) {
    runtime = createPlatformRuntime({
      createServer,
      getOptions: () => options,
      port: 0,
      onError: () => {},
    });
    app = await runtime.start();
  } else {
    app = createServer({ ...options, restartPlatform });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  }
  const origin = "http://127.0.0.1:" + app.address().port;
  t.after(async () => {
    if (runtime) await runtime.stop();
    else await new Promise((resolve) => app.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, method = "GET", value, session, headers = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(6000),
    });
    return {
      status: response.status,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      ...(await response.json()),
    };
  }
  async function login(username) {
    const result = await request("/api/v1/auth/login", "POST", {
      username,
      password: "restart-test-password",
    });
    assert.equal(result.status, 200);
    return { cookie: result.cookie, csrf: result.data.csrf };
  }
  return { request, login, origin };
}

async function until(fn) {
  for (let n = 0; n < 150; n++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await delay(50);
  }
  throw Error("等待平台重启超时");
}

test("重启必须登录、管理员、有效CSRF和明确确认；未托管模式明确拒绝", async (t) => {
  const f = await fixture(t);
  const admin = await f.login("admin"),
    viewer = await f.login("viewer");
  const path = "/api/v1/system/restart";
  assert.equal((await f.request(path, "POST", { confirm: true })).status, 401);
  assert.equal(
    (await f.request(path, "POST", { confirm: true }, viewer)).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, "POST", { confirm: true }, admin, {
        "X-CSRF-Token": "invalid",
      })
    ).status,
    403,
  );
  const unsupported = await f.request(path, "POST", { confirm: true }, admin);
  assert.equal(unsupported.status, 503);
  assert.equal(unsupported.error.code, "RESTART_UNAVAILABLE");
  const config = await f.request(
    "/api/v1/system/config",
    "GET",
    undefined,
    admin,
  );
  assert.equal(config.data.runtime.restartAvailable, false);
});

test("重复重启请求只受理一次并只记一次审计；未确认不触发", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    restartPlatform: () => {
      calls++;
    },
  });
  const admin = await f.login("admin"),
    path = "/api/v1/system/restart";
  assert.equal((await f.request(path, "POST", {}, admin)).status, 400);
  assert.equal(calls, 0);
  const [first, second] = await Promise.all([
    f.request(path, "POST", { confirm: true }, admin),
    f.request(path, "POST", { confirm: true }, admin),
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(first.data.instanceId, second.data.instanceId);
  await until(() => calls === 1);
  const audit = await f.request("/api/v1/audit", "GET", undefined, admin);
  assert.equal(
    audit.data.items.filter((row) => row.action === "system.restart").length,
    1,
  );
});

test("实际重启重载已保存配置、保留登录和端口，实例更换后才确认完成，可再次重启", async (t) => {
  const f = await fixture(t, { managed: true });
  const admin = await f.login("admin");
  const before = await f.request("/api/health");
  const current = (
    await f.request("/api/v1/system/config", "GET", undefined, admin)
  ).data;
  const saved = await f.request(
    "/api/v1/system/config",
    "PUT",
    {
      revision: current.settings.revision,
      sip: { ...current.settings.values.sip, port: 15389 },
      media: {
        ...current.settings.values.media,
        secretConfigured: undefined,
        hookConfigured: undefined,
      },
    },
    admin,
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.data.restartRequired, true);
  const accepted = await f.request(
    "/api/v1/system/restart",
    "POST",
    { confirm: true },
    admin,
  );
  assert.equal(accepted.status, 202);
  assert.equal(accepted.data.instanceId, before.data.instanceId);
  const after = await until(async () => {
    const value = await f.request("/api/health");
    return (
      value.data.instanceId !== before.data.instanceId &&
      value.data.status === "ok" &&
      value
    );
  });
  const reloaded = await f.request(
    "/api/v1/system/config",
    "GET",
    undefined,
    admin,
  );
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.data.sip.port, 15389);
  assert.equal(reloaded.data.settings.restartRequired, false);
  assert.equal(reloaded.data.runtime.instanceId, after.data.instanceId);
  assert.equal(
    (await f.request("/api/v1/me", "GET", undefined, admin)).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "/api/v1/system/restart",
        "POST",
        { confirm: true },
        admin,
      )
    ).status,
    202,
  );
  await until(
    async () =>
      (await f.request("/api/health")).data.instanceId !==
      after.data.instanceId,
  );
  const audit = await f.request("/api/v1/audit", "GET", undefined, admin);
  assert.equal(
    audit.data.items.filter((row) => row.action === "system.restart").length,
    2,
  );
});

test("SIP端口被占用时仍保留配置页面，修正后可重启恢复", async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const config = loadConfig({
    SIP_ENABLED: "1",
    SIP_HOST: "127.0.0.1",
    SIP_PORT: String(occupied.address().port),
  });
  const f = await fixture(t, { managed: true, config });
  const admin = await f.login("admin");
  const before = await f.request("/api/health");
  assert.equal(before.data.status, "degraded");
  const current = (
    await f.request("/api/v1/system/config", "GET", undefined, admin)
  ).data.settings;
  const { secretConfigured, hookConfigured, ...media } = current.values.media;
  assert.equal(
    (
      await f.request(
        "/api/v1/system/config",
        "PUT",
        {
          revision: current.revision,
          sip: { ...current.values.sip, enabled: false },
          media,
        },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        "/api/v1/system/restart",
        "POST",
        { confirm: true },
        admin,
      )
    ).status,
    202,
  );
  await until(async () => {
    const health = await f.request("/api/health");
    return (
      health.data.instanceId !== before.data.instanceId &&
      health.data.status === "ok"
    );
  });
});

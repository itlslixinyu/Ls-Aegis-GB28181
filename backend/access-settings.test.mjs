import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccessSettings } from "./lib/access-settings.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
import { openStore, hashPassword } from "./lib/store.mjs";
function payload(store) {
  const view = store.view(),
    { secretConfigured, hookConfigured, ...media } = view.values.media;
  return {
    revision: view.revision,
    sip: { ...view.values.sip },
    media: { ...media, secret: "", hookToken: "" },
  };
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "aegis-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("接入配置原子保存、重启生效、空白保留凭据及显式清除，响应不回显密钥", async (t) => {
  const dir = await directory(t),
    file = join(dir, "access-config.json"),
    base = loadConfig({ SIP_ENABLED: "0" }),
    store = new AccessSettings(base, file);
  const value = payload(store);
  value.sip.port = 15061;
  value.sip.heartbeatTimeout = 90000;
  value.media.url = "http://127.0.0.1:9093/";
  value.media.secret = "secret-fixture-one";
  value.media.hookToken = "hook-fixture-one";
  const saved = store.save(value);
  assert.equal(saved.restartRequired, true);
  assert.equal(store.active.sip.port, 8116);
  assert.equal(store.active.media.configured, false);
  assert.equal(saved.values.media.url, "http://127.0.0.1:9093");
  const response = JSON.stringify(saved);
  assert.ok(!response.includes(value.media.secret));
  assert.ok(!response.includes(value.media.hookToken));
  assert.equal(saved.values.media.secretConfigured, true);
  assert.equal(saved.values.media.hookConfigured, true);
  store.save(payload(store));
  const restarted = new AccessSettings(base, file);
  assert.equal(restarted.active.sip.port, 15061);
  assert.equal(restarted.active.sip.heartbeatTimeout, 90000);
  assert.equal(restarted.active.media.secret, "secret-fixture-one");
  assert.equal(restarted.active.media.configured, true);
  assert.equal(restarted.view().restartRequired, false);
  const clear = payload(restarted);
  clear.media.clearSecret = true;
  clear.media.clearHookToken = true;
  assert.equal(restarted.save(clear).restartRequired, true);
  const next = new AccessSettings(base, file);
  assert.equal(next.active.media.secret, "");
  assert.equal(next.active.media.hookToken, "");
  assert.equal(next.active.media.configured, false);
});

test("非法SIP、地址、编号、媒体URL与路径不覆盖已保存配置；旧版本保存被拒绝", async (t) => {
  const dir = await directory(t),
    file = join(dir, "access-config.json"),
    store = new AccessSettings(loadConfig({}), file);
  store.save(payload(store));
  const original = await readFile(file, "utf8");
  for (const [section, key, v] of [
    ["sip", "enabled", "true"],
    ["sip", "port", 0],
    ["sip", "port", 65536],
    ["sip", "domain", 1234567890],
    ["sip", "serverId", "123"],
    ["sip", "host", "example.com"],
    ["sip", "advertisedHost", "0.0.0.0"],
    ["sip", "heartbeatTimeout", 29000],
    ["media", "url", "http://user:pass@localhost:9093"],
    ["media", "url", "http://localhost:9093/?secret=test"],
    ["media", "rtpHost", "bad"],
    ["media", "recordPath", "//host/{stream}/{date}/{file}"],
    ["media", "recordPath", "/../{stream}/{date}/{file}"],
    ["media", "secret", {}],
  ]) {
    const v2 = payload(store);
    v2[section][key] = v;
    assert.throws(() => store.save(v2));
    assert.equal(await readFile(file, "utf8"), original);
  }
  const first = payload(store);
  store.save(first);
  assert.throws(
    () => store.save(first),
    (e) => e.status === 409 && e.code === "CONFIG_CONFLICT",
  );
  const invalid = payload(store);
  invalid.media.clearSecret = true;
  invalid.media.secret = "cannot-set-and-clear";
  assert.throws(() => store.save(invalid), /同时替换和清除/);
});

test("损坏配置文件明确拒绝加载；未保存的环境配置仍可启动", async (t) => {
  const dir = await directory(t),
    file = join(dir, "access-config.json"),
    base = loadConfig({ SIP_PORT: "15062" });
  assert.equal(new AccessSettings(base, file).active.sip.port, 15062);
  await writeFile(file, "{bad-private-content");
  assert.throws(
    () => new AccessSettings(base, file),
    (e) =>
      e.code === "CONFIG_STORAGE_ERROR" &&
      !e.message.includes("private-content"),
  );
});

test("管理员配置HTTP保存、读取、审计与重启持久化；只读和无效CSRF不能保存", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-config-http-")),
    database = join(dir, "platform.db"),
    file = join(dir, "access-config.json"),
    { db } = openStore(database);
  for (const role of ["admin", "viewer"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      role,
      role,
      hashPassword("configuration-test-password"),
      role,
    );
  db.close();
  let app;
  const start = async () => {
    app = createServer({
      database,
      legacy: null,
      config: loadConfig({ SIP_ENABLED: "0" }),
    });
    await new Promise((r) => app.listen(0, "127.0.0.1", r));
    return "http://127.0.0.1:" + app.address().port;
  };
  let origin = await start();
  t.after(async () => {
    await new Promise((r, j) => app.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, method = "GET", value, session, headers = {}) {
    const r = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(10000),
    });
    return {
      status: r.status,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
      body: r.status === 204 ? null : await r.json(),
    };
  }
  async function login(role) {
    const r = await request("/auth/login", "POST", {
      username: role,
      password: "configuration-test-password",
    });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.body.data.csrf };
  }
  const admin = await login("admin"),
    viewer = await login("viewer");
  assert.equal(
    (await request("/system/config", "GET", undefined, viewer)).status,
    403,
  );
  assert.equal(
    (await request("/system/config", "PUT", {}, viewer)).status,
    403,
  );
  assert.equal((await request("/system/config")).status, 401);
  const current = await request("/system/config", "GET", undefined, admin),
    { secretConfigured, hookConfigured, ...media } =
      current.body.data.settings.values.media;
  const value = {
    revision: current.body.data.settings.revision,
    sip: { ...current.body.data.settings.values.sip, port: 15063 },
    media: {
      ...media,
      secret: "unique-private-test-secret",
      hookToken: "unique-private-test-hook",
    },
  };
  assert.equal(
    (
      await request("/system/config", "PUT", value, admin, {
        "X-CSRF-Token": "invalid",
      })
    ).status,
    403,
  );
  const saved = await request("/system/config", "PUT", value, admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.restartRequired, true);
  const text = JSON.stringify(saved.body);
  assert.ok(!text.includes(value.media.secret));
  assert.ok(!text.includes(value.media.hookToken));
  const running = await request("/system/config", "GET", undefined, admin);
  assert.equal(running.body.data.sip.port, 8116);
  assert.equal(running.body.data.settings.values.sip.port, 15063);
  assert.equal(
    (await request("/system/config", "PUT", value, admin)).status,
    409,
  );
  const audit = await request("/audit", "GET", undefined, admin);
  assert.ok(
    audit.body.data.items.some((r) => r.action === "system.config.update"),
  );
  assert.ok(!JSON.stringify(audit).includes(value.media.secret));
  await new Promise((r, j) => app.close((e) => (e ? j(e) : r())));
  origin = await start();
  const reloaded = await request("/system/config", "GET", undefined, admin);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.data.sip.port, 15063);
  assert.equal(reloaded.body.data.settings.restartRequired, false);
  assert.equal(reloaded.body.data.settings.values.media.secretConfigured, true);
  assert.ok(
    (await readFile(file, "utf8")).includes("unique-private-test-secret"),
  );
});

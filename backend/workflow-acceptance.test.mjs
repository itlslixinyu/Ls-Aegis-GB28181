import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
import { Access } from "./services/access.mjs";
import { SecurityEvents } from "./services/security-events.mjs";
const password = "workflow-test-password";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "aegis-workflow-"));
  const database = join(dir, "test.db");
  const { db } = openStore(database);
  for (const [id, role] of [
    ["admin", "admin"],
    ["reader", "viewer"],
  ])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      hashPassword(password),
      role,
    );
  const events = new SecurityEvents({
    db,
    access: new Access(db),
    sip: { state: "disabled" },
  });
  for (const n of [1, 2]) {
    db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
      "g" + n,
      "[测试] 分组" + n,
      "",
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,createdAt,groupId) VALUES(?,?,?,?,?)",
    ).run(
      "d" + n,
      "3402000000132000000" + n,
      "[测试] 设备" + n,
      new Date().toISOString(),
      "g" + n,
    );
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      "c" + n,
      "d" + n,
      "3402000000131000000" + n,
      "[测试] 通道" + n,
      "offline",
    );
    const device = db.prepare("SELECT * FROM devices WHERE id=?").get("d" + n);
    events.handle(device, {
      Notify: {
        CmdType: "Alarm",
        SN: String(n),
        DeviceID: device.deviceId,
        AlarmPriority: "2",
        AlarmMethod: "5",
        AlarmTime: new Date().toISOString(),
        AlarmDescription: "[测试] 流程告警",
      },
    });
  }
  db.prepare("INSERT INTO user_groups VALUES('reader','g1')").run();
  db.close();
  const app = createServer({
    database,
    legacy: null,
    config: loadConfig({ SIP_ENABLED: "0" }),
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r, j) => app.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = "http://127.0.0.1:" + app.address().port;
  async function request(path, method = "GET", value, session, extra = {}) {
    const response = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...extra,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(10000),
    });
    const json = response.status === 204 ? null : await response.json();
    return {
      status: response.status,
      data: json?.data,
      error: json?.error,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function login(username = "admin") {
    const r = await request("/auth/login", "POST", { username, password });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.data.csrf };
  }
  return { request, login };
}

test("登录限流仅累计失败：连续正常登录不被封锁，十次失败后仍拒绝重试", async (t) => {
  const { request } = await fixture(t);
  for (let i = 0; i < 12; i++)
    assert.equal(
      (await request("/auth/login", "POST", { username: "admin", password }))
        .status,
      200,
    );
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await request("/auth/login", "POST", {
          username: "admin",
          password: "wrong",
        })
      ).status,
      401,
    );
  assert.equal(
    (await request("/auth/login", "POST", { username: "admin", password }))
      .status,
    429,
  );
});

test("删除或非法资源输入返回可操作提示，不暴露数据库绑定错误", async (t) => {
  const { request, login } = await fixture(t),
    admin = await login();
  const missing = await request(
    "/cascade/platforms/missing/channels",
    "GET",
    undefined,
    admin,
  );
  assert.equal(missing.status, 404);
  assert.match(missing.error.message, /平台不存在/);
  for (const channelId of [undefined, null, 7, {}, []]) {
    const r = await request(
      "/recording-plans",
      "POST",
      {
        name: "校验计划",
        channelId,
        days: [1],
        startTime: "09:00",
        endTime: "10:00",
        enabled: false,
        retentionDays: 7,
        segmentSeconds: 900,
      },
      admin,
    );
    assert.equal(r.status, 400);
    assert.match(r.error.message, /有效通道/);
  }
});

test("实际业务顺序：分组、设备、录像计划、订阅、位置、告警与级联闭环及非法输入", async (t) => {
  const { request, login } = await fixture(t),
    admin = await login();
  async function call(path, method = "GET", body, expected = 200) {
    const r = await request(path, method, body, admin);
    assert.equal(r.status, expected, `${method} ${path}: ${r.error?.message}`);
    return r.data;
  }
  assert.equal((await call("/system/config")).sip.enabled, false);
  assert.equal(
    (await call("/media-nodes/local/check", "POST", {})).state,
    "not_configured",
  );
  for (const name of ["", " ", 5, "长".repeat(81)])
    await call("/groups", "POST", { name }, 400);
  const group = await call("/groups", "POST", { name: "[测试] 流程组" }, 201);
  await call("/groups", "POST", { name: "[测试] 流程组" }, 409);
  for (const body of [
    { name: "设备", deviceId: "123" },
    { name: " ", deviceId: "34020000001320000009" },
    { name: "设备", deviceId: 34020000001320000009 },
  ])
    await call("/devices", "POST", body, 400);
  const device = await call(
    "/devices",
    "POST",
    { name: "[测试] 新设备", deviceId: "34020000001320000009" },
    201,
  );
  await call(
    "/devices",
    "POST",
    { name: "重复", deviceId: device.deviceId },
    409,
  );
  await call(
    "/devices/" + device.id + "/credential",
    "PUT",
    { password: "short" },
    400,
  );
  await call(
    "/devices/" + device.id + "/credential",
    "PUT",
    { password: "device-test-password" },
    204,
  );
  assert.equal("sipHa1" in (await call("/devices/" + device.id)), false);
  await call(
    "/groups/" + group.id + "/devices",
    "PUT",
    { deviceIds: [device.id, "missing"] },
    404,
  );
  assert.equal((await call("/devices/" + device.id)).groupId, "default");
  await call(
    "/groups/" + group.id + "/devices",
    "PUT",
    { deviceIds: [device.id] },
    204,
  );
  await call("/groups/" + group.id, "DELETE", undefined, 409);
  await call("/devices/" + device.id + "/media-transport", "PUT", {
    transport: "TCP-PASSIVE",
  });
  await call(
    "/devices/" + device.id + "/media-transport",
    "PUT",
    { transport: "invalid" },
    400,
  );
  await call("/devices/" + device.id + "/catalog-sync", "POST", {}, 409);
  for (const body of [
    { longitude: 181, latitude: 0 },
    { longitude: 0, latitude: -91 },
    { longitude: "0", latitude: 0 },
    { longitude: null, latitude: 0 },
  ])
    await call("/devices/" + device.id + "/location", "PUT", body, 400);
  await call("/devices/" + device.id + "/location", "PUT", {
    longitude: 0,
    latitude: 0,
    address: "[测试] 零坐标",
  });
  assert.equal(
    (await call("/map")).items.find((d) => d.id === device.id).longitude,
    0,
  );
  await call("/devices/" + device.id + "/location", "DELETE", undefined, 204);
  for (const body of [
    { enabled: "true", expires: 60, interval: 5 },
    { enabled: true, expires: 29, interval: 5 },
    { enabled: true, expires: 60, interval: 61 },
  ])
    await call(
      "/devices/" + device.id + "/subscriptions/MobilePosition",
      "PUT",
      body,
      400,
    );
  await call(
    "/devices/" + device.id + "/subscriptions/MobilePosition",
    "PUT",
    { enabled: false, expires: 60, interval: 5 },
    202,
  );
  assert.equal(
    (await call("/subscriptions?q=" + device.deviceId)).items[0].enabled,
    0,
  );
  const plan = {
    name: "[测试] 计划",
    channelId: "c1",
    days: [1, 2],
    startTime: "09:00",
    endTime: "18:00",
    enabled: false,
    retentionDays: 7,
    segmentSeconds: 900,
  };
  for (const patch of [
    { days: [] },
    { days: [1, 1] },
    { startTime: "25:00" },
    { retentionDays: 0 },
    { retentionDays: 366 },
    { segmentSeconds: 59 },
    { enabled: "false" },
  ])
    await call("/recording-plans", "POST", { ...plan, ...patch }, 400);
  const saved = await call("/recording-plans", "POST", plan, 201);
  await call("/recording-plans/" + saved.id, "PUT", {
    ...plan,
    retentionDays: 8,
  });
  await call(
    "/recording-plans/" + saved.id + "/enabled",
    "PUT",
    { enabled: "false" },
    409,
  );
  await call(
    "/recording-plans/" + saved.id + "/enabled",
    "PUT",
    { enabled: false },
    204,
  );
  await call("/recording-plans/" + saved.id, "DELETE", undefined, 204);
  await call(
    "/record-queries",
    "POST",
    {
      channelId: "c1",
      start: "2026-11-02T00:00:00Z",
      end: "2026-11-01T00:00:00Z",
    },
    400,
  );
  await call(
    "/record-queries",
    "POST",
    {
      channelId: "c1",
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-03T00:00:00Z",
    },
    400,
  );
  await call("/live-sessions", "POST", { channelId: "c1" }, 409);
  await call("/recording-jobs", "POST", { recordId: "missing" }, 409);
  await call("/recording-jobs?kind=invalid", "GET", undefined, 400);
  const alarm = (await call("/alarms")).items[0];
  await call(
    "/alarms/" + alarm.id + "/actions",
    "POST",
    { action: "resolve", note: "越序", version: alarm.version },
    409,
  );
  const ack = await call("/alarms/" + alarm.id + "/actions", "POST", {
    action: "acknowledge",
    version: alarm.version,
  });
  await call(
    "/alarms/" + alarm.id + "/actions",
    "POST",
    { action: "resolve", note: " ", version: ack.version },
    409,
  );
  await call(
    "/alarms/" + alarm.id + "/actions",
    "POST",
    { action: "resolve", note: "已核实", version: alarm.version },
    409,
  );
  assert.equal(
    (
      await call("/alarms/" + alarm.id + "/actions", "POST", {
        action: "resolve",
        note: "[测试] 已核实",
        version: ack.version,
      })
    ).status,
    "resolved",
  );
  await call(
    "/alarms?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z",
    "GET",
    undefined,
    400,
  );
  await call("/devices/d1/positions?from=bad&to=bad", "GET", undefined, 400);
  const platform = {
    name: "[测试] 上级",
    serverId: "44010000002000000001",
    localId: "44010000002000000002",
    domain: "4401000000",
    host: "127.0.0.1",
    port: 15070,
    expires: 3600,
    heartbeat: 60,
    password: "platform-test-password",
    sipTransport: "UDP",
  };
  for (const patch of [
    { serverId: 123 },
    { localId: platform.serverId },
    { port: 0 },
    { host: "not-an-ip" },
    { heartbeat: 9 },
  ])
    await call("/cascade/platforms", "POST", { ...platform, ...patch }, 400);
  const p = await call("/cascade/platforms", "POST", platform, 201);
  await call(
    "/cascade/platforms/" + p.id + "/channels",
    "PUT",
    { items: [{ channelId: "c1", alias: "bad" }] },
    400,
  );
  await call("/cascade/platforms/" + p.id + "/channels", "PUT", {
    items: [{ channelId: "c1", alias: "44010000001310000001" }],
  });
  assert.equal(
    (await call("/cascade/platforms/" + p.id + "/channels")).items.length,
    1,
  );
  await call("/cascade/platforms/" + p.id + "/register", "POST", {}, 409);
  await call("/cascade/platforms/" + p.id, "DELETE", undefined, 204);
  assert.ok(
    (await call("/audit")).items.some((a) => a.action === "alarm.resolve"),
  );
  await call("/users/admin", "DELETE", undefined, 409);
  await call("/devices/" + device.id, "DELETE", undefined, 204);
  await call("/groups/" + group.id, "DELETE", undefined, 204);
});

test("只读和撤权：绕过页面直接访问所有管理接口仍被拒绝，资源读取不跨组", async (t) => {
  const { request, login } = await fixture(t),
    admin = await login(),
    viewer = await login("reader");
  for (const path of [
    "/system/config",
    "/users",
    "/audit",
    "/media-nodes",
    "/recording-plans",
    "/cascade/platforms",
    "/users/reader/groups",
  ])
    assert.equal(
      (await request(path, "GET", undefined, viewer)).status,
      403,
      path,
    );
  for (const [path, method] of [
    ["/users", "POST"],
    ["/users/admin", "DELETE"],
    ["/groups", "POST"],
    ["/groups/g1", "PUT"],
    ["/groups/g1/devices", "PUT"],
    ["/users/reader/groups", "PUT"],
    ["/devices", "POST"],
    ["/devices/d1", "PATCH"],
    ["/devices/d1", "DELETE"],
    ["/devices/d1/credential", "PUT"],
    ["/devices/d1/media-transport", "PUT"],
    ["/devices/d1/catalog-sync", "POST"],
    ["/devices/d1/location", "PUT"],
    ["/devices/d1/location", "DELETE"],
    ["/devices/d1/subscriptions/Alarm", "PUT"],
    ["/recording-plans", "POST"],
    ["/recording-plans/missing/enabled", "PUT"],
    ["/cascade/platforms", "POST"],
    ["/cascade/platforms/missing/channels", "PUT"],
    ["/channels/c1/ptz", "POST"],
    ["/media-nodes/local/check", "POST"],
  ])
    assert.equal(
      (await request(path, method, {}, viewer)).status,
      403,
      method + " " + path,
    );
  for (const path of [
    "/devices/d2",
    "/devices/d2/channels",
    "/devices/d2/position-targets",
    "/devices/d2/positions",
  ])
    assert.equal(
      (await request(path, "GET", undefined, viewer)).status,
      404,
      path,
    );
  for (const path of ["/devices", "/channels", "/map", "/alarms"]) {
    const r = await request(path, "GET", undefined, viewer);
    assert.equal(r.status, 200);
    assert.equal(r.data.items.length, 1, path);
  }
  const denied = await request("/groups", "POST", { name: "不应写入" }, admin, {
    "X-CSRF-Token": "invalid",
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.error.code, "CSRF_REJECTED");
  assert.equal((await request("/users", "GET")).status, 401);
  assert.equal(
    (await request("/users/reader/groups", "PUT", { groupIds: [] }, admin))
      .status,
    204,
  );
  for (const path of ["/devices", "/channels", "/map", "/alarms"])
    assert.equal(
      (await request(path, "GET", undefined, viewer)).data.items.length,
      0,
      path,
    );
  assert.equal(
    (await request("/devices/d1", "GET", undefined, viewer)).status,
    404,
  );
  assert.equal((await request("/auth/logout", "POST", {}, viewer)).status, 204);
  assert.equal((await request("/me", "GET", undefined, viewer)).status, 401);
});

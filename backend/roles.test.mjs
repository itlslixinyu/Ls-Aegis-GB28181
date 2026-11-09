import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
import { authorization } from "./services/authorization.mjs";
import { normalizePermissions } from "./lib/permission-catalog.mjs";
async function fixture(t, sipGateway = null) {
  const dir = await mkdtemp(join(tmpdir(), "aegis-roles-")),
    database = join(dir, "platform.db"),
    { db } = openStore(database);
  for (const [id, role] of [
    ["admin", "admin"],
    ["admin2", "admin"],
    ["viewer", "viewer"],
  ])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      hashPassword("roles-test-password"),
      role,
    );
  for (const id of ["A", "B"]) {
    db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
      id,
      "区域" + id,
      "",
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,groupId,createdAt) VALUES(?,?,?,?,?)",
    ).run(
      "device-" + id,
      "3402000000132000000" + (id === "A" ? "1" : "2"),
      "设备" + id,
      id,
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      "channel-" + id,
      "device-" + id,
      "3402000000131000000" + (id === "A" ? "1" : "2"),
      "通道" + id,
      "online",
    );
  }
  const media = {
    status: { state: "online" },
    config: {},
    release: async () => {},
    openRecording: async (_stream, _file, _range, signal) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          signal.addEventListener(
            "abort",
            () => controller.error(Error("revoked")),
            { once: true },
          );
        },
      });
      return new Response(body, { headers: { "Content-Type": "video/mp4" } });
    },
  };
  const app = createServer({
    database,
    legacy: null,
    config: loadConfig({ SIP_ENABLED: "0" }),
    mediaAdapter: media,
    sipGateway,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + app.address().port;
  t.after(async () => {
    await new Promise((r) => app.close(r));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function call(path, method = "GET", value, session, extra = {}) {
    const res = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...extra,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(8000),
    });
    return {
      status: res.status,
      ...(res.status === 204 ? {} : await res.json()),
    };
  }
  async function login(username) {
    const res = await fetch(origin + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "roles-test-password" }),
    });
    const body = await res.json();
    return {
      cookie: res.headers.get("set-cookie").split(";")[0],
      csrf: body.data.csrf,
    };
  }
  const admin = await login("admin"),
    viewer = await login("viewer");
  async function role(permissions = ["live.preview"], name = "测试角色") {
    const res = await call("/roles", "POST", { name, permissions }, admin);
    assert.equal(res.status, 201);
    return res.data.id;
  }
  async function assign(
    roleId,
    scopeMode = "groups",
    groupIds = ["A"],
    user = "viewer",
  ) {
    const current = await call(
      "/users/" + user + "/authorization",
      "GET",
      undefined,
      admin,
    );
    return call(
      "/users/" + user + "/authorization",
      "PUT",
      { roleId, scopeMode, groupIds, version: current.data.version },
      admin,
    );
  }
  return { db, app, origin, call, admin, viewer, role, assign };
}
test("权限依赖补齐，拒绝未知与平台管理权限", () => {
  assert.deepEqual(normalizePermissions(["ptz.control"]), [
    "devices.view",
    "live.preview",
    "ptz.control",
  ]);
  for (const list of [["system.restart"], ["users.manage"], ["bad"], null])
    assert.throws(() => normalizePermissions(list));
});
test("内置角色不可改删，角色名唯一、版本冲突、在用角色不可删除", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call("/roles", "GET", undefined, f.viewer)).status,
    403,
  );
  assert.equal(
    (
      await f.call("/roles", "POST", { name: "x", permissions: [] }, f.admin, {
        "X-CSRF-Token": "bad",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.call("/roles/admin", "DELETE", undefined, f.admin)).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        "/roles/viewer",
        "PUT",
        { name: "改名", permissions: [], version: 0 },
        f.admin,
      )
    ).status,
    409,
  );
  const id = await f.role();
  assert.equal(
    (
      await f.call(
        "/roles",
        "POST",
        { name: "测试角色", permissions: [] },
        f.admin,
      )
    ).status,
    409,
  );
  assert.equal((await f.assign(id)).status, 200);
  assert.equal(
    (await f.call("/roles/" + id, "DELETE", undefined, f.admin)).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        "/roles/" + id,
        "PUT",
        { name: "新版", permissions: ["devices.view"], version: 0 },
        f.admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/roles/" + id,
        "PUT",
        { name: "过期覆盖", permissions: [], version: 0 },
        f.admin,
      )
    ).status,
    409,
  );
  await f.assign("viewer");
  assert.equal(
    (await f.call("/roles/" + id, "DELETE", undefined, f.admin)).status,
    204,
  );
});
test("功能和分组双重校验：同组可读、越组隐藏、未授权操作与直接接口被拒绝", async (t) => {
  const f = await fixture(t),
    id = await f.role(["map.manage"]);
  await f.assign(id);
  const me = (await f.call("/me", "GET", undefined, f.viewer)).data.user;
  assert.equal(me.roleName, "测试角色");
  assert.equal(me.role, "viewer");
  assert.ok(me.permissions.includes("map.view"));
  assert.ok(!me.permissions.includes("live.preview"));
  const devices = await f.call("/devices", "GET", undefined, f.viewer);
  assert.deepEqual(
    devices.data.items.map((d) => d.id),
    ["device-A"],
  );
  assert.equal(
    (await f.call("/devices/device-B/channels", "GET", undefined, f.viewer))
      .status,
    404,
  );
  assert.equal(
    (
      await f.call(
        "/live-sessions",
        "POST",
        { channelId: "channel-A" },
        f.viewer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/channels/channel-A/ptz",
        "POST",
        { action: "left" },
        f.viewer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/devices/device-B/location",
        "PUT",
        { longitude: 110, latitude: 30 },
        f.viewer,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        "/devices/device-A/location",
        "PUT",
        { longitude: 110, latitude: 30 },
        f.viewer,
      )
    ).status,
    200,
  );
  for (const path of ["/users", "/system/config", "/audit", "/recording-plans"])
    assert.equal((await f.call(path, "GET", undefined, f.viewer)).status, 403);
});
test("全部设备范围包含以后新增设备，授权旧版本不能覆盖；空角色仅能访问个人中心", async (t) => {
  const f = await fixture(t),
    id = await f.role(["devices.view"]);
  await f.assign(id, "all", []);
  assert.equal(
    (await f.call("/devices", "GET", undefined, f.viewer)).data.items.length,
    2,
  );
  f.db
    .prepare(
      "INSERT INTO devices(id,deviceId,name,groupId,createdAt) VALUES(?,?,?,?,?)",
    )
    .run(
      "device-C",
      "34020000001320000003",
      "设备C",
      "B",
      new Date().toISOString(),
    );
  assert.equal(
    (await f.call("/devices", "GET", undefined, f.viewer)).data.items.length,
    3,
  );
  const stale = await f.call(
    "/users/viewer/authorization",
    "PUT",
    { roleId: id, scopeMode: "groups", groupIds: [], version: 0 },
    f.admin,
  );
  assert.equal(stale.status, 409);
  const empty = await f.role([], "空角色");
  await f.assign(empty, "all", []);
  assert.equal((await f.call("/me", "GET", undefined, f.viewer)).status, 200);
  assert.equal(
    (await f.call("/devices", "GET", undefined, f.viewer)).status,
    403,
  );
});
test("管理员保护：禁止修改自己，必须保留最后一个管理员", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.assign("viewer", "groups", [], "admin")).data,
    undefined,
  );
  const own = await f.assign("viewer", "groups", [], "admin");
  assert.equal(own.error.code, "SELF_AUTHORIZATION");
  assert.equal((await f.assign("viewer", "groups", [], "admin2")).status, 200);
  const last = await f.assign("viewer", "groups", [], "admin");
  assert.equal(last.error.code, "LAST_ADMIN");
  assert.equal(authorization(f.db, "admin").roleId, "admin");
});
test("角色撤权立即回收目标观看者，不影响其他账号观看；移组立即改变数据范围", async (t) => {
  const f = await fixture(t),
    id = await f.role(["live.preview"]);
  await f.assign(id);
  f.db
    .prepare(
      "INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt,kind) VALUES('live-test','channel-A','device-A','stream','ready',?,'live')",
    )
    .run(new Date().toISOString());
  for (const [view, user] of [
    ["view-test", "viewer"],
    ["view-admin", "admin"],
  ])
    f.db
      .prepare("INSERT INTO viewers VALUES(?,?,?,?)")
      .run(view, "live-test", user, Date.now() + 60000);
  assert.equal(
    (
      await f.call(
        "/live-sessions/live-test?viewerId=view-test",
        "GET",
        undefined,
        f.viewer,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/roles/" + id,
        "PUT",
        { name: "撤回预览", permissions: ["devices.view"], version: 0 },
        f.admin,
      )
    ).status,
    200,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM viewers WHERE id='view-test'").get()
      .n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM viewers WHERE id='view-admin'")
      .get().n,
    1,
  );
  assert.equal(
    (
      await f.call(
        "/live-sessions/live-test?viewerId=view-test",
        "GET",
        undefined,
        f.viewer,
      )
    ).status,
    403,
  );
  await f.assign(id, "groups", ["B"]);
  assert.deepEqual(
    (await f.call("/devices", "GET", undefined, f.viewer)).data.items.map(
      (d) => d.id,
    ),
    ["device-B"],
  );
});
test("下载撤权中断正在传输的文件；计划录像只可在设备范围内查看，不能被普通角色结束", async (t) => {
  const f = await fixture(t),
    id = await f.role(["recording.download"]);
  await f.assign(id);
  f.db
    .prepare(
      "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,createdAt,streamId) VALUES('job','admin','channel-A','scheduled','succeeded',?,?,?)",
    )
    .run(Date.now() + 10000, new Date().toISOString(), "record-stream");
  f.db
    .prepare(
      "INSERT INTO recording_files VALUES('file','job','2026-11-05','segment.mp4')",
    )
    .run();
  assert.equal(
    (await f.call("/recording-jobs?kind=scheduled", "GET", undefined, f.viewer))
      .data.items.length,
    1,
  );
  assert.equal(
    (await f.call("/recording-jobs/job/cancel", "POST", {}, f.viewer)).status,
    403,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    f.origin + "/api/v1/recording-jobs/job/files/file",
    { headers: { Cookie: f.viewer.cookie }, signal: controller.signal },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.length, 4);
  await f.call(
    "/roles/" + id,
    "PUT",
    { name: "仅回放", permissions: ["recording.view"], version: 0 },
    f.admin,
  );
  await assert.rejects(reader.read());
  assert.equal(
    (await f.call("/recording-jobs/job/files/file", "GET", undefined, f.viewer))
      .status,
    403,
  );
  await f.assign(id, "groups", ["B"]);
  assert.equal(
    (await f.call("/recording-jobs/job", "GET", undefined, f.viewer)).status,
    404,
  );
});

test("权限通知仅限登录同源会话，授权与设备移组立即通知，过期连接退出", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/me/authorization-events")).status, 401);
  assert.equal(
    (
      await f.call("/me/authorization-events", "GET", undefined, f.viewer, {
        Origin: "http://other.invalid",
      })
    ).status,
    403,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(f.origin + "/api/v1/me/authorization-events", {
    headers: { Cookie: f.viewer.cookie },
    signal: controller.signal,
  });
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  const reader = response.body.getReader();
  const next = async () => {
    const result = await Promise.race([
      reader.read(),
      new Promise((_r, j) => {
        const timer = setTimeout(() => j(Error("notification timeout")), 2000);
        timer.unref();
      }),
    ]);
    return new TextDecoder().decode(result.value);
  };
  assert.match(await next(), /event: authorization/);
  const role = await f.role(["devices.view"]);
  await f.assign(role);
  assert.match(await next(), /event: authorization/);
  await f.call(
    "/groups/B/devices",
    "PUT",
    { deviceIds: ["device-A"] },
    f.admin,
  );
  assert.match(await next(), /event: authorization/);
  assert.equal(
    (await f.call("/devices", "GET", undefined, f.viewer)).data.items.length,
    0,
  );
  await f.call(
    "/roles/" + role,
    "PUT",
    { name: "更新角色", permissions: ["map.view"], version: 0 },
    f.admin,
  );
  assert.match(await next(), /event: authorization/);
  f.db.prepare("UPDATE sessions SET expiresAt=0 WHERE userId=?").run("viewer");
  assert.match(await next(), /event: expired/);
  assert.equal((await reader.read()).done, true);
});

test("设备移出授权分组立即发送云台停止，其他账号的合法动作保持", async (t) => {
  const sent = [];
  const sip = {
    state: "listening",
    seq: 1,
    dialogs: {},
    config: { heartbeatTimeout: 180000 },
    requests: {
      async request(v) {
        sent.push(v);
        return { status: 200 };
      },
    },
    async close() {},
  };
  const f = await fixture(t, sip);
  f.db
    .prepare(
      "UPDATE devices SET status='online',registeredUntil=?,lastHeartbeat=?,remoteAddress='127.0.0.1',remotePort=19999",
    )
    .run(Date.now() + 60000, Date.now());
  const role = await f.role(["ptz.control"]);
  await f.assign(role);
  assert.equal(
    (
      await f.call(
        "/channels/channel-A/ptz",
        "POST",
        { action: "left", duration: 3000, token: "test-move-a" },
        f.viewer,
      )
    ).status,
    202,
  );
  assert.equal(
    (
      await f.call(
        "/channels/channel-B/ptz",
        "POST",
        { action: "right", duration: 3000, token: "test-admin-b" },
        f.admin,
      )
    ).status,
    202,
  );
  await f.call(
    "/groups/B/devices",
    "PUT",
    { deviceIds: ["device-A"] },
    f.admin,
  );
  const stops = sent.filter((v) => v.body.includes("<PTZCmd>A50F0100000000B5"));
  assert.equal(stops.length, 1);
  assert.match(stops[0].body, /<DeviceID>34020000001310000001/);
  assert.equal(
    (
      await f.call(
        "/channels/channel-A/ptz",
        "POST",
        { action: "left" },
        f.viewer,
      )
    ).status,
    404,
  );
});

test("慢请求读取期间撤回角色、移组或注销，不能继续修改设备位置", async (t) => {
  const f = await fixture(t),
    role = await f.role(["map.manage"]);
  for (const kind of ["role", "group", "session"]) {
    f.db.prepare("UPDATE devices SET groupId='A' WHERE id='device-A'").run();
    f.db
      .prepare("UPDATE platform_roles SET permissions=? WHERE id=?")
      .run(JSON.stringify(normalizePermissions(["map.manage"])), role);
    await f.assign(role);
    const pending = new Promise((resolve, reject) => {
      const req = httpRequest(
        f.origin + "/api/v1/devices/device-A/location",
        {
          method: "PUT",
          headers: {
            Cookie: f.viewer.cookie,
            "X-CSRF-Token": f.viewer.csrf,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode, value: JSON.parse(body) }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(Error("slow request timeout")));
      req.write('{"longitude":');
      setTimeout(async () => {
        try {
          if (kind === "role")
            await f.call(
              "/roles/" + role,
              "PUT",
              {
                name: "已撤回",
                permissions: ["map.view"],
                version: f.db
                  .prepare("SELECT version FROM platform_roles WHERE id=?")
                  .get(role).version,
              },
              f.admin,
            );
          if (kind === "group")
            await f.call(
              "/groups/B/devices",
              "PUT",
              { deviceIds: ["device-A"] },
              f.admin,
            );
          if (kind === "session")
            await f.call("/auth/logout", "POST", {}, f.viewer);
          req.end('114.3,"latitude":30.6}');
        } catch (e) {
          req.destroy(e);
        }
      }, 50);
    });
    const result = await pending;
    assert.equal(
      result.status,
      kind === "role" ? 403 : kind === "group" ? 404 : 401,
      kind,
    );
    assert.ok(result.value.requestId);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM device_locations").get().n,
      0,
    );
  }
});

test("默认分组允许管理员编辑名称和说明，保持设备授权及默认属性，仍禁止删除", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare("UPDATE devices SET groupId='default' WHERE id='device-A'")
    .run();
  await f.assign("viewer", "groups", ["default"]);
  const before = f.db
    .prepare("SELECT * FROM user_groups ORDER BY userId,groupId")
    .all();
  assert.equal(
    (
      await f.call(
        "/groups/default",
        "PUT",
        { name: "总部默认设备", description: "新接入设备归档" },
        f.admin,
      )
    ).status,
    204,
  );
  const group = (
    await f.call("/groups", "GET", undefined, f.viewer)
  ).data.items.find((g) => g.id === "default");
  assert.equal(group.name, "总部默认设备");
  assert.equal(group.description, "新接入设备归档");
  assert.equal(
    f.db.prepare("SELECT groupId FROM devices WHERE id='device-A'").get()
      .groupId,
    "default",
  );
  assert.deepEqual(
    f.db.prepare("SELECT * FROM user_groups ORDER BY userId,groupId").all(),
    before,
  );
  assert.equal(
    (await f.call("/devices", "GET", undefined, f.viewer)).data.items[0]
      .groupName,
    "总部默认设备",
  );
  assert.equal(
    (await f.call("/groups/default", "PUT", { name: "无权修改" }, f.viewer))
      .status,
    403,
  );
  assert.equal(
    (await f.call("/groups/default", "PUT", { name: "   " }, f.admin)).status,
    400,
  );
  assert.equal(
    (await f.call("/groups/default", "PUT", { name: "区域A" }, f.admin)).status,
    409,
  );
  assert.equal(
    (await f.call("/groups/default", "DELETE", undefined, f.admin)).status,
    409,
  );
  f.db.prepare("UPDATE devices SET groupId='A' WHERE id='device-A'").run();
  await f.assign("viewer", "groups", []);
  assert.equal(
    (await f.call("/groups/default", "DELETE", undefined, f.admin)).status,
    409,
  );
  assert.equal(
    f.db.prepare("SELECT name FROM device_groups WHERE id='default'").get()
      .name,
    "总部默认设备",
  );
});

test("分组授权版本冲突不覆盖新范围，重新读取后可提交", async (t) => {
  const f = await fixture(t);
  await f.assign("viewer", "groups", ["A"]);
  const first = (
    await f.call("/users/viewer/groups", "GET", undefined, f.admin)
  ).data;
  assert.ok(Number.isInteger(first.version));
  assert.equal(
    (
      await f.call(
        "/users/viewer/groups",
        "PUT",
        { groupIds: ["B"], version: first.version },
        f.admin,
      )
    ).status,
    204,
  );
  const stale = await f.call(
    "/users/viewer/groups",
    "PUT",
    { groupIds: ["A"], version: first.version },
    f.admin,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, "AUTHORIZATION_CONFLICT");
  const current = (
    await f.call("/users/viewer/groups", "GET", undefined, f.admin)
  ).data;
  assert.deepEqual(current.groupIds, ["B"]);
  assert.equal(
    (
      await f.call(
        "/users/viewer/groups",
        "PUT",
        { groupIds: [], version: current.version },
        f.admin,
      )
    ).status,
    204,
  );
  assert.equal(
    (await f.call("/devices", "GET", undefined, f.viewer)).data.items.length,
    0,
  );
});

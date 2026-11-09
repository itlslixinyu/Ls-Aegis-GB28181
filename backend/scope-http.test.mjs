import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
test("HTTP分组隔离覆盖列表/统计/地图/告警/播放/历史文件，撤权中断连接而不误停其他观看者", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl-scope-")),
    database = join(dir, "test.db"),
    { db } = openStore(database),
    now = Date.now();
  for (const id of ["admin", "va", "vb"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      hashPassword("test-password-123"),
      id === "admin" ? "admin" : "viewer",
    );
  for (const id of ["ga", "gb"])
    db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
      id,
      id,
      "测试分组",
      new Date(now).toISOString(),
    );
  for (const [id, g, code] of [
    ["da", "ga", "34020000001320000001"],
    ["db", "gb", "34020000001320000002"],
  ]) {
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat,remoteAddress,remotePort,groupId) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      code,
      id,
      "online",
      new Date(now).toISOString(),
      now + 3600000,
      now,
      "127.0.0.1",
      15060,
      g,
    );
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      "c" + id,
      id,
      code.replace("132", "131"),
      id + "通道",
      "online",
    );
  }
  db.prepare("INSERT INTO user_groups VALUES(?,?)").run("va", "ga");
  db.prepare("INSERT INTO user_groups VALUES(?,?)").run("vb", "gb");
  for (const [id, c] of [
    ["ja", "cda"],
    ["jb", "cdb"],
  ]) {
    db.prepare(
      "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      id,
      "va",
      c,
      "download",
      "succeeded",
      now,
      "gl_" + id,
      new Date(now).toISOString(),
    );
    db.prepare("INSERT INTO recording_files VALUES(?,?,?,?)").run(
      "f" + id,
      id,
      "2026-11-01",
      "test.mp4",
    );
  }
  const sourceA = db.prepare("SELECT * FROM devices WHERE id='da'").get(),
    sourceB = db.prepare("SELECT * FROM devices WHERE id='db'").get();
  db.close();
  const config = loadConfig({
      SIP_ENABLED: "1",
      MEDIA_URL: "http://127.0.0.1:9092",
      MEDIA_SECRET: "test",
    }),
    streams = new Set();
  let downloadSignal;
  const sip = {
    state: "listening",
    config: config.sip,
    seq: 1,
    async start() {},
    close() {},
    requests: {
      async request() {
        return { status: 200 };
      },
    },
    dialogs: {
      async invite() {
        return { id: "test-dialog" };
      },
      async end() {},
    },
  };
  const media = {
    status: { state: "online" },
    async allocate(id) {
      streams.add(id);
      return { port: 40000 };
    },
    async release(id) {
      streams.delete(id);
    },
    async streams() {
      return [...streams].map((stream) => ({
        app: "rtp",
        schema: "rtmp",
        stream,
      }));
    },
    async openRecording(id, file, range, signal) {
      downloadSignal = signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
          },
        }),
        { headers: { "Content-Type": "video/mp4" } },
      );
    },
  };
  const server = createServer({
    database,
    legacy: null,
    config,
    sipGateway: sip,
    mediaAdapter: media,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function login(username) {
    const r = await fetch(origin + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "test-password-123" }),
    });
    return {
      cookie: r.headers.get("set-cookie").split(";")[0],
      csrf: (await r.json()).data.csrf,
    };
  }
  async function call(path, user, method = "GET", value) {
    const r = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        Cookie: user.cookie,
        "X-CSRF-Token": user.csrf,
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return {
      status: r.status,
      data: r.status === 204 ? null : (await r.json()).data,
    };
  }
  let reader;
  try {
    const a = await login("admin"),
      va = await login("va"),
      vb = await login("vb");
    assert.equal((await call("/groups", va)).data.items.length, 1);
    assert.equal(
      (await call("/groups", va, "POST", { name: "不允许创建" })).status,
      403,
    );
    const groupCreated = await call("/groups", a, "POST", {
      name: "HTTP空分组",
      description: "测试管理",
    });
    assert.equal(groupCreated.status, 201);
    const groupId = groupCreated.data.id;
    assert.equal(
      (await call("/groups", a, "POST", { name: "HTTP空分组" })).status,
      409,
    );
    assert.equal(
      (
        await call("/groups/" + groupId, a, "PUT", {
          name: "HTTP新名称",
          description: "修改说明",
        })
      ).status,
      204,
    );
    assert.equal(
      (await call("/users/va/groups", a, "PUT", { groupIds: ["ga", groupId] }))
        .status,
      204,
    );
    assert.equal((await call("/groups/" + groupId, a, "DELETE")).status, 409);
    await call("/users/va/groups", a, "PUT", { groupIds: ["ga"] });
    assert.equal((await call("/groups/" + groupId, a, "DELETE")).status, 204);
    assert.equal((await call("/devices", va)).data.total, 1);
    assert.equal((await call("/overview", va)).data.devices, 1);
    assert.equal((await call("/channels?q=3402", va)).data.items.length, 1);
    assert.equal((await call("/devices/db", va)).status, 404);
    assert.equal((await call("/devices/db/channels", va)).status, 404);
    assert.equal(
      (
        await call("/record-queries", va, "POST", {
          channelId: "cdb",
          start: "2026-11-01T00:00:00Z",
          end: "2026-11-01T01:00:00Z",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/live-sessions", va, "POST", { channelId: "cdb" })).status,
      409,
    );
    assert.equal((await call("/recording-jobs", va)).data.items.length, 1);
    assert.equal((await call("/recording-jobs/jb/files/fjb", va)).status, 404);
    const event = (device) => ({
      Notify: {
        CmdType: "Alarm",
        SN: "1",
        DeviceID: device.deviceId,
        AlarmPriority: "1",
        AlarmMethod: "5",
        AlarmTime: "2026-11-01T08:00:00",
        AlarmDescription: "分组告警测试",
      },
    });
    sip.onDeviceMessage(sourceA, event(sourceA));
    sip.onDeviceMessage(sourceB, event(sourceB));
    const list = (await call("/alarms", va)).data;
    assert.equal(list.total, 1);
    assert.equal(list.stats.total, 1);
    assert.equal((await call("/alarms", a)).data.total, 2);
    const alarm = list.items[0];
    assert.equal((await call("/alarms/" + alarm.id, vb)).status, 404);
    assert.equal(
      (
        await call("/alarms/" + alarm.id + "/actions", va, "POST", {
          action: "acknowledge",
          version: 1,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/alarms/" + alarm.id + "/actions", a, "POST", {
          action: "acknowledge",
          version: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/alarms/" + alarm.id + "/actions", a, "POST", {
          action: "acknowledge",
          version: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call("/alarms/" + alarm.id + "/actions", a, "POST", {
          action: "resolve",
          version: 2,
          note: "现场核查完成",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/devices/da/location", a, "PUT", {
          longitude: 116.4,
          latitude: 39.9,
          address: "测试点位",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/devices/da/location", va, "PUT", {
          longitude: 1,
          latitude: 2,
        })
      ).status,
      403,
    );
    const map = (await call("/map", va)).data;
    assert.equal(map.items.length, 1);
    assert.equal(map.items[0].longitude, 116.4);
    assert.equal(map.tileConfigured, false);
    assert.equal(
      (await call("/users/va/groups", va, "PUT", { groupIds: ["gb"] })).status,
      403,
    );
    assert.equal(
      (
        await call("/groups/gb/devices", a, "PUT", {
          deviceIds: ["da", "missing"],
        })
      ).status,
      404,
    );
    assert.equal((await call("/devices/da", a)).data.groupId, "ga");
    const v1 = (await call("/live-sessions", va, "POST", { channelId: "cda" }))
        .data,
      v2 = (await call("/live-sessions", a, "POST", { channelId: "cda" })).data;
    assert.equal(v1.sessionId, v2.sessionId);
    const download = await fetch(
      origin + "/api/v1/recording-jobs/ja/files/fja",
      { headers: { Cookie: va.cookie } },
    );
    reader = download.body.getReader();
    await reader.read();
    assert.ok(downloadSignal && !downloadSignal.aborted);
    assert.equal(
      (await call("/users/va/groups", a, "PUT", { groupIds: [] })).status,
      204,
    );
    assert.equal(downloadSignal.aborted, true);
    assert.equal(
      (await call(`/live-sessions/${v1.sessionId}?viewerId=${v1.viewerId}`, va))
        .status,
      403,
    );
    assert.equal(
      (await call(`/live-sessions/${v2.sessionId}?viewerId=${v2.viewerId}`, a))
        .data.state,
      "ready",
    );
    assert.equal((await call("/devices", va)).data.total, 0);
    assert.equal((await call("/map", va)).data.items.length, 0);
    assert.equal((await call("/alarms/" + alarm.id, va)).status, 404);
    assert.equal((await call("/recording-jobs/ja/files/fja", va)).status, 404);
    await reader.cancel().catch(() => {});
    await call("/users/va/groups", a, "PUT", { groupIds: ["ga"] });
    const vaOther = await login("va");
    const firstTransfer = await fetch(
        origin + "/api/v1/recording-jobs/ja/files/fja",
        { headers: { Cookie: va.cookie } },
      ),
      firstReader = firstTransfer.body.getReader();
    await firstReader.read();
    const firstSignal = downloadSignal;
    const otherTransfer = await fetch(
        origin + "/api/v1/recording-jobs/ja/files/fja",
        { headers: { Cookie: vaOther.cookie } },
      ),
      otherReader = otherTransfer.body.getReader();
    await otherReader.read();
    const otherSignal = downloadSignal;
    assert.equal((await call("/auth/logout", va, "POST", {})).status, 204);
    assert.equal(firstSignal.aborted, true, "退出应终止本登录的MP4传输");
    assert.equal(otherSignal.aborted, false, "保留同账号另一登录的传输");
    await firstReader.cancel().catch(() => {});
    await otherReader.cancel().catch(() => {});
    assert.equal(
      (await call("/groups/gb/devices", a, "PUT", { deviceIds: ["da"] }))
        .status,
      204,
    );
    assert.equal((await call("/devices", vb)).data.total, 2);
    assert.equal((await call("/alarms", vb)).data.total, 2);
    await call(
      `/live-sessions/${v2.sessionId}/viewers/${v2.viewerId}`,
      a,
      "DELETE",
    );
  } finally {
    await reader?.cancel().catch(() => {});
    await new Promise((r) => server.close(r));
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
test("HTTP闭环：录像查询到回放控制、云台权限和级联配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl-features-")),
    database = join(dir, "test.db");
  const { db } = openStore(database);
  for (const role of ["admin", "viewer"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      role,
      role,
      hashPassword("test-password-123"),
      role,
    );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat,remoteAddress,remotePort) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "d",
    "34020000001320000001",
    "设备",
    "online",
    new Date().toISOString(),
    Date.now() + 3600000,
    Date.now(),
    "127.0.0.1",
    15060,
  );
  db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
    "c",
    "d",
    "34020000001310000001",
    "通道",
    "online",
  );
  db.prepare(
    "INSERT INTO user_groups SELECT id,'default' FROM users WHERE role='viewer'",
  ).run();
  db.close();
  const config = loadConfig({
      SIP_ENABLED: "1",
      MEDIA_URL: "http://127.0.0.1:9092",
      MEDIA_SECRET: "test",
    }),
    requests = [],
    invites = [],
    controls = [];
  let stream;
  const sip = {
    seq: 1,
    state: "listening",
    config: config.sip,
    requests: {
      async request(value) {
        requests.push(value);
        return { status: 200 };
      },
    },
    dialogs: {
      async invite(...args) {
        invites.push(args);
        return { id: "dialog" };
      },
      async end() {},
      async control(...args) {
        controls.push(args);
      },
    },
    close() {},
  };
  const media = {
    status: { state: "online" },
    async allocate(id) {
      stream = id;
      return { port: 40000 };
    },
    async streams() {
      return [{ app: "rtp", schema: "rtmp", stream }];
    },
    async release() {},
    async setPaused() {},
  };
  const server = createServer({
    database,
    legacy: null,
    config,
    sipGateway: sip,
    mediaAdapter: media,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function login(username) {
    const r = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "test-password-123" }),
    });
    const data = (await r.json()).data;
    return {
      cookie: r.headers.get("set-cookie").split(";")[0],
      csrf: data.csrf,
    };
  }
  async function call(path, user, method = "GET", data) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: user.cookie,
        "X-CSRF-Token": user.csrf,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  try {
    const admin = await login("admin"),
      viewer = await login("viewer");
    assert.equal(
      (await call("/channels/c/ptz", viewer, "POST", { action: "left" }))
        .status,
      403,
    );
    const ptz = await call("/channels/c/ptz", admin, "POST", {
      action: "right",
      token: "http-ptz-1",
    });
    assert.equal(ptz.status, 202);
    assert.ok(ptz.body.data.commandId);
    await call("/channels/c/ptz", admin, "POST", {
      action: "stop",
      token: "http-ptz-1",
    });
    const query = await call("/record-queries", viewer, "POST", {
      channelId: "c",
      start: "2026-10-31T00:00:00Z",
      end: "2026-10-31T01:00:00Z",
    });
    assert.equal(query.status, 202);
    const sn = requests
      .find((r) => r.body.includes("RecordInfo"))
      .body.match(/<SN>(\d+)<\/SN>/)[1];
    sip.onDeviceMessage(
      { id: "d" },
      {
        Response: {
          CmdType: "RecordInfo",
          SN: sn,
          DeviceID: "34020000001310000001",
          SumNum: "1",
          RecordList: {
            Item: {
              DeviceID: "34020000001310000001",
              Name: "录像",
              StartTime: "2026-10-31T08:00:00",
              EndTime: "2026-10-31T09:00:00",
              FilePath: "/test",
              Type: "time",
            },
          },
        },
      },
    );
    const result = await call(
      "/record-queries/" + query.body.data.taskId,
      viewer,
    );
    assert.equal(result.body.data.status, "succeeded");
    assert.equal(
      (await call("/record-queries/" + query.body.data.taskId, admin)).status,
      404,
    );
    const recordId = result.body.data.items[0].id;
    assert.equal(
      (await call("/playback-sessions", admin, "POST", { recordId })).status,
      404,
    );
    const playback = await call("/playback-sessions", viewer, "POST", {
      recordId,
    });
    assert.equal(playback.status, 202);
    const { sessionId, viewerId } = playback.body.data;
    let status;
    for (let n = 0; n < 20; n++) {
      status = await call(
        `/live-sessions/${sessionId}?viewerId=${viewerId}`,
        viewer,
      );
      if (status.body.data.state === "ready") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(status.body.data.kind, "playback");
    assert.deepEqual(invites[0][2].playback, {
      start: "2026-10-31T00:00:00.000Z",
      end: "2026-10-31T01:00:00.000Z",
    });
    assert.equal(
      (
        await call(`/playback-sessions/${sessionId}/control`, viewer, "POST", {
          viewerId,
          action: "pause",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/playback-sessions/${sessionId}/control`, viewer, "POST", {
          viewerId,
          action: "seek",
          position: 4000,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(`/playback-sessions/${sessionId}/control`, viewer, "POST", {
          viewerId,
          action: "speed",
          scale: 99,
        })
      ).status,
      409,
    );
    assert.equal(controls.length, 1);
    await call(
      `/live-sessions/${sessionId}/viewers/${viewerId}`,
      viewer,
      "DELETE",
    );
    assert.equal((await call("/cascade/platforms", viewer)).status, 403);
    const platform = {
      name: "上级平台",
      serverId: "44010000002000000001",
      localId: "44010000002000000002",
      domain: "4401000000",
      host: "127.0.0.1",
      port: 15070,
      password: "platform-password",
      expires: 3600,
      heartbeat: 60,
    };
    assert.equal(
      (
        await call("/cascade/platforms", admin, "POST", {
          ...platform,
          serverId: Number(platform.serverId),
        })
      ).status,
      400,
    );
    const created = await call("/cascade/platforms", admin, "POST", platform);
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assert.equal(
      (
        await call(`/cascade/platforms/${id}/channels`, admin, "PUT", {
          items: [{ channelId: "c", alias: 44010000001310000001 }],
        })
      ).status,
      400,
    );
    assert.ok(!JSON.stringify(created.body).includes("platform-password"));
    assert.equal(created.body.data.ha1, undefined);
    assert.equal(
      (
        await call(`/cascade/platforms/${id}/channels`, admin, "PUT", {
          items: [{ channelId: "c", alias: "44010000001310000001" }],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/cascade/platforms/${id}/channels`, admin, "PUT", {
          items: [{ channelId: "missing", alias: "44010000001310000001" }],
        })
      ).status,
      400,
    );
    assert.equal(
      (await call(`/cascade/platforms/${id}/channels`, admin)).body.data.items
        .length,
      1,
    );
    assert.equal(
      (await call(`/cascade/platforms/${id}`, admin, "DELETE")).status,
      204,
    );
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

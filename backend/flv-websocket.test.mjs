import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";

async function fixture(t, { convert = false, tracks } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "aegis-ws-")),
    database = join(dir, "test.db"),
    store = openStore(database),
    db = store.db;
  for (const role of ["admin", "viewer"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      role,
      role,
      hashPassword("ws-fixture-password"),
      role,
    );
  db.prepare("INSERT INTO user_groups VALUES('viewer','default')").run();
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "nvr",
    "34020000001110000001",
    "模拟NVR",
    "online",
    new Date().toISOString(),
    Date.now() + 3600000,
    Date.now(),
  );
  for (let i = 0; i < 36; i++)
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      "c" + i,
      "nvr",
      "3402000000132" + String(i + 1).padStart(7, "0"),
      "通道" + i,
      "online",
    );
  const streams = new Set(),
    clients = [];
  let aborted = 0;
  const config = loadConfig({
    SIP_ENABLED: "1",
    MEDIA_URL: "http://media.invalid",
    MEDIA_SECRET: "fixture-secret",
    MEDIA_AAC_PREVIEW_DEVICES: convert ? "34020000001110000001" : "",
    MEDIA_AAC_PREVIEW_EXECUTABLE: tracks ? "ffmpeg" : "",
  });
  const media = {
    async allocate(id) {
      streams.add(id);
      return { port: 40000 };
    },
    async release(id) {
      streams.delete(id);
    },
    async streams() {
      return [...streams].map((stream) => ({
        stream,
        app: "rtp",
        schema: "rtmp",
        tracks,
      }));
    },
    async openFlv(id, signal) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("FLV-test-" + id));
            signal.addEventListener(
              "abort",
              () => {
                aborted++;
                controller.error(Error("closed"));
              },
              { once: true },
            );
          },
        }),
      );
    },
  };
  const sip = {
    state: "listening",
    config: config.sip,
    seq: 1,
    requests: {
      async request() {
        return { status: 200 };
      },
    },
    dialogs: {
      async invite() {
        return { id: "dialog" };
      },
      async end() {},
    },
    close() {},
  };
  const app = createServer({
    database,
    legacy: null,
    config,
    mediaAdapter: media,
    sipGateway: sip,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + app.address().port;
  t.after(async () => {
    clients.forEach((ws) => ws.terminate());
    await new Promise((r, j) => app.close((e) => (e ? j(e) : r())));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function login(name) {
    const r = await fetch(origin + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: name, password: "ws-fixture-password" }),
    });
    const data = (await r.json()).data;
    return {
      Cookie: r.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
      "X-CSRF-Token": data.csrf,
    };
  }
  async function api(path, headers, method = "GET", data) {
    const r = await fetch(origin + "/api/v1" + path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return {
      status: r.status,
      data: r.status === 204 ? null : (await r.json()).data,
    };
  }
  async function create(headers, i = 0) {
    const r = await api("/live-sessions", headers, "POST", {
      channelId: "c" + i,
    });
    assert.equal(r.status, 202);
    for (let n = 0; n < 100; n++) {
      const state = await api(
        "/live-sessions/" + r.data.sessionId + "?viewerId=" + r.data.viewerId,
        headers,
      );
      if (state.data.state === "ready")
        return { ...r.data, path: state.data.playUrl };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("mock stream not ready");
  }
  async function connect(path, headers) {
    const ws = new WebSocket(origin.replace("http:", "ws:") + path, {
      headers: { ...headers, Origin: origin },
    });
    clients.push(ws);
    ws.on("error", () => {});
    const [data] = await once(ws, "message");
    assert.match(data.toString(), /^FLV-test-/);
    return ws;
  }
  async function rejected(path, headers) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(origin.replace("http:", "ws:") + path, {
        headers,
      });
      clients.push(ws);
      ws.on("error", () => {});
      ws.on("open", () => reject(Error("Unauthorized socket opened")));
      ws.on("unexpected-response", (_, res) => {
        const status = res.statusCode;
        res.resume();
        ws.terminate();
        resolve(status);
      });
    });
  }
  return {
    api,
    db,
    login,
    create,
    connect,
    rejected,
    origin,
    media,
    get aborted() {
      return aborted;
    },
  };
}

test("转换预览仅授权给该观看者，关闭 HTTP 后取消上游", async (t) => {
  const f = await fixture(t, { convert: true });
  const admin = await f.login("admin");
  const viewer = await f.login("viewer");
  const session = await f.create(admin);
  assert.match(session.path, /\/stream\.mp4$/);
  f.media.openPreviewMp4 = f.media.openFlv;
  const url = f.origin + session.path;
  assert.equal((await fetch(url, { headers: viewer })).status, 403);
  const response = await fetch(url, { headers: admin });
  assert.equal(response.headers.get("content-type"), "video/mp4");
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /^FLV-test-/);
  await reader.cancel();
  for (let i = 0; i < 30 && !f.aborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.aborted, 1);
});

test("未列入名单的 NVR 通道按 H.265/G.711 轨道启用转换", async (t) => {
  const f = await fixture(t, {
    tracks: [
      { codec_type: 0, codec_id: 1 },
      { codec_type: 1, codec_id: 3 },
    ],
  });
  const session = await f.create(await f.login("admin"), 35);
  assert.match(session.path, /\/stream\.mp4$/);
});

test("WebSocket-FLV：36路鉴权二进制视频并发，管理请求可用，断开回收上游", async (t) => {
  const f = await fixture(t),
    auth = await f.login("admin"),
    views = [];
  for (let i = 0; i < 36; i++) views.push(await f.create(auth, i));
  const sockets = await Promise.all(views.map((v) => f.connect(v.path, auth)));
  assert.equal(sockets.length, 36);
  assert.equal((await f.api("/devices", auth)).status, 200);
  await Promise.all(
    views.map((v) =>
      f.api(
        `/live-sessions/${v.sessionId}/viewers/${v.viewerId}/renew`,
        auth,
        "POST",
        {},
      ),
    ),
  );
  await Promise.all(
    sockets.map(async (ws) => {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }),
  );
  for (let i = 0; i < 100 && f.aborted < 36; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.aborted, 36);
});

test("WebSocket-FLV：拒绝未登录、跨站、缺失Origin和其他用户的观看者", async (t) => {
  const f = await fixture(t),
    admin = await f.login("admin"),
    viewer = await f.login("viewer"),
    v = await f.create(admin);
  assert.equal(await f.rejected(v.path, { Origin: f.origin }), 401);
  assert.equal(
    await f.rejected(v.path, { ...admin, Origin: "https://external.invalid" }),
    403,
  );
  assert.equal(await f.rejected(v.path, admin), 403);
  assert.equal(await f.rejected(v.path, { ...viewer, Origin: f.origin }), 403);
});

test("WebSocket-FLV：过期会话拒绝、已连接会话到期断开，不接受上行媒体", async (t) => {
  const f = await fixture(t),
    auth = await f.login("admin"),
    v = await f.create(auth),
    ws = await f.connect(v.path, auth);
  const badMessage = once(ws, "close");
  ws.send("unexpected");
  await badMessage;
  assert.equal((await f.api("/devices", auth)).status, 200);
  f.db
    .prepare("UPDATE sessions SET expiresAt=? WHERE userId='admin'")
    .run(Date.now() - 1);
  assert.equal(await f.rejected(v.path, { ...auth, Origin: f.origin }), 401);
  const fresh = await f.login("admin"),
    newView = await f.create(fresh);
  f.db
    .prepare(
      "UPDATE sessions SET expiresAt=? WHERE token=(SELECT token FROM sessions WHERE userId='admin' ORDER BY expiresAt DESC LIMIT 1)",
    )
    .run(Date.now() + 1000);
  const expiring = await f.connect(newView.path, fresh);
  await once(expiring, "close");
  assert.ok(f.aborted >= 2);
});

test("WebSocket-FLV：撤权、注销与异常上游关闭连接，不泄漏媒体凭据", async (t) => {
  const f = await fixture(t),
    admin = await f.login("admin"),
    viewer = await f.login("viewer"),
    v = await f.create(viewer),
    ws = await f.connect(v.path, viewer);
  const revoked = once(ws, "close");
  assert.equal(
    (await f.api("/users/viewer/groups", admin, "PUT", { groupIds: [] }))
      .status,
    204,
  );
  await revoked;
  const own = await f.create(admin),
    ownWs = await f.connect(own.path, admin),
    loggedOut = once(ownWs, "close");
  assert.equal((await f.api("/auth/logout", admin, "POST", {})).status, 204);
  await loggedOut;
  const again = await f.login("admin"),
    broken = await f.create(again);
  f.media.openFlv = async () => {
    throw Error("private media URL secret must stay private");
  };
  const bad = new WebSocket(f.origin.replace("http:", "ws:") + broken.path, {
    headers: { ...again, Origin: f.origin },
  });
  bad.on("error", () => {});
  const [code, reason] = await once(bad, "close");
  assert.equal(code, 1011);
  assert.doesNotMatch(reason.toString(), /secret|private/);
  assert.equal((await f.api("/devices", again)).status, 200);
});

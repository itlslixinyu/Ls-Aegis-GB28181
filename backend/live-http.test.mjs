import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
test("HTTP点播接受、只读用户观看、资源所有权、同源流代理和退出回收", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl-live-"));
  const database = join(dir, "test.db");
  const { db } = openStore(database);
  for (const id of ["viewer1", "viewer2"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      hashPassword("test-password-123"),
      "viewer",
    );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "d",
    "34020000001320000001",
    "设备",
    "online",
    new Date().toISOString(),
    Date.now() + 3600000,
    Date.now(),
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
  });
  let stream,
    releaseCount = 0;
  const media = {
    status: { state: "online" },
    async allocate(id) {
      stream = id;
      return { port: 40000 };
    },
    async streams() {
      return [{ stream, app: "rtp", schema: "rtmp" }];
    },
    async release() {
      releaseCount++;
    },
    async openFlv() {
      return new Response(Buffer.from("FLV-test-only"));
    },
  };
  const sip = {
    state: "listening",
    dialogs: {
      async invite() {
        return { id: "dialog" };
      },
      async end() {},
    },
    close() {},
  };
  const server = createServer({
    database,
    legacy: null,
    config,
    mediaAdapter: media,
    sipGateway: sip,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function login(username) {
    const response = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "test-password-123" }),
    });
    const data = (await response.json()).data;
    return {
      cookie: response.headers.get("set-cookie").split(";")[0],
      csrf: data.csrf,
    };
  }
  const call = (path, user, method = "GET", body, headers = {}) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: user.cookie,
        "X-CSRF-Token": user.csrf,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const u1 = await login("viewer1"),
      u2 = await login("viewer2");
    assert.equal((await call("/overview", u1)).status, 200);
    for (const streamNumber of [-1, 2, "1", null, {}, true]) {
      assert.equal(
        (
          await call("/live-sessions", u1, "POST", {
            channelId: "c",
            streamNumber,
          })
        ).status,
        400,
      );
    }
    const created = await call(
      "/live-sessions",
      u1,
      "POST",
      { channelId: "c" },
      { "Idempotency-Key": "request-1" },
    );
    assert.equal(created.status, 202);
    const a = (await created.json()).data;
    const duplicate = (
      await (
        await call(
          "/live-sessions",
          u1,
          "POST",
          { channelId: "c" },
          { "Idempotency-Key": "request-1" },
        )
      ).json()
    ).data;
    assert.equal(duplicate.viewerId, a.viewerId);
    const b = (
      await (
        await call("/live-sessions", u2, "POST", { channelId: "c" })
      ).json()
    ).data;
    assert.equal(a.sessionId, b.sessionId);
    const path = `/live-sessions/${a.sessionId}/viewers/${a.viewerId}`;
    assert.equal((await call(path + "/renew", u2, "POST", {})).status, 409);
    assert.equal((await call(path, u2, "DELETE")).status, 403);
    let snapshot;
    for (let n = 0; n < 10; n++) {
      snapshot = (
        await (
          await call(`/live-sessions/${a.sessionId}?viewerId=${a.viewerId}`, u1)
        ).json()
      ).data;
      if (snapshot.state === "ready") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(snapshot.state, "ready");
    assert.equal((await call(path + "/stream.flv", u2)).status, 403);
    const proxy = await call(path + "/stream.flv", u1);
    assert.equal(proxy.status, 200);
    assert.equal(proxy.headers.get("content-type"), "video/x-flv");
    assert.equal(await proxy.text(), "FLV-test-only");
    assert.equal((await call(path, u1, "DELETE")).status, 204);
    assert.equal(releaseCount, 0);
    assert.equal(
      (
        await call(
          `/live-sessions/${b.sessionId}/viewers/${b.viewerId}`,
          u2,
          "DELETE",
        )
      ).status,
      204,
    );
    assert.equal(releaseCount, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

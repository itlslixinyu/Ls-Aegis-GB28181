import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "./lib/store.mjs";
import { createServer } from "./server.mjs";
import { loadConfig } from "./lib/config.mjs";
test("录像HTTP权限、计划CRUD、回调鉴权、跨用户拒绝及文件范围下载", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gl-record-http-")),
    database = join(directory, "test.db");
  const { db } = openStore(database);
  for (const role of ["admin", "viewer"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      role,
      role,
      hashPassword("test-password-123"),
      role,
    );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt) VALUES(?,?,?,?)",
  ).run("d", "34020000001320000001", "HTTP测试", new Date().toISOString());
  db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
    "c",
    "d",
    "34020000001310000001",
    "离线测试通道",
    "offline",
  );
  db.prepare(
    "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    "job",
    "admin",
    "c",
    "download",
    "succeeded",
    Date.now(),
    "gl_record_test",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO recording_files VALUES(?,?,?,?)").run(
    "file",
    "job",
    "2026-11-01",
    "file.mp4",
  );
  db.prepare(
    "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,createdAt) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "scheduled-job",
    "admin",
    "c",
    "scheduled",
    "failed",
    Date.now(),
    new Date().toISOString(),
  );
  db.close();
  const config = loadConfig({
      MEDIA_HOOK_TOKEN: "test-strong-token-24-characters",
    }),
    ranges = [];
  const media = {
    status: { state: "not_configured" },
    async release() {},
    async openRecording(stream, file, range) {
      ranges.push(range);
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: range ? 206 : 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "4",
          ...(range ? { "Content-Range": "bytes 0-3/16" } : {}),
        },
      });
    },
  };
  const server = createServer({
    database,
    legacy: null,
    config,
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
  async function call(path, user, method = "GET", value, extra = {}) {
    return fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        Cookie: user.cookie,
        "X-CSRF-Token": user.csrf,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  try {
    const admin = await login("admin"),
      viewer = await login("viewer");
    assert.equal((await call("/recording-plans", viewer)).status, 403);
    assert.equal(
      (await call("/recording-jobs/job/files/file", viewer)).status,
      404,
    );
    const list = await (await call("/recording-jobs", viewer)).json();
    assert.equal(list.data.items.length, 0);
    const scheduled = await (
      await call("/recording-jobs?kind=scheduled", admin)
    ).json();
    assert.deepEqual(
      scheduled.data.items.map((j) => j.id),
      ["scheduled-job"],
    );
    const daily = await (
      await call("/recording-jobs?kind=scheduled&daily=1", admin)
    ).json();
    assert.equal(daily.data.items.length, 1);
    assert.equal(daily.data.items[0].attempts[0].id, "scheduled-job");
    assert.equal(
      (await call("/recording-jobs?kind=download&daily=1", admin)).status,
      400,
    );
    assert.equal(
      (await call("/recording-jobs?kind=scheduled&daily=1", viewer)).status,
      200,
    );
    const exported = await (
      await call("/recording-jobs?kind=download", admin)
    ).json();
    assert.deepEqual(
      exported.data.items.map((j) => j.id),
      ["job"],
    );
    assert.equal(
      (await call("/recording-jobs?kind=unknown", admin)).status,
      400,
    );
    const range = await call(
      "/recording-jobs/job/files/file",
      admin,
      "GET",
      undefined,
      { Range: "bytes=0-3" },
    );
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 0-3/16");
    assert.equal((await range.arrayBuffer()).byteLength, 4);
    assert.match(range.headers.get("content-disposition"), /^attachment/);
    assert.deepEqual(ranges, ["bytes=0-3"]);
    assert.equal(
      (
        await call("/recording-jobs/job/files/file", admin, "GET", undefined, {
          Range: "bytes=1-2,4-5",
        })
      ).status,
      416,
    );
    const value = {
      name: "HTTP录像计划",
      channelId: "c",
      days: [1, 2, 3, 4, 5],
      startTime: "09:00",
      endTime: "18:00",
      enabled: false,
      retentionDays: 7,
      segmentSeconds: 900,
    };
    const created = await call("/recording-plans", admin, "POST", value);
    assert.equal(created.status, 201);
    const p = (await created.json()).data;
    assert.equal(
      (await call("/recording-plans/" + p.id, viewer, "DELETE")).status,
      403,
    );
    assert.equal(
      (
        await call("/recording-plans/" + p.id + "/enabled", admin, "PUT", {
          enabled: true,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await call("/recording-plans/" + p.id, admin, "PUT", {
          ...value,
          name: "改名",
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("/recording-plans/" + p.id, admin, "DELETE")).status,
      204,
    );
    assert.equal(
      (
        await call("/devices/d/media-transport", viewer, "PUT", {
          transport: "TCP-PASSIVE",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/devices/d/media-transport", admin, "PUT", {
          transport: "TCP-PASSIVE",
        })
      ).status,
      200,
    );
    const devices = await (await call("/devices", admin)).json();
    assert.equal(devices.data.items[0].mediaTransport, "TCP-PASSIVE");
    const hook = async (token, event) =>
      fetch(origin + "/api/hooks/media/publish?token=" + token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
    assert.equal(
      (await hook("wrong", { app: "rtp", stream: "gl_record_test" })).status,
      403,
    );
    const { db: control } = openStore(database);
    control
      .prepare("UPDATE recording_jobs SET status='starting' WHERE id='job'")
      .run();
    control.close();
    const published = await hook(config.media.hookToken, {
      app: "rtp",
      vhost: "__defaultVhost__",
      stream: "gl_record_test",
    });
    const flags = await published.json();
    assert.equal(flags.enable_mp4, true);
    assert.equal(flags.code, 0);
    assert.equal(flags.mp4_max_second, 900);
    const publicConfig = await (await call("/system/config", admin)).json();
    assert.ok(!JSON.stringify(publicConfig).includes(config.media.hookToken));
    const { db: reset } = openStore(database);
    reset
      .prepare("UPDATE recording_jobs SET status='succeeded' WHERE id='job'")
      .run();
    reset.close();
  } finally {
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true });
  }
});

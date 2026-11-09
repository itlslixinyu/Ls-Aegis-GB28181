import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { openStore } from "./lib/store.mjs";
import { AlarmSnapshots } from "./services/alarm-snapshots.mjs";
import { monitoringFixture } from "./test-support/monitoring-fixture.mjs";
function alarm(db, id, device = "d") {
  db.prepare(
    "INSERT INTO alarms(id,deviceId,deviceName,targetCode,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint) VALUES(?,?,?,?,4,?,?,?, ?,?,?,?)",
  ).run(
    id,
    device,
    "camera",
    "34020000001320000001",
    "5",
    "2",
    "",
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
    id,
  );
}
test("异步抓图共享、独立媒体读取、权限之外的资源不修改、无源跳过、失败与保留清理", async () => {
  const { db } = openStore(":memory:");
  db.exec(
    "INSERT INTO devices(id,deviceId,name,createdAt) VALUES('d','34020000001320000001','camera','now');INSERT INTO channels VALUES('c','d','34020000001320000001','camera','online');INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt) VALUES('s','c','d','stream','ready','now');",
  );
  const image = await sharp({
    create: { width: 64, height: 32, channels: 3, background: "blue" },
  })
    .jpeg()
    .toBuffer();
  let complete,
    calls = 0;
  const s = new AlarmSnapshots({
    db,
    decode: async () => {
      calls++;
      await new Promise((r) => (complete = r));
      return image;
    },
  });
  alarm(db, "a");
  alarm(db, "b");
  s.schedule("a", { id: "d" }, "34020000001320000001");
  s.schedule("b", { id: "d" }, "34020000001320000001");
  assert.equal(s.get("a").status, "capturing");
  assert.equal(s.get("a").id, s.get("b").id);
  await Promise.resolve();
  complete();
  await s.current.promise;
  assert.equal(calls, 1);
  assert.equal(s.get("a").status, "ready");
  assert.ok(s.image("b").length);
  assert.equal(
    db.prepare("select state from live_sessions").get().state,
    "ready",
  );
  assert.equal(db.prepare("select count(*) n from viewers").get().n, 0);
  db.exec("UPDATE alarm_snapshots SET requestedAt='2000-01-01'");
  s.prune();
  assert.equal(s.get("a").status, "expired");
  alarm(db, "no-source");
  s.schedule("no-source", { id: "d" }, "other");
  assert.equal(s.get("no-source").status, "skipped");
  await s.close();
  const failed = new AlarmSnapshots({
    db,
    decode: async () => {
      throw Error("secret upstream details");
    },
  });
  alarm(db, "failure");
  failed.schedule("failure", { id: "d" }, "34020000001320000001");
  await failed.current.promise;
  assert.equal(failed.get("failure").status, "failed");
  assert.equal(JSON.stringify(failed.get("failure")).includes("secret"), false);
  await failed.close();
  db.close();
});
test("告警图片HTTP要求登录、功能与设备范围权限，返回JPEG且禁止缓存", async (t) => {
  const f = await monitoringFixture();
  t.after(() => f.close());
  const image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "blue" },
  })
    .jpeg()
    .toBuffer();
  alarm(f.db, "visible", "qa-nvr");
  alarm(f.db, "hidden", "qa-denied");
  f.db
    .prepare("INSERT INTO alarm_snapshots VALUES(?,?,?,?,?,?)")
    .run(
      "pic",
      "ready",
      null,
      new Date().toISOString(),
      new Date().toISOString(),
      image,
    );
  for (const id of ["visible", "hidden"])
    f.db.prepare("INSERT INTO alarm_snapshot_links VALUES(?,?)").run(id, "pic");
  async function login(username) {
    const r = await fetch(f.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: f.password }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  }
  const admin = await login("qa-admin"),
    viewer = await login("qa-monitor");
  async function get(id, cookie) {
    return fetch(f.base + "/api/v1/alarms/" + id + "/snapshot", {
      headers: cookie ? { Cookie: cookie } : {},
    });
  }
  assert.equal((await get("visible")).status, 401);
  const ok = await get("visible", admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal((await get("hidden", viewer)).status, 404);
  f.db
    .prepare(
      "UPDATE user_authorizations SET scopeMode='groups' WHERE userId='qa-admin'",
    )
    .run(); // Admin remains global by role, test viewer scope via its authorized role below.
  assert.equal((await get("visible", viewer)).status, 200);
  f.db.prepare("DELETE FROM user_groups WHERE userId='qa-monitor'").run();
  assert.equal((await get("visible", viewer)).status, 404);
});
test("抓图进行中关闭会取消独立读取，恢复时捕获中状态不会假报成功", async () => {
  const { db } = openStore(":memory:");
  db.exec(
    "INSERT INTO devices(id,deviceId,name,createdAt) VALUES('d','34020000001320000001','camera','now');INSERT INTO channels VALUES('c','d','34020000001320000001','camera','online');INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt) VALUES('s','c','d','stream','ready','now');",
  );
  let stopped = false;
  const s = new AlarmSnapshots({
    db,
    decode: async (_, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(Error("cancelled"));
          },
          { once: true },
        );
      }),
  });
  alarm(db, "closing");
  s.schedule("closing", { id: "d" }, "34020000001320000001");
  await Promise.resolve();
  await s.close();
  assert.equal(stopped, true);
  assert.equal(s.get("closing").status, "failed");
  assert.equal(
    db.prepare("select state from live_sessions").get().state,
    "ready",
  );
  db.close();
});
test('计划录像源可直接复用，排除回放源，抓图不更换录像任务和租约',async()=>{
 const {db}=openStore(':memory:');db.exec("INSERT INTO devices(id,deviceId,name,createdAt) VALUES('d','34020000001320000001','camera','now');INSERT INTO channels VALUES('c','d','34020000001320000001','camera','online');INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,kind,createdAt) VALUES('r','c','d','recording-stream','ready','recording','now'),('p','c','d','playback-stream','ready','playback','later');");
 const image=await sharp({create:{width:16,height:16,channels:3,background:'blue'}}).jpeg().toBuffer();let source;
 const s=new AlarmSnapshots({db,decode:async stream=>{source=stream;return image}});alarm(db,'record-source');s.schedule('record-source',{id:'d'},'34020000001320000001');await s.current.promise;assert.equal(source,'recording-stream');assert.equal(s.get('record-source').status,'ready');assert.equal(db.prepare("select state from live_sessions where id='r'").get().state,'ready');await s.close();db.close();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { Recordings, occurrence } from "./services/recordings.mjs";
import { LiveSessions } from "./media/live-sessions.mjs";
const wait = () => new Promise((r) => setTimeout(r, 5));
function fixture() {
  const { db } = openStore(":memory:");
  let now = Date.parse("2026-11-02T01:00:00Z");
  for (const u of ["a", "b"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      u,
      u,
      "unused",
      u === "a" ? "admin" : "viewer",
    );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat,remoteAddress,remotePort) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "d",
    "34020000001320000001",
    "模拟设备",
    "online",
    new Date(now).toISOString(),
    now + 86400000,
    now,
    "127.0.0.1",
    15060,
  );
  const channel = {
    id: "c",
    deviceId: "d",
    channelCode: "34020000001310000001",
    name: "模拟通道",
    status: "online",
  };
  db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
    channel.id,
    channel.deviceId,
    channel.channelCode,
    channel.name,
    channel.status,
  );
  // Use explicit insert order for the channel schema.
  db.prepare("UPDATE channels SET name=?,status=? WHERE id=?").run(
    "模拟通道",
    "online",
    "c",
  );
  const streams = new Set(),
    files = new Map(),
    calls = { allocate: [], start: [], stop: [], deleted: [], invites: [] };
  const media = {
    config: { hookToken: "test-hook-token-at-least-24-characters" },
    async allocate(id, mode) {
      streams.add(id);
      calls.allocate.push([id, mode]);
      return { port: 40000 };
    },
    async release(id) {
      streams.delete(id);
      if (calls.start.includes(id))
        files.set(id, [{ date: "2026-11-02", name: "09-00-00-0.mp4" }]);
    },
    async streams() {
      return [...streams].map((stream) => ({
        app: "rtp",
        schema: "rtmp",
        stream,
      }));
    },
    async startRecord(id) {
      calls.start.push(id);
    },
    async stopRecord(id) {
      calls.stop.push(id);
      if (calls.start.includes(id))
        files.set(id, [{ date: "2026-11-02", name: "09-00-00-0.mp4" }]);
    },
    async recordFiles(id) {
      return files.get(id) || [];
    },
    async deleteRecordFile(id, f) {
      calls.deleted.push([id, f.name]);
    },
  };
  const sip = {
    state: "listening",
    dialogs: {
      async invite(device, channel, options) {
        const id = "dialog-" + calls.invites.length;
        calls.invites.push({ device, channel, options, id });
        return {
          id,
          answer: `v=0\r\nc=IN IP4 127.0.0.1\r\nm=video 40002 TCP/RTP/AVP 96\r\na=setup:${options.mediaTransport === "TCP-ACTIVE" ? "passive" : "active"}\r\n`,
        };
      },
      async end() {},
    },
  };
  const live = new LiveSessions({
    db,
    media,
    sip,
    config: {
      sip: { heartbeatTimeout: 180000 },
      media: { configured: true, rtpHost: "127.0.0.1" },
      playTimeout: 1000,
    },
    now: () => now,
    poll: 5,
  });
  const recordings = new Recordings({ db, media, live, now: () => now });
  const plan = (values = {}) =>
    recordings.savePlan(
      {
        name: "工作日录像",
        channelId: "c",
        days: [1, 2, 3, 4, 5],
        startTime: "09:00",
        endTime: "10:00",
        enabled: true,
        retentionDays: 7,
        segmentSeconds: 900,
        ...values,
      },
      "a",
    );
  const record = () => {
    db.prepare("INSERT INTO record_queries VALUES(?,?,?,?,?,?,?,?)").run(
      "q",
      "a",
      "c",
      "succeeded",
      "2026-11-02T00:00:00.000Z",
      "2026-11-02T01:00:00.000Z",
      null,
      new Date(now).toISOString(),
    );
    db.prepare("INSERT INTO record_items VALUES(?,?,?,?,?,?,?,?)").run(
      "r",
      "q",
      "c",
      "测试录像",
      "/test",
      "2026-11-02T00:00:00.000Z",
      "2026-11-02T01:00:00.000Z",
      "time",
    );
  };
  return {
    db,
    media,
    sip,
    live,
    recordings,
    calls,
    channel,
    plan,
    record,
    now: () => now,
    advance(ms) {
      now += ms;
      db.prepare("UPDATE devices SET lastHeartbeat=?").run(now);
    },
    async close() {
      await recordings.close();
      await live.shutdown();
      db.close();
    },
  };
}
test("北京时间周计划跨日/跨周边界，重叠计划与非法参数被拒绝", async () => {
  const f = fixture();
  try {
    const p = f.plan({ days: [7], startTime: "23:00", endTime: "01:00" });
    const raw = f.db
      .prepare("SELECT * FROM recording_plans WHERE id=?")
      .get(p.id);
    assert.ok(occurrence(raw, Date.parse("2026-11-01T16:30:00Z")));
    assert.equal(occurrence(raw, Date.parse("2026-11-01T17:00:00Z")), null);
    assert.throws(
      () => f.plan({ days: [1], startTime: "00:30", endTime: "02:00" }),
      /重叠/,
    );
    assert.throws(() => f.plan({ days: [1, 1] }));
    assert.throws(() => f.plan({ startTime: "24:01" }));
  } finally {
    await f.close();
  }
});

test("全天计划完整覆盖24小时，跨执行日无一分钟配置空档，保留按天且支持六档分钟分段", async () => {
  const f = fixture();
  try {
    const p = f.plan({ days: [1, 2], startTime: "00:00", endTime: "00:00" });
    const raw = f.db
      .prepare("SELECT * FROM recording_plans WHERE id=?")
      .get(p.id);
    const last = occurrence(raw, Date.parse("2026-11-02T15:59:59.999Z"));
    assert.equal(last.end - last.start, 86400000);
    const next = occurrence(raw, last.end);
    assert.ok(next);
    assert.equal(next.start, last.end);
    assert.notEqual(next.key, last.key);
    for (const minutes of [1, 3, 5, 10, 15, 20]) {
      const plan = f.plan({
        enabled: false,
        startTime: "00:00",
        endTime: "00:00",
        retentionDays: 30,
        segmentSeconds: minutes * 60,
      });
      assert.equal(plan.retentionDays, 30);
      assert.equal(plan.segmentSeconds, minutes * 60);
    }
    for (const retentionDays of [0, 1.5, 366])
      assert.throws(
        () => f.plan({ enabled: false, retentionDays }),
        /保留天数/,
      );
  } finally {
    await f.close();
  }
});
test("计划只调度一次，独立录制不误停观看，停用后保留部分文件", async () => {
  const f = fixture();
  try {
    const viewer = f.live.create(f.channel, "a");
    const p = f.plan();
    await f.recordings.tick();
    await wait();
    await f.recordings.tick();
    assert.equal(f.recordings.list("a").length, 1);
    assert.equal(f.recordings.list("a")[0].status, "recording");
    assert.equal(f.calls.allocate.length, 2);
    await f.recordings.tick();
    assert.equal(f.recordings.list("a").length, 1);
    const recordFiles = f.media.recordFiles;
    f.media.recordFiles = async () => [
      { date: "2026-11-02", name: "09-00-00-0.mp4" },
    ];
    f.advance(30000);
    f.live.renew(viewer.sessionId, "a", viewer.viewerId);
    await f.recordings.tick();
    await f.recordings.discoveryTask;
    assert.equal(f.recordings.list("a")[0].status, "recording");
    assert.equal(f.recordings.list("a")[0].files.length, 1);
    f.media.recordFiles = recordFiles;
    f.recordings.enablePlan(p.id, false);
    await f.recordings.tick();
    assert.equal(f.recordings.list("a")[0].status, "finalizing");
    assert.equal(
      f.live.snapshot(viewer.sessionId, "a", viewer.viewerId).state,
      "ready",
    );
    f.advance(31000);
    f.live.renew(viewer.sessionId, "a", viewer.viewerId);
    await f.recordings.tick();
    const j = f.recordings.list("a")[0];
    assert.equal(j.status, "cancelled");
    assert.equal(j.files.length, 1);
    await f.live.leave(viewer.sessionId, "a", viewer.viewerId);
  } finally {
    await f.close();
  }
});
test("设备导出校验归属/范围/幂等，收到结束通知且文件确认后才成功", async () => {
  const f = fixture();
  try {
    f.record();
    assert.throws(() => f.recordings.download({ recordId: "r" }, "b"), /无权/);
    for (const key of ["", "bad key", "x".repeat(101), []])
      assert.throws(
        () => f.recordings.download({ recordId: "r" }, "a", key),
        /幂等/,
      );
    assert.throws(() =>
      f.recordings.download({ recordId: "r", speed: 3 }, "a"),
    );
    const j = f.recordings.download({ recordId: "r", speed: 2 }, "a", "key-1");
    assert.equal(
      f.recordings.download({ recordId: "r", speed: 2 }, "a", "key-1").id,
      j.id,
    );
    for (let i = 0; i < 16; i++)
      assert.equal(
        f.recordings.download({ recordId: "r", speed: 2 }, "a", "key-1").id,
        j.id,
      );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM recording_jobs").get().n,
      1,
    );
    assert.throws(() =>
      f.recordings.download({ recordId: "r", speed: 1 }, "a", "key-1"),
    );
    const raw = f.recordings.job(j.id, "a");
    assert.throws(() => f.recordings.job(j.id, "b"));
    f.recordings.published(raw.streamId);
    await wait();
    await f.recordings.tick();
    assert.equal(f.calls.invites[0].options.download, true);
    assert.equal(f.calls.invites[0].options.speed, 2);
    await f.live.endNotification(
      "d",
      f.channel.channelCode,
      f.calls.invites[0].id,
    );
    await f.recordings.tick();
    assert.equal(f.recordings.job(j.id, "a").status, "finalizing");
    f.advance(31000);
    await f.recordings.tick();
    assert.equal(f.recordings.job(j.id, "a").status, "succeeded");
    assert.equal(f.recordings.list("a")[0].files.length, 1);
  } finally {
    await f.close();
  }
});
test("导出缺少发布回调不得假报成功，空文件也不能完成", async () => {
  const f = fixture();
  try {
    f.record();
    const j = f.recordings.download({ recordId: "r" }, "a");
    await wait();
    await f.recordings.tick();
    assert.match(f.recordings.job(j.id, "a").error, /回调/);
    f.advance(31000);
    await f.recordings.tick();
    assert.equal(f.recordings.job(j.id, "a").status, "failed");
    assert.equal(f.recordings.list("a")[0].files.length, 0);
    const short = f.recordings.download({ recordId: "r" }, "a");
    await wait();
    await f.live.endNotification(
      "d",
      f.channel.channelCode,
      f.calls.invites.at(-1).id,
    );
    f.media.recordFiles = async () => [
      { date: "2026-11-02", name: "partial.mp4" },
    ];
    await f.recordings.tick();
    f.advance(31000);
    await f.recordings.tick();
    assert.equal(f.recordings.job(short.id, "a").status, "failed");
    assert.match(f.recordings.job(short.id, "a").error, /回调/);
    f.media.config.hookToken = "";
    assert.throws(() => f.recordings.download({ recordId: "r" }, "a"), /配置/);
  } finally {
    await f.close();
  }
});
test("计划故障持续退避重试且按通道日汇总，停止期间不重放已结束时段", async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE devices SET status='offline'").run();
    f.plan();
    await f.recordings.tick();
    assert.equal(f.recordings.list("a").length, 1);
    await f.recordings.tick();
    assert.equal(f.recordings.list("a").length, 1);
    for (let n = 0; n < 3; n++) {
      f.advance(301000);
      await f.recordings.tick();
    }
    assert.equal(f.recordings.list("a").length, 4);
    const daily = f.recordings.list("a", true, "scheduled", true);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].attempts.length, 4);
    assert.equal(daily[0].executionDate, "2026-11-02");
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM alarms WHERE type='recording-interrupted'",
        )
        .get().n,
      4,
    );
    assert.equal(f.recordings.list("b", false, "scheduled", true).length, 0);
    f.advance(2 * 3600000);
    await f.recordings.tick();
    assert.equal(f.recordings.list("a").length, 4);
  } finally {
    await f.close();
  }
});
test("文件到期只删除任务自己的媒体文件，媒体删除失败时保留元数据", async () => {
  const f = fixture();
  try {
    f.record();
    const j = f.recordings.download({ recordId: "r" }, "a");
    const raw = f.recordings.job(j.id, "a");
    f.recordings.published(raw.streamId);
    await wait();
    await f.recordings.tick();
    await f.recordings.cancel(j.id, "a");
    f.advance(31000);
    await f.recordings.tick();
    f.advance(8 * 86400000);
    const del = f.media.deleteRecordFile;
    f.media.deleteRecordFile = async () => {
      throw Error("断网");
    };
    await f.recordings.retention();
    assert.equal(f.recordings.list("a")[0].files.length, 1);
    f.media.deleteRecordFile = del;
    await f.recordings.retention();
    assert.equal(f.recordings.list("a")[0].files.length, 0);
    assert.equal(f.calls.deleted.length, 1);
  } finally {
    await f.close();
  }
});
test("TCP媒体主动/被动模式正确分配，主动连接限定设备注册地址", async () => {
  for (const mode of ["TCP-PASSIVE", "TCP-ACTIVE"]) {
    const f = fixture();
    try {
      let connected;
      f.media.connectRtp = async (...args) => {
        connected = args;
      };
      f.db.prepare("UPDATE devices SET mediaTransport=?").run(mode);
      const v = f.live.create(f.channel, "a");
      await wait();
      assert.equal(
        f.live.snapshot(v.sessionId, "a", v.viewerId).state,
        "ready",
      );
      assert.equal(f.calls.allocate[0][1], mode === "TCP-PASSIVE" ? 1 : 2);
      if (mode === "TCP-ACTIVE")
        assert.deepEqual(connected.slice(1), ["127.0.0.1", 40002]);
      await f.live.leave(v.sessionId, "a", v.viewerId);
    } finally {
      await f.close();
    }
  }
});

test("服务中断恢复后保留文件，在当前计划窗口内接续新任务", async () => {
  const f = fixture();
  let recovered;
  try {
    f.plan();
    await f.recordings.tick();
    await wait();
    await f.recordings.tick();
    const before = f.recordings.list("a")[0];
    f.db
      .prepare("UPDATE recording_jobs SET attempt=3 WHERE id=?")
      .run(before.id);
    await f.recordings.close();
    await f.live.recover();
    recovered = new Recordings({
      db: f.db,
      media: f.media,
      live: f.live,
      now: f.now,
    });
    recovered.start();
    for (let i = 0; i < 20 && recovered.ticking; i++) await wait();
    f.advance(31000);
    await recovered.tick();
    const old = recovered.job(before.id, "a");
    assert.equal(old.status, "interrupted");
    assert.equal(recovered.list("a")[0].files.length, 1);
    f.advance(301000);
    await recovered.tick();
    assert.equal(recovered.list("a").length, 2);
    const latest = recovered.list("a")[0];
    assert.equal(latest.attempt, 4);
    assert.notEqual(latest.id, before.id);
    await wait();
    await recovered.tick();
    const daily = recovered.list("a", true, "scheduled", true);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].status, "recording");
    assert.equal(daily[0].files[0].jobId, before.id);
    assert.equal(daily[0].attempts.length, 2);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM alarms WHERE fingerprint=?")
        .get("recording:" + before.id).n,
      1,
    );
  } finally {
    if (recovered) await recovered.close();
    await f.close();
  }
});

test("重启重试间隔为已有录像预留名额，新计划不能抢占全部账号并发", async () => {
  const f = fixture();
  let recovered;
  try {
    const established = f.plan();
    await f.recordings.tick();
    await wait();
    await f.recordings.tick();
    await f.recordings.close();
    await f.live.recover();
    for (let i = 0; i < 6; i++) {
      f.db
        .prepare("INSERT INTO channels VALUES(?,?,?,?,?)")
        .run("extra" + i, "d", "extra" + i, "extra" + i, "online");
      f.plan({ channelId: "extra" + i });
    }
    recovered = new Recordings({
      db: f.db,
      media: f.media,
      live: f.live,
      now: f.now,
    });
    recovered.start();
    for (let i = 0; i < 20 && recovered.ticking; i++) await wait();
    f.advance(31000);
    await recovered.tick();
    await wait();
    await recovered.tick();
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM recording_jobs WHERE status IN ('starting','recording')",
        )
        .get().n,
      3,
    );
    assert.equal(recovered.recoveryReservations.has(established.id), true);
    for (let i = 0; i < 7; i++) {
      f.advance(9000);
      await recovered.tick();
      await wait();
    }
    const active = f.db
      .prepare(
        "SELECT planId FROM recording_jobs WHERE status IN ('starting','recording')",
      )
      .all();
    assert.equal(
      active.length,
      4,
      JSON.stringify(
        f.db.prepare("SELECT channelId,status,error FROM recording_jobs").all(),
      ),
    );
    assert.equal(
      active.some((j) => j.planId === established.id),
      true,
    );
    assert.equal(recovered.recoveryReservations.has(established.id), false);
  } finally {
    if (recovered) await recovered.close();
    await f.close();
  }
});

test("恢复优先保留本周期已有文件的任务，预留超时后释放，避免永久阻塞", async () => {
  const f = fixture();
  let recovered;
  try {
    const plans = [f.plan()];
    for (let i = 0; i < 4; i++) {
      f.db
        .prepare("INSERT INTO channels VALUES(?,?,?,?,?)")
        .run("recover" + i, "d", "recover" + i, "recover" + i, "online");
      plans.push(f.plan({ channelId: "recover" + i }));
    }
    for (let i = 0; i < 4; i++) {
      const p = plans[i],
        period = occurrence({ ...p, days: JSON.stringify(p.days) }, f.now()),
        id = "prior" + i;
      f.db
        .prepare(
          "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,planId,occurrence,start,end,createdAt,finishedAt,deadline) VALUES(?,'a',?,'scheduled','interrupted',?,?,?,?,?,?,?)",
        )
        .run(
          id,
          p.channelId,
          p.id,
          period.key,
          new Date(period.start).toISOString(),
          new Date(period.end).toISOString(),
          new Date(f.now() - 60000 - i * 1000).toISOString(),
          new Date(f.now()).toISOString(),
          period.end,
        );
      f.db
        .prepare("INSERT INTO recording_files VALUES(?,?,?,?)")
        .run("file" + i, id, "2026-11-02", "sample" + i + ".mp4");
    }
    recovered = new Recordings({
      db: f.db,
      media: f.media,
      live: f.live,
      now: f.now,
    });
    recovered.start();
    for (let i = 0; i < 20 && recovered.ticking; i++) await wait();
    assert.equal(recovered.recoveryReservations.size, 4);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM recording_jobs WHERE planId=?")
        .get(plans[4].id).n,
      0,
    );
    f.advance(301000);
    await recovered.tick();
    assert.equal(recovered.recoveryReservations.size, 0);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM recording_jobs WHERE planId=?")
        .get(plans[4].id).n,
      1,
    );
  } finally {
    if (recovered) await recovered.close();
    await f.close();
  }
});

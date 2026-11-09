import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { Recordings } from "./services/recordings.mjs";
import { RecordingTaskGroups } from "./services/recording-task-groups.mjs";
function fixture(t) {
  const { db } = openStore(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO users VALUES('a','admin','unused','admin'),('v','viewer','unused','viewer');INSERT INTO device_groups VALUES('g','测试分组','','2026-11-07'),('x','其他分组','','2026-11-07');INSERT INTO user_groups VALUES('v','g');",
  );
  for (const id of ["g", "x"])
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,groupId,createdAt) VALUES(?,?,?,?,?)",
    ).run(id, id, id, id, "2026-11-07");
  for (const [id, d] of [
    ["c1", "g"],
    ["c2", "g"],
    ["c3", "g"],
    ["cx", "x"],
  ])
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      id,
      d,
      id,
      id,
      "online",
    );
  const recordings = new Recordings({ db, live: {}, media: {} }),
    groups = new RecordingTaskGroups(recordings);
  const job = (id, channelId, start, status = "succeeded") =>
    db
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,start,createdAt,deadline) VALUES(?,?,?,'scheduled',?,?,?,0)",
      )
      .run(id, "a", channelId, status, start, start);
  return { db, groups, recordings, job };
}
test("任务分组跨多日只占一行，超过200个历史日仍计入所有文件，查询只读", (t) => {
  const { db, groups, job } = fixture(t);
  for (let i = 0; i < 250; i++) {
    const time = new Date(Date.UTC(2026, 0, 1 + i, 4)).toISOString();
    job("j" + i, "c1", time);
    db.prepare("INSERT INTO recording_files VALUES(?,?,?,?)").run(
      "f" + i,
      "j" + i,
      time.slice(0, 10),
      "f" + i + ".mp4",
    );
  }
  job("active", "c2", "2026-11-07T04:00:00Z", "recording");
  job("other", "cx", "2026-11-07T04:00:00Z", "failed");
  const before = db.prepare("SELECT * FROM recording_jobs ORDER BY id").all();
  const result = groups.list("a");
  assert.equal(result.total, 2);
  assert.deepEqual(
    { ...result.items.find((g) => g.id === "g") },
    {
      id: "g",
      name: "测试分组",
      channels: 2,
      recording: 1,
      processing: 0,
      errors: 0,
      waiting: 0,
      files: 250,
    },
  );
  assert.equal(
    groups
      .channels("a", "g", { date: "2026-01-01" })
      .items.find((c) => c.channelId === "c1").job.files.length,
    1,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM recording_jobs ORDER BY id").all(),
    before,
  );
});
test("组内按通道一行；中断续录归于当天，原文件任务关联与活动操作目标保留", (t) => {
  const { db, groups, recordings, job } = fixture(t);
  recordings.savePlan(
    {
      name: "待执行",
      channelId: "c3",
      days: [1],
      startTime: "00:00",
      endTime: "00:00",
      enabled: false,
      retentionDays: 7,
      segmentSeconds: 180,
    },
    "a",
  );
  job("old", "c1", "2026-11-06T16:01:00Z", "interrupted");
  job("new", "c1", "2026-11-07T03:00:00Z", "recording");
  db.prepare("INSERT INTO recording_files VALUES(?,?,?,?)").run(
    "f",
    "old",
    "2026-11-07",
    "first.mp4",
  );
  const rows = groups.channels("a", "g", { date: "2026-11-07" }).items;
  assert.equal(rows.length, 2);
  const entry = rows.find((r) => r.channelId === "c1").job;
  assert.equal(entry.id, "new");
  assert.equal(entry.attempts.length, 2);
  assert.equal(entry.files[0].jobId, "old");
  assert.equal(rows.find((r) => r.channelId === "c3").job, null);
  assert.equal(
    groups.channels("a", "g", { date: "2026-11-06" }).items[0].job,
    null,
  );
});
test("权限过滤分组、汇总和通道；撤销分组授权立即生效", (t) => {
  const { db, groups, job } = fixture(t);
  job("one", "c1", "2026-11-07T04:00:00Z");
  job("two", "cx", "2026-11-07T04:00:00Z");
  assert.equal(groups.list("v").total, 1);
  assert.equal(groups.list("v").stats.channels, 1);
  assert.throws(
    () => groups.channels("v", "x", { date: "2026-11-07" }),
    (e) => e.status === 404,
  );
  db.prepare("DELETE FROM user_groups WHERE userId='v'").run();
  assert.equal(groups.list("v").total, 0);
  assert.throws(
    () => groups.channels("v", "g", { date: "2026-11-07" }),
    (e) => e.status === 404,
  );
});
test("历史、分页、模糊查询与日期校验", (t) => {
  const { db, groups, job } = fixture(t);
  job("one", "c1", "2026-11-07T04:00:00Z");
  job("two", "c2", "2026-11-07T04:00:00Z");
  assert.equal(
    groups.channels("a", "g", { date: "2026-11-07", pageSize: 1, page: 2 })
      .items[0].channelId,
    "c2",
  );
  assert.equal(
    groups.channels("a", "g", { date: "2026-11-07", q: "c2" }).total,
    1,
  );
  for (const date of ["2026-02-30", "not-date", "2026-11-31"])
    assert.throws(
      () => groups.channels("a", "g", { date }),
      (e) => e.status === 400,
    );
  assert.throws(
    () => groups.list("a", { page: 0 }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => groups.list("a", { pageSize: 101 }),
    (e) => e.status === 400,
  );
  db.prepare("DELETE FROM channels WHERE id='c1'").run();
  assert.equal(groups.list("a").total, 1);
  assert.equal(
    groups
      .list("a", { includeDeleted: true })
      .items.find((g) => g.id === "__deleted__").channels,
    1,
  );
  assert.equal(groups.list("v", { includeDeleted: true }).total, 1);
});

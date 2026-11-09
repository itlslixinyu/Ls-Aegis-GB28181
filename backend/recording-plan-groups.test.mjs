import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { Recordings } from "./services/recordings.mjs";
import { RecordingPlanGroups } from "./services/recording-plan-groups.mjs";
function fixture(t) {
  const { db } = openStore(":memory:");
  t.after(() => db.close());
  db.prepare("INSERT INTO users VALUES('a','a','unused','admin')").run();
  db.prepare(
    "INSERT INTO device_groups VALUES('other','其他组','','2026-11-07')",
  ).run();
  for (const [id, group] of [
    ["d", "default"],
    ["o", "other"],
  ])
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,createdAt,groupId) VALUES(?,?,?,?,?)",
    ).run(id, id, id, "2026-11-07", group);
  for (const [id, device] of [
    ["c1", "d"],
    ["c2", "d"],
    ["x", "o"],
  ])
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      id,
      device,
      id,
      id,
      "online",
    );
  const recordings = new Recordings({
    db,
    live: {},
    media: {},
    now: () => Date.parse("2026-11-07T04:00:00Z"),
  });
  return { db, recordings, groups: new RecordingPlanGroups(recordings) };
}
const config = {
  name: "分组计划",
  deviceGroupId: "default",
  channelIds: ["c1", "c2"],
  days: [1, 2, 3, 4, 5, 6, 7],
  startTime: "00:00",
  endTime: "00:00",
  enabled: false,
  retentionDays: 7,
  segmentSeconds: 180,
};
test("分组计划按快照选择通道，幂等创建，新增通道不自动录制，更新保留执行关联", (t) => {
  const { db, recordings, groups } = fixture(t);
  const p = groups.save(config, "a", null, "create-key-0001");
  assert.equal(groups.list().length, 1);
  assert.equal(recordings.plans().length, 2);
  assert.equal(groups.save(config, "a", null, "create-key-0001").id, p.id);
  assert.throws(
    () =>
      groups.save(
        { ...config, name: "不同请求" },
        "a",
        null,
        "create-key-0001",
      ),
    /其他内容/,
  );
  db.prepare(
    "INSERT INTO channels VALUES('c3','d','c3','新通道','online')",
  ).run();
  assert.equal(groups.get(p.id).channelCount, 2);
  const childIds = groups
    .children(p.id)
    .map((c) => c.id)
    .sort();
  const next = groups.save(
    { ...config, version: p.version, name: "新名称" },
    "a",
    p.id,
  );
  assert.deepEqual(
    groups
      .children(p.id)
      .map((c) => c.id)
      .sort(),
    childIds,
  );
  assert.equal(next.version, 1);
  assert.throws(() => groups.enable(p.id, true, 0), /已被更新/);
  assert.equal(groups.enable(p.id, true, next.version).enabled, 1);
  assert.equal(
    recordings.plans().every((c) => c.enabled),
    true,
  );
});
test("跨组、重复通道被拒绝；晚发生的重叠错误回滚整个分组事务", (t) => {
  const { db, recordings, groups } = fixture(t);
  assert.throws(
    () => groups.save({ ...config, channelIds: ["c1", "x"] }, "a"),
    /不属于/,
  );
  assert.throws(
    () => groups.save({ ...config, channelIds: ["c1", "c1"] }, "a"),
    /重复/,
  );
  recordings.savePlan({ ...config, channelId: "c2", enabled: true }, "a");
  assert.throws(() => groups.save({ ...config, enabled: true }, "a"), /重叠/);
  assert.equal(
    db.prepare("SELECT count(*) n FROM recording_plan_groups").get().n,
    0,
  );
  assert.equal(recordings.plans().length, 1);
  const p = groups.save(config, "a");
  assert.throws(() => groups.enable(p.id, true, p.version), /重叠/);
  assert.equal(groups.get(p.id).enabled, 0);
  assert.equal(
    groups.children(p.id).some((c) => c.enabled),
    false,
  );
});
test("旧单通道计划兼容展示，升级保留计划与任务ID，活动任务阻止修改和删除", (t) => {
  const { db, recordings, groups } = fixture(t);
  const child = recordings.savePlan({ ...config, channelId: "c1" }, "a");
  assert.equal(groups.get(child.id).legacy, true);
  const p = groups.save(
    { ...config, channelIds: ["c1"], version: 0 },
    "a",
    child.id,
  );
  assert.equal(p.legacy, false);
  assert.equal(groups.children(p.id)[0].id, child.id);
  db.prepare(
    "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,planId,deadline,createdAt,start) VALUES('j','a','c1','scheduled','recording',?,9999999999999,'2026-11-07T04:00:00Z','2026-11-07T04:00:00Z')",
  ).run(child.id);
  assert.throws(
    () => groups.save({ ...config, version: p.version }, "a", p.id),
    /仍有执行任务/,
  );
  assert.throws(() => groups.remove(p.id, p.version), /等待任务结束/);
  const paused = groups.enable(p.id, false, p.version);
  assert.equal(paused.enabled, 0);
  assert.equal(groups.details(p.id, "a")[0].latest.status, "recording");
  db.prepare("UPDATE recording_jobs SET status='succeeded' WHERE id='j'").run();
  groups.remove(p.id, paused.version);
  assert.equal(groups.list().length, 0);
  assert.equal(
    db.prepare("SELECT planId FROM recording_jobs WHERE id='j'").get().planId,
    null,
  );
});

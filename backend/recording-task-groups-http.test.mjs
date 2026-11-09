import { test } from "node:test";
import assert from "node:assert/strict";
import { monitoringFixture } from "./test-support/monitoring-fixture.mjs";
test("录像任务分组HTTP权限、分页及无效日期契约，不影响后台录像计划", async (t) => {
  const f = await monitoringFixture();
  t.after(() => f.close());
  f.db
    .prepare(
      "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,createdAt,start) VALUES('history','qa-admin','qa-ch-65','scheduled','succeeded',0,'2026-10-07T04:00:00Z','2026-10-07T04:00:00Z')",
    )
    .run();
  const before = f.stats().planFingerprint;
  async function login(username) {
    const r = await fetch(f.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: f.base },
      body: JSON.stringify({ username, password: f.password }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  }
  const cookie = await login("qa-monitor");
  async function get(path, auth = cookie) {
    const r = await fetch(f.base + "/api/v1" + path, {
      headers: { Cookie: auth },
    });
    return { status: r.status, body: await r.json() };
  }
  assert.equal((await get("/recording-task-groups", "")).status, 401);
  const groups = await get("/recording-task-groups");
  assert.equal(groups.status, 200);
  assert.equal(groups.body.data.total, 1);
  assert.equal(groups.body.data.items[0].id, "qa-nvr");
  const detail = await get(
    "/recording-task-groups/qa-nvr/channels?date=2026-10-07",
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.items[0].job.id, "history");
  assert.equal(
    (await get("/recording-task-groups/qa-record/channels?date=2026-10-07"))
      .status,
    404,
  );
  assert.equal(
    (await get("/recording-task-groups?includeDeleted=1")).status,
    403,
  );
  assert.equal((await get("/recording-task-groups?page=NaN")).status, 400);
  assert.equal(
    (await get("/recording-task-groups/qa-nvr/channels?date=2026-02-30"))
      .status,
    400,
  );
  f.db.prepare("DELETE FROM user_groups WHERE userId='qa-monitor'").run();
  assert.equal((await get("/recording-task-groups")).body.data.total, 0);
  assert.equal(
    (await get("/recording-task-groups/qa-nvr/channels?date=2026-10-07"))
      .status,
    404,
  );
  assert.equal(f.stats().planFingerprint, before);
});

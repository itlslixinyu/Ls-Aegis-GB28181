import { test } from "node:test";
import assert from "node:assert/strict";
import { monitoringFixture } from "./test-support/monitoring-fixture.mjs";
test("分组录像HTTP权限、CSRF、跨组拒绝、幂等创建、版本与子计划保护", async (t) => {
  const f = await monitoringFixture();
  t.after(() => f.close());
  async function login(username) {
    const r = await fetch(f.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: f.password }),
    });
    return {
      cookie: r.headers.get("set-cookie").split(";")[0],
      csrf: (await r.json()).data.csrf,
    };
  }
  const admin = await login("qa-admin"),
    viewer = await login("qa-monitor");
  const call = (path, auth = admin, method = "GET", data, key) =>
    fetch(f.base + "/api/v1" + path, {
      method,
      headers: {
        cookie: auth.cookie,
        "X-CSRF-Token": auth.csrf,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  const v = {
    name: "HTTP分组录制",
    deviceGroupId: "qa-nvr",
    channelIds: ["qa-ch-65", "qa-ch-66"],
    enabled: false,
    days: [1, 2, 3, 4, 5, 6, 7],
    startTime: "00:00",
    endTime: "00:00",
    retentionDays: 7,
    segmentSeconds: 180,
  };
  assert.equal((await call("/recording-plan-groups", viewer)).status, 403);
  assert.equal(
    (await call("/recording-plan-groups", viewer, "POST", v)).status,
    403,
  );
  assert.equal(
    (await call("/recording-plan-groups", { ...admin, csrf: "" }, "POST", v))
      .status,
    403,
  );
  assert.equal(
    (
      await call("/recording-plan-groups", admin, "POST", {
        ...v,
        channelIds: ["qa-denied"],
      })
    ).status,
    400,
  );
  const created = await call(
    "/recording-plan-groups",
    admin,
    "POST",
    v,
    "test-create-0001",
  );
  assert.equal(created.status, 201);
  const p = (await created.json()).data;
  const repeat = (
    await (
      await call("/recording-plan-groups", admin, "POST", v, "test-create-0001")
    ).json()
  ).data;
  assert.equal(repeat.id, p.id);
  const details = await call(`/recording-plan-groups/${p.id}/channels`);
  assert.equal(details.status, 200);
  const members = (await details.json()).data.items;
  assert.equal(members.length, 2);
  assert.equal(
    (await call(`/recording-plan-groups/${p.id}/channels`, viewer)).status,
    403,
  );
  assert.equal(
    (
      await call(`/recording-plans/${members[0].id}/enabled`, admin, "PUT", {
        enabled: true,
      })
    ).status,
    409,
  );
  const enabled = await call(
    `/recording-plan-groups/${p.id}/enabled`,
    admin,
    "PUT",
    { enabled: false, version: p.version },
  );
  assert.equal(enabled.status, 200);
  const next = (await enabled.json()).data;
  assert.equal(
    (
      await call(`/recording-plan-groups/${p.id}/enabled`, admin, "PUT", {
        enabled: true,
        version: p.version,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/recording-plan-groups/${p.id}?version=${next.version}`,
        admin,
        "DELETE",
      )
    ).status,
    204,
  );
  assert.equal(f.stats().plan.enabled, 1);
  assert.equal(f.stats().recordStopped, 0);
});

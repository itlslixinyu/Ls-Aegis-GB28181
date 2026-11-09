import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { monitoringFixture } from "./test-support/monitoring-fixture.mjs";

test("128路录像机：分页与分组隔离、36路开关回收不停止后台录像", async (t) => {
  const f = await monitoringFixture();
  t.after(() => f.close());
  async function login(username) {
    const r = await fetch(f.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: f.base },
      body: JSON.stringify({ username, password: f.password }),
    });
    assert.equal(r.status, 200);
    const result = (await r.json()).data;
    const headers = {
      Cookie: r.headers.get("set-cookie").split(";")[0],
      Origin: f.base,
      "Content-Type": "application/json",
      "X-CSRF-Token": result.csrf,
    };
    return async (path, method = "GET", body, key) => {
      const res = await fetch(f.base + "/api/v1" + path, {
        method,
        headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        ...(res.status === 204 ? {} : await res.json()),
      };
    };
  }
  const call = await login("qa-monitor");
  for (let i = 0; i < 60 && f.stats().background?.status !== "recording"; i++)
    await delay(100);
  const before = f.stats();
  assert.equal(before.background.status, "recording");
  const pages = [];
  for (let page = 1; page <= 4; page++) {
    const res = await call(`/channels?page=${page}&pageSize=32`);
    assert.equal(res.status, 200);
    assert.equal(res.data.total, 128);
    assert.equal(res.data.items.length, 32);
    pages.push(...res.data.items);
  }
  assert.equal(pages[32].id, "qa-ch-33");
  assert.equal(pages[127].id, "qa-ch-128");
  assert.ok(pages.every((c) => c.deviceId === "qa-nvr"));
  assert.notEqual(
    (await call("/live-sessions", "POST", { channelId: "qa-denied" })).status,
    202,
  );
  const viewers = [];
  for (const channel of pages
    .filter((c) => c.status === "online")
    .slice(0, 36)) {
    const r = await call(
      "/live-sessions",
      "POST",
      { channelId: channel.id },
      "qa-" + channel.id,
    );
    assert.equal(r.status, 202);
    viewers.push(r.data);
  }
  assert.equal(f.stats().nvrViewers, 36);
  const repeat = await call(
    "/live-sessions",
    "POST",
    { channelId: "qa-ch-65" },
    "qa-qa-ch-65",
  );
  assert.equal(repeat.status, 202);
  assert.equal(f.stats().nvrViewers, 36);
  await Promise.all(
    viewers.map(async (v) =>
      assert.equal(
        (
          await call(
            `/live-sessions/${v.sessionId}/viewers/${v.viewerId}`,
            "DELETE",
          )
        ).status,
        204,
      ),
    ),
  );
  assert.equal(f.stats().nvrViewers, 0);
  assert.equal(f.stats().background.id, before.background.id);
  assert.equal(f.stats().background.status, "recording");
  assert.equal(f.stats().planFingerprint, before.planFingerprint);
  assert.equal(f.stats().recordStopped, 0);
  // Previewing the recording's own channel uses an independent source and
  // must not release the background recording viewer.
  const admin = await login("qa-admin");
  const preview = await admin("/live-sessions", "POST", {
    channelId: "qa-record",
  });
  assert.notEqual(preview.data.sessionId, before.background.sessionId);
  assert.equal(
    (
      await admin(
        `/live-sessions/${preview.data.sessionId}/viewers/${preview.data.viewerId}`,
        "DELETE",
      )
    ).status,
    204,
  );
  assert.equal(f.stats().background.status, "recording");
  assert.equal(f.stats().recordStopped, 0);
  assert.ok(
    f.db
      .prepare("SELECT 1 FROM viewers WHERE id=?")
      .get(before.background.viewerId),
  );
});

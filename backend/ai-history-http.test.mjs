import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { monitoringFixture } from "./test-support/monitoring-fixture.mjs";
import { AiSettings } from "./ai/settings.mjs";
test("录像按线索检索HTTP受理、CSRF、原文件定位及正式计划隔离", async (t) => {
  const settings = new AiSettings({ envKey: "" });
  settings.save({
    ...settings.public(),
    enabled: true,
    apiKey: "test-only-history-provider-key",
  });
  const picture = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "blue" },
  })
    .jpeg()
    .toBuffer();
  const f = await monitoringFixture({
    channelCount: 1,
    allOnline: true,
    aiSettings: settings,
    aiLocalModel: {
      run: async () => ({ embedding: Array(512).fill(1), ms: 1, rss: 1024 }),
      close() {},
    },
    aiArchiveReader: { duration: async () => 20, frame: async () => picture },
    aiFetcher: async () =>
      Response.json({
        model: "isolated-batch-test",
        choices: [
          {
            message: {
              content: JSON.stringify({
                matches: [
                  {
                    index: 1,
                    summary: "蓝色画面候选",
                    tags: ["蓝色"],
                    objects: [],
                    observations: [],
                  },
                ],
              }),
            },
          },
        ],
      }),
  });
  t.after(() => f.close());
  const c = f.db
    .prepare("SELECT id FROM channels ORDER BY id LIMIT 1")
    .get().id;
  f.db
    .prepare(
      "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt,start,end) VALUES('history-file-job','qa-admin',?,'scheduled','succeeded',?,'history-stream','2026-11-08T01:00:00+08:00','2026-11-08T01:00:00+08:00','2026-11-08T01:00:20+08:00')",
    )
    .run(c, Date.now());
  f.db.exec(
    "INSERT INTO recording_files VALUES('history-file','history-file-job','2026-11-08','2026-11-08-01-00-00-0.mp4')",
  );
  const plans = JSON.stringify(
    f.db.prepare("SELECT * FROM recording_plans ORDER BY id").all(),
  );
  async function login(username) {
    const r = await fetch(f.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: f.base, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: f.password }),
    });
    const j = await r.json();
    return {
      Cookie: r.headers.get("set-cookie").split(";")[0],
      Origin: f.base,
      "Content-Type": "application/json",
      "X-CSRF-Token": j.data.csrf,
    };
  }
  const headers = await login("qa-admin"),
    viewer = await login("qa-monitor");
  const body = {
    question: "寻找蓝色物体",
    from: "2026-11-08T01:00:00+08:00",
    to: "2026-11-08T01:00:20+08:00",
    channelIds: [c],
  };
  async function post(h) {
    return fetch(f.base + "/api/v1/ai/history-searches", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
  }
  assert.equal((await post({ ...headers, "X-CSRF-Token": "bad" })).status, 403);
  assert.equal((await post(viewer)).status, 403);
  const accepted = await post(headers);
  assert.equal(accepted.status, 202);
  const id = (await accepted.json()).data.id;
  let result;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    result = (
      await (
        await fetch(f.base + "/api/v1/ai/history-searches/" + id, { headers })
      ).json()
    ).data;
    if (!["queued", "running"].includes(result.status)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(result.status, "succeeded", result.error);
  assert.ok(result.items.length);
  assert.equal(result.items[0].recording.fileId, "history-file");
  assert.ok(result.modelCalls <= 4);
  assert.equal(
    JSON.stringify(
      f.db.prepare("SELECT * FROM recording_plans ORDER BY id").all(),
    ),
    plans,
  );
});

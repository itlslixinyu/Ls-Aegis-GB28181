import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { openStore } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { AiSettings } from "./ai/settings.mjs";
import { AiService } from "./ai/service.mjs";
test("AI账号并发/排队保护、取消和关闭可回收，不修改录像计划", async () => {
  const { db } = openStore(":memory:");
  db.prepare("INSERT INTO users VALUES('a','admin','unused','admin')").run();
  const settings = new AiSettings({ envKey: "" });
  settings.save({
    ...settings.public(),
    enabled: true,
    apiKey: "isolated-queue-key-not-real",
  });
  const image = await sharp({
    create: { width: 50, height: 50, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const ai = new AiService({
    db,
    access: new Access(db),
    settings,
    client: {
      analyze: async (_i, _q, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        }),
    },
    capture: {},
  });
  try {
    const body = {
        question: "测试排队",
        image: "data:image/jpeg;base64," + image.toString("base64"),
      },
      jobs = [];
    for (let i = 0; i < 5; i++)
      jobs.push(await ai.create("a", body, "queue-test-" + i));
    assert.equal(ai.running.size, 2);
    await assert.rejects(
      ai.create("a", body, "queue-test-6"),
      (e) => e.code === "AI_QUEUE_FULL",
    );
    const pending = ai.list("a").items.find((j) => j.status === "queued");
    ai.cancel("a", pending.id);
    assert.equal(ai.get("a", pending.id).status, "cancelled");
    await ai.close();
    assert.equal(ai.running.size, 0);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running')",
        )
        .get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM recording_plans").get().n,
      0,
    );
  } finally {
    await ai.close();
    db.close();
  }
});

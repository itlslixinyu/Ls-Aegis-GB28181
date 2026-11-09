import { test } from "node:test";
import assert from "node:assert/strict";
import { motionChanges, periodicOffsets, WIDTH, HEIGHT } from "./ai/motion.mjs";
import { parseLocalQuery, QueryCache } from "./ai/query-cache.mjs";
import { openStore } from "./lib/store.mjs";

test("变化检测定位局部活动并合并持续变化，均匀照明变化不触发", () => {
  const size = WIDTH * HEIGHT,
    first = Buffer.alloc(size, 30),
    lit = Buffer.alloc(size, 70);
  assert.deepEqual(motionChanges(Buffer.concat([first, lit]), 0), []);
  const moved = Buffer.from(first);
  for (let y = 12; y < 24; y++)
    for (let x = 20; x < 34; x++) moved[y * WIDTH + x] = 180;
  const events = motionChanges(Buffer.concat([first, moved, moved]), 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].offset, 11);
  assert.ok(
    events[0].region.x < 20 / WIDTH && events[0].region.right > 34 / WIDTH,
  );
  const periodic = periodicOffsets(0, 65, 30, 6);
  assert.ok(periodic.includes(30) && periodic.includes(60));
  const bounded = periodicOffsets(0, 900, 30, 3);
  assert.equal(bounded.length, 3);
  assert.equal(bounded[0], 0);
  assert.ok(bounded[2] > 890);
});

test("自由中文查询分段覆盖全文，解析/向量缓存跨实例复用且按账号隔离", () => {
  const { db } = openStore(":memory:");
  try {
    db.exec(
      "INSERT INTO users VALUES('a','a','unused','admin'),('b','b','unused','admin')",
    );
    const text = "寻找背着黑色双肩包、手拿雨伞并穿浅色外套的人。".repeat(5),
      parsed = parseLocalQuery(text);
    assert.equal(parsed.parts.join(""), text);
    assert.ok(parsed.parts.every((x) => Array.from(x).length <= 40));
    const now = Date.now(),
      cache = new QueryCache(db, () => now),
      embedding = Array(512).fill(0.1);
    cache.put(
      "a",
      text,
      parsed,
      embedding,
      new Date(now + 60000).toISOString(),
    );
    assert.equal(
      new QueryCache(db, () => now).get("a", text).parsed.text,
      text,
    );
    assert.equal(cache.get("b", text), null);
    assert.equal(new QueryCache(db, () => now + 61000).get("a", text), null);
  } finally {
    db.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import sharp from "sharp";
import { openStore } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { AiSettings } from "./ai/settings.mjs";
import { AiService } from "./ai/service.mjs";
import { LocalIndex, INDEX_VERSION } from "./ai/local-index.mjs";
import { packVector } from "./ai/history-samples.mjs";
const now = Date.parse("2026-11-08T08:00:00+08:00");
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "ls-idle-index-")),
    path = join(dir, "test.db");
  const { db } = openStore(path);
  db.exec(
    "INSERT INTO users VALUES('a','admin','unused','admin'),('v','viewer','unused','viewer'); INSERT INTO devices(id,deviceId,name,groupId,createdAt) VALUES('d','d','Camera','default','2026-11-08'); INSERT INTO channels VALUES('c','d','code','Camera','online'); INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt,start,end) VALUES('r','a','c','scheduled','succeeded',0,'stream','2026-11-08','2026-11-07T16:00:00Z','2026-11-08T16:00:00Z'); INSERT INTO recording_files VALUES('f','r','2026-11-08','2026-11-08-01-00-00-0.mp4');",
  );
  const settings = new AiSettings({ envKey: "" });
  settings.save({ ...settings.public(), indexEnabled: true }, { userId: "a" });
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const calls = { frames: [], images: 0, texts: 0 },
    vector = Array(512).fill(1);
  let version = "v1";
  const reader = {
    fingerprint: async () => version,
    duration: async () => 300,
    frame: async (f, at) => {
      calls.frames.push(at);
      return image;
    },
  };
  const local = {
    run: async (input) => {
      if (input.image) calls.images++;
      else calls.texts++;
      return { embedding: vector, ms: 1 };
    },
    close() {},
  };
  const ai = new AiService({
    db,
    access: new Access(db),
    settings,
    archiveReader: reader,
    localModel: local,
    now: () => now,
    capture: {
      frame() {
        throw Error("No live capture");
      },
    },
    client: {
      searchFrames() {
        throw Error("No external call");
      },
    },
  });
  clearInterval(ai.timer);
  clearInterval(ai.history.timer);
  clearInterval(ai.history.index.timer);
  t.after(async () => {
    await ai.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    directory: dir,
    db,
    ai,
    settings,
    calls,
    reader,
    local,
    image,
    vector,
    setVersion: (v) => {
      version = v;
    },
  };
}
async function finish(f, id) {
  for (let i = 0; i < 1000; i++) {
    const r = f.ai.history.get("a", id);
    if (!["queued", "running"].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("query timeout");
}
const query = {
  question: "红色汽车",
  verify: false,
  channelIds: ["c"],
  from: "2026-11-08T01:00:00+08:00",
  to: "2026-11-08T01:05:00+08:00",
};
test("配置容量、保留期和启用人严格校验，内部身份不回传", () => {
  const s = new AiSettings({ envKey: "" });
  assert.throws(() => s.save({ ...s.public(), indexEnabled: true }), /管理员/);
  for (const bad of [
    { indexCapacityMiB: 63 },
    { indexRetentionDays: 0 },
    { indexCapacityMiB: 32769 },
    { indexEnabled: "yes" },
  ])
    assert.throws(() => s.save({ ...s.public(), ...bad }, { userId: "a" }));
  s.save(
    { ...s.public(), indexEnabled: true, indexOwnerId: "forged" },
    { userId: "a" },
  );
  assert.equal(s.state.indexOwnerId, "a");
  assert.equal("indexOwnerId" in s.public(), false);
});
test("逐帧提交游标，关闭重新建立调度器后从断点继续，不重复抽帧", async (t) => {
  const f = await setup(t);
  await f.ai.history.index.tick();
  assert.equal(
    f.db.prepare("SELECT nextOffset FROM ai_index_files").get().nextOffset,
    30,
  );
  await f.ai.history.index.close();
  f.ai.history.index = new LocalIndex(f.ai.history);
  clearInterval(f.ai.history.index.timer);
  await f.ai.history.index.tick();
  assert.deepEqual(f.calls.frames, [0, 30]);
  for (let i = 0; i < 8; i++) await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().files, 1);
  assert.equal(f.calls.frames.length, 10);
  await f.ai.history.index.tick();
  assert.equal(f.calls.frames.length, 10);
  assert.equal(
    f.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
});
test("文字和参考图检索均优先匹配本地索引，复查缓存复用，保留录像定位", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 10; i++) await f.ai.history.index.tick();
  const before = f.calls.images;
  const first = await finish(
    f,
    f.ai.history.create("a", query, "index-text").id,
  );
  assert.ok(["partial", "succeeded"].includes(first.status), first.error);
  assert.equal(first.localMetrics.indexedFiles, 1);
  assert.equal(first.localMetrics.indexHits, 10);
  assert.equal(f.calls.texts, 1);
  assert.ok(f.calls.images - before <= 24);
  assert.ok(first.items.length > 0);
  assert.equal(first.items[0].recordingFileId, "f");
  const beforeRepeat = f.calls.frames.length;
  const ref = await f.ai.create(
    "a",
    {
      question: "参考图",
      image: "data:image/jpeg;base64," + f.image.toString("base64"),
      reference: true,
      localReference: true,
    },
    "ref-index",
  );
  const second = await finish(
    f,
    f.ai.history.create(
      "a",
      { ...query, question: "", referenceId: ref.id },
      "index-image",
    ).id,
  );
  assert.equal(second.localMetrics.indexedFiles, 1);
  assert.equal(second.localMetrics.indexHits, 10);
  assert.equal(f.calls.frames.length, beforeRepeat);
  assert.equal(
    f.db.prepare("SELECT status FROM recording_jobs WHERE id='r'").get().status,
    "succeeded",
  );
  assert.throws(() => f.ai.history.get("v", first.id), /不存在|无权|权限/);
});
test("预览/前台任务到来取消后台读取，游标不超前；释放后可续建", async (t) => {
  const f = await setup(t);
  let started;
  const ready = new Promise((r) => {
    started = r;
  });
  f.reader.frame = async (file, at, signal) => {
    started();
    await new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  };
  const pending = f.ai.history.index.tick();
  await ready;
  f.ai.history.index.playbacks++;
  await f.ai.history.index.suspend();
  await pending;
  assert.equal(
    f.db.prepare("SELECT nextOffset FROM ai_index_files").get().nextOffset,
    0,
  );
  assert.equal(f.ai.history.index.status().frames, 0);
  f.ai.history.index.playbacks--;
  f.reader.frame = async () => f.image;
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().frames, 1);
  f.ai.running.set("front", {});
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().frames, 1);
  f.ai.running.clear();
  f.settings.save({ ...f.settings.public(), localEnabled: false });
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().frames, 1);
});
test("源版本变动重建，容量及保留清理只删除索引，删除录像级联回收统计", async (t) => {
  const f = await setup(t);
  await f.ai.history.index.tick();
  f.setVersion("v2");
  await f.ai.history.index.tick();
  assert.deepEqual(f.calls.frames, [0, 0]);
  assert.equal(f.ai.history.index.status().frames, 1);
  f.db
    .prepare("INSERT INTO recording_files VALUES(?,?,?,?)")
    .run("f2", "r", "2026-11-08", "2026-11-08-02-00-00-0.mp4");
  f.db
    .prepare(
      "INSERT INTO ai_index_files(fileId,sourceVersion,modelVersion,duration,nextOffset,state,updatedAt,expiresAt,retryAt) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run("f2", "v", INDEX_VERSION, 60, 60, "ready", 0, now + 86400000, 0);
  // Large synthetic records exercise quota eviction without decoding huge images.
  f.db
    .prepare("INSERT INTO ai_index_frames VALUES(?,?,?,?,?,?,?)")
    .run(
      "f2",
      0,
      Buffer.alloc(65 * 1048576),
      "hash",
      320,
      180,
      packVector(f.vector),
    );
  f.settings.save({ ...f.settings.public(), indexCapacityMiB: 64 });
  f.ai.history.index.maintain();
  assert.ok(f.ai.history.index.status().bytes <= 64 * 1048576);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM recording_files").get().n,
    2,
  );
  f.db.prepare("UPDATE ai_index_files SET expiresAt=?").run(now - 1);
  f.ai.history.index.maintain();
  assert.equal(f.ai.history.index.status().frames, 0);
  await f.ai.history.index.tick();
  assert.ok(f.ai.history.index.status().bytes > 0);
  f.db.prepare("DELETE FROM recording_files WHERE id='f'").run();
  assert.equal(f.ai.history.index.status().bytes, 0);
});
test("后台启用人失去权限后立即停止，未完成索引仍走原检索补查", async (t) => {
  const f = await setup(t);
  await f.ai.history.index.tick();
  const original = f.ai.access.can.bind(f.ai.access);
  f.ai.access.can = (u, p) => (p === "ai.configure" ? false : original(u, p));
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().frames, 1);
  const r = await finish(
    f,
    f.ai.history.create("a", query, "partial-index").id,
  );
  assert.equal(r.localMetrics.indexedFiles, 0);
  assert.ok(r.localMetrics.cacheMisses > 0);
  assert.equal(r.error, null);
});

test("后台录像自身的媒体租约不阻止空闲索引，真实观看租约立即阻止", async (t) => {
  const f = await setup(t);
  f.db.exec(
    "INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt) VALUES('ls','c','d','test-live','ready','2026-11-08');",
  );
  f.db
    .prepare("INSERT INTO viewers VALUES(?,?,?,?)")
    .run("rec-view", "ls", "a", now + 60000);
  f.db
    .prepare(
      "UPDATE recording_jobs SET viewerId='rec-view',status='recording' WHERE id='r'",
    )
    .run();
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().frames, 1);
  f.db
    .prepare("INSERT INTO viewers VALUES(?,?,?,?)")
    .run("human-view", "ls", "a", now + 60000);
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().frames, 1);
  assert.equal(f.ai.history.index.status().state, "预览与回放优先");
});
test("完整服务在持久数据库副本上重启后续建，迁移幂等且不重复起点", async (t) => {
  const f = await setup(t);
  await f.ai.history.index.tick();
  await f.ai.history.index.close();
  const path = join(f.directory, "restart.db");
  await backup(f.db, path);
  const { db } = openStore(path);
  const ai = new AiService({
    db,
    access: new Access(db),
    settings: f.settings,
    archiveReader: f.reader,
    localModel: f.local,
    now: () => now,
  });
  clearInterval(ai.timer);
  clearInterval(ai.history.timer);
  clearInterval(ai.history.index.timer);
  try {
    await ai.history.index.tick();
    assert.deepEqual(f.calls.frames, [0, 30]);
    assert.equal(
      db.prepare("SELECT nextOffset FROM ai_index_files").get().nextOffset,
      60,
    );
    assert.equal(
      db.prepare("SELECT max(version) v FROM migrations").get().v,
      23,
    );
  } finally {
    await ai.close();
    db.close();
  }
});
test("变化扫描的待处理帧也持久保存，暂停续建不重扫整个窗口", async (t) => {
  const f = await setup(t);
  let scans = 0;
  f.reader.motion = async () => {
    scans++;
    return {
      events: [{ offset: 10 }, { offset: 11 }, { offset: 22 }],
      scannedSeconds: 30,
    };
  };
  await f.ai.history.index.tick();
  assert.equal(
    f.db.prepare("SELECT nextOffset FROM ai_index_files").get().nextOffset,
    0,
  );
  await f.ai.history.index.close();
  f.ai.history.index = new LocalIndex(f.ai.history);
  clearInterval(f.ai.history.index.timer);
  await f.ai.history.index.tick();
  await f.ai.history.index.tick();
  assert.deepEqual(f.calls.frames, [0, 10, 22]);
  assert.equal(scans, 1);
  assert.equal(
    f.db.prepare("SELECT nextOffset FROM ai_index_files").get().nextOffset,
    30,
  );
});
test("同通道先完成当前文件，多通道逐帧轮转，不把整个档案都停在首帧", async (t) => {
  const f = await setup(t);
  let clock = now;
  f.ai.history.index.now = () => clock;
  f.reader.duration = async () => 65;
  f.db.exec(
    "INSERT INTO channels VALUES('c2','d','code2','Second','online');INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt) VALUES('r2','a','c2','scheduled','succeeded',0,'second','2026-11-08');INSERT INTO recording_files VALUES('f2','r','2026-11-08','2026-11-08-02-00-00-0.mp4'),('g','r2','2026-11-08','2026-11-08-01-00-00-0.mp4');",
  );
  const calls = [];
  f.reader.frame = async (file, at) => {
    calls.push([file.id, at]);
    return f.image;
  };
  for (let i = 0; i < 6; i++) {
    await f.ai.history.index.tick();
    clock += 2000;
  }
  assert.deepEqual(calls.slice(0, 5), [
    ["f", 0],
    ["g", 0],
    ["f", 30],
    ["g", 30],
    ["f", 60],
  ]);
  assert.deepEqual(calls[5], ["f2", 0]);
  await f.ai.history.index.tick();
  assert.deepEqual(calls.at(-1), ["g", 60]);
  assert.equal(f.ai.history.index.status().files, 2);
});

test("真实录像不足一秒尾段正常收尾，极短视频也不请求无效变化扫描", async (t) => {
  const f = await setup(t);
  f.reader.duration = async () => 180.095;
  f.reader.motion = async (file, a, b) => {
    assert.ok(b - a >= 1);
    return { events: [] };
  };
  for (let i = 0; i < 7; i++) await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().files, 1);
  assert.equal(f.calls.frames.length, 6);
  assert.equal(
    f.db.prepare("SELECT nextOffset FROM ai_index_files").get().nextOffset,
    180.095,
  );
  f.setVersion("short");
  f.db.prepare("UPDATE ai_index_files SET updatedAt=?").run(now - 7200000);
  f.reader.duration = async () => 0.5;
  f.reader.motion = async () => {
    throw Error("must not scan a fractional window");
  };
  await f.ai.history.index.tick();
  assert.equal(f.ai.history.index.status().files, 1);
  assert.equal(f.calls.frames.at(-1), 0);
});
test('升级前已保存的不足一秒尾帧队列可幂等修复，仅收尾索引，不改原录像',async t=>{
 const {repairIndexTails}=await import('../scripts/repair-ai-index-tail.mjs');
 const f=await setup(t);await f.ai.history.index.tick();
 f.db.prepare("UPDATE ai_index_files SET duration=30.095,nextOffset=30,state='error',pendingOffsets='[30]'").run();
 assert.equal(repairIndexTails(f.db,now),1);assert.equal(repairIndexTails(f.db,now),0);
 const row=f.db.prepare('SELECT state,nextOffset,pendingOffsets FROM ai_index_files').get();assert.equal(row.state,'ready');assert.equal(row.nextOffset,30.095);assert.equal(row.pendingOffsets,'[]');
 assert.equal(f.db.prepare('SELECT count(*) n FROM recording_files').get().n,1);assert.equal(f.db.prepare("SELECT status FROM recording_jobs WHERE id='r'").get().status,'succeeded');
 f.db.prepare("UPDATE ai_index_files SET nextOffset=30,state='error',pendingOffsets='[25,30]'").run();assert.equal(repairIndexTails(f.db,now),0);
});

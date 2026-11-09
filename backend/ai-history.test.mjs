import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { openStore } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { AiService } from "./ai/service.mjs";
import { AiSettings } from "./ai/settings.mjs";
async function fixture(t, match) {
  const { db } = openStore(":memory:");
  const now = Date.parse("2026-11-08T08:00:00+08:00");
  db.exec(
    "INSERT INTO users VALUES('a','admin','unused','admin'),('v','viewer','unused','viewer');INSERT INTO devices(id,deviceId,name,groupId,createdAt) VALUES('d','d','Camera','default','2026-11-08');INSERT INTO channels VALUES('c','d','code','Camera','online');",
  );
  db.prepare(
    "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt,start,end) VALUES('r','a','c','scheduled','succeeded',?,'stream',?,?,?)",
  ).run(
    now,
    new Date(now).toISOString(),
    "2026-11-07T16:00:00Z",
    "2026-11-08T16:00:00Z",
  );
  db.exec(
    "INSERT INTO recording_files VALUES('f','r','2026-11-08','2026-11-08-01-00-00-0.mp4')",
  );
  const settings = new AiSettings({ envKey: "" });
  settings.save({
    ...settings.public(),
    enabled: true,
    apiKey: "unit-test-not-a-real-provider-key",
  });
  const pixels = Buffer.from(
    Array.from(
      { length: 80 * 60 * 3 },
      (_, i) => (i * 29 + Math.floor(i / 7) * 11) % 256,
    ),
  );
  const image = await sharp(pixels, {
      raw: { width: 80, height: 60, channels: 3 },
    })
      .jpeg()
      .toBuffer(),
    calls = [];
  const ai = new AiService({
    db,
    access: new Access(db),
    settings,
    now: () => now,
    localModel: {
      run: async () => ({ embedding: Array(512).fill(1), ms: 1, rss: 1024 }),
      close() {},
    },
    archiveReader: {
      fingerprint: async () => "immutable-test-source",
      duration: async () => 65,
      frame: async (f, offset) => {
        calls.push(offset);
        return image;
      },
    },
    capture: {
      frame: () => {
        throw Error("Live source must not be opened");
      },
    },
    client: {
      searchFrames:
        match ||
        async function (frames) {
          return [
            {
              index: 0,
              analysis: {
                summary: "红色汽车",
                tags: ["红色", "汽车"],
                objects: [],
                observations: [],
              },
              model: "test",
              usage: {},
            },
          ];
        },
    },
  });
  clearInterval(ai.timer);
  clearInterval(ai.history.timer);
  t.after(async () => {
    await ai.close();
    db.close();
  });
  return { ai, db, calls, image };
}
const params = {
  question: "找红色汽车",
  from: "2026-11-08T01:00:00+08:00",
  to: "2026-11-08T01:02:00+08:00",
  channelIds: ["c"],
};
test('录像检索不与等待它的Qwen队列互相阻塞，普通AI排队仍优先', async t => {
  const {ai,db}=await fixture(t);
  const now='2026-11-08T00:00:00.000Z';
  db.prepare("INSERT INTO ai_jobs(id,ownerId,sourceName,sourceType,status,question,createdAt,expiresAt) VALUES('qwen-wait','a','告警图','upload','queued','描述',?,?)").run(now,'2026-11-09T00:00:00.000Z');
  db.prepare("INSERT INTO alarm_ai_jobs(snapshotId,jobId,deviceId,channelId,alarmId,queuedAt,capturedAt) VALUES('photo','qwen-wait','d','c','alarm',?,?)").run(now,now);
  await ai.history.capacity({id:'capacity-check',ownerId:'a'},AbortSignal.timeout(100));
  db.prepare("INSERT INTO ai_jobs(id,ownerId,sourceName,sourceType,status,question,createdAt,expiresAt) VALUES('cloud-wait','a','上传','upload','queued','描述',?,?)").run(now,'2026-11-09T00:00:00.000Z');
  await assert.rejects(ai.history.capacity({id:'capacity-check',ownerId:'a'},AbortSignal.timeout(60)));
});
async function done(ai, id) {
  for (let i = 0; i < 3000; i++) {
    const s = ai.history.get("a", id);
    if (!["queued", "running"].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("timeout");
}
test("按线索检索历史录像，拼批与候选细查、定位结果，不点播不修改录像", async (t) => {
  const f = await fixture(t);
  const created = f.ai.history.create("a", params, "query-test-1");
  const result = await done(f.ai, created.id);
  assert.equal(result.status, "succeeded", result.error);
  assert.ok(result.sampleCount >= 2);
  assert.ok(result.modelCalls <= 4);
  assert.ok(
    result.items[0].recording.url.includes("/recording-jobs/r/files/f?play=1"),
  );
  assert.equal(
    f.db.prepare("SELECT status FROM recording_jobs").get().status,
    "succeeded",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM recording_plans").get().n,
    0,
  );
  const repeated = await done(
    f.ai,
    f.ai.history.create("a", params, "query-test-2").id,
  );
  assert.equal(repeated.localMetrics.cacheHits, result.sampleCount);
  assert.equal(repeated.localMetrics.queryCacheHit, true);
  assert.equal(repeated.modelCalls, 0);
  assert.equal(f.calls.length, result.sampleCount);
  const frameId = result.items[0].id;
  f.db.exec("DELETE FROM recording_files WHERE id='f'");
  assert.throws(
    () => f.ai.get("a", frameId),
    (e) => e.status === 404,
  );
  assert.equal(f.ai.history.get("a", created.id).total, 0);
  assert.throws(
    () => f.ai.history.get("v", created.id),
    (e) => e.status === 403,
  );
});
test("查询范围校验，空命中不伪造完整扫描结果", async (t) => {
  const f = await fixture(t, async () => []);
  assert.throws(
    () =>
      f.ai.history.create(
        "a",
        { ...params, to: "2026-11-10T01:00:00+08:00" },
        "invalid-query",
      ),
    (e) => e.status === 400,
  );
  const s = await done(
    f.ai,
    f.ai.history.create("a", params, "no-match-test").id,
  );
  assert.equal(s.total, 0);
  assert.match(s.method, /候选|抽样/);
  assert.equal(s.modelCalls, 1);
});
test("取消在途检索后迟到模型结果不能发布，文件删除移除相关画面", async (t) => {
  let release;
  const f = await fixture(t, () => new Promise((r) => (release = r)));
  const created = f.ai.history.create("a", params, "cancel-query-test");
  for (let i = 0; i < 1200 && !release; i++)
    await new Promise((r) => setTimeout(r, 5));
  f.ai.history.cancel("a", created.id);
  release([]);
  const s = await done(f.ai, created.id);
  assert.equal(s.status, "cancelled");
  assert.equal(s.total, 0);
});

test("不同文字查询复用帧和特征，文件版本变化后重新读取；删除录像清理缓存", async (t) => {
  const f = await fixture(t);
  const first = await done(
    f.ai,
    f.ai.history.create("a", params, "cache-first-query").id,
  );
  const second = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, question: "白色汽车" },
      "cache-second-query",
    ).id,
  );
  assert.equal(second.localMetrics.cacheHits, first.sampleCount);
  assert.equal(f.calls.length, first.sampleCount);
  f.ai.history.reader.fingerprint = async () => "source-replaced";
  const changed = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, question: "黑色汽车" },
      "cache-changed-query",
    ).id,
  );
  assert.equal(changed.localMetrics.cacheMisses, first.sampleCount);
  assert.equal(f.calls.length, first.sampleCount * 2);
  assert.ok(
    f.db.prepare("SELECT count(*) n FROM ai_feature_cache").get().n > 0,
  );
  f.db.exec("DELETE FROM recording_files WHERE id='f'");
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ai_feature_cache").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ai_duration_cache").get().n,
    0,
  );
});

test("本地检索无需密钥；参考图片不发送外部模型；相似候选明确标识未复核", async (t) => {
  const f = await fixture(t, () => {
    throw Error("must not call provider");
  });
  f.ai.settings.save({ ...f.ai.settings.public(), clearKey: true });
  const ref = await f.ai.create(
    "a",
    {
      question: "本地参考图",
      image: "data:image/jpeg;base64," + f.image.toString("base64"),
      reference: true,
      localReference: true,
    },
    "local-reference-test",
  );
  assert.equal(ref.status, "succeeded");
  assert.equal(ref.model, "local-reference");
  const result = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, question: "", referenceId: ref.id, verify: false },
      "local-no-key-test",
    ).id,
  );
  assert.equal(result.modelCalls, 0);
  assert.equal(result.total, 1);
  assert.ok(result.items[0].usage.segment.sampleCount>1);
  assert.match(result.items[0].result.summary, /相似画面/);
  assert.throws(
    () =>
      f.ai.history.create(
        "a",
        { ...params, verify: true },
        "verify-no-key-test",
      ),
    (e) => e.code === "AI_KEY_REQUIRED",
  );
});

test("本地筛选最多四张候选且只一次外部复核，缓存不绕过当前权限", async (t) => {
  let submitted = 0;
  const f = await fixture(t, async (frames) => {
    submitted += frames.length;
    return [];
  });
  for (let i = 1; i < 6; i++)
    f.db
      .prepare("INSERT INTO recording_files VALUES(?,?,?,?)")
      .run(
        "f" + i,
        "r",
        "2026-11-08",
        `2026-11-08-01-${String(i * 2).padStart(2, "0")}-00-0.mp4`,
      );
  const result = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, to: "2026-11-08T01:12:00+08:00" },
      "shortlist-limit-test",
    ).id,
  );
  assert.ok(result.sampleCount > 48);
  assert.ok(result.localMetrics.refinedSamples > 0);
  assert.ok(submitted>0&&submitted<=4);
  assert.equal(result.modelCalls, 1);
  f.db.exec(
    "UPDATE users SET role='viewer' WHERE id='a'; UPDATE user_authorizations SET roleId='viewer',scopeMode='groups' WHERE userId='a'",
  );
  assert.throws(
    () => f.ai.history.get("a", result.id),
    (e) => e.status === 403,
  );
});

test("变化区域、定期补帧与前后精查共同检索；再次查询复用运动及查询缓存", async (t) => {
  const f = await fixture(t);
  let scans = 0;
  f.ai.history.reader.motion = async (file, begin, end) => {
    scans++;
    return {
      scannedSeconds: end - begin,
      events: [
        {
          offset: begin + 1,
          score: 0.1,
          region: { x: 0.1, y: 0.1, right: 0.6, bottom: 0.7 },
        },
      ],
    };
  };
  const first = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, question: "背着双肩包并手拿雨伞的人" },
      "motion-first-test",
    ).id,
  );
  assert.equal(first.status, "succeeded");
  assert.ok(
    first.localMetrics.motionEvents > 0 &&
      first.localMetrics.periodicSamples > 0 &&
      first.localMetrics.refinedSamples > 0 &&
      first.localMetrics.focusSamples > 0,
  );
  assert.equal(first.modelCalls, 1);
  const reads = f.calls.length;
  const repeated = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, question: "背着双肩包并手拿雨伞的人" },
      "motion-second-test",
    ).id,
  );
  assert.equal(scans, 3);
  assert.equal(f.calls.length, reads);
  assert.equal(repeated.localMetrics.motionCacheHits, 3);
  assert.equal(repeated.localMetrics.queryCacheHit, true);
  assert.equal(repeated.modelCalls, 0);
  f.db.exec("DELETE FROM recording_files WHERE id='f'");
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ai_motion_cache").get().n,
    0,
  );
});

test("运动扫描迟到响应在撤权后不写入缓存或发布结果", async (t) => {
  const f = await fixture(t);
  let release;
  f.ai.history.reader.motion = () => new Promise((r) => (release = r));
  const created = f.ai.history.create("a", params, "motion-revoke-test");
  for (let i = 0; i < 1000 && !release; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(typeof release, "function");
  f.db.exec(
    "UPDATE users SET role='viewer' WHERE id='a';UPDATE user_authorizations SET roleId='viewer',scopeMode='groups' WHERE userId='a'",
  );
  release({ events: [], scannedSeconds: 15 });
  await f.ai.history.running?.promise;
  assert.equal(
    f.db
      .prepare("SELECT status FROM ai_history_searches WHERE id=?")
      .get(created.id).status,
    "failed",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ai_motion_cache").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM ai_history_matches").get().n,
    0,
  );
});

test("活动录像达到保护阈值时不解码也不调用模型，仍可取消", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++)
    f.db
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,createdAt) VALUES(?,'a','c','scheduled','recording',0,'2026-11-08')",
      )
      .run("busy" + i);
  const created = f.ai.history.create("a", params, "recording-priority-test");
  assert.equal(f.ai.history.get("a", created.id).phase, "waiting-resources");
  assert.equal(f.calls.length, 0);
  f.ai.history.cancel("a", created.id);
  assert.equal((await done(f.ai, created.id)).status, "cancelled");
});

test("局部采样失败不跳过变化扫描，模型故障则保留准确错误并终止", async (t) => {
  const f = await fixture(t);
  const original = f.ai.history.reader.frame;
  let scans = 0;
  f.ai.history.reader.frame = async (file, offset) => {
    if (offset === 64)
      throw Object.assign(Error("tail unavailable"), { status: 502 });
    return original(file, offset);
  };
  f.ai.history.reader.motion = async (f, begin, end) => {
    scans++;
    return { events: [], scannedSeconds: end - begin };
  };
  const result = await done(
    f.ai,
    f.ai.history.create("a", params, "tail-failure-test").id,
  );
  assert.equal(result.status, "partial");
  assert.equal(scans, 3);
  assert.ok(result.total > 0);
  f.ai.history.local.run = async () => {
    throw Object.assign(Error("local inference failed"), {
      status: 503,
      code: "AI_LOCAL_INFERENCE",
    });
  };
  f.ai.history.reader.fingerprint = async () => "changed";
  const failed = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, question: "穿着浅色外套的人" },
      "model-failure-test",
    ).id,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "local inference failed");
});

test("不再按每小时六次限制；超过原文件和帧数仍继续处理并展示全部画面", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 7; i++) {
    const result = await done(
      f.ai,
      f.ai.history.create(
        "a",
        { ...params, verify: false, to: "2026-11-08T01:00:05+08:00" },
        "unlimited-user-query-" + i,
      ).id,
    );
    assert.equal(result.status, "succeeded");
  }
  for (let i = 1; i < 16; i++)
    f.db
      .prepare("INSERT INTO recording_files VALUES(?,?,?,?)")
      .run(
        "many" + i,
        "r",
        "2026-11-08",
        `2026-11-08-01-${String(i * 2).padStart(2, "0")}-00-0.mp4`,
      );
  const result = await done(
    f.ai,
    f.ai.history.create(
      "a",
      { ...params, verify: false, to: "2026-11-08T01:33:00+08:00" },
      "all-files-analysis",
    ).id,
  );
  assert.equal(result.fileCount, 16);
  assert.ok(result.sampleCount > 48);
  const page1 = f.ai.history.get("a", result.id, 1, "samples"),
    page2 = f.ai.history.get("a", result.id, 2, "samples");
  assert.equal(page1.total, result.sampleCount);
  assert.equal(page1.items.length, 12);
  assert.equal(page2.items.length, 12);
  assert.notEqual(page1.items[0].id, page2.items[0].id);
  assert.equal(JSON.stringify(page1).includes("embedding"), false);
});

test("分析画面在云复核前可见；取消保留已分析数据，设备事件优先定位", async (t) => {
  let release;
  const f = await fixture(t, () => new Promise((r) => (release = r)));
  let seconds = 0;
  f.ai.history.reader.motion = async (file, begin, end) => {
    seconds += end - begin;
    return { events: [], scannedSeconds: end - begin };
  };
  f.db
    .prepare(
      "INSERT INTO alarms(id,deviceId,deviceName,targetCode,channelId,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint) VALUES('camera-event','d','Camera','code','c',1,'5','motion','移动侦测',?,?,?,'event-fingerprint')",
    )
    .run(
      "2026-11-07T17:00:23Z",
      "2026-11-07T17:00:23Z",
      "2026-11-07T17:00:23Z",
    );
  const created = f.ai.history.create("a", params, "stream-visible-test");
  for (let i = 0; i < 2000 && !release; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(typeof release, "function");
  const data = f.ai.history.get("a", created.id, 1, "samples");
  assert.ok(data.total > 4);
  assert.ok(seconds < 65);
  assert.equal(data.localMetrics.deviceEvents, 1);
  const row = f.db
    .prepare(
      "SELECT id FROM ai_history_samples WHERE searchId=? AND reason='device-event'",
    )
    .get(created.id);
  assert.ok(row);
  const reference = `sample:${created.id}:${row.id}`;
  assert.equal(f.ai.history.referenceJob("a", reference).status, "succeeded");
  assert.ok(f.ai.history.referenceImage("a", reference).length > 0);
  f.ai.history.cancel("a", created.id);
  release([]);
  await f.ai.history.running?.promise;
  assert.ok(f.ai.history.get("a", created.id, 1, "samples").total > 0);
  assert.equal(f.ai.history.get("a", created.id).status, "cancelled");
  assert.throws(
    () => f.ai.history.samples.row("v", created.id, row.id),
    (e) => e.status === 403,
  );
});

test("本地接入独立于大模型开关和密钥，停用本地接入后拒绝新检索", async (t) => {
  const f = await fixture(t, () => {
    throw Error("Cloud must not be called");
  });
  f.ai.settings.save({
    ...f.ai.settings.public(),
    enabled: false,
    localEnabled: true,
    clearKey: true,
  });
  const first = await done(
    f.ai,
    f.ai.history.create("a", params, "local-independent-query").id,
  );
  assert.equal(first.status, "succeeded", first.error);
  assert.equal(first.modelCalls, 0);
  assert.ok(first.sampleCount > 0);
  assert.equal(f.ai.settings.public().hasKey, false);
  assert.throws(
    () =>
      f.ai.history.create(
        "a",
        { ...params, verify: true },
        "cloud-disabled-query",
      ),
    (e) => e.code === "AI_KEY_REQUIRED",
  );
  f.ai.settings.save({ ...f.ai.settings.public(), localEnabled: false });
  assert.throws(
    () =>
      f.ai.history.create(
        "a",
        { ...params, verify: false },
        "local-disabled-query",
      ),
    (e) => e.code === "AI_DISABLED",
  );
  assert.throws(
    () =>
      f.ai.settings.save({ ...f.ai.settings.public(), localEnabled: "yes" }),
    (e) => e.code === "INVALID_AI_CONFIG",
  );
});

test('全天粗筛仍检查末尾文件，设备线索触发全局精查且结果合并片段',async t=>{
 const f=await fixture(t,()=>{throw Error('No external model allowed')});
 f.db.exec('DELETE FROM recording_files');
 f.ai.history.reader.duration=async()=>1800;
 let motionSeconds=0;
 f.ai.history.reader.motion=async(_f,a,b)=>{motionSeconds+=b-a;return {events:[],scannedSeconds:b-a};};
 for(let i=0;i<48;i++){
  const hour=String(Math.floor(i/2)).padStart(2,'0'),minute=i%2?'30':'00';
  f.db.prepare('INSERT INTO recording_files VALUES(?,?,?,?)').run('day-'+i,'r','2026-11-08',`2026-11-08-${hour}-${minute}-00-0.mp4`);
 }
 const time=new Date('2026-11-08T23:44:37+08:00').toISOString();
 f.db.prepare("INSERT INTO alarms(id,deviceId,deviceName,targetCode,channelId,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint) VALUES('late-event','d','Camera','code','c',1,'5','motion','移动侦测',?,?,?,'late-event')").run(time,time,time);
 const result=await done(f.ai,f.ai.history.create('a',{...params,from:'2026-11-08T00:00:00+08:00',to:'2026-11-09T00:00:00+08:00',verify:false},'adaptive-day-test').id);
 assert.equal(result.fileCount,48);assert.equal(result.status,'partial');assert.equal(result.truncated,true);
 assert.equal(result.localMetrics.sampleIntervalSeconds,300);assert.equal(result.localMetrics.periodicSamples,289);
 assert.ok(result.localMetrics.refinedSamples<=24);assert.ok(result.sampleCount<340);assert.equal(motionSeconds,240);assert.equal(result.modelCalls,0);
 assert.ok(f.db.prepare("SELECT 1 FROM ai_history_samples WHERE searchId=? AND fileId='day-47' AND reason='device-event'").get(result.id));
 assert.ok(f.db.prepare("SELECT 1 FROM ai_history_samples WHERE searchId=? AND fileId='day-47' AND reason='refined'").get(result.id));
 assert.ok(result.items.every(item=>item.usage.segment));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiResultKind,
  aiResultSummary,
  aiTargetCount,
  aiConfidence,
} from "../frontend/src/ai-types.ts";
test("参考图、候选、采样与千问结果不混淆，兼容历史文案", () => {
  const ref = {
    model: "local-reference",
    result: { summary: "本地检索参考图，未调用外部模型分析" },
  };
  assert.equal(aiResultSummary(ref), "检索参考图");
  const candidate = {
    model: "local-chinese-clip",
    result: { summary: "本地相似候选（尚未复核）" },
  };
  assert.equal(aiResultSummary(candidate), "相似画面");
  assert.equal(
    aiResultKind({
      historySample: {},
      result: { summary: "已分析画面，尚未复核" },
    }),
    "录像采样画面",
  );
  assert.equal(
    aiResultSummary({
      model: "local-qwen-test",
      result: { summary: "道路上有白色汽车" },
    }),
    "道路上有白色汽车",
  );
});
test("不将类别数作为目标总数，不将相似度或缺失值伪造为置信度", () => {
  assert.equal(aiTargetCount({ result: { objects: [] } }), "未提供");
  assert.equal(
    aiTargetCount({ result: { objects: [{ count: 2 }, { count: 1 }] } }),
    "3 个",
  );
  assert.equal(
    aiTargetCount({ result: { objects: [{ count: null }] } }),
    "未提供",
  );
  assert.equal(aiConfidence(undefined), "未提供");
  assert.equal(aiConfidence(NaN), "未提供");
  assert.equal(aiConfidence(80), "未提供");
  assert.equal(aiConfidence(0.82), "82%");
});

test('退役迁移只移除派生检测缓存，保留业务数据并可重复打开',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {resolve,join}=await import('node:path');const {openStore}=await import('./lib/store.mjs');
 const directory=await mkdtemp(resolve('.tmp/retire-ai-cache-'));const file=join(directory,'isolated.db');
 let store=openStore(file);
 try {
  store.db.exec("CREATE TABLE ai_detection_cache(cacheKey TEXT PRIMARY KEY,result TEXT NOT NULL,expiresAt INTEGER NOT NULL);INSERT INTO ai_detection_cache VALUES('old','{}',1);DELETE FROM migrations WHERE version=22;INSERT INTO users VALUES('preserve','preserve','unused','admin');");
  store.db.close();store=openStore(file);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='ai_detection_cache'").get(),undefined);
  assert.equal(store.db.prepare("SELECT username FROM users WHERE id='preserve'").get().username,'preserve');assert.equal(store.db.prepare('SELECT max(version) v FROM migrations').get().v,23);
  store.db.close();store=openStore(file);assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 } finally {store.db.close();await rm(directory,{recursive:true,force:true});}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import sharp from "sharp";
import { openStore } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { AiSettings } from "./ai/settings.mjs";
import { DeepSeekClient, normalizeAnalysis } from "./ai/deepseek.mjs";
import { QWEN_MODEL } from "./ai/qwen-runner.mjs";
import { AiService } from "./ai/service.mjs";
import { AiCapture } from "./ai/capture.mjs";
import { prepareAiImage, imageDistance } from "./ai/images.mjs";
const picture = () =>
  sharp({
    create: { width: 80, height: 60, channels: 3, background: "#df2424" },
  })
    .png()
    .toBuffer();
const analysis = {
  summary: "画面中有一辆红色汽车",
  tags: ["红色", "汽车", "道路"],
  objects: [{ label: "汽车", color: "红色", count: 1, position: "中央" }],
  observations: [],
};
async function fixture(t, { analyze } = {}) {
  const { db } = openStore(":memory:");
  db.exec(
    "INSERT INTO users VALUES('a','admin','unused','admin'),('v','viewer','unused','viewer');INSERT INTO device_groups VALUES('other','其他组','','2026-11-07');",
  );
  db.prepare(
    "INSERT INTO platform_roles VALUES('analyst','分析员','',?,0,0,'2026-11-07')",
  ).run(
    JSON.stringify(["devices.view", "ai.view", "ai.analyze", "live.preview"]),
  );
  db.exec(
    "UPDATE user_authorizations SET roleId='analyst' WHERE userId='v';INSERT INTO user_groups VALUES('v','default');",
  );
  for (const [id, group] of [
    ["d", "default"],
    ["x", "other"],
  ]) {
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,groupId,createdAt) VALUES(?,?,?,?,?)",
    ).run(id, id, id, group, "2026-11-07");
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      id,
      id,
      id,
      id,
      "online",
    );
  }
  const settings = new AiSettings({ envKey: "" });
  settings.save({
    ...settings.public(),
    enabled: true,
    apiKey: "unit-test-key-without-real-provider",
  });
  const image = await picture(),
    calls = [];
  const service = new AiService({
    db,
    access: new Access(db),
    settings,
    capture: {
      frame: async (c, u) => {
        calls.push([c.id, u]);
        return image;
      },
    },
    client: {
      analyze:
        analyze ||
        (async () => ({
          analysis,
          model: "unit-model",
          usage: { inputTokens: 1, outputTokens: 2 },
        })),
    },
  });
  t.after(async () => {
    await service.close();
    db.close();
  });
  return { db, settings, service, image, calls };
}
async function completed(service, user, id) {
  for (let i = 0; i < 100; i++) {
    const job = service.get(user, id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("test job timeout");
}
test("AI密钥加密、脱敏、版本冲突及显式清除", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "ls-ai-secret-")),
    file = join(directory, "ai-config.json");
  try {
    const settings = new AiSettings({ file, envKey: "" }),
      key = "not-a-real-provider-secret-00001";
    settings.save({ ...settings.public(), enabled: true, apiKey: key });
    assert.equal(settings.key(), key);
    assert.equal(JSON.stringify(settings.public()).includes(key), false);
    assert.equal(readFileSync(file, "utf8").includes(key), false);
    assert.equal(new AiSettings({ file, envKey: "" }).key(), key);
    assert.throws(
      () => settings.save({ ...settings.public(), version: 0 }),
      (e) => e.status === 409,
    );
    settings.save({ ...settings.public(), enabled: false, clearKey: true });
    assert.equal(settings.key(), "");
    assert.equal(settings.public().hasKey, false);
  } finally {
    assert.equal(dirname(directory), join(process.cwd(), ".tmp"));
    rmSync(directory, { recursive: true, force: true });
  }
});
test("图像正规解码、尺寸限制和相似特征", async () => {
  const image = await picture(),
    a = await prepareAiImage(image),
    b = await prepareAiImage(image);
  assert.equal(a.width, 80);
  assert.equal(a.image[0], 255);
  assert.equal(imageDistance(a.hash, b.hash), 0);
  assert.equal(imageDistance("0000000000000000", "ffffffffffffffff"), 64);
  await assert.rejects(
    prepareAiImage(Buffer.from("bad")),
    (e) => e.code === "INVALID_AI_IMAGE",
  );
  await assert.rejects(
    prepareAiImage(Buffer.alloc(4 * 1024 * 1024)),
    (e) => e.status === 400,
  );
});
test("真实协议适配包含JSON与图像输入；余额、无效JSON和文字模型有明确错误", async () => {
  const settings = new AiSettings({ envKey: "test-key-without-real-provider" }),
    requests = [];
  let mode = "ok";
  const client = new DeepSeekClient({
    settings,
    fetcher: async (url, options) => {
      requests.push({ url, options });
      if (mode === "balance") return new Response("{}", { status: 402 });
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "deepseek-flash",
              input_modalities: mode === "text" ? ["text"] : ["text", "image"],
            },
          ],
        });
      return Response.json({
        model: "test",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: mode === "bad" ? "" : JSON.stringify(analysis),
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5 },
      });
    },
  });
  assert.equal((await client.test(await picture())).lastTest.status, "passed");
  assert.equal(requests[0].url, "https://api.deepseek.com/models");
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.response_format.type, "json_object");
  assert.match(
    body.messages[1].content[1].image_url.url,
    /^data:image\/jpeg;base64,/,
  );
  mode = "balance";
  await assert.rejects(client.analyze(await picture(), ""), /余额不足/);
  mode = "bad";
  await assert.rejects(
    client.analyze(await picture(), ""),
    (e) => e.code === "AI_INVALID_RESULT",
  );
  mode = "text";
  await assert.rejects(
    client.test(await picture()),
    (e) => e.code === "AI_MODEL_NO_VISION",
  );
  assert.throws(
    () => normalizeAnalysis({ summary: "x", objects: [] }),
    (e) => e.status === 502,
  );
});
test("分析任务幂等、设备分组隔离、图像权限与描述/图片检索", async (t) => {
  const { service, image, calls } = await fixture(t);
  const upload = {
    question: "描述物体",
    image: "data:image/png;base64," + image.toString("base64"),
    name: "测试图",
  };
  const first = await service.create("v", upload, "request-0001");
  assert.equal(
    (await service.create("v", upload, "request-0001")).id,
    first.id,
  );
  await assert.rejects(
    service.create("v", { ...upload, question: "不同内容" }, "request-0001"),
    (e) => e.status === 409,
  );
  assert.equal((await completed(service, "v", first.id)).status, "succeeded");
  assert.ok(service.image("v", first.id).length);
  assert.throws(
    () => service.get("a", first.id),
    (e) => e.status === 404,
  );
  const camera = await service.create(
    "a",
    { channelId: "d", question: "描述车辆" },
    "camera-0001",
  );
  await completed(service, "a", camera.id);
  assert.equal(service.get("v", camera.id).status, "succeeded");
  assert.equal(calls.length, 1);
  const forbidden = await service.create(
    "a",
    { channelId: "x", question: "" },
    "camera-0002",
  );
  await completed(service, "a", forbidden.id);
  assert.throws(
    () => service.get("v", forbidden.id),
    (e) => e.status === 404,
  );
  const text = service.search("v", { text: "红色汽车" });
  assert.equal(text.items.length, 2);
  assert.equal(
    text.items.some((i) => i.id === forbidden.id),
    false,
  );
  assert.equal(service.search("v", { referenceId: first.id }).items.length, 2);
  await assert.rejects(
    service.create("v", { channelId: "x", question: "" }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    service.create("v", { channelId: { bad: true }, question: "" }),
    (e) => e.status === 400,
  );
});
test("权限在模型返回前撤销时清除图片，不发布结果；取消不被迟到响应复活", async (t) => {
  let release;
  const waiting = new Promise((r) => (release = r)),
    { service, image, db } = await fixture(t, {
      analyze: async () => {
        await waiting;
        return { analysis, model: "unit", usage: {} };
      },
    });
  const j = await service.create(
    "v",
    { channelId: "d", question: "" },
    "revoked-001",
  );
  db.prepare("DELETE FROM user_groups WHERE userId='v'").run();
  release();
  await service.running.get(j.id)?.promise;
  assert.throws(
    () => service.get("v", j.id),
    (e) => e.status === 404,
  );
  const stored = db
    .prepare("SELECT status,image,result FROM ai_jobs WHERE id=?")
    .get(j.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.image, null);
  assert.equal(stored.result, null);
  let resume;
  const blocked = new Promise((r) => (resume = r));
  service.client.analyze = async () => {
    await blocked;
    return { analysis, model: "unit", usage: {} };
  };
  const upload = await service.create(
    "a",
    {
      image: "data:image/png;base64," + image.toString("base64"),
      question: "",
    },
    "cancelled-01",
  );
  service.cancel("a", upload.id);
  resume();
  await service.running.get(upload.id)?.promise;
  assert.equal(service.get("a", upload.id).status, "cancelled");
});
test("抓拍只释放自己的观看租约，成功失败均不关闭其他录像", async () => {
  const events = [],
    capture = new AiCapture({
      db: { prepare: () => ({ get: () => ({ streamId: "s" }) }) },
      media: {},
      live: {
        create: () => ({ sessionId: "shared", viewerId: "ai-only" }),
        snapshot: () => ({ state: "ready" }),
        leave: async (...args) => events.push(args),
      },
    });
  capture.decode = async () => Buffer.from("test");
  await capture.frame({ id: "c" }, "a", new AbortController().signal);
  assert.deepEqual(events, [["shared", "a", "ai-only"]]);
  capture.decode = async () => {
    throw Error("failure");
  };
  await assert.rejects(
    capture.frame({ id: "c" }, "a", new AbortController().signal),
  );
  assert.equal(events.length, 2);
});


test("文字检索意图异步解析，排除词、同义词和私有权限生效", async t => {
 const {service,db}=await fixture(t);
 service.client.interpret=async()=>({analysis:{summary:"查找红色车辆",tags:["红色","汽车"],objects:[],observations:[],query:{groups:[["红色"],["汽车","车辆"]],exclude:["蓝色"],all:false}},model:"test",usage:{}});
 const image=await service.create("a",{channelId:"d",question:"描述"},"camera-example");await completed(service,"a",image.id);
 const plan=await service.create("a",{textSearch:true,question:"找红色车，不要蓝色"},"query-example");const ready=await completed(service,"a",plan.id);assert.equal(ready.status,"succeeded");assert.equal(ready.imageUrl,null);
 assert.equal(service.list("a").total,1);assert.equal(service.search("a",{queryId:plan.id}).total,1);assert.throws(()=>service.search("v",{queryId:plan.id}),e=>e.status===404);
 const result=JSON.parse(db.prepare("SELECT result FROM ai_jobs WHERE id=?").get(image.id).result);result.tags.push("蓝色");db.prepare("UPDATE ai_jobs SET result=? WHERE id=?").run(JSON.stringify(result),image.id);assert.equal(service.search("a",{queryId:plan.id}).total,0);
 await assert.rejects(service.create("a",{textSearch:true,question:"x",channelId:"d"}),e=>e.status===400);
});
test("DeepSeek文字查询使用受限JSON条件，不把指令执行为操作", async()=>{
 const settings=new AiSettings({envKey:""});settings.save({...settings.public(),enabled:true,apiKey:"unit-test-key-without-real-provider"});
 let body;const client=new DeepSeekClient({settings,fetcher:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({summary:"红车",groups:[["汽车","车辆"]],exclude:["蓝色"],all:false})}}]})}});
 const output=await client.interpret("找汽车，排除蓝色");assert.deepEqual(output.analysis.query.exclude,["蓝色"]);assert.equal(body.messages[1].content,"找汽车，排除蓝色");assert.equal(body.response_format.type,"json_object");
});

test('千问手动分析独立于云端，精确图片缓存和账号隔离',async t=>{
 const {service,settings,image}=await fixture(t);settings.save({...settings.public(),enabled:false});
 const prompts=[];let runs=0;service.qwenRunner={ready:()=>true,run:async(_image,_signal,prompt)=>{prompts.push(prompt);runs++;return {result:{summary:'画面中央有红色方块',tags:['红色','方块'],objects:[],observations:[]},model:QWEN_MODEL,metrics:{elapsedMs:10}}}};
 service.localResourceReason=()=>null;
 const value={question:'本地画面分析',image:'data:image/png;base64,'+image.toString('base64'),localAnalysis:true};
 const first=await service.create('a',value,'qwen-first-request');const done=await completed(service,'a',first.id);
 assert.equal(done.status,'succeeded');assert.equal(done.result.summary,'画面中央有红色方块');assert.equal(done.result.objects.length,0);assert.equal(runs,1);
 const second=await service.create('a',value,'qwen-second-request');const cached=await completed(service,'a',second.id);assert.equal(cached.usage.cached,true);assert.equal(runs,1);
 const third=await service.create('v',value,'qwen-other-request');await completed(service,'v',third.id);assert.equal(runs,2);
 const changed=await service.create('a',{...value,question:'只关注车辆颜色'},'qwen-changed-prompt');await completed(service,'a',changed.id);assert.equal(runs,3);assert.equal(prompts.at(-1),'只关注车辆颜色');
 await assert.rejects(()=>service.create('a',{...value,reference:true}),e=>e.code==='INVALID_AI_SOURCE');
 settings.save({...settings.public(),localEnabled:false});await assert.rejects(()=>service.create('a',value),e=>e.code==='AI_NOT_ENABLED');
});
test('千问队列尊重录像负载，等待期间可取消',async t=>{
 const {service,settings,image}=await fixture(t);settings.save({...settings.public(),enabled:false});let runs=0;
 service.qwenRunner={ready:()=>true,run:async()=>{runs++;throw Error('must not run')}};service.localResourceReason=()=> '预览和录像优先';
 const job=await service.create('a',{question:'本地',image:'data:image/png;base64,'+image.toString('base64'),localAnalysis:true});
 await service.drain();assert.equal(service.get('a',job.id).status,'queued');assert.equal(runs,0);service.cancel('a',job.id);assert.equal(service.get('a',job.id).status,'cancelled');
});

test('千问运行期使用运行门槛，资源不足回到原任务排队而非失败',async t=>{
 const {service,settings,image}=await fixture(t);settings.save({...settings.public(),enabled:false});const phases=[];
 service.localResourceReason=(starting=true)=>{phases.push(starting);return null;};
 service.qwenRunner={ready:()=>true,run:async(_image,signal)=>{await new Promise(r=>setTimeout(r,1100));const e=Error('预览和录像优先');e.status=429;e.code='QWEN_RESOURCE_BUSY';throw e;}};
 const job=await service.create('a',{question:'本地',localAnalysis:true,image:'data:image/png;base64,'+image.toString('base64')});
 const pending=service.running.get(job.id);await pending.promise;
 assert.ok(phases.includes(false));assert.equal(service.get('a',job.id).status,'queued');assert.equal(service.get('a',job.id).finishedAt,null);service.cancel('a',job.id);
});
test('千问通道抓拍可独立使用本地模型而不调用云端',async t=>{
 const {service,settings,calls}=await fixture(t,{analyze:async()=>{throw Error('云端不应调用')}});settings.save({...settings.public(),enabled:false});
 let runs=0;service.localResourceReason=()=>null;service.qwenRunner={ready:()=>true,run:async()=>{runs++;return {result:analysis,model:QWEN_MODEL,metrics:{elapsedMs:1}}}};
 const job=await service.create('a',{channelId:'d',question:'本地画面分析',localAnalysis:true});const done=await completed(service,'a',job.id);assert.equal(done.status,'succeeded');assert.equal(done.model,QWEN_MODEL);assert.equal(runs,1);assert.deepEqual(calls,[['d','a']]);
});
test('录像时间点分析从授权原文件取帧，保留来源和精确时间且不点播实时流',async t=>{
 const {db,service,settings,image,calls}=await fixture(t);settings.save({...settings.public(),enabled:false});
 db.prepare("INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt) VALUES('archive-job','a','d','scheduled','succeeded',0,'archive-stream','2026-11-08')").run();
 db.prepare("INSERT INTO recording_files VALUES('archive-file','archive-job','2026-11-08','2026-11-08-01-00-00-0.mp4')").run();
 let offsets=[];service.history.reader={duration:async()=>65,frame:async(_file,offset)=>{offsets.push(offset);return image}};service.localResourceReason=()=>null;service.qwenRunner={ready:()=>true,run:async()=>({result:analysis,model:QWEN_MODEL,metrics:{elapsedMs:1}})};
 const value={recordingFileId:'archive-file',frameOffset:17.5,question:'本地',localAnalysis:true};const first=await service.create('a',value,'archive-frame-request');const done=await completed(service,'a',first.id);assert.equal(done.status,'succeeded');assert.equal(done.recording.offsetSeconds,17.5);assert.equal(done.capturedAt,'2026-11-07T17:00:17.500Z');assert.deepEqual(offsets,[17.5]);assert.equal(calls.length,0);
 assert.equal((await service.create('a',value,'archive-frame-request')).id,first.id);
 await assert.rejects(()=>service.create('a',{...value,frameOffset:18},'archive-frame-request'),e=>e.status===409);
 await assert.rejects(()=>service.create('v',value),e=>e.status===404);
 await assert.rejects(()=>service.create('a',{...value,channelId:'d'}),e=>e.code==='INVALID_RECORDING_FRAME');
 const invalid=await service.create('a',{...value,frameOffset:70});assert.equal((await completed(service,'a',invalid.id)).status,'failed');assert.deepEqual(offsets,[17.5]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { monitoringFixture } from "./test-support/monitoring-fixture.mjs";
import { AiSettings } from "./ai/settings.mjs";
test("AI HTTP密钥脱敏、CSRF、模型测试、异步图片分析与当前分组权限", async (t) => {
  const settings = new AiSettings({ envKey: "" });
  const fake = async (url) =>
    url.endsWith("/models")
      ? Response.json({
          data: [{ id: "deepseek-flash", input_modalities: ["text", "image"] }],
        })
      : Response.json({
          model: "mock-deepseek",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "蓝色方块和红色圆形",
                  tags: ["蓝色", "方块", "红色", "圆形"],
                  objects: [
                    {
                      label: "方块",
                      color: "蓝色",
                      count: 1,
                      position: "左侧",
                    },
                  ],
                  observations: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
  const f = await monitoringFixture({ aiSettings: settings, aiFetcher: fake });
  t.after(() => f.close());
  const plan = f.stats().planFingerprint;
  async function login(username) {
    const r = await fetch(f.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: f.base, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: f.password }),
    });
    assert.equal(r.status, 200);
    const json = await r.json();
    return {
      Cookie: r.headers.get("set-cookie").split(";")[0],
      Origin: f.base,
      "Content-Type": "application/json",
      "X-CSRF-Token": json.data.csrf,
    };
  }
  const admin = await login("qa-admin"),
    viewer = await login("qa-monitor");
  async function call(path, headers = admin, method = "GET", body) {
    const r = await fetch(f.base + "/api/v1" + path, {
      headers,
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, value: await r.json() };
  }
  assert.equal((await call("/ai/status", viewer)).status, 403);
  const key = "http-test-secret-with-no-provider";
  const saved = await call("/ai/settings", admin, "PUT", {
    ...settings.public(),
    apiKey: key,
    enabled: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.value).includes(key), false);
  assert.equal(saved.value.data.hasKey, true);
  assert.equal((await call("/ai/settings", viewer)).status, 403);
  assert.equal((await call("/ai/settings/local-models", viewer)).status, 403);
  assert.equal((await call("/ai/settings/local-index", viewer)).status,403);
  const index = await call("/ai/settings/local-index",admin);
  assert.equal(index.status,200);assert.equal(index.value.data.frames,0);
  const indexed=await call("/ai/settings",admin,"PUT",{...settings.public(),indexEnabled:true,indexCapacityMiB:256,indexRetentionDays:3,indexOwnerId:'forged'});
  assert.equal(indexed.status,200);assert.equal(settings.state.indexOwnerId,'qa-admin');
  assert.equal(JSON.stringify(indexed.value).includes('indexOwnerId'),false);
  const inventory = await call("/ai/settings/local-models", admin);
  assert.equal(inventory.status, 200);
  assert.deepEqual(inventory.value.data.items.map((m) => m.id), ["chinese", "qwen"]);
  assert.equal(JSON.stringify(inventory.value).includes("model.onnx"), false);
  const localStatus=await call('/ai/status',admin);
  assert.equal(Object.hasOwn(localStatus.value.data.local,'yoloReady'),false);
  assert.equal(typeof localStatus.value.data.local.qwenReady,'boolean');
  assert.equal((await call('/ai/analyses/retired/detections',admin)).status,404);

  assert.equal(
    (
      await call(
        "/ai/settings",
        { ...admin, "X-CSRF-Token": "invalid" },
        "PUT",
        {},
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/ai/settings/test", admin, "POST", {
        version: settings.state.version,
      })
    ).status,
    202,
  );
  for (let i = 0; i < 30 && settings.state.lastTest?.status === "testing"; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(settings.state.lastTest.status, "passed");
  const image = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "blue" },
  })
    .jpeg()
    .toBuffer();
  const added = await call(
    "/ai/analyses",
    { ...admin, "Idempotency-Key": "http-create-0001" },
    "POST",
    {
      image: "data:image/jpeg;base64," + image.toString("base64"),
      question: "描述颜色",
    },
  );
  assert.equal(added.status, 202);
  const id = added.value.data.id;
  let result;
  for (let i = 0; i < 50; i++) {
    result = await call("/ai/analyses/" + id);
    if (result.value.data.status === "succeeded") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(result.value.data.status, "succeeded");
  const download = await fetch(
    f.base + "/api/v1/ai/analyses/" + id + "/image",
    { headers: admin },
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "image/jpeg");
  assert.equal(download.headers.get("cache-control"), "no-store");
  const query = await call("/ai/search", admin, "POST", { text: "蓝色方块" });
  assert.equal(query.value.data.total, 1);
  assert.equal((await call("/ai/analyses/" + id, viewer)).status, 403);
  assert.equal(
    (
      await call("/ai/analyses", admin, "POST", {
        image: "data:image/jpeg;base64,AA==",
        question: "",
      })
    ).status,
    400,
  );
  // Uploading a search reference must work without cloud credentials in every scope.
  settings.save({...settings.public(),enabled:false,clearKey:true});
  const reference=await call('/ai/analyses',admin,'POST',{question:'检索参考图',image:'data:image/jpeg;base64,'+image.toString('base64'),reference:true,localReference:true});
  assert.equal(reference.status,202);assert.equal(reference.value.data.status,'succeeded');assert.equal(reference.value.data.model,'local-reference');
  const imageQuery=await call('/ai/search',admin,'POST',{referenceId:reference.value.data.id});
  assert.equal(imageQuery.status,200);assert.ok(imageQuery.value.data.items.some(item=>item.id===id));
  assert.equal((await call('/ai/search',viewer,'POST',{referenceId:reference.value.data.id})).status,403);
  assert.equal(f.stats().planFingerprint, plan);
});

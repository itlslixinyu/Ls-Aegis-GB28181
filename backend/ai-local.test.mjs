import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalModel, localText, cosine } from "./ai/local-model.mjs";
import { AiArchiveReader } from "./ai/archive-reader.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("中文查询不再受物体词库限制，保留描述并校验长度", () => {
  assert.equal(localText("查找路口的白色汽车"), "查找路口的白色汽车");
  assert.equal(
    localText("背着双肩包、手持雨伞并穿浅色外套的人"),
    "背着双肩包、手持雨伞并穿浅色外套的人",
  );
  assert.equal(localText("昨天遗失的特殊仪器"), "昨天遗失的特殊仪器");
  assert.throws(() => localText(" "));
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([NaN], [1]));
});

test("取消先于模型启动时不生成子进程", async () => {
  const local = new LocalModel(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(local.run({ text: "car" }, controller.signal));
  assert.equal(local.child, null);
  local.close();
});

test("本地录像版本使用真实文件属性，变更失效且拒绝目录逃逸", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ls-ai-cache-test-"));
  const previous = process.env.AI_ARCHIVE_LOCAL_ROOT,
    prefix = process.env.AI_ARCHIVE_LOCAL_URL_PREFIX;
  process.env.AI_ARCHIVE_LOCAL_ROOT = root;
  process.env.AI_ARCHIVE_LOCAL_URL_PREFIX = "/record/";
  t.after(async () => {
    if (previous === undefined) delete process.env.AI_ARCHIVE_LOCAL_ROOT;
    else process.env.AI_ARCHIVE_LOCAL_ROOT = previous;
    if (prefix === undefined) delete process.env.AI_ARCHIVE_LOCAL_URL_PREFIX;
    else process.env.AI_ARCHIVE_LOCAL_URL_PREFIX = prefix;
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "sample.mp4");
  await writeFile(path, "one");
  let url = new URL("http://127.0.0.1/record/sample.mp4");
  const reader = new AiArchiveReader({ recordingUrl: () => url }),
    signal = AbortSignal.timeout(5000);
  const a = await reader.fingerprint({}, signal),
    b = await reader.fingerprint({}, signal);
  assert.equal(a, b);
  await writeFile(path, "replacement");
  assert.notEqual(await reader.fingerprint({}, signal), a);
  url = new URL("http://127.0.0.1/record/%2e%2e%2foutside.mp4");
  await assert.rejects(
    reader.fingerprint({}, signal),
    (e) => e.code === "AI_ARCHIVE_PATH_INVALID",
  );
});

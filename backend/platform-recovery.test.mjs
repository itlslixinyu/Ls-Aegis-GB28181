import test from "node:test";
import assert from "node:assert/strict";
import {
  probePlatform,
  waitForPlatformRestart,
} from "../frontend/src/platform-recovery.ts";

const health = (instanceId, status = "ok", restartState = "idle") => ({
  ok: true,
  json: async () => ({ data: { instanceId, status, restartState } }),
});

test("普通设备/媒体故障且平台实例未变时不自动反复点播", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => health("old"));
  assert.equal(
    await waitForPlatformRestart("old", {
      signal: new AbortController().signal,
    }),
    null,
  );
  assert.equal(mock.mock.callCount(), 1);
});

test("已受理重启、短暂断网、新健康实例出现后允许重建观看", async (t) => {
  let n = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++n === 1) return health("old", "ok", "accepted");
    if (n === 2) throw Error("connection refused");
    return health("new");
  });
  assert.equal(
    await waitForPlatformRestart("old", {
      signal: new AbortController().signal,
      pollMs: 1,
    }),
    "new",
  );
  assert.equal(n, 3);
});

test("多窗口共享健康请求，各自仍保留独立观看者", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const mock = t.mock.method(globalThis, "fetch", async () => {
    await gate;
    return health("new");
  });
  const first = probePlatform(),
    second = probePlatform();
  assert.equal(mock.mock.callCount(), 1);
  release();
  assert.deepEqual(await first, await second);
});

test("关闭窗口/切换码流取消等待，迟到的新实例不能触发恢复", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async () => {
    await gate;
    return health("new");
  });
  const controller = new AbortController();
  const waiting = waitForPlatformRestart("old", { signal: controller.signal });
  controller.abort();
  release();
  assert.equal(await waiting, null);
});

test("接入服务启动失败的新实例不会冒充恢复成功", async (t) => {
  t.mock.method(globalThis, "fetch", async () => health("new", "degraded"));
  assert.equal(
    await waitForPlatformRestart("old", {
      signal: new AbortController().signal,
    }),
    null,
  );
});

test("网络持续不可用有等待上限，重启失败也及时结束等待", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw Error("offline");
  });
  assert.equal(
    await waitForPlatformRestart("old", {
      signal: new AbortController().signal,
      pollMs: 1,
      timeoutMs: 8,
    }),
    null,
  );
  mock.mock.mockImplementation(async () => health("old", "ok", "failed"));
  assert.equal(
    await waitForPlatformRestart("old", {
      signal: new AbortController().signal,
    }),
    null,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaAdapter } from "./media/adapter.mjs";
test("媒体适配器正确携带管理参数，验证业务响应并补偿无效分配", async () => {
  const calls = [];
  let valid = true;
  const adapter = new MediaAdapter(
    { url: "http://localhost:9092", secret: "test-secret" },
    {
      fetcher: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          json: async () =>
            url.pathname.endsWith("openRtpServer")
              ? { code: 0, port: valid ? 40000 : 0 }
              : { code: 0 },
        };
      },
    },
  );
  assert.equal((await adapter.check()).state, "online");
  assert.equal((await adapter.allocate("test-stream")).port, 40000);
  assert.equal(calls[1].options.body.get("secret"), "test-secret");
  assert.equal(calls[1].options.body.get("tcp_mode"), "0");
  assert.equal(calls[1].options.body.has("local_ip"), false);
  assert.equal(calls[1].url.search, "");
  valid = false;
  await assert.rejects(adapter.allocate("invalid-result"), /无效接收端口/);
  assert.ok(calls.some((c) => c.url.pathname.endsWith("closeRtpServer")));
  assert.match(calls.at(-1).url.pathname, /close_streams$/);
  assert.ok(!JSON.stringify(adapter.status).includes("test-secret"));
  const failed = new MediaAdapter(
    { url: "http://localhost:9092", secret: "s" },
    {
      fetcher: async () => ({
        ok: true,
        json: async () => ({ code: -100, msg: "secret=s" }),
      }),
    },
  );
  await assert.rejects(
    failed.allocate("stream"),
    (e) => e.message === "媒体节点拒绝请求",
  );
  assert.equal((await failed.check()).state, "offline");
  assert.equal(
    (await new MediaAdapter({ url: "", secret: "" }).check()).state,
    "not_configured",
  );
});

test("原生媒体节点可以指定 RTP 监听网卡", async () => {
  const adapter = new MediaAdapter(
    { url: "http://localhost:9092", secret: "test", rtpBindIp: "192.0.2.10" },
    {
      fetcher: async (_url, { body }) => {
        assert.equal(body.get("local_ip"), "192.0.2.10");
        return { ok: true, json: async () => ({ code: 0, port: 40000 }) };
      },
    },
  );
  assert.equal((await adapter.allocate("test-stream")).port, 40000);
});

test("媒体转发停止幂等，鉴权失败不能伪装为资源已回收", async () => {
  const stopped = [];
  const adapter = new MediaAdapter(
    { url: "http://localhost:9092", secret: "test" },
    {
      fetcher: async (url, options) => {
        stopped.push(url.pathname);
        return {
          ok: true,
          json: async () =>
            url.pathname.endsWith("stopSendRtp")
              ? { code: -1 }
              : url.pathname.endsWith("getMediaList")
                ? { code: 0, data: [] }
                : { code: 0 },
        };
      },
    },
  );
  await adapter.stopForward("gone", "0100000001");
  assert.deepEqual(stopped, [
    "/index/api/stopSendRtp",
    "/index/api/getMediaList",
  ]);
  const denied = new MediaAdapter(
    { url: "http://localhost:9092", secret: "test" },
    { fetcher: async () => ({ ok: true, json: async () => ({ code: -100 }) }) },
  );
  await assert.rejects(denied.stopForward("stream", "0100000001"));
});
test("暂停与恢复使用媒体节点的RTP超时检查API", async () => {
  const calls = [];
  const adapter = new MediaAdapter(
    { url: "http://localhost:9092", secret: "test" },
    {
      fetcher: async (url, options) => {
        calls.push({ path: url.pathname, body: options.body });
        return { ok: true, json: async () => ({ code: 0 }) };
      },
    },
  );
  await adapter.setPaused("test-stream", true);
  await adapter.setPaused("test-stream", false);
  assert.match(calls[0].path, /pauseRtpCheck$/);
  assert.equal(calls[0].body.get("pause_seconds"), "60");
  assert.equal(calls[0].body.get("stream_id"), "test-stream");
  assert.match(calls[1].path, /resumeRtpCheck$/);
});

test("录像适配器使用MP4 API，筛除危险路径，下载不携带管理密钥", async () => {
  const calls = [];
  const adapter = new MediaAdapter(
    {
      url: "http://127.0.0.1:9092",
      playUrl: "http://127.0.0.1:9093",
      secret: "private-secret",
    },
    {
      fetcher: async (url, options) => {
        calls.push({ url, options });
        if (url.pathname.endsWith("getMP4RecordFile"))
          return {
            ok: true,
            json: async () => ({
              code: 0,
              data: {
                paths: options.body.has("period")
                  ? ["09-00-00-0.mp4", "../private.mp4", ".hidden.mp4"]
                  : ["2026-11-01", "../private"],
              },
            }),
          };
        if (url.pathname.startsWith("/record/"))
          return new Response(new Uint8Array([0, 0, 0, 1]), {
            status: 206,
            headers: { "Content-Type": "video/mp4" },
          });
        return { ok: true, json: async () => ({ code: 0, local_port: 42000 }) };
      },
    },
  );
  const files = await adapter.recordFiles("gl_test");
  assert.deepEqual(files, [{ date: "2026-11-01", name: "09-00-00-0.mp4" }]);
  await adapter.startRecord("gl_test", 300);
  await adapter.stopRecord("gl_test");
  await adapter.startForward("gl_test", "0100000001", "127.0.0.1", 40000, true);
  await adapter.startForward(
    "gl_test",
    "0100000002",
    "127.0.0.1",
    9,
    "passive",
  );
  await adapter.openRecording("gl_test", files[0], "bytes=0-3");
  const request = calls.at(-1);
  assert.equal(request.url.origin, "http://127.0.0.1:9093");
  assert.equal(request.options.headers.Range, "bytes=0-3");
  assert.ok(!request.url.href.includes("private-secret"));
  assert.equal(
    calls
      .find((c) => c.url.pathname.endsWith("startRecord"))
      .options.body.get("max_second"),
    "300",
  );
  assert.equal(
    calls
      .find((c) => c.url.pathname.endsWith("startSendRtp"))
      .options.body.get("is_udp"),
    "0",
  );
  assert.ok(calls.some((c) => c.url.pathname.endsWith("startSendRtpPassive")));
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  api,
  ApiError,
  setSession,
  currentUser,
  authNotice,
  logout,
} from "../frontend/src/api.ts";
const user = (id) => ({ id, username: id, role: "viewer" });
const enter = (id) => setSession({ user: user(id), csrf: "csrf-" + id });
beforeEach(() => enter("first"));

test("HTTP错误保留状态和业务错误码，非JSON拒绝也能识别权限失效", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { code: "NOT_FOUND", message: "资源不存在" } },
      { status: 404 },
    ),
  );
  await assert.rejects(
    api("/devices/missing"),
    (e) =>
      e instanceof ApiError &&
      e.status === 404 &&
      e.code === "NOT_FOUND" &&
      e.message === "资源不存在",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("Forbidden", { status: 403 }),
  );
  await assert.rejects(
    api("/devices/missing"),
    (e) => e instanceof ApiError && e.status === 403,
  );
});

test("登录和用户表单账号规则兼容浏览器Unicode v模式，非法字符不会绕过校验", () => {
  for (const file of ["App.vue", "components/Administration.vue"]) {
    const source = readFileSync(
      new URL("../frontend/src/" + file, import.meta.url),
      "utf8",
    );
    const pattern = source.match(/pattern="([^"]+)"/)[1];
    const rule = new RegExp("^(?:" + pattern + ")$", "v");
    for (const value of ["admin", "qa-reader", "user_123"])
      assert.equal(rule.test(value), true, file + value);
    for (const value of ["a!", "aa", "admin x", "a".repeat(33)])
      assert.equal(rule.test(value), false, file + value);
  }
});

test("网络中断提示中文并要求确认写操作结果，不自动重发", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api("/devices", "POST", {}), /网络.*确认操作结果/);
  assert.equal(calls, 1);
});

test("当前CSRF失效可重新登录，普通403与旧会话拒绝不注销新会话", async (t) => {
  let complete;
  const csrfFailure = () =>
    Response.json(
      { error: { code: "CSRF_REJECTED", message: "会话校验失败，请重新登录" } },
      { status: 403 },
    );
  t.mock.method(globalThis, "fetch", async () => csrfFailure());
  await assert.rejects(api("/groups", "POST", {}), /重新登录/);
  assert.equal(currentUser.value, null);
  assert.match(authNotice.value, /会话校验失败.*重新登录/);
  enter("second");
  assert.equal(authNotice.value, "");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { code: "FORBIDDEN", message: "需要管理员权限" } },
      { status: 403 },
    ),
  );
  await assert.rejects(api("/users"), /管理员/);
  assert.equal(currentUser.value.id, "second");
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise((r) => {
        complete = r;
      }),
  );
  const pending = api("/groups", "POST", {});
  enter("third");
  complete(csrfFailure());
  await assert.rejects(pending, /登录状态已变化/);
  assert.equal(currentUser.value.id, "third");
});
test("前端请求保留CSRF与JSON契约，204和退出可正确完成", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url, ...options };
    return options.method === "POST" && url.endsWith("logout")
      ? new Response(null, { status: 204 })
      : Response.json({ data: { id: "ok" } });
  });
  assert.deepEqual(await api("/devices", "POST", { name: "测试" }), {
    id: "ok",
  });
  assert.equal(request.headers["X-CSRF-Token"], "csrf-first");
  assert.equal(JSON.parse(request.body).name, "测试");
  assert.ok(request.signal instanceof AbortSignal);
  await logout();
  assert.equal(currentUser.value, null);
});
test("前端错误使用明确提示：业务拒绝、网关非JSON和缺失响应数据", async (t) => {
  let response = Response.json(
    { error: { message: "无权访问" } },
    { status: 403 },
  );
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(api("/devices"), /无权访问/);
  response = new Response("<html>bad gateway</html>", { status: 502 });
  await assert.rejects(api("/devices"), /响应格式异常/);
  response = Response.json({ unexpected: true });
  await assert.rejects(api("/devices"), /响应格式异常/);
});
test("前端超时中止挂起请求，写操作提示先确认结果", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  t.mock.method(
    globalThis,
    "fetch",
    (_url, options) =>
      new Promise((_r, reject) => {
        signal = options.signal;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const pending = api("/devices", "POST", { name: "测试" });
  t.mock.timers.tick(30000);
  await assert.rejects(pending, /请求超时.*确认操作结果/);
  assert.equal(signal.aborted, true);
});
test("账号切换后旧的成功响应不得进入新账号界面", async (t) => {
  let complete;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise((r) => {
        complete = r;
      }),
  );
  const pending = api("/devices");
  enter("second");
  complete(Response.json({ data: { private: "first account data" } }));
  await assert.rejects(pending, /登录状态已变化/);
  assert.equal(currentUser.value.id, "second");
});
test("旧会话迟到401不能注销新的登录会话", async (t) => {
  let complete;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise((r) => {
        complete = r;
      }),
  );
  const pending = api("/devices");
  enter("second");
  complete(Response.json({ error: { message: "请先登录" } }, { status: 401 }));
  await assert.rejects(pending, /登录状态已变化/);
  assert.equal(currentUser.value.id, "second");
});
test("解析失败的旧401也不能清除新会话；当前401仍能回到登录", async (t) => {
  let rejectBody;
  t.mock.method(globalThis, "fetch", async () => ({
    status: 401,
    ok: false,
    json: () =>
      new Promise((_r, j) => {
        rejectBody = j;
      }),
  }));
  const pending = api("/devices");
  await Promise.resolve();
  enter("second");
  rejectBody(Error("invalid json"));
  await assert.rejects(pending, /登录状态已变化/);
  assert.equal(currentUser.value.id, "second");
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("login required", { status: 401 }),
  );
  await assert.rejects(api("/devices"), /登录已过期/);
  assert.equal(currentUser.value, null);
});

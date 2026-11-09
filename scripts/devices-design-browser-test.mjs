import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createServer } from "../backend/server.mjs";
import { loadConfig } from "../backend/lib/config.mjs";

const browserPath =
  process.env.LS_QA_CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "ls-profile-browser-"));
const testSip = { state: "disabled", seq: 1, dialogs: {}, async close() {} };
const app = createServer({
  database: ":memory:",
  legacy: null,
  config: loadConfig({}),
  sipGateway: testSip,
});
const oldPassword = "qa-original-password-123";
const newPassword = "qa-replacement-password-123";
let browser, ws;
try {
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = "http://127.0.0.1:" + app.address().port;
  const setup = await fetch(base + "/api/v1/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "qa-profile", password: oldPassword }),
  });
  assert.equal(setup.status, 201);
  browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  await once(browser, "spawn");
  async function until(fn, label, timeout = 40000) {
    for (let i = 0; i < Math.ceil(timeout / 100); i++) {
      const result = await fn();
      if (result) return result;
      await delay(100);
    }
    throw Error("Timed out: " + label);
  }
  const port = await until(
    async () =>
      (
        await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(
          () => "",
        )
      ).split("\n")[0],
    "Chrome debugging port",
  );
  const targets = await (
    await fetch("http://127.0.0.1:" + port + "/json/list")
  ).json();
  ws = new WebSocket(
    targets.find((target) => target.type === "page").webSocketDebuggerUrl,
  );
  await once(ws, "open");
  const pending = new Map(),
    exceptions = [];
  let seq = 0;
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === "Runtime.exceptionThrown")
      exceptions.push(msg.params.exceptionDetails.text);
    if (!pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(Error(msg.error.message));
    else resolve(msg.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function read(expression) {
    const result = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description || expression);
    return result.result.value;
  }
  const wait = (expression) => until(() => read(expression), expression);
  const latencies = [];
  async function soon(expression, label) {
    const start = performance.now();
    await until(() => read(expression), label, 5000);
    latencies.push({ label, ms: Math.round(performance.now() - start) });
  }
  async function click(selector) {
    await wait(
      `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length && !document.querySelector(${JSON.stringify(selector)})?.disabled`,
    );
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: "nearest" });
      const r = element.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  }
  async function fill(selector, value) {
    await click(selector);
    await read(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp("Input.insertText", { text: value });
  }
  async function login(password) {
    await fill("#auth input[autocomplete=username]", "qa-profile");
    await fill("#auth input[type=password]", password);
    await click("#auth .login-submit");
  }
  const fs = await import("node:fs/promises");
  const authResponse = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "qa-profile", password: oldPassword }),
  });
  const auth = (await authResponse.json()).data,
    adminHeaders = {
      "Content-Type": "application/json",
      Cookie: authResponse.headers.get("set-cookie").split(";")[0],
      "X-CSRF-Token": auth.csrf,
    };
  async function adminApi(path, method = "GET", body) {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: adminHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw Error(value.error?.message);
    return value.data;
  }

  await adminApi("/devices", "POST", {
    deviceId: "34020000001320000001",
    name: "应急指挥中心 · 东门摄像机",
  });
  await adminApi("/devices", "POST", {
    deviceId: "34020000001320000002",
    name: "办公楼录像机 · 多通道设备档案",
  });
  const reader = (
    await adminApi("/users", "POST", {
      username: "qa-device-reader",
      password: "qa-device-reader-123",
      role: "viewer",
    })
  ).id;
  await adminApi("/users/" + reader + "/groups", "PUT", {
    groupIds: ["default"],
  });
  await cdp("Runtime.enable");
  await cdp("Page.navigate", { url: base });
  await login(oldPassword);
  await wait("document.querySelectorAll('#devices-view tbody tr').length===2");
  async function mark(scope, text, key) {
    await read(
      `Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")})).find(b=>b.textContent.trim()===${JSON.stringify(text)}).dataset[${JSON.stringify(key)}]='1'`,
    );
  }
  async function screenshot(name) {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(
      ".tmp/devices-redesign-" + name + ".png",
      Buffer.from(r.data, "base64"),
    );
  }
  const sizes = [];
  for (const [label, width, height] of [
    ["desktop", 1440, 900],
    ["wide", 3380, 1000],
    ["mobile", 390, 950],
  ]) {
    await cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const size = await read(
      "(()=>{const search=document.querySelector('[aria-label=搜索设备]').getBoundingClientRect();return {search:Math.round(search.width),overflow:document.documentElement.scrollWidth>innerWidth,overview:Math.round(document.querySelector('.device-overview').getBoundingClientRect().height)}})()",
    );
    assert.equal(size.overflow, false, label);
    assert.ok(size.search <= 360, label);
    sizes.push({ label, ...size });
    await screenshot(label);
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  await delay(200);
  async function more() {
    await click("#devices-view tbody tr:first-child .device-more-action");
    await wait(
      "document.querySelector('.device-maintenance-menu')?.matches(':popover-open')",
    );
    const bounds = await read(
      "(()=>{const r=document.querySelector('.device-maintenance-menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight}})()",
    );
    assert.ok(
      bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= bounds.w &&
        bounds.bottom <= bounds.h,
    );
  }
  await more();
  await screenshot("menu");
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
  });
  assert.equal(
    await read("document.activeElement.textContent.trim()"),
    "传输设置",
  );
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await wait(
    "!document.querySelector('.device-maintenance-menu').matches(':popover-open')",
  );
  for (const [action, title] of [
    ["编辑设备", "编辑设备档案"],
    ["传输设置", "设备传输设置"],
    ["接入密码", "设置设备接入密码"],
    ["删除设备", "删除设备档案"],
  ]) {
    await more();
    await mark(".device-maintenance-menu", action, "qaMaintenance");
    await click("[data-qa-maintenance]");
    await wait(
      `document.querySelector('dialog[open]')?.textContent.includes(${JSON.stringify(title)})`,
    );
    await mark("dialog[open] .actions", "取消", "qaCancelDevice");
    await click("dialog[open] [data-qa-cancel-device]");
    await wait("!document.querySelector('dialog[open]')");
    await read(
      "document.querySelectorAll('[data-qa-maintenance]').forEach(b=>b.removeAttribute('data-qa-maintenance'));document.querySelectorAll('[data-qa-cancel-device]').forEach(b=>b.removeAttribute('data-qa-cancel-device'))",
    );
  }
  await mark("#devices-view tbody tr:first-child", "通道", "qaChannels");
  await click("[data-qa-channels]");
  await wait("!!document.querySelector('#channels-dialog[open]')");
  await click('#channels-dialog [aria-label="关闭弹窗"]');
  await fill("[aria-label=搜索设备]", "不存在设备");
  await wait(
    "document.querySelector('#empty')?.textContent.includes('没有匹配')",
  );
  await click(".device-reset-filter");
  await wait("document.querySelectorAll('#devices-view tbody tr').length===2");
  await click(".account-trigger");
  await mark("#account-panel", "退出登录", "qaLogout");
  await click("[data-qa-logout]");
  await wait("!!document.querySelector('#auth')");
  await fill("#auth input[autocomplete=username]", "qa-device-reader");
  await fill("#auth input[type=password]", "qa-device-reader-123");
  await click("#auth .login-submit");
  await wait("document.querySelectorAll('#devices-view tbody tr').length===2");
  assert.equal(
    await read("document.querySelectorAll('.device-more-action').length"),
    0,
  );
  assert.equal(
    await read("document.querySelectorAll('.device-channels-action').length"),
    2,
  );
  assert.deepEqual(exceptions, []);
  console.log(
    "Device redesign verified: responsive sizes, overlay bounds, keyboard, edit/transport/password/delete dialogs, channels, filters and viewer permissions",
    JSON.stringify(sizes),
  );
} finally {
  ws?.terminate();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await once(browser, "close").catch(() => {});
  }
  await new Promise((resolve) => app.close(resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200,
  });
}

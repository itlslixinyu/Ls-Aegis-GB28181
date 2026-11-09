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
const app = createServer({
  database: ":memory:",
  legacy: null,
  config: loadConfig({}),
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
  async function until(fn, label) {
    for (let i = 0; i < 100; i++) {
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
    });
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description || expression);
    return result.result.value;
  }
  const wait = (expression) => until(() => read(expression), expression);
  async function click(selector) {
    await wait(
      `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`,
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
  const config = '[aria-label="项目配置"]';
  const drawer = ".appearance-drawer";
  const account = ".account-trigger";
  const profileDialog = ".profile-dialog";
  const closeProfile = '[aria-label="关闭个人中心"]';
  await cdp("Runtime.enable");
  await cdp("Page.navigate", { url: base });
  await login(oldPassword);
  await wait("!!document.querySelector('#workspace')");
  await click('[aria-label="搜索菜单"]');
  await wait("document.querySelector('.menu-search-dialog').open");
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
  await wait("!document.querySelector('.menu-search-dialog').open");
  await click('[aria-label="深色侧栏"]');
  await wait("document.documentElement.classList.contains('dark-sidebar')");
  await click('[aria-label="切换全屏"]');
  await wait(
    "document.fullscreenElement === document.documentElement || !!document.querySelector('.header-fullscreen-notice')",
  );
  if (await read("document.fullscreenElement === document.documentElement")) {
    await wait(
      "document.querySelector('[aria-label=切换全屏]').getAttribute('aria-pressed') === 'true'",
    );
    await click('[aria-label="切换全屏"]');
    await wait("!document.fullscreenElement");
    console.log("Fullscreen entered and exited");
  } else {
    assert.match(
      await read(
        "document.querySelector('.header-fullscreen-notice').textContent",
      ),
      /未能切换全屏/,
    );
    console.log(
      "Fullscreen unavailable in this headless session; visible error verified",
    );
  }
  await click('[aria-label="告警消息"]');
  await wait(
    "Array.from(document.querySelectorAll('h1')).some(el => el.textContent.includes('告警'))",
  );
  await click(config);
  await wait(`document.querySelector('${drawer}').open`);
  await click(`${drawer} [data-theme=teal]`);
  await wait("document.documentElement.dataset.appearance === 'teal'");
  await click(`${drawer} input[role=switch]`);
  await wait("!document.querySelector('.header-product')");
  await cdp("Page.reload");
  await wait(
    "!!document.querySelector('#workspace') && document.documentElement.dataset.appearance === 'teal'",
  );
  assert.equal(
    await read("!!document.querySelector('.header-product')"),
    false,
  );
  await click(config);
  await click(`${drawer} .appearance-drawer-body > button.secondary`);
  await wait(
    "document.documentElement.dataset.appearance === 'government' && !!document.querySelector('.header-product')",
  );
  await cdp("Page.reload");
  await wait(
    "!!document.querySelector('#workspace') && document.documentElement.dataset.appearance === 'government'",
  );
  assert.equal(
    await read("document.documentElement.classList.contains('dark-sidebar')"),
    false,
  );
  await click(account);
  await wait(
    "document.querySelector('#account-panel').matches(':popover-open')",
  );
  await click("#account-panel button:nth-of-type(1)");
  await wait("document.querySelector(' .profile-dialog')?.open");
  await click(".profile-tabs button:nth-child(2)");
  await wait(`document.querySelector('${profileDialog}').open`);
  assert.match(
    await read("document.querySelector('.profile-summary').textContent"),
    /qa-profile/,
  );
  await fill(
    `${profileDialog} .profile-form input[autocomplete=current-password]`,
    "wrong-password",
  );
  await fill(
    `${profileDialog} .profile-form input[autocomplete=new-password]:first-of-type`,
    newPassword,
  );
  await fill(
    `${profileDialog} .profile-form label:nth-of-type(3) input`,
    "qa-different-password-123",
  );
  await click(`${profileDialog} .profile-form button[type=submit]`);
  await wait(
    "document.querySelector('.profile-form [role=alert]')?.textContent.includes('两次输入的新密码不一致')",
  );
  await fill(
    `${profileDialog} .profile-form label:nth-of-type(3) input`,
    newPassword,
  );
  await click(`${profileDialog} .profile-form button[type=submit]`);
  await wait(
    "document.querySelector('.profile-form [role=alert]')?.textContent.includes('当前密码不正确')",
  );
  await click(closeProfile);
  await wait("document.activeElement.matches('.account-trigger')");
  await click(account);
  await click("#account-panel button:nth-of-type(1)");
  await wait("document.querySelector(' .profile-dialog')?.open");
  await click(".profile-tabs button:nth-child(2)");
  assert.equal(
    await read(
      "Array.from(document.querySelectorAll('.profile-form input')).every(input => input.value === '')",
    ),
    true,
  );
  await fill(
    `${profileDialog} .profile-form input[autocomplete=current-password]`,
    oldPassword,
  );
  await fill(
    `${profileDialog} .profile-form label:nth-of-type(2) input`,
    newPassword,
  );
  await fill(
    `${profileDialog} .profile-form label:nth-of-type(3) input`,
    newPassword,
  );
  await click(`${profileDialog} .profile-form button[type=submit]`);
  await wait(
    "!!document.querySelector('#auth') && document.body.textContent.includes('密码已更新')",
  );
  await login(oldPassword);
  await wait("document.body.textContent.includes('账号或密码错误')");
  await login(newPassword);
  await wait("!!document.querySelector('#workspace')");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await read("document.documentElement.scrollWidth <= innerWidth"),
    true,
  );
  await click(config);
  await wait(`document.querySelector('${drawer}').open`);
  assert.equal(
    await read(
      "document.querySelector('.appearance-drawer').getBoundingClientRect().right <= innerWidth",
    ),
    true,
  );
  assert.deepEqual(exceptions, []);
  console.log(
    "PASS desktop and 360px toolbar/drawer, search, fullscreen, alerts, theme/layout persistence and reset, profile validation and relogin",
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

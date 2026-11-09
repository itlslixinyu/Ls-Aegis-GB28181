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
  database: join(profile, "video-qa.db"),
  legacy: null,
  config: loadConfig({}),
  sipGateway: testSip,
  mediaAdapter: {
    status: { state: "not_configured" },
    config: {},
    async release() {},
    async openRecording() {
      return new Response(new Uint8Array([0, 0, 0, 0]), {
        headers: { "Content-Type": "video/mp4", "Content-Length": "4" },
      });
    },
  },
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

  const { DatabaseSync } = await import("node:sqlite");
  const fixture = new DatabaseSync(join(profile, "video-qa.db"));
  const now = new Date().toISOString();
  try {
    for (let i = 1; i <= 2; i++) {
      fixture
        .prepare(
          "INSERT INTO devices(id,deviceId,name,status,channels,createdAt,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          "qa-d" + i,
          String(34020000001320000000n + BigInt(i)),
          "[测试] 行政中心" + i + "号设备",
          "online",
          1,
          now,
          Date.now() + 3600000,
          Date.now(),
        );
      fixture
        .prepare("INSERT INTO channels VALUES(?,?,?,?,?)")
        .run(
          "qa-c" + i,
          "qa-d" + i,
          String(34020000001310000000n + BigInt(i)),
          "[测试] " + (i === 1 ? "大厅全景" : "东侧出入口"),
          "online",
        );
    }
    fixture
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "qa-complete",
        auth.user.id,
        "qa-c1",
        "scheduled",
        "succeeded",
        Date.now(),
        "qa-stream",
        now,
      );
    fixture
      .prepare("INSERT INTO recording_files VALUES(?,?,?,?)")
      .run(
        "qa-file",
        "qa-complete",
        now.slice(0, 10),
        "2026-11-05-09-00-00.mp4",
      );
    fixture
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,error,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "qa-interrupted",
        auth.user.id,
        "qa-c1",
        "scheduled",
        "interrupted",
        Date.now(),
        "[模拟] 服务中断",
        new Date(Date.now() - 60000).toISOString(),
      );
    fixture
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,createdAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "qa-resumed",
        auth.user.id,
        "qa-c1",
        "scheduled",
        "succeeded",
        Date.now(),
        new Date(Date.now() + 1000).toISOString(),
      );
    fixture
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,error,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "qa-failed",
        auth.user.id,
        "qa-c2",
        "download",
        "failed",
        Date.now(),
        "[模拟] 设备离线，请核查接入状态",
        now,
      );
  } finally {
    fixture.close();
  }
  await adminApi("/recording-plans", "POST", {
    name: "[测试] 行政大厅工作日录像",
    channelId: "qa-c1",
    days: [1, 2, 3, 4, 5],
    startTime: "09:00",
    endTime: "18:00",
    enabled: false,
    retentionDays: 7,
    segmentSeconds: 900,
  });
  const role = (
    await adminApi("/roles", "POST", {
      name: "仅录像回放",
      permissions: ["recording.view"],
    })
  ).id;
  const reader = (
    await adminApi("/users", "POST", {
      username: "qa-video-reader",
      password: "qa-video-reader-123",
      role,
    })
  ).id;
  await adminApi("/users/" + reader + "/groups", "PUT", {
    groupIds: ["default"],
  });
  await cdp("Runtime.enable");
  await cdp("Page.navigate", { url: base });
  await login(oldPassword);
  await wait("!!document.querySelector('#workspace')");
  await delay(200);
  async function choosePage(label) {
    const selector =
      "button.nav-button[aria-label=" + JSON.stringify(label) + "]";
    if (
      !(await read(
        `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`,
      ))
    ) {
      await read(
        `document.querySelector(${JSON.stringify(selector)}).closest('.nav-group').querySelector('.nav-parent').dataset.qaParent='1'`,
      );
      await click("[data-qa-parent]");
      await read(
        "document.querySelector('[data-qa-parent]').removeAttribute('data-qa-parent')",
      );
    }
    await click(selector);
  }
  async function mark(scope, text, key) {
    await read(
      `Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")})).find(b=>b.textContent.trim()===${JSON.stringify(text)}).dataset[${JSON.stringify(key)}]='1'`,
    );
  }
  async function select(selector, value) {
    await read(
      `(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
  }
  const geometry = [];
  async function screenshots(page, root) {
    for (const [label, width, height] of [
      ["desktop", 1440, 1000],
      ["wide", 3380, 1100],
      ["mobile", 390, 1050],
    ]) {
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(80);
      const state = await read(
        `(()=>{const root=document.querySelector(${JSON.stringify(root)});return {overflow:document.documentElement.scrollWidth>innerWidth,inputs:Array.from(root.querySelectorAll('.business-filters input,.business-filters select')).map(i=>Math.round(i.getBoundingClientRect().width))}})()`,
      );
      assert.equal(state.overflow, false, page + " " + label);
      if (label !== "mobile")
        assert.ok(
          state.inputs.every((w) => w <= 330),
          page + " bounded filters",
        );
      geometry.push({ page, label, ...state });
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(
        ".tmp/video-" + page + "-" + label + ".png",
        Buffer.from(shot.data, "base64"),
      );
    }
    await cdp("Emulation.clearDeviceMetricsOverride");
    await delay(100);
  }
  await choosePage("实时监控");
  await wait("document.querySelectorAll('.channel-list li').length===2");
  for (const count of [1, 4, 9, 16, 25, 36]) {
    await click('[aria-label="' + count + '画面"]');
    assert.equal(
      await read("document.querySelectorAll('.video-tile').length"),
      count,
    );
  }
  await click('[aria-label="4画面"]');
  await screenshots("monitoring", "#monitoring-view");
  await read(
    "document.querySelector('.video-tile').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await read("!!document.querySelector('.video-wall.is-maximized')"),
    true,
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
  await wait("!document.querySelector('.video-wall.is-maximized')");
  await fill("[aria-label=搜索通道]", "不存在通道");
  await wait("!document.querySelector('.channel-list li')");
  await fill("[aria-label=搜索通道]", "");
  await wait("document.querySelectorAll('.channel-list li').length===2");
  await choosePage("录像回放");
  await wait(
    "document.querySelectorAll('.recording-library tbody tr').length===1",
  );
  await screenshots("library", "#records-view");
  await click(".archive-files > summary");
  await click(".record-source button:nth-child(2)");
  await wait("!!document.querySelector('.record-filter')");
  await screenshots("device-records", "#records-view");
  await click(".record-filter button");
  assert.equal(
    await read(
      "document.querySelector('.record-filter select').checkValidity()",
    ),
    false,
  );
  await choosePage("录像计划");
  await wait(
    "document.querySelectorAll('[data-section=plans] .recording-table:first-of-type tbody tr').length>0||document.querySelector('[data-section=plans] tbody')?.textContent.includes('行政大厅')",
  );
  await screenshots("plans", "#recording-center");
  assert.equal(
    await read(
      "document.querySelectorAll('[data-section=plans] .recording-table:last-of-type tbody tr').length",
    ),
    1,
  );
  assert.equal(
    await read(
      "document.querySelectorAll('[data-section=plans] .recording-attempts').length",
    ),
    0,
  );
  assert.equal(
    (await adminApi("/recording-jobs?kind=scheduled&daily=1")).items[0].files[0]
      .jobId,
    "qa-complete",
  );
  await mark("#recording-center .title", "新增录像计划", "qaNewPlan");
  await click("[data-qa-new-plan]");
  await click(".plan-dialog .actions button:last-child");
  assert.equal(
    await read(
      "document.querySelector('.plan-dialog input[autofocus]').checkValidity()",
    ),
    false,
  );
  await fill(".plan-dialog input[autofocus]", "[测试] 东门补充录像");
  await select('.plan-dialog select[aria-label="视频通道"]', "qa-c2");
  if (await read("document.querySelector('.plan-enable input').checked"))
    await click(".plan-enable input");
  await click(".plan-dialog .actions button:last-child");
  await wait("!document.querySelector('.plan-dialog[open]')");
  assert.ok(
    (await adminApi("/recording-plans")).items.some(
      (p) => p.name === "[测试] 东门补充录像",
    ),
  );
  await choosePage("录像任务");
  await wait(
    "document.querySelectorAll('#recording-center tbody tr').length===2",
  );
  assert.equal(
    await read(
      "document.querySelectorAll('#recording-center .recording-attempts').length",
    ),
    2,
  );
  await click("#recording-center .recording-attempts summary");
  assert.equal(
    await read(
      "document.querySelectorAll('#recording-center .recording-attempts[open] p').length",
    ),
    3,
  );
  await screenshots("jobs", "#recording-center");
  await click("#recording-center details:not(.recording-attempts) summary");
  await wait(
    "!!document.querySelector('#recording-center details[open] .file-link')",
  );
  await mark("#recording-center details[open]", "回放", "qaJobPlay");
  await click("[data-qa-job-play]");
  await wait(
    "!!document.querySelector('.recording-playback-dialog[open] video')",
  );
  const src = await read(
    "document.querySelector('.recording-playback-dialog video').getAttribute('src')",
  );
  assert.equal(new URL(src, base).searchParams.get("play"), "1");
  assert.ok(src.includes("/recording-jobs/qa-complete/files/qa-file"));
  await click('.recording-playback-dialog [aria-label="关闭弹窗"]');
  await click(".account-trigger");
  await mark("#account-panel", "退出登录", "qaLogout");
  await click("[data-qa-logout]");
  await wait("!!document.querySelector('#auth')");
  await fill("#auth input[autocomplete=username]", "qa-video-reader");
  await fill("#auth input[type=password]", "qa-video-reader-123");
  await click("#auth .login-submit");
  await wait("!!document.querySelector('#workspace')");
  await delay(200);
  assert.equal(
    await read(
      "!!document.querySelector('button.nav-button[aria-label=录像计划]')",
    ),
    false,
  );
  await choosePage("录像回放");
  await wait(
    "document.querySelectorAll('.recording-library tbody tr').length===1",
  );
  assert.equal(
    await read(
      "document.querySelectorAll('.recording-library a[download]').length",
    ),
    0,
  );
  await click(".archive-files > summary");
  await mark(".recording-library tbody", "回放", "qaReaderPlay");
  await click("[data-qa-reader-play]");
  await wait(
    "!!document.querySelector('.recording-playback-dialog[open] video')",
  );
  const viewerUrl = await read(
    "document.querySelector('.recording-playback-dialog video').getAttribute('src')",
  );
  assert.equal(new URL(viewerUrl, base).searchParams.get("play"), "1");
  assert.equal(
    await read(
      "fetch(document.querySelector('.recording-playback-dialog video').src).then(r=>r.status)",
    ),
    200,
  );
  assert.equal(
    await read(
      `fetch(${JSON.stringify(viewerUrl.split("?")[0])}).then(r=>r.status)`,
    ),
    403,
  );
  // Refresh must validate saved addresses and tabs against the current account.
  await read(`fetch('/api/v1/me').then(r=>r.json()).then(({data})=>{
    sessionStorage.setItem('ls-aegis:last-view:'+data.user.id,'records');
    sessionStorage.setItem('ls-aegis:opened-pages:'+data.user.id,JSON.stringify(['records','config','users']));
    history.replaceState(null,'','#page=config');window.__qaRefresh=true;
  })`);
  await cdp("Page.reload", { ignoreCache: true });
  await wait("!window.__qaRefresh&&!!document.querySelector('#workspace')");
  assert.equal(
    await read(
      "document.querySelector('.nav-button[aria-current=page]').getAttribute('aria-label')",
    ),
    "录像回放",
  );
  assert.equal(
    await read(
      "document.querySelectorAll('[aria-label=切换到接入配置],[aria-label=切换到用户管理]').length",
    ),
    0,
  );
  assert.deepEqual(exceptions, []);
  console.log(
    "Video business verified: four modules, responsive screens, six layouts, maximize, source switching, plan validation/create, file expansion and playback-only role",
  );
  console.log(JSON.stringify(geometry));
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

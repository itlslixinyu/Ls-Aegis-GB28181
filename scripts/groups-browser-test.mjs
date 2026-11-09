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

  const reader = (
    await adminApi("/users", "POST", {
      username: "qa-group-reader",
      password: "qa-group-password-123",
      role: "viewer",
    })
  ).id;
  for (let i = 1; i <= 23; i++)
    await adminApi("/devices", "POST", {
      deviceId: String(34020000001320000000n + BigInt(i)),
      name: "模拟设备" + String(i).padStart(2, "0"),
    });
  await cdp("Runtime.enable");
  await cdp("Page.navigate", { url: base });
  await login(oldPassword);
  await wait("!!document.querySelector('#workspace')");
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
  async function tagGroup(name) {
    await wait(
      `Array.from(document.querySelectorAll('#groups-view tbody tr')).some(r=>r.querySelector('b')?.textContent===${JSON.stringify(name)})`,
    );
    await read(
      `(()=>{document.querySelector('[data-qa-group]')?.removeAttribute('data-qa-group');Array.from(document.querySelectorAll('#groups-view tbody tr')).find(r=>r.querySelector('b')?.textContent===${JSON.stringify(name)}).dataset.qaGroup='1'})()`,
    );
  }
  async function groupButton(name, text) {
    await tagGroup(name);
    await read("document.querySelectorAll('[data-qa-group] [data-qa-group-action]').forEach(b=>b.removeAttribute('data-qa-group-action'))");
    await mark("[data-qa-group]", text, "qaGroupAction");
    await click("[data-qa-group] [data-qa-group-action]");
  }
  async function choosePage(label) {
    const s = "button.nav-button[aria-label=" + JSON.stringify(label) + "]";
    if (
      !(await read(
        `!!document.querySelector(${JSON.stringify(s)})?.getClientRects().length`,
      ))
    ) {
      await read(
        `document.querySelector(${JSON.stringify(s)}).closest('.nav-group').querySelector('.nav-parent').dataset.qaParent='1'`,
      );
      await click("[data-qa-parent]");
      await read(
        "document.querySelector('[data-qa-parent]').removeAttribute('data-qa-parent')",
      );
    }
    await click(s);
  }
  async function saveGroup(name, description) {
    await fill("dialog[open] input[autofocus]", name);
    await fill("dialog[open] textarea", description);
    await click("dialog[open] .actions button:last-child");
  }
  const metrics = [];
  async function measure(label, selector) {
    await wait(
      `!!document.querySelector(${JSON.stringify(selector + " table")})`,
    );
    const value = await read(
      `(()=>{const w=document.querySelector(${JSON.stringify(selector)}),t=w.querySelector('table');return {gap:Math.round(w.clientHeight-t.getBoundingClientRect().height),row:Math.round(t.querySelector('tbody tr')?.getBoundingClientRect().height||0),pageOverflow:document.documentElement.scrollWidth>innerWidth}})()`,
    );
    assert.ok(value.gap <= 3, label + JSON.stringify(value));
    assert.ok(!value.pageOverflow, label);
    metrics.push({ label, ...value });
  }
  await choosePage("分组授权");
  await wait("document.querySelectorAll('#groups-view tbody tr').length===1");
  await mark("#groups-view .title", "新建设备分组", "qaNewGroup");
  await click("[data-qa-new-group]");
  await click("dialog[open] .actions button:last-child");
  assert.equal(
    await read(
      "document.querySelector('dialog[open] input[autofocus]').checkValidity()",
    ),
    false,
  );
  await saveGroup("   ", "空白测试");
  await wait(
    "document.querySelector('dialog[open] .error')?.textContent.includes('无效')",
  );
  await saveGroup("区域甲", "甲区说明");
  await wait("!document.querySelector('dialog[open]')");
  await click("[data-qa-new-group]");
  await saveGroup("区域甲", "重复名称");
  await wait(
    "document.querySelector('dialog[open] .error')?.textContent.includes('已存在')",
  );
  await saveGroup("区域乙", "乙区说明");
  await wait("!document.querySelector('dialog[open]')");
  await groupButton("区域甲", "编辑");
  await saveGroup("区域甲改", "编辑后的说明");
  await wait("!document.querySelector('dialog[open]')");
  const groups = (await adminApi("/groups")).items,
    A = groups.find((g) => g.name === "区域甲改").id,
    B = groups.find((g) => g.name === "区域乙").id;
  await groupButton("区域甲改", "移入设备");
  await wait("document.querySelectorAll('dialog[open] tbody tr').length===20");
  await click("dialog[open] tbody tr:nth-child(1) input[type=checkbox]");
  await mark("dialog[open] .pager", "下一页", "qaNextPage");
  await click("[data-qa-next-page]");
  await wait("document.querySelectorAll('dialog[open] tbody tr').length===3");
  await click("dialog[open] tbody tr:nth-child(1) input[type=checkbox]");
  await mark("dialog[open] .actions", "确认移入", "qaMove");
  await click("[data-qa-move]");
  await wait("!document.querySelector('dialog[open]')");
  assert.equal(
    (await adminApi("/groups")).items.find((g) => g.id === A).devices,
    2,
  );
  await tagGroup("区域甲改");
  assert.equal(
    await read(
      "Array.from(document.querySelectorAll('[data-qa-group] button')).find(b=>b.textContent.trim()==='删除').disabled",
    ),
    true,
  );
  const bDevice=(await adminApi('/devices?page=1&pageSize=100')).items.find(d=>d.groupId==='default');
  await groupButton("区域乙", "移入设备");
  await wait("document.querySelectorAll('dialog[open] tbody tr').length===20");
  await fill("dialog[open] [aria-label=查找设备]", bDevice.name);
  await click("dialog[open] form.toolbar button");
  await wait(
    `document.querySelectorAll('dialog[open] tbody tr').length===1&&document.querySelector('dialog[open] tbody').textContent.includes(${JSON.stringify(bDevice.name)})`,
  );
  await click("dialog[open] tbody input[type=checkbox]");
  await mark("dialog[open] .actions", "确认移入", "qaMoveB");
  await click("[data-qa-move-b]");
  await wait("!document.querySelector('dialog[open]')");
  await mark("#groups-view .title", "用户分组授权", "qaGrants");
  await click("[data-qa-grants]");
  assert.equal(
    await read(
      "document.querySelector('dialog[open] .actions button:last-child').disabled",
    ),
    true,
  );
  await select("dialog[open] select", reader);
  await wait(
    "!document.querySelector('dialog[open] .actions button:last-child').disabled",
  );
  await click('dialog[open] input[value="' + A + '"]');
  const before = await adminApi("/users/" + reader + "/groups");
  await adminApi("/users/" + reader + "/groups", "PUT", {
    groupIds: [B],
    version: before.version,
  });
  await click("dialog[open] .actions button:last-child");
  await wait(
    "document.querySelector('dialog[open] .error')?.textContent.includes('已更新')",
  );
  assert.equal(
    await read(
      "document.querySelector('dialog[open] .actions button:last-child').disabled",
    ),
    true,
  );
  await mark("dialog[open] .actions", "重新读取", "qaReread");
  await click("[data-qa-reread]");
  await wait(
    "document.querySelector('dialog[open] input[value=\"" +
      B +
      "\"]')?.checked",
  );
  await click('dialog[open] input[value="' + B + '"]');
  await click('dialog[open] input[value="' + A + '"]');
  await click("dialog[open] .actions button:last-child");
  await wait("!document.querySelector('dialog[open]')");
  const viewerResponse = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "qa-group-reader",
      password: "qa-group-password-123",
    }),
  });
  const viewerHeaders = {
    Cookie: viewerResponse.headers.get("set-cookie").split(";")[0],
  };
  async function visible() {
    return (
      await (
        await fetch(base + "/api/v1/devices?page=1&pageSize=100", {
          headers: viewerHeaders,
        })
      ).json()
    ).data.items;
  }
  assert.equal((await visible()).length, 2);
  await mark("#groups-view .title", "用户分组授权", "qaGrants");
  await click("[data-qa-grants]");
  await select("dialog[open] select", reader);
  await wait(
    "document.querySelector('dialog[open] input[value=\"" +
      A +
      "\"]')?.checked",
  );
  await click('dialog[open] input[value="' + A + '"]');
  await click("dialog[open] .actions button:last-child");
  await wait("!document.querySelector('dialog[open]')");
  assert.equal((await visible()).length, 0);
  async function moveBack(name) {
    await groupButton("未分组", "移入设备");
    await fill("dialog[open] [aria-label=查找设备]", name);
    await click("dialog[open] form.toolbar button");
    await wait(
      `document.querySelectorAll('dialog[open] tbody tr').length===1&&document.querySelector('dialog[open] tbody').textContent.includes(${JSON.stringify(name)})`,
    );
    await click("dialog[open] tbody input[type=checkbox]");
    await mark("dialog[open] .actions", "确认移入", "qaMoveBack");
    await click("[data-qa-move-back]");
    await wait("!document.querySelector('dialog[open]')");
  }
  const moved = (await adminApi("/devices?page=1&pageSize=100")).items.filter(
    (d) => d.groupId === A || d.groupId === B,
  );
  for (const device of moved) await moveBack(device.name);
  // Empty but still-granted groups must be rejected by the server, then allow delete after revocation.
  await mark("#groups-view .title", "用户分组授权", "qaGrants");
  await click("[data-qa-grants]");
  await select("dialog[open] select", reader);
  await wait(
    "!document.querySelector('dialog[open] .actions button:last-child').disabled",
  );
  await click('dialog[open] input[value="' + A + '"]');
  await click("dialog[open] .actions button:last-child");
  await wait("!document.querySelector('dialog[open]')");
  await groupButton("区域甲改", "删除");
  await click("dialog[open] .actions button:last-child");
  await wait(
    "document.querySelector('dialog[open] .error')?.textContent.includes('授权')",
  );
  await click("dialog[open] .actions button:first-child");
  await mark("#groups-view .title", "用户分组授权", "qaGrants");
  await click("[data-qa-grants]");
  await select("dialog[open] select", reader);
  await wait(
    "document.querySelector('dialog[open] input[value=\"" +
      A +
      "\"]')?.checked",
  );
  await click('dialog[open] input[value="' + A + '"]');
  await click("dialog[open] .actions button:last-child");
  await wait("!document.querySelector('dialog[open]')");
  for (const name of ["区域甲改", "区域乙"]) {
    await groupButton(name, "删除");
    await click("dialog[open] .actions button:last-child");
    await wait("!document.querySelector('dialog[open]')");
    await wait(
      `!Array.from(document.querySelectorAll('#groups-view tbody tr')).some(r=>r.querySelector('b')?.textContent===${JSON.stringify(name)})`,
    );
  }
  assert.equal((await adminApi("/groups")).items.length, 1);
  await measure("删除后单行分组", "#groups-view .data-table-scroll");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 3380,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await measure("超宽屏单行分组", "#groups-view .data-table-scroll");
  let shot = await cdp("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(
    ".tmp/groups-single-row-wide.png",
    Buffer.from(shot.data, "base64"),
  );
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await measure("窄屏单行分组", "#groups-view .data-table-scroll");
  shot = await cdp("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(
    ".tmp/groups-single-row-mobile.png",
    Buffer.from(shot.data, "base64"),
  );
  await cdp("Emulation.clearDeviceMetricsOverride");
  await choosePage("用户管理");
  await wait("document.querySelectorAll('#users-view tbody tr').length===2");
  await fill("[aria-label=查找用户]", "qa-group-reader");
  await wait("document.querySelectorAll('#users-view tbody tr').length===1");
  await measure("筛选后单行用户", "#users-view .data-table-scroll");
  await choosePage("订阅管理");
  await measure("订阅空表", ".subscriptions-view .data-table-scroll");
  await choosePage("国标级联");
  await measure("级联空表", "#cascade-view .data-table-scroll");
  assert.deepEqual(exceptions, []);
  console.log(
    "Group create/edit, cross-page move/search, grants/conflict/reread/revoke, in-use delete denial and final deletion verified",
  );
  console.log("Table geometry", JSON.stringify(metrics));
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


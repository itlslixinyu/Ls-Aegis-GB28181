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
  const groupA = (
      await adminApi("/groups", "POST", { name: "区域 A", description: "" })
    ).id,
    groupB = (
      await adminApi("/groups", "POST", { name: "区域 B", description: "" })
    ).id;
  await adminApi("/devices", "POST", {
    deviceId: "34020000001320000001",
    name: "区域 A 测试设备",
    groupId: groupA,
  });
  await adminApi("/devices", "POST", {
    deviceId: "34020000001320000002",
    name: "区域 B 测试设备",
    groupId: groupB,
  });
  const fixtureDevices = (await adminApi("/devices")).items;
  await adminApi("/groups/" + groupA + "/devices", "PUT", {
    deviceIds: [fixtureDevices.find((d) => d.name === "区域 A 测试设备").id],
  });
  await adminApi("/groups/" + groupB + "/devices", "PUT", {
    deviceIds: [fixtureDevices.find((d) => d.name === "区域 B 测试设备").id],
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
  async function snap(name) {
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(
      ".tmp/roles-" + name + ".png",
      Buffer.from(shot.data, "base64"),
    );
  }
  async function select(selector, value) {
    await read(
      `(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
  }
  async function logout() {
    await click(".account-trigger");
    await mark("#account-panel", "退出登录", "qaLogout");
    await click("[data-qa-logout]");
    await wait("!!document.querySelector('#auth')");
  }
  await click('button.nav-button[aria-label="分组授权"]');
  await wait(
    "Array.from(document.querySelectorAll('#groups-view tbody tr')).some(r=>r.querySelector('.badge')?.textContent.includes('默认'))",
  );
  await read(
    "Array.from(document.querySelectorAll('#groups-view tbody tr')).find(r=>r.querySelector('.badge')?.textContent.includes('默认')).dataset.qaDefaultGroup='1'",
  );
  await mark("[data-qa-default-group]", "编辑", "qaEditDefault");
  assert.equal(
    await read("document.querySelector('[data-qa-edit-default]').disabled"),
    false,
  );
  assert.equal(
    await read(
      "Array.from(document.querySelectorAll('[data-qa-default-group] button')).find(b=>b.textContent.trim()==='删除').disabled",
    ),
    true,
  );
  await click("[data-qa-edit-default]");
  await fill("dialog[open] form input[autofocus]", "默认接入设备");
  await fill("dialog[open] form textarea", "新接入设备等待分组");
  await click("dialog[open] .actions button:last-child");
  await wait(
    "!document.querySelector('dialog[open]')&&document.querySelector('#groups-view tbody')?.textContent.includes('新接入设备等待分组')",
  );
  await cdp("Page.reload");
  await wait(
    "document.querySelector('#groups-view tbody')?.textContent.includes('默认接入设备')",
  );
  await read(
    "Array.from(document.querySelectorAll('#groups-view tbody tr')).find(r=>r.querySelector('.badge')?.textContent.includes('默认')).dataset.qaDefaultGroup='1'",
  );
  await mark("[data-qa-default-group]", "编辑", "qaEditDefault");
  await click("[data-qa-edit-default]");
  await fill("dialog[open] form input[autofocus]", "区域 A");
  await click("dialog[open] .actions button:last-child");
  await wait(
    "document.querySelector('dialog[open] .error')?.textContent.includes('已存在')",
  );
  await click("dialog[open] .actions button:first-child");
  console.log(
    "Default group browser edit, description, refresh persistence and duplicate-name rejection verified; delete remains disabled",
  );
  await click('button.nav-button[aria-label="用户管理"]');
  await wait("!!document.querySelector('.user-management-tabs')");
  await click(".user-management-tabs button:nth-child(2)");
  await wait("document.querySelectorAll('.roles-panel tbody tr').length>=2");
  await mark(".roles-panel", "创建角色", "qaCreateRole");
  await click("[data-qa-create-role]");
  await fill(".role-editor-dialog [name=roleName]", "值班角色");
  await fill(
    ".role-editor-dialog [name=roleDescription]",
    "只管理授权区域的日常值守",
  );
  for (const key of [
    "live.preview",
    "alarms.handle",
    "recording.view",
    "map.view",
  ])
    await click('.role-editor-dialog input[value="' + key + '"]');
  assert.ok(
    await read(
      "document.querySelector('.role-editor-dialog input[value=\"devices.view\"]').checked&&document.querySelector('.role-editor-dialog input[value=\"alarms.view\"]').checked",
    ),
  );
  await snap("permission-desktop");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.ok(await read("document.documentElement.scrollWidth<=innerWidth"));
  await snap("permission-mobile");
  await cdp("Emulation.clearDeviceMetricsOverride");
  await click(".role-editor-dialog .actions button:last-child");
  await wait("!document.querySelector('.role-editor-dialog').open");
  const role = (await adminApi("/roles")).items.find(
    (r) => r.name === "值班角色",
  );
  assert.ok(role.permissions.includes("alarms.view"));
  await read(
    `(()=>{const row=Array.from(document.querySelectorAll('.roles-panel tbody tr')).find(r=>r.textContent.includes(${JSON.stringify(role.name)}));row.querySelector('button').dataset.qaEditRole='1'})()`,
  );
  await click("[data-qa-edit-role]");
  await fill(".role-editor-dialog [name=roleName]", "未保存的角色草稿");
  await adminApi("/roles/" + role.id, "PUT", {
    name: role.name,
    description: "其他窗口更新的角色说明",
    permissions: role.permissions,
    version: role.version,
  });
  await click(".role-editor-dialog .actions button:last-child");
  await wait(
    "document.querySelector('.role-editor-dialog [role=alert]')?.textContent.includes('已更新')",
  );
  assert.equal(
    await read(
      "document.querySelector('.role-editor-dialog [name=roleName]').value",
    ),
    "未保存的角色草稿",
  );
  assert.equal(
    await read(
      "document.querySelector('.role-editor-dialog .actions button:last-child').disabled",
    ),
    true,
  );
  await mark(".role-editor-dialog", "重新读取", "qaReadRole");
  await click("[data-qa-read-role]");
  await wait(
    "document.querySelector('.role-editor-dialog [name=roleDescription]').value==='其他窗口更新的角色说明'",
  );
  await click(".role-editor-dialog .actions button:last-child");
  await wait("!document.querySelector('.role-editor-dialog[open]')");
  await click(".user-management-tabs button:nth-child(1)");
  const unusedRole = (
    await adminApi("/roles", "POST", {
      name: "待清理筛选角色",
      permissions: [],
    })
  ).id;
  await mark("#users-view .title", "刷新", "qaRefreshUsers");
  await click("[data-qa-refresh-users]");
  await wait(
    `!!document.querySelector('[aria-label="筛选账号角色"] option[value="${unusedRole}"]')`,
  );
  await select('[aria-label="筛选账号角色"]', unusedRole);
  await adminApi("/roles/" + unusedRole, "DELETE");
  await click("[data-qa-refresh-users]");
  await wait("document.querySelector('[aria-label=筛选账号角色]').value===''");
  await mark("#users-view", "创建用户", "qaCreate");
  await click("[data-qa-create]");
  await fill(".user-editor-dialog input[autofocus]", "qa-duty");
  await fill(
    ".user-editor-dialog input[type=password]",
    "qa-duty-original-123",
  );
  await select(".user-editor-dialog .user-account-fields select", role.id);
  await fill(".user-editor-dialog input[name=displayName]", "区域值班员");
  await click(".user-editor-dialog .actions button:last-child");
  await wait("!document.querySelector('.user-editor-dialog').open");
  await fill('[aria-label="查找用户"]', "qa-duty");
  await wait(
    "document.querySelector('#users-view tbody tr')?.textContent.includes('值班角色')",
  );
  const target = (await adminApi("/users")).items.find(
    (u) => u.username === "qa-duty",
  );
  await mark("#users-view tbody tr", "授权", "qaAuthorize");
  await click("[data-qa-authorize]");
  await wait(
    "!!document.querySelector('.user-authorization-dialog select:not(:disabled)')",
  );
  assert.ok(
    await read(
      "document.querySelector('.authorization-summary')?.textContent.includes('告警确认与处置')",
    ),
  );
  await select(".user-authorization-dialog [name=authorizationRole]", "admin");
  assert.equal(
    await read(
      "document.querySelector('.user-authorization-dialog [name=authorizationScope]').value",
    ),
    "all",
  );
  await select(".user-authorization-dialog [name=authorizationRole]", role.id);
  assert.equal(
    await read(
      "document.querySelector('.user-authorization-dialog [name=authorizationScope]').value",
    ),
    "groups",
  );
  await click('.user-authorization-dialog input[value="' + groupA + '"]');
  await snap("assignment-desktop");
  await click(".user-authorization-dialog .actions button:last-child");
  await wait("!document.querySelector('.user-authorization-dialog')");
  await click("[data-qa-authorize]");
  await wait(
    "!!document.querySelector('.user-authorization-dialog select:not(:disabled)')",
  );
  const current = await adminApi("/users/" + target.id + "/authorization");
  await adminApi("/users/" + target.id + "/authorization", "PUT", {
    roleId: role.id,
    scopeMode: "groups",
    groupIds: [groupB],
    version: current.version,
  });
  await click(".user-authorization-dialog .actions button:last-child");
  await wait(
    "document.querySelector('.user-authorization-dialog [role=alert]')?.textContent.includes('已更新')",
  );
  await click(".user-authorization-dialog .actions button:nth-child(2)");
  await wait(
    "document.querySelector('.user-authorization-dialog input[value=\"" +
      groupB +
      "\"]')?.checked",
  );
  await click('.user-authorization-dialog input[value="' + groupB + '"]');
  await click('.user-authorization-dialog input[value="' + groupA + '"]');
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.ok(await read("document.documentElement.scrollWidth<=innerWidth"));
  await snap("assignment-mobile");
  await cdp("Emulation.clearDeviceMetricsOverride");
  await click(".user-authorization-dialog .actions button:last-child");
  await wait("!document.querySelector('.user-authorization-dialog')");
  console.log(
    "Role creation, permission dependencies, custom role on user create, group assignment and conflict recovery verified",
  );
  await logout();
  await fill("#auth input[autocomplete=username]", "qa-duty");
  await fill("#auth input[type=password]", "qa-duty-original-123");
  await click("#auth .login-submit");
  await wait("!!document.querySelector('#workspace')");
  assert.equal(
    await read(
      "!!document.querySelector('button.nav-button[aria-label=用户管理]')",
    ),
    false,
  );
  assert.ok(
    await read(
      "!!document.querySelector('button.nav-button[aria-label=实时监控]')",
    ),
  );
  await wait(
    "document.querySelector('#devices-table tbody')?.textContent.includes('区域 A 测试设备')||Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes('区域 A 测试设备'))",
  );
  assert.equal(
    await read(
      "Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes('区域 B 测试设备'))",
    ),
    false,
  );
  assert.equal(
    await read("fetch('/api/v1/system/config').then(r=>r.status)"),
    403,
  );
  await adminApi("/groups/" + groupB + "/devices", "PUT", {
    deviceIds: [fixtureDevices.find((d) => d.name === "区域 A 测试设备").id],
  });
  await soon(
    "!Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes('区域 A 测试设备'))",
    "设备移出分组立即消失",
  );
  await adminApi("/groups/" + groupA + "/devices", "PUT", {
    deviceIds: [fixtureDevices.find((d) => d.name === "区域 A 测试设备").id],
  });
  await soon(
    "Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes('区域 A 测试设备'))",
    "设备移入分组立即出现",
  );
  await click('button.nav-parent[aria-label="事件与位置"]');
  await click('button.nav-button[aria-label="告警管理"]');
  const currentRole = (await adminApi("/roles")).items.find(
    (r) => r.id === role.id,
  );
  await adminApi("/roles/" + role.id, "PUT", {
    name: role.name,
    description: role.description,
    permissions: ["devices.view"],
    version: currentRole.version,
  });
  await soon(
    "!document.querySelector('button.nav-button[aria-label=告警管理]')&&!!document.querySelector('#devices-view')",
    "撤权后菜单移除并退出失权页面",
  );
  assert.equal(
    await read(
      "fetch('/api/v1/me').then(r=>r.json()).then(me=>fetch('/api/v1/live-sessions',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.data.csrf},body:JSON.stringify({channelId:'not-a-channel'})})).then(r=>r.json()).then(r=>r.error.code)",
    ),
    "PERMISSION_DENIED",
  );
  const a = await adminApi("/users/" + target.id + "/authorization");
  await adminApi("/users/" + target.id + "/authorization", "PUT", {
    roleId: role.id,
    scopeMode: "all",
    groupIds: [],
    version: a.version,
  });
  await soon(
    "Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes('区域 B 测试设备'))",
    "全部设备范围立即刷新",
  );
  await select(
    "#devices-view .business-filters label:nth-child(3) select",
    groupA,
  );
  const filteredAuth = await adminApi("/users/" + target.id + "/authorization");
  await adminApi("/users/" + target.id + "/authorization", "PUT", {
    roleId: role.id,
    scopeMode: "groups",
    groupIds: [groupB],
    version: filteredAuth.version,
  });
  await soon(
    "Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes('区域 B 测试设备'))",
    "收回旧筛选分组后自动展示新授权范围",
  );
  const menuPermissions = {
    接入配置: "system.configure",
    用户管理: "users.manage",
    分组授权: "groups.manage",
    国标设备: "devices.view",
    实时监控: "live.preview",
    录像计划: "plans.manage",
    录像回放: "recording.view",
    录像任务: "recording.view",
    告警管理: "alarms.view",
    订阅管理: "subscriptions.view",
    历史轨迹: "tracks.view",
    设备地图: "map.view",
    国标级联: "cascade.manage",
    操作审计: "audit.view",
  };
  async function openMenu(label) {
    const selector =
      "button.nav-button[aria-label=" + JSON.stringify(label) + "]";
    const visible = await read(
      `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`,
    );
    if (!visible) {
      await read(
        `document.querySelector(${JSON.stringify(selector)}).closest('.nav-group').querySelector('.nav-parent').dataset.qaOpenGroup='1'`,
      );
      await click("[data-qa-open-group]");
      await read(
        "document.querySelector('[data-qa-open-group]').removeAttribute('data-qa-open-group')",
      );
    }
    await click(selector);
  }
  const testedRoles = [];
  const profiles = [
    ["admin", null],
    ["viewer", null],
    ["仅看设备", ["devices.view"]],
    ["云台值守", ["ptz.control"]],
    ["只看录像", ["recording.view"]],
    ["录像下载", ["recording.download"]],
    ["告警处置", ["alarms.handle"]],
    ["只看地图", ["map.view"]],
    ["维护点位", ["map.manage"]],
    ["订阅维护", ["subscriptions.manage"]],
    ["轨迹查看", ["tracks.view"]],
  ];
  const temporaryRoles = [];
  for (const [name, permissions] of profiles) {
    let id = name;
    if (permissions) {
      id = (await adminApi("/roles", "POST", { name, permissions })).id;
      temporaryRoles.push(id);
    }
    const authz = await adminApi("/users/" + target.id + "/authorization");
    await adminApi("/users/" + target.id + "/authorization", "PUT", {
      roleId: id,
      scopeMode: "groups",
      groupIds: [groupA],
      version: authz.version,
    });
    const assigned = (await adminApi("/roles")).items.find((r) => r.id === id);
    const expected = Object.entries(menuPermissions)
      .filter(([, permission]) => assigned.permissions.includes(permission))
      .map(([label]) => label)
      .sort();
    await soon(
      `JSON.stringify(Array.from(document.querySelectorAll('button.nav-button')).map(b=>b.getAttribute('aria-label')).sort())===${JSON.stringify(JSON.stringify(expected))}`,
      "角色菜单 " + name,
    );
    if (assigned.permissions.includes("live.preview")) {
      await openMenu("实时监控");
      await wait(
        "!!document.querySelector('.monitoring-page, .video-wall-scroll')",
      );
      assert.equal(
        await read("!!document.querySelector('.ptz-panel')"),
        assigned.permissions.includes("ptz.control"),
        name + " 云台按钮",
      );
    }
    if (assigned.permissions.includes("alarms.view")) {
      const device = fixtureDevices.find((d) => d.name === "区域 A 测试设备");
      testSip.onDeviceMessage(device, {
        Notify: {
          CmdType: "Alarm",
          SN: String(testedRoles.length + 1),
          DeviceID: device.deviceId,
          AlarmPriority: "1",
          AlarmMethod: "2",
          AlarmTime: new Date().toISOString(),
          AlarmDescription: "隔离权限验收 " + name,
        },
      });
      await openMenu("告警管理");
      await wait("document.querySelectorAll('#alarms-view tbody tr').length>0");
      await click("#alarms-view tbody tr button");
      await wait("!!document.querySelector('.alarm-dialog[open]')");
      assert.equal(
        await read("!!document.querySelector('.alarm-dialog textarea')"),
        assigned.permissions.includes("alarms.handle"),
      );
      if (name === "告警处置") {
        await mark(".alarm-dialog", "确认告警", "qaAck");
        await click("[data-qa-ack]");
        await wait(
          "document.querySelector('.alarm-dialog')?.textContent.includes('完成处置')",
        );
        await fill(".alarm-dialog textarea", "隔离账号完成核查");
        await mark(".alarm-dialog", "完成处置", "qaResolve");
        await click("[data-qa-resolve]");
        await wait("!document.querySelector('.alarm-dialog textarea')");
      }
      await mark(".alarm-dialog", "关闭", "qaCloseAlarm");
      await click("[data-qa-close-alarm]");
    }
    if (assigned.permissions.includes("map.view")) {
      await openMenu("设备地图");
      await wait(
        "document.querySelectorAll('.map-device-list button').length>0",
      );
      await click(".map-device-list button");
      await wait("!!document.querySelector('.map-detail')");
      for (const [text, permission] of [
        ["历史轨迹", "tracks.view"],
        ["实时预览", "live.preview"],
        ["设置位置", "map.manage"],
      ]) {
        assert.equal(
          await read(
            `Array.from(document.querySelectorAll('.map-detail button')).some(b=>b.textContent.trim()===${JSON.stringify(text)})`,
          ),
          assigned.permissions.includes(permission),
          name + " " + text,
        );
      }
      if (name === "维护点位") {
        await mark(".map-detail", "设置位置", "qaLocation");
        await click("[data-qa-location]");
        await wait(
          "!!document.querySelector('dialog[open] input[type=number]')",
        );
        await fill("dialog[open] input[type=number]", "114.3");
        await fill("dialog[open] label:nth-of-type(3) input", "30.6");
        await click("dialog[open] .actions button:last-child");
        await wait("!document.querySelector('dialog[open]')");
        assert.ok(
          await read(
            "document.querySelector('.map-detail')?.textContent.includes('114.3')",
          ),
        );
      }
    }
    if (assigned.permissions.includes("subscriptions.view")) {
      await openMenu("订阅管理");
      await wait("!!document.querySelector('.subscriptions-view')");
      assert.equal(
        await read(
          "Array.from(document.querySelectorAll('.subscriptions-view .title button')).some(b=>b.textContent.trim()==='配置订阅')",
        ),
        assigned.permissions.includes("subscriptions.manage"),
        name + " 订阅操作",
      );
      if (name === "订阅维护") {
        await mark(".subscriptions-view .title", "配置订阅", "qaSubscribe");
        await click("[data-qa-subscribe]");
        await wait(
          "document.querySelectorAll('.subscription-dialog select option').length>3",
        );
        await select(
          ".subscription-dialog label:nth-of-type(2) select",
          fixtureDevices.find((d) => d.name === "区域 A 测试设备").id,
        );
        await click(".subscription-dialog input[type=checkbox]");
        await click(".subscription-dialog .dialog-actions button:last-child");
        await wait("!document.querySelector('.subscription-dialog[open]')");
        await wait(
          "document.querySelector('.subscriptions-view tbody')?.textContent.includes('区域 A 测试设备')",
        );
      }
    }
    const own = await read(
      "fetch('/api/v1/me').then(r=>r.json()).then(r=>r.data.user)",
    );
    assert.equal(own.roleId, id);
    testedRoles.push(name);
  }
  console.log("Role/menu/action matrix verified", JSON.stringify(testedRoles));
  const empty = (
    await adminApi("/roles", "POST", { name: "暂不开放功能", permissions: [] })
  ).id;
  const latest = await adminApi("/users/" + target.id + "/authorization");
  await cdp("Network.enable");
  await cdp("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await delay(300);
  await adminApi("/users/" + target.id + "/authorization", "PUT", {
    roleId: empty,
    scopeMode: "all",
    groupIds: [],
    version: latest.version,
  });
  await cdp("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await soon(
    "document.querySelector('#workspace')?.textContent.includes('暂无可用功能')",
    "空角色立即清空业务菜单",
  );
  await click(".account-trigger");
  await mark("#account-panel", "个人中心", "qaProfile");
  await click("[data-qa-profile]");
  await wait(
    "!!document.querySelector('.personal-details input:not(:disabled)')",
  );
  await click('[aria-label="关闭个人中心"]');
  await adminApi("/users/" + target.id, "DELETE");
  await wait("!!document.querySelector('#auth')");
  await adminApi("/roles/" + role.id, "DELETE");
  await adminApi("/roles/" + empty, "DELETE");
  for (const id of temporaryRoles) await adminApi("/roles/" + id, "DELETE");
  assert.deepEqual(exceptions, []);
  console.log(
    "Browser verified: scoped rows, hidden menus, direct API denial, live revocation/navigation refresh, all-device scope and empty role personal center",
  );
  console.log("Authorization update latency", JSON.stringify(latencies));
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

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
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description || expression);
    return result.result.value;
  }
  const wait = (expression) => until(() => read(expression), expression);
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
  await cdp("Runtime.enable");
  await cdp("Page.navigate", { url: base });
  await login(oldPassword);
  await wait("!!document.querySelector('#workspace')");
  async function snap(name) {
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(
      ".tmp/user-info-" + name + ".png",
      Buffer.from(shot.data, "base64"),
    );
  }
  async function markButton(scope, text, key) {
    await read(
      `Array.from(document.querySelectorAll(${JSON.stringify(scope + " button")})).find(b=>b.textContent.trim()===${JSON.stringify(text)}).dataset[${JSON.stringify(key)}]='1'`,
    );
  }
  async function logout() {
    await click(".account-trigger");
    await markButton("#account-panel", "退出登录", "qaLogout");
    await click("[data-qa-logout]");
    await wait("!!document.querySelector('#auth')");
  }
  async function signIn(username, password) {
    await fill("#auth input[autocomplete=username]", username);
    await fill("#auth input[type=password]", password);
    await click("#auth .login-submit");
    await wait("!!document.querySelector('#workspace')");
  }
  async function openProfile() {
    await click(".account-trigger");
    await markButton("#account-panel", "个人中心", "qaProfile");
    await click("[data-qa-profile]");
    await wait(
      "document.querySelector('.profile-dialog').open&&!!document.querySelector('.personal-details input:not(:disabled)')",
    );
  }
  const dialog = ".user-editor-dialog",
    fields = dialog + " .user-profile-fields";
  const accountName = "qa-info-viewer",
    userPassword = "qa-user-original-123";
  await click('button.nav-button[aria-label="用户管理"]');
  await wait("!!document.querySelector('#users-view tbody tr')");
  await markButton("#users-view", "创建用户", "qaCreate");
  await click("[data-qa-create]");
  await fill(dialog + " input[autofocus]", accountName);
  await fill(dialog + " input[type=password]", userPassword);
  for (const [key, value] of Object.entries({
    displayName: "张三",
    department: "运行保障部",
    jobTitle: "值班员",
    phone: "+86 13800138000",
    email: "bad-email",
  }))
    await fill(fields + ` [name=${key}]`, value);
  await fill(fields + " textarea[name=remark]", "<b>测试备注</b>\n值班联系人");
  await click(dialog + " .actions button:last-child");
  assert.equal(
    await read(
      `document.querySelector('${fields} [name=email]').checkValidity()`,
    ),
    false,
  );
  assert.ok(await read("document.querySelector('.user-editor-dialog').open"));
  await fill(fields + " [name=email]", "operator@example.cn");
  await fill(fields + " [name=phone]", "abc");
  assert.equal(
    await read(
      `document.querySelector('${fields} [name=phone]').checkValidity()`,
    ),
    false,
  );
  await fill(fields + " [name=phone]", "+86 13800138000");
  await click(dialog + " .actions button:last-child");
  await wait(
    "!document.querySelector('.user-editor-dialog').open&&document.querySelector('#users-view').textContent.includes('张三')",
  );
  console.log(
    "Create user with full profile, native email and telephone validation verified",
  );
  await fill('[aria-label="查找用户"]', "运行保障部");
  await wait("document.querySelectorAll('#users-view tbody tr').length===1");
  await cdp("Page.reload");
  await wait("!!document.querySelector('#users-view')");
  assert.equal(
    await read("document.querySelector('[aria-label=查找用户]').value"),
    "运行保障部",
  );
  await wait("document.querySelectorAll('#users-view tbody tr').length===1");
  await markButton("#users-view tbody tr", "详情", "qaDetails");
  await click("[data-qa-details]");
  await wait(
    "document.querySelector('.user-details-dialog').textContent.includes('operator@example.cn')",
  );
  assert.ok(
    await read(
      "document.querySelector('.user-details-dialog').textContent.includes('<b>测试备注</b>')",
    ),
  );
  assert.equal(
    await read("!!document.querySelector('.profile-note b')"),
    false,
  );
  await snap("details-desktop");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.ok(await read("document.documentElement.scrollWidth<=innerWidth"));
  await snap("details-mobile");
  await click(".user-details-dialog .actions button");
  await cdp("Emulation.clearDeviceMetricsOverride");
  await markButton("#users-view tbody tr", "编辑", "qaEdit");
  await click("[data-qa-edit]");
  await wait(
    "!!document.querySelector('.user-editor-dialog input[name=displayName]:not(:disabled)')",
  );
  await fill(fields + " [name=displayName]", "张三（管理员维护）");
  await fill(fields + " [name=department]", "应急保障部");
  assert.equal(
    await read(
      `(async()=>{const me=(await (await fetch('/api/v1/me')).json()).data;const user=(await (await fetch('/api/v1/users')).json()).data.items.find(u=>u.username===${JSON.stringify(accountName)});const keys=['displayName','department','jobTitle','phone','email','remark'];const profile=Object.fromEntries(keys.map(k=>[k,user[k]||'']));return (await fetch('/api/v1/users/'+user.id+'/profile',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf},body:JSON.stringify({...profile,department:'其他窗口维护部门',version:user.version})})).status})()`,
    ),
    200,
  );
  await click(dialog + " .actions button:last-child");
  await wait(
    "document.querySelector('.user-editor-dialog [role=alert]')?.textContent.includes('其他页面更新')",
  );
  assert.equal(
    await read(
      "document.querySelector('.user-editor-dialog [name=displayName]').value",
    ),
    "张三（管理员维护）",
  );
  await markButton(dialog, "重新读取", "qaReadUser");
  await click("[data-qa-read-user]");
  await wait(
    "document.querySelector('.user-editor-dialog [name=department]').value==='其他窗口维护部门'",
  );
  await fill(fields + " [name=displayName]", "张三（管理员维护）");
  await fill(fields + " [name=department]", "应急保障部");
  await click(dialog + " .actions button:last-child");
  await wait("!document.querySelector('.user-editor-dialog').open");
  await fill('[aria-label="查找用户"]', accountName);
  await wait(
    "document.querySelector('#users-view tbody tr').textContent.includes('张三（管理员维护）')",
  );
  await snap("users-desktop");
  await logout();
  await signIn(accountName, userPassword);
  assert.equal(
    await read(
      "!!document.querySelector('button.nav-button[aria-label=用户管理]')",
    ),
    false,
  );
  assert.equal(await read("fetch('/api/v1/users').then(r=>r.status)"), 403);
  await openProfile();
  assert.equal(
    await read(
      "document.querySelector('.personal-details [name=department]').value",
    ),
    "应急保障部",
  );
  await fill(".personal-details [name=displayName]", "用户尚未保存的草稿");
  await click(".profile-tabs button:nth-child(2)");
  await click(".profile-tabs button:nth-child(1)");
  assert.equal(
    await read(
      "document.querySelector('.personal-details [name=displayName]').value",
    ),
    "用户尚未保存的草稿",
  );
  const conflict = await read(
    "(async()=>{const m=(await (await fetch('/api/v1/me')).json()).data,u=m.user,keys=['displayName','department','jobTitle','phone','email','remark'];const p=Object.fromEntries(keys.map(k=>[k,u[k]||'']));return (await fetch('/api/v1/me/profile',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':m.csrf},body:JSON.stringify({...p,department:'其他页面部门',version:u.version})})).status})()",
  );
  assert.equal(conflict, 200);
  await click(".personal-details .dialog-actions button:last-child");
  await wait(
    "document.querySelector('.personal-details [role=alert]')?.textContent.includes('其他页面更新')",
  );
  assert.equal(
    await read(
      "document.querySelector('.personal-details [name=displayName]').value",
    ),
    "用户尚未保存的草稿",
  );
  await click(".personal-details .dialog-actions .secondary");
  await wait(
    "document.querySelector('.personal-details [name=department]').value==='其他页面部门'",
  );
  await fill(".personal-details [name=displayName]", "张三 · 值班员");
  await fill(".personal-details [name=email]", "zhangsan@example.cn");
  await click(".personal-details .dialog-actions button:last-child");
  await wait(
    "document.querySelector('.personal-details [role=status]')?.textContent.includes('个人资料已保存')",
  );
  assert.equal(
    await read("document.querySelector('.account-name').textContent.trim()"),
    "张三 · 值班员",
  );
  await read("document.querySelector('.profile-dialog').scrollTop=0");
  await snap("personal-desktop");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.ok(await read("document.documentElement.scrollWidth<=innerWidth"));
  await snap("personal-mobile");
  await cdp("Emulation.clearDeviceMetricsOverride");
  assert.equal(
    await read(
      "document.querySelector('.personal-details [name=displayName]').value",
    ),
    "张三 · 值班员",
  );
  await click('[aria-label="关闭个人中心"]');
  await logout();
  await signIn("qa-profile", oldPassword);
  await click('button.nav-button[aria-label="用户管理"]');
  await wait("!!document.querySelector('[aria-label=查找用户]')");
  await fill('[aria-label="查找用户"]', accountName);
  await wait(
    "document.querySelector('#users-view tbody tr')?.textContent.includes('张三 · 值班员')",
  );
  await markButton("#users-view tbody tr", "删除", "qaRemove");
  await click("[data-qa-remove]");
  await wait(
    "Array.from(document.querySelectorAll('dialog[open]')).some(d=>d.textContent.includes('确认删除账号'))",
  );
  await read(
    "Array.from(document.querySelectorAll('dialog[open] .actions button')).find(b=>b.textContent.includes('删除')).dataset.qaConfirmRemove='1'",
  );
  await click("[data-qa-confirm-remove]");
  await wait(
    "document.querySelector('#users-view').textContent.includes('暂无匹配的用户')",
  );
  await fill('[aria-label="查找用户"]', "");
  await openProfile();
  await fill(".personal-details [name=displayName]", "测试管理员资料");
  await click(".personal-details .dialog-actions button:last-child");
  await wait(
    "document.querySelector('.personal-details [role=status]')?.textContent.includes('个人资料已保存')",
  );
  await click('[aria-label="关闭个人中心"]');
  assert.ok(
    await read(
      "document.querySelector('#users-view tbody').textContent.includes('测试管理员资料')",
    ),
  );
  assert.deepEqual(exceptions, []);
  console.log(
    "Admin edit/details/search and conflict reread, viewer self profile, persistence, permissions and deletion verified at desktop/mobile widths",
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

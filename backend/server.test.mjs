import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.mjs";
test("管理员初始化、鉴权、CSRF、设备CRUD、审计和重启持久化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vms-"));
  const database = join(dir, "platform.db"),
    legacy = join(dir, "devices.json");
  await writeFile(
    legacy,
    JSON.stringify([{ deviceId: "34020000001320000001", name: "旧设备" }]),
  );
  let server,
    base,
    cookie = "",
    csrf = "";
  async function start() {
    server = createServer({ database, legacy });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  }
  async function call(path, method = "GET", data, headers = {}) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const value = r.status === 204 ? null : await r.json();
    return { r, value };
  }
  try {
    await start();
    const homepage = await fetch(base.replace("/api/v1", "/"));
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /assets\/index-/);
    assert.match(
      homepage.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal((await call("/devices")).r.status, 401);
    assert.equal((await call("/devices")).r.status, 401);
    assert.equal((await call("/setup")).value.data.required, true);
    const credentials = { username: "admin", password: "correct-horse-123" };
    for (const username of [null, undefined, ["admin"], 123])
      assert.equal(
        (await call("/setup", "POST", { ...credentials, username })).r.status,
        400,
      );
    assert.equal(
      (await call("/setup", "POST", { ...credentials, password: "short" })).r
        .status,
      400,
    );
    assert.equal(
      (
        await call("/setup", "POST", credentials, {
          Origin: "https://evil.example",
        })
      ).r.status,
      403,
    );
    assert.equal((await call("/setup", "POST", credentials)).r.status, 201);
    assert.equal((await call("/setup", "POST", credentials)).r.status, 409);
    assert.equal(
      (await call("/auth/login", "POST", { ...credentials, password: "wrong" }))
        .r.status,
      401,
    );
    const login = await call("/auth/login", "POST", credentials);
    assert.equal(login.r.status, 200);
    cookie = login.r.headers.get("set-cookie").split(";")[0];
    csrf = login.value.data.csrf;
    assert.equal((await call("/devices")).value.data.total, 1);
    for (const username of [null, undefined, ["viewer"], 123])
      assert.equal(
        (
          await call("/users", "POST", {
            username,
            password: "viewer-password-123",
            role: "viewer",
          })
        ).r.status,
        400,
      );
    assert.equal(
      (
        await call("/users", "POST", {
          username: "viewer",
          password: "viewer-password-123",
          role: "viewer",
        })
      ).r.status,
      201,
    );
    assert.equal(
      (
        await call("/users", "POST", {
          username: "viewer",
          password: "viewer-password-123",
          role: "viewer",
        })
      ).r.status,
      409,
    );
    await call("/users", "POST", {
      username: "removable",
      password: "temporary-user-123",
      role: "viewer",
    });
    const removable = (await call("/users")).value.data.items.find(
      (u) => u.username === "removable",
    );
    const removedLogin = await call("/auth/login", "POST", {
        username: "removable",
        password: "temporary-user-123",
      }),
      removedCookie = removedLogin.r.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (await call("/users/" + removable.id, "DELETE")).r.status,
      204,
    );
    assert.equal(
      (await fetch(base + "/me", { headers: { Cookie: removedCookie } }))
        .status,
      401,
    );
    const me = await call("/me");
    assert.equal(
      (await call("/users/" + me.value.data.user.id, "DELETE")).r.status,
      409,
    );
    assert.equal(
      (await call("/media-nodes/local/check", "POST", {})).value.data.state,
      "not_configured",
    );
    const config = await call("/system/config");
    assert.equal(config.value.data.sip.port, 8116);
    assert.equal(config.value.data.media.secret, undefined);
    assert.equal(
      (await call("/devices", "POST", { name: "x", deviceId: "bad" })).r.status,
      400,
    );
    assert.equal((await call("/devices", "POST", null)).r.status, 400);
    const device = { name: "园区东门", deviceId: "34020000001320000002" };
    assert.equal(
      (await call("/devices", "POST", device, { "X-CSRF-Token": "" })).r.status,
      403,
    );
    const added = await call("/devices", "POST", device);
    assert.equal(added.r.status, 201);
    const id = added.value.data.id;
    assert.equal(
      (
        await call("/devices/" + id + "/credential", "PUT", {
          password: "sip-password-123",
        })
      ).r.status,
      204,
    );
    const detail = await call("/devices/" + id);
    assert.equal(detail.value.data.sipHa1, undefined);
    assert.equal(
      (await call("/devices/" + id + "/channels")).value.data.items.length,
      0,
    );
    assert.equal(
      (await call("/devices/" + id + "/catalog-sync", "POST", {})).r.status,
      409,
    );
    assert.equal((await call("/devices", "POST", device)).r.status, 409);
    assert.equal((await call("/devices?page=0")).r.status, 400);
    assert.equal(
      (await call("/devices?q=" + encodeURIComponent("东门"))).value.data.total,
      1,
    );
    assert.equal(
      (await call("/devices/" + id, "PATCH", { name: "东门新名称" })).value.data
        .name,
      "东门新名称",
    );
    await new Promise((r) => server.close(r));
    await start();
    assert.equal((await call("/devices")).value.data.total, 2);
    assert.equal((await call("/devices/" + id, "DELETE")).r.status, 204);
    assert.equal((await call("/devices/" + id)).r.status, 404);
    const logs = (await call("/audit")).value.data.items;
    assert.ok(logs.some((x) => x.action === "device.delete"));
    assert.ok(!JSON.stringify(logs).includes(credentials.password));
    assert.equal((await call("/auth/logout", "POST")).r.status, 204);
    assert.equal((await call("/devices")).r.status, 401);
    // Read-only role must be enforced by the server, not just hidden UI controls.
    cookie = "";
    csrf = "";
    const viewer = await call("/auth/login", "POST", {
      username: "viewer",
      password: "viewer-password-123",
    });
    cookie = viewer.r.headers.get("set-cookie").split(";")[0];
    csrf = viewer.value.data.csrf;
    assert.equal((await call("/devices")).r.status, 200);
    assert.equal((await call("/devices", "POST", device)).r.status, 403);
    assert.equal((await call("/audit")).r.status, 403);
    assert.equal((await call("/users")).r.status, 403);
    assert.equal((await call("/system/config")).r.status, 403);
    assert.equal(
      (await call("/media-nodes/local/check", "POST", {})).r.status,
      403,
    );
    const second = await call("/auth/login", "POST", {
      username: "viewer",
      password: "viewer-password-123",
    });
    const secondCookie = second.r.headers.get("set-cookie").split(";")[0];
    const change = {
      currentPassword: "viewer-password-123",
      newPassword: "viewer-replacement-123",
    };
    assert.equal(
      (await call("/me/password", "POST", change, { "X-CSRF-Token": "" })).r
        .status,
      403,
    );
    assert.equal(
      (
        await call("/me/password", "POST", {
          ...change,
          currentPassword: "wrong",
        })
      ).r.status,
      400,
    );
    assert.equal((await call("/me")).r.status, 200);
    assert.equal((await call("/me/password", "POST", change)).r.status, 204);
    assert.equal((await call("/me")).r.status, 401);
    assert.equal(
      (await call("/me", "GET", undefined, { Cookie: secondCookie })).r.status,
      401,
    );
    assert.equal(
      (
        await call("/auth/login", "POST", {
          username: "viewer",
          password: change.currentPassword,
        })
      ).r.status,
      401,
    );
    assert.equal(
      (
        await call("/auth/login", "POST", {
          username: "viewer",
          password: change.newPassword,
        })
      ).r.status,
      200,
    );
    assert.equal(
      (await call("/auth/login", "POST", credentials)).r.status,
      200,
    );
  } finally {
    if (server?.listening) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

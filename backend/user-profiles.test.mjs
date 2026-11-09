import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openStore, hashPassword } from "./lib/store.mjs";
import { validateProfile, publicUser } from "./services/user-profiles.mjs";
import { createServer } from "./server.mjs";
import { loadConfig } from "./lib/config.mjs";

const example = {
  displayName: "张三",
  department: "运行保障部",
  jobTitle: "值班员",
  phone: "+86 13800138000",
  email: "operator@example.cn",
  remark: "夜班\n设备巡检",
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "aegis-user-profile-")),
    database = join(dir, "platform.db");
  const { db } = openStore(database);
  for (const role of ["admin", "viewer"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      role,
      role,
      hashPassword("profile-password-123"),
      role,
    );
  db.close();
  let app, origin;
  async function start() {
    app = createServer({
      database,
      legacy: null,
      config: loadConfig({ SIP_ENABLED: "0" }),
    });
    await new Promise((r) => app.listen(0, "127.0.0.1", r));
    origin = "http://127.0.0.1:" + app.address().port;
  }
  await start();
  t.after(async () => {
    await new Promise((r) => app.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  async function call(path, method = "GET", value, session, headers = {}) {
    const response = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(8000),
    });
    return {
      status: response.status,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      ...(response.status === 204 ? {} : await response.json()),
    };
  }
  async function login(username = "admin", password = "profile-password-123") {
    const r = await call("/auth/login", "POST", { username, password });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.data.csrf, user: r.data.user };
  }
  return {
    call,
    login,
    database,
    async restart() {
      await new Promise((r) => app.close(r));
      await start();
    },
  };
}

test("资料校验：可选、去空格、长度与联系方式校验，拒绝越权字段", () => {
  assert.equal(
    validateProfile({ ...example, displayName: " 张三 " }).displayName,
    "张三",
  );
  assert.equal(validateProfile().email, "");
  for (const value of [
    { email: "broken" },
    { phone: "abc123" },
    { phone: "12" },
    { displayName: "x".repeat(51) },
    { remark: "x".repeat(501) },
    { department: "bad\nline" },
    { displayName: "x\u0000y" },
    { role: "admin" },
    { userId: "other" },
    { password: "secret" },
    null,
    [],
  ])
    assert.throws(
      () => validateProfile(value),
      (e) => e.status === 400,
    );
  assert.throws(() => validateProfile({ ...example, version: -1 }, true));
});

test("迁移11：保留旧账号与密码，时间只回填真实审计；幂等且资料随用户删除", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-profile-migration-")),
    file = join(dir, "platform.db");
  t.after(() => rm(dir, { recursive: true, force: true }));
  let { db } = openStore(file);
  db.exec(
    "DROP TRIGGER user_profile_insert;DROP TABLE user_profiles;DELETE FROM migrations WHERE version=11",
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "known",
    "known",
    "unchanged-hash",
    "viewer",
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "unknown",
    "unknown",
    "unchanged-hash-2",
    "admin",
  );
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?)").run(
    "a",
    "admin",
    "user.create",
    "known",
    "2024-01-02T00:00:00Z",
  );
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?)").run(
    "b",
    "known",
    "auth.login",
    null,
    "2025-01-02T00:00:00Z",
  );
  db.close();
  ({ db } = openStore(file));
  assert.equal(publicUser(db, "known").createdAt, "2024-01-02T00:00:00Z");
  assert.equal(publicUser(db, "known").lastLoginAt, "2025-01-02T00:00:00Z");
  assert.equal(publicUser(db, "unknown").createdAt, null);
  assert.equal(publicUser(db, "unknown").lastLoginAt, null);
  assert.equal(
    db.prepare("SELECT passwordHash FROM users WHERE id=?").get("known")
      .passwordHash,
    "unchanged-hash",
  );
  db.prepare(
    "UPDATE user_profiles SET displayName='保留资料' WHERE userId='known'",
  ).run();
  db.close();
  ({ db } = openStore(file));
  assert.equal(publicUser(db, "known").displayName, "保留资料");
  db.prepare("DELETE FROM users WHERE id='known'").run();
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM user_profiles WHERE userId='known'")
      .get().n,
    0,
  );
  db.close();
});

test("管理员创建、查看和编辑资料；登录、本人资料与重启后信息一致且不泄露密码", async (t) => {
  const f = await fixture(t),
    admin = await f.login();
  const created = await f.call(
    "/users",
    "POST",
    {
      username: "profile-user",
      password: "profile-user-password",
      role: "viewer",
      profile: example,
    },
    admin,
  );
  assert.equal(created.status, 201);
  const user = created.data;
  assert.equal(user.displayName, example.displayName);
  assert.ok(user.createdAt);
  assert.equal(user.lastLoginAt, null);
  const session = await f.login("profile-user", "profile-user-password");
  assert.ok(session.user.lastLoginAt);
  const mine = await f.call("/me", "GET", undefined, session);
  assert.equal(mine.data.user.email, example.email);
  const update = await f.call(
    "/me/profile",
    "PUT",
    {
      ...example,
      displayName: "自行维护姓名",
      version: mine.data.user.version,
    },
    session,
  );
  assert.equal(update.status, 200);
  const detail = await f.call("/users/" + user.id, "GET", undefined, admin);
  assert.equal(detail.data.displayName, "自行维护姓名");
  const edited = await f.call(
    "/users/" + user.id + "/profile",
    "PUT",
    { ...example, department: "应急保障部", version: detail.data.version },
    admin,
  );
  assert.equal(edited.status, 200);
  assert.equal(
    (await f.call("/me", "GET", undefined, session)).data.user.department,
    "应急保障部",
  );
  const list = await f.call("/users", "GET", undefined, admin);
  assert.ok(
    list.data.items.some(
      (u) => u.id === user.id && u.department === "应急保障部",
    ),
  );
  for (const value of [created, session, mine, detail, edited, list]) {
    assert.ok(!JSON.stringify(value).includes("passwordHash"));
    assert.ok(!JSON.stringify(value).includes("profile-user-password"));
  }
  await f.restart();
  const persisted = await f.call("/me", "GET", undefined, session);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.data.user.department, "应急保障部");
  assert.equal(
    (await f.login("profile-user", "profile-user-password")).user.role,
    "viewer",
  );
});

test("权限和CSRF：只读用户只能维护自己，不能查看或修改其他用户资料", async (t) => {
  const f = await fixture(t),
    admin = await f.login(),
    viewer = await f.login("viewer");
  for (const path of ["/users", "/users/admin"])
    assert.equal((await f.call(path, "GET", undefined, viewer)).status, 403);
  assert.equal(
    (await f.call("/me/profile", "PUT", { ...example, version: 0 })).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        "/users/admin/profile",
        "PUT",
        { ...example, version: 0 },
        viewer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("/me/profile", "PUT", { ...example, version: 0 }, viewer, {
        "X-CSRF-Token": "bad",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/users/viewer/profile",
        "PUT",
        { ...example, version: 0 },
        admin,
        { "X-CSRF-Token": "bad" },
      )
    ).status,
    403,
  );
  for (const extra of [
    { role: "admin" },
    { id: "admin" },
    { username: "admin" },
    { createdAt: "fake" },
  ])
    assert.equal(
      (
        await f.call(
          "/me/profile",
          "PUT",
          { ...example, version: 0, ...extra },
          viewer,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await f.call(
        "/users/missing/profile",
        "PUT",
        { ...example, version: 0 },
        admin,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call("/users/missing", "GET", undefined, admin)).status,
    404,
  );
  assert.equal(
    (await f.call("/me", "GET", undefined, viewer)).data.user.role,
    "viewer",
  );
});

test("过期版本与无效字段不覆盖资料；审计仅记录资源和操作", async (t) => {
  const f = await fixture(t),
    admin = await f.login(),
    viewer = await f.login("viewer");
  assert.equal(
    (await f.call("/me/profile", "PUT", { ...example, version: 0 }, viewer))
      .status,
    200,
  );
  const stale = await f.call(
    "/users/viewer/profile",
    "PUT",
    { ...example, displayName: "不应覆盖", version: 0 },
    admin,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, "PROFILE_CONFLICT");
  assert.equal(
    (
      await f.call(
        "/me/profile",
        "PUT",
        { ...example, email: "not-an-email", version: 1 },
        viewer,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.call("/me", "GET", undefined, viewer)).data.user.displayName,
    example.displayName,
  );
  const invalidCreate = await f.call(
    "/users",
    "POST",
    {
      username: "not-created",
      password: "valid-password-123",
      role: "viewer",
      profile: { email: "broken" },
    },
    admin,
  );
  assert.equal(invalidCreate.status, 400);
  assert.ok(
    !(await f.call("/users", "GET", undefined, admin)).data.items.some(
      (u) => u.username === "not-created",
    ),
  );
  const audit = await f.call("/audit", "GET", undefined, admin);
  assert.equal(
    audit.data.items.filter((a) => a.action === "user.profile.self").length,
    1,
  );
  assert.ok(!JSON.stringify(audit).includes(example.phone));
  assert.ok(!JSON.stringify(audit).includes(example.email));
});

test("成功登录记录最近登录，失败登录不覆盖；删除用户清理资料", async (t) => {
  const f = await fixture(t),
    admin = await f.login();
  const before = (await f.call("/me", "GET", undefined, admin)).data.user;
  assert.equal(
    (
      await f.call("/auth/login", "POST", {
        username: "admin",
        password: "wrong-password",
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.call("/me", "GET", undefined, admin)).data.user.lastLoginAt,
    before.lastLoginAt,
  );
  assert.equal(
    (await f.call("/users/viewer", "DELETE", undefined, admin)).status,
    204,
  );
  const db = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM user_profiles WHERE userId='viewer'")
      .get().n,
    0,
  );
  db.close();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, hashPassword } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";

test("通道HTTP分页：32/33边界、超过旧上限、搜索与分组权限一致", async (t) => {
  const prefix = join(tmpdir(), "aegis-channel-page-");
  const dir = await mkdtemp(prefix),
    database = join(dir, "test.db");
  const { db } = openStore(database);
  for (const [id, role] of [
    ["admin", "admin"],
    ["viewer", "viewer"],
  ])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      hashPassword("test-password-123"),
      role,
    );
  for (const [id, count, name] of [
    ["nvr-a", 1030, "大型录像机"],
    ["nvr-b", 32, "其他录像机"],
  ]) {
    db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
      id,
      id,
      "测试",
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,createdAt,groupId) VALUES(?,?,?,?,?)",
    ).run(
      id,
      id === "nvr-a" ? "34020000001110000001" : "34020000001110000002",
      name,
      new Date().toISOString(),
      id,
    );
    for (let i = 1; i <= count; i++)
      db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
        `${id}:${i}`,
        id,
        String(34020000001310000000n + BigInt(i)),
        `通道${i}`,
        "online",
      );
  }
  db.prepare("INSERT INTO user_groups VALUES(?,?)").run("viewer", "nvr-a");
  db.close();
  const server = createServer({
    database,
    config: loadConfig({}),
    configFile: null,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    if (!dir.startsWith(prefix)) throw Error("Unexpected temporary path");
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function login(username) {
    const r = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "test-password-123" }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  }
  const admin = await login("admin"),
    viewer = await login("viewer");
  async function get(path, cookie = admin, status = 200) {
    const r = await fetch(base + path, { headers: { Cookie: cookie } });
    assert.equal(r.status, status, path);
    return (await r.json()).data;
  }
  const first = await get("/devices/nvr-a/channels?page=1&pageSize=32");
  const second = await get("/devices/nvr-a/channels?page=2&pageSize=32");
  assert.equal(first.total, 1030);
  assert.equal(first.items.length, 32);
  assert.equal(second.items[0].id, "nvr-a:33");
  assert.equal(
    new Set([...first.items, ...second.items].map((x) => x.id)).size,
    64,
  );
  assert.equal(
    (await get("/devices/nvr-a/channels?page=33&pageSize=32")).items.length,
    6,
  );
  assert.equal(
    (await get("/devices/nvr-b/channels?page=2&pageSize=32")).items.length,
    0,
  );
  assert.equal(
    (await get("/devices/nvr-b/channels?page=1&pageSize=32")).total,
    32,
  );
  const all = await get("/channels?page=1&pageSize=32");
  assert.equal(all.total, 1062);
  assert.equal((await get("/channels?page=1&pageSize=32", viewer)).total, 1030);
  await get("/devices/nvr-b/channels?page=1&pageSize=32", viewer, 404);
  const search = await get(
    "/channels?page=1&pageSize=32&q=" + encodeURIComponent("通道1030"),
    viewer,
  );
  assert.deepEqual(
    search.items.map((x) => x.id),
    ["nvr-a:1030"],
  );
  assert.equal(search.total, 1);
  assert.equal(
    (
      await get(
        "/channels?page=1&pageSize=32&q=" + encodeURIComponent("大型录像机"),
      )
    ).total,
    1030,
  );
  assert.equal(
    (await get("/channels?channelId=nvr-a%3A1030&page=1&pageSize=1", viewer))
      .items[0].id,
    "nvr-a:1030",
  );
  assert.equal(
    (await get("/channels?channelId=nvr-b%3A1&page=1&pageSize=1", viewer))
      .total,
    0,
  );
  assert.equal((await get("/channels")).items.length, 500);
  assert.equal((await get("/devices/nvr-a/channels")).items.length, 1000);
  for (const query of [
    "page=0",
    "page=-1",
    "page=1.2",
    "page=no",
    "pageSize=0",
    "pageSize=101",
    "pageSize=NaN",
    "page=9007199254740991&pageSize=100",
  ])
    for (const route of ["/channels", "/devices/nvr-a/channels"])
      await get(route + "?" + query, admin, 400);
});

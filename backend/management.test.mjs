import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { openStore, hashPassword } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { SecurityEvents } from "./services/security-events.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { parseSip } from "./sip/protocol.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
test("SIP告警只接受已注册端点和本设备通道，错误来源不得落库", async () => {
  const { db } = openStore(":memory:"),
    now = Date.now(),
    code = "34020000001320000001";
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,remoteAddress,remotePort,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "d",
    code,
    "告警源",
    "online",
    new Date().toISOString(),
    "127.0.0.1",
    16000,
    now + 3600000,
    now,
  );
  const sip = new SipGateway({
      db,
      config: {
        enabled: false,
        host: "127.0.0.1",
        port: 8116,
        serverId: "41010500002000000001",
        domain: "4101050000",
      },
    }),
    events = new SecurityEvents({ db, sip, access: new Access(db) }),
    output = [];
  sip.state = "listening";
  sip.socket = {
    send(buffer, p, h, cb) {
      output.push(parseSip(buffer));
      cb?.();
    },
    close() {},
  };
  sip.requests.request = async () => ({ status: 200 });
  sip.onDeviceMessage = (d, x) => events.handle(d, x);
  function packet(seq, target = code) {
    const xml = `<Notify><CmdType>Alarm</CmdType><SN>${seq}</SN><DeviceID>${target}</DeviceID><AlarmPriority>2</AlarmPriority><AlarmMethod>5</AlarmMethod><AlarmTime>2026-11-01T12:00:00</AlarmTime><AlarmDescription>边界测试</AlarmDescription></Notify>`;
    return Buffer.from(
      [
        `MESSAGE sip:41010500002000000001@4101050000 SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:16000;branch=z9hG4bK${seq}`,
        `From: <sip:${code}@4101050000>;tag=test`,
        `To: <sip:41010500002000000001@4101050000>`,
        `Call-ID: alarm-${seq}`,
        `CSeq: ${seq} MESSAGE`,
        "Content-Type: Application/MANSCDP+xml",
        `Content-Length: ${Buffer.byteLength(xml)}`,
        "",
        xml,
      ].join("\r\n"),
    );
  }
  try {
    sip.receive(packet(1), { address: "127.0.0.1", port: 16001 });
    assert.equal(output.at(-1).status, 403);
    assert.equal(db.prepare("SELECT count(*) AS n FROM alarms").get().n, 0);
    sip.receive(packet(2), { address: "127.0.0.1", port: 16000 });
    assert.equal(output.at(-1).status, 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM alarms").get().n, 1);
    sip.receive(packet(3, "34020000001310000002"), {
      address: "127.0.0.1",
      port: 16000,
    });
    assert.equal(output.at(-1).status, 400);
    assert.equal(db.prepare("SELECT count(*) AS n FROM alarms").get().n, 1);
  } finally {
    await events.close();
    sip.close();
    db.close();
  }
});
test("v0.5已有设备迁移至默认分组，保留既有只读访问且新用户默认拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl-migrate-scope-")),
    path = join(dir, "old.db");
  let db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE migrations(version INTEGER PRIMARY KEY);INSERT INTO migrations VALUES(1),(2),(3),(4),(5),(6),(7);CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,passwordHash TEXT,role TEXT);INSERT INTO users VALUES('v','viewer','unused','viewer');CREATE TABLE devices(id TEXT PRIMARY KEY,deviceId TEXT UNIQUE,name TEXT,status TEXT DEFAULT 'unregistered',channels INTEGER DEFAULT 0,createdAt TEXT,sipHa1 TEXT,remoteAddress TEXT,remotePort INTEGER,registeredUntil INTEGER,lastHeartbeat INTEGER,sipTransport TEXT DEFAULT 'UDP',mediaTransport TEXT DEFAULT 'UDP');INSERT INTO devices(id,deviceId,name,createdAt) VALUES('d','34020000001320000001','旧设备','2026-10-31T00:00:00Z');`,
  );
  db.close();
  try {
    ({ db } = openStore(path));
    const access = new Access(db);
    assert.equal(
      db.prepare("SELECT groupId FROM devices WHERE id='d'").get().groupId,
      "default",
    );
    assert.equal(access.device("v", "d"), true);
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      "new",
      "newuser",
      "unused",
      "viewer",
    );
    assert.equal(access.device("new", "d"), false);
    assert.throws(() =>
      db.prepare("UPDATE devices SET groupId='missing'").run(),
    );
    db.close();
    ({ db } = openStore(path));
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM user_groups").get().n,
      1,
    );
    assert.ok(db.prepare("SELECT 1 FROM migrations WHERE version=8").get());
  } finally {
    db.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});
test("地图瓦片经登录代理、参数有界且不返回上游凭据；非图像响应拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl-map-")),
    database = join(dir, "test.db"),
    { db } = openStore(database);
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "a",
    "admin",
    hashPassword("test-password-123"),
    "admin",
  );
  db.close();
  let lastPath = "";
  const tiles = http.createServer((req, res) => {
    lastPath = req.url;
    if (req.url.startsWith("/1/0/0")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([1, 2, 3]));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("not an image");
    }
  });
  await new Promise((r) => tiles.listen(0, "127.0.0.1", r));
  const config = loadConfig({
      MAP_TILE_URL: `http://127.0.0.1:${tiles.address().port}/{z}/{x}/{y}?key=private-key`,
      MAP_ATTRIBUTION: "测试底图",
    }),
    server = createServer({ database, legacy: null, config });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(origin + "/api/v1/map/tiles/1/0/0")).status, 401);
    const login = await fetch(origin + "/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "test-password-123",
        }),
      }),
      cookie = login.headers.get("set-cookie").split(";")[0];
    await login.json();
    const tile = await fetch(origin + "/api/v1/map/tiles/1/0/0", {
      headers: { Cookie: cookie },
    });
    assert.equal(tile.status, 200);
    assert.equal((await tile.arrayBuffer()).byteLength, 3);
    assert.equal(tile.headers.get("cache-control"), "private, max-age=604800");
    assert.match(lastPath, /key=private-key/);
    assert.equal(
      (
        await fetch(origin + "/api/v1/map/tiles/20/0/0", {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(origin + "/api/v1/map/tiles/1/1/0", {
          headers: { Cookie: cookie },
        })
      ).status,
      502,
    );
    const data = await (
      await fetch(origin + "/api/v1/map", { headers: { Cookie: cookie } })
    ).json();
    assert.equal(data.data.tileConfigured, true);
    assert.ok(!JSON.stringify(data).includes("private-key"));
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => tiles.close(r));
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});

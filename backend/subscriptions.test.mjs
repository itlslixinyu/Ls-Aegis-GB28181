import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { SecurityEvents } from "./services/security-events.mjs";
import { Subscriptions } from "./services/subscriptions.mjs";
import { PositionHistory } from "./services/position-history.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { SipFramer } from "./sip/transport.mjs";
import { parseSip, response } from "./sip/protocol.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createServer } from "./server.mjs";
const code = "34020000001320000001";
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error("测试条件超时");
}
function seed(db) {
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "a",
    "admin",
    hashPassword("test-password-123"),
    "admin",
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "v",
    "viewer",
    hashPassword("test-password-123"),
    "viewer",
  );
  db.prepare("INSERT INTO user_groups VALUES(?,?)").run("v", "default");
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat,remoteAddress,remotePort) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "d",
    code,
    "测试设备",
    "online",
    new Date().toISOString(),
    Date.now() + 3600000,
    Date.now(),
    "127.0.0.1",
    15060,
  );
}
function position(time = new Date().toISOString(), lon = 116.4, target = code) {
  return {
    Notify: {
      CmdType: "MobilePosition",
      SN: "1",
      DeviceID: target,
      Time: time,
      Longitude: String(lon),
      Latitude: "39.9",
    },
  };
}
const xmlOf = (p) =>
  "<Notify>" +
  Object.entries(p.Notify)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("") +
  "</Notify>";
function notice(
  d,
  {
    seq = 1,
    state = "active;expires=60",
    body = xmlOf(position()),
    fromTag = "guanlan",
    event = "presence",
  } = {},
) {
  return parseSip(
    Buffer.from(
      [
        `NOTIFY sip:41010500002000000001@127.0.0.1 SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:15060;branch=z9hG4bKn${seq}`,
        `From: <sip:${code}@4101050000>;tag=${fromTag}`,
        `To: ${d.from}`,
        `Call-ID: ${d.callId}`,
        `CSeq: ${seq} NOTIFY`,
        `Event: ${event}`,
        `Subscription-State: ${state}`,
        `Content-Type: Application/MANSCDP+xml`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body,
      ].join("\r\n"),
    ),
  );
}
function fixture() {
  const { db } = openStore(":memory:");
  seed(db);
  const access = new Access(db),
    requests = [];
  const sip = {
    state: "listening",
    seq: 1,
    config: loadConfig({}).sip,
    requests: {
      request: async (o) => {
        requests.push(o);
        return {
          status: 200,
          headers: {
            to: [o.to.includes(";tag=") ? o.to : o.to + ";tag=guanlan"],
            expires: [
              o.headers?.find((h) => h.startsWith("Expires:"))?.slice(9) ||
                "60",
            ],
          },
          body: Buffer.alloc(0),
        };
      },
    },
  };
  const history = new PositionHistory({ db, access }),
    events = new SecurityEvents({ db, sip, access, history }),
    service = new Subscriptions({ db, sip, access, events, autoStart: false });
  return {
    db,
    access,
    sip,
    history,
    events,
    service,
    requests,
    device: db.prepare("SELECT * FROM devices WHERE id=?").get("d"),
    async close() {
      await service.close();
      await events.close();
      db.close();
    },
  };
}
const settings = { enabled: true, expires: 60, interval: 5 };
test("订阅接受与通知分开，协商有效期、同对话递增续订、取消和最终空通知", async () => {
  const f = fixture();
  try {
    const { id } = f.service.set("a", "d", "MobilePosition", settings);
    await until(() => f.service.row(id)?.status === "awaiting_notify");
    const d = f.service.dialogs.get(id);
    assert.equal(f.service.row(id).lastNotifyAt, null);
    assert.match(f.requests[0].body, /<Interval>5/);
    f.service.notify(f.device, notice(d), position());
    assert.equal(f.service.row(id).status, "active");
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      1,
    );
    f.db
      .prepare(
        "UPDATE device_subscriptions SET nextAttempt=0,expiresAt=? WHERE id=?",
      )
      .run(Date.now() + 4000, id);
    f.service.tick();
    await until(() => !f.service.jobs.size);
    assert.equal(f.requests[1].callId, f.requests[0].callId);
    assert.equal(f.requests[1].cseq, 2);
    assert.match(f.requests[1].to, /tag=guanlan/);
    assert.ok(f.service.row(id).expiresAt > Date.now() + 55000);
    f.service.set("a", "d", "MobilePosition", { ...settings, enabled: false });
    await until(() => f.service.row(id).status === "disabled");
    assert.ok(f.requests.at(-1).headers.includes("Expires: 0"));
    f.service.notify(
      f.device,
      notice(d, { seq: 2, state: "terminated;reason=timeout", body: "" }),
      null,
    );
    assert.equal(f.service.dialogs.size, 0);
    assert.equal(f.service.row(id).enabled, 0);
  } finally {
    await f.close();
  }
});
test("初始NOTIFY先于200可建立对话；请求中停用不处理迟到内容并发送取消", async () => {
  const f = fixture();
  let resolve;
  try {
    f.sip.requests.request = (o) => {
      f.requests.push(o);
      if (f.requests.length === 1)
        return new Promise((r, j) => {
          resolve = r;
          o.signal.addEventListener("abort", () => j(Error("aborted")), {
            once: true,
          });
        });
      return Promise.resolve({
        status: 200,
        headers: { to: [o.to], expires: ["0"] },
        body: Buffer.alloc(0),
      });
    };
    const { id } = f.service.set("a", "d", "MobilePosition", settings);
    await until(() => f.requests.length === 1);
    const d = f.service.dialogs.get(id);
    f.service.notify(f.device, notice(d), position());
    assert.equal(f.service.row(id).status, "active");
    f.service.set("a", "d", "MobilePosition", { ...settings, enabled: false });
    await until(() => !f.service.jobs.size);
    f.service.notify(
      f.device,
      notice(d, {
        seq: 2,
        body: xmlOf(position(new Date().toISOString(), 117)),
      }),
      position(new Date().toISOString(), 117),
    );
    f.service.tick();
    await until(() => f.service.row(id).status === "disabled");
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      1,
    );
    assert.ok(f.requests.at(-1).headers.includes("Expires: 0"));
    resolve?.({ status: 200, headers: {} });
  } finally {
    await f.close();
  }
});
test("订阅校验拒绝非法设置、错误事件/标签/类型/序号与外部Contact，不污染轨迹", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.set("v", "d", "Alarm", settings), /权限/);
    assert.throws(
      () => f.service.set("a", "d", "Alarm", { ...settings, expires: 10 }),
      /有效期/,
    );
    const { id } = f.service.set("a", "d", "MobilePosition", settings);
    await until(() => !f.service.jobs.size && f.service.row(id).acceptedAt);
    const d = f.service.dialogs.get(id);
    for (const options of [
      { event: "Alarm" },
      { fromTag: "wrong" },
      { body: "<Notify><CmdType>Alarm</CmdType></Notify>" },
    ]) {
      const req = notice(d, options);
      assert.throws(() =>
        f.service.notify(
          f.device,
          req,
          options.body ? { Notify: { CmdType: "Alarm" } } : position(),
        ),
      );
    }
    let req = notice(d);
    req.headers.contact = ["<sip:" + code + "@192.0.2.1:9999>"];
    assert.throws(() => f.service.notify(f.device, req, position()), /Contact/);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      0,
    );
    f.service.notify(f.device, notice(d, { seq: 3 }), position());
    f.service.notify(f.device, notice(d, { seq: 3 }), position());
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      1,
    );
    assert.throws(
      () => f.service.notify(f.device, notice(d, { seq: 2 }), position()),
      /序号/,
    );
  } finally {
    await f.close();
  }
});
test("拒绝、通知超时与481退避可恢复；重启丢弃旧对话但保留启用意图，关闭清理待办", async () => {
  const f = fixture();
  try {
    let mode = "reject";
    f.sip.requests.request = async (o) => {
      f.requests.push(o);
      return {
        status: mode === "reject" ? 481 : 200,
        headers: { to: [o.to + ";tag=guanlan"], expires: ["60"] },
        body: Buffer.alloc(0),
      };
    };
    const { id } = f.service.set("a", "d", "Alarm", settings);
    await until(() => f.service.row(id).status === "failed");
    assert.equal(f.service.dialogs.size, 0);
    assert.ok(f.service.row(id).nextAttempt > Date.now());
    mode = "ok";
    f.db.prepare("UPDATE device_subscriptions SET nextAttempt=0").run();
    f.service.tick();
    await until(() => f.service.row(id).status === "awaiting_notify");
    const oldCall = f.service.dialogs.get(id).callId;
    f.service.dialogs.get(id).notifyDeadline = Date.now() - 1;
    f.service.tick();
    assert.equal(f.service.row(id).status, "failed");
    await f.service.close();
    const next = new Subscriptions({
      db: f.db,
      sip: f.sip,
      access: f.access,
      events: f.events,
      autoStart: false,
    });
    assert.equal(next.row(id).enabled, 1);
    assert.equal(next.row(id).status, "waiting");
    next.tick();
    await until(() => next.row(id).status === "awaiting_notify");
    assert.notEqual(next.dialogs.get(id).callId, oldCall);
    await next.close();
    assert.equal(next.jobs.size, 0);
  } finally {
    await f.close();
  }
});
test("历史轨迹独立于手工点位：晚到点按时序、重复去重、目标隔离及撤权", async () => {
  const f = fixture();
  try {
    const now = Date.now(),
      t1 = new Date(now - 60000).toISOString(),
      t2 = new Date(now - 30000).toISOString();
    f.events.position("d", { longitude: 120, latitude: 30 });
    f.events.handle(f.device, position(t2, 117));
    f.events.handle(f.device, position(t1, 116));
    f.events.handle(f.device, position(t1, 116));
    const params = new URLSearchParams({
      start: new Date(now - 120000).toISOString(),
      end: new Date(now).toISOString(),
    });
    const result = f.history.query("v", "d", params);
    assert.deepEqual(
      result.items.map((p) => p.longitude),
      [116, 117],
    );
    assert.equal(
      f.db.prepare("SELECT longitude FROM device_locations").get().longitude,
      120,
    );
    assert.equal(f.history.targets("d").items[0].code, code);
    assert.throws(
      () =>
        f.history.query(
          "v",
          "d",
          new URLSearchParams({
            ...Object.fromEntries(params),
            targetCode: "34020000001320000002",
          }),
        ),
      /不属于/,
    );
    f.db.prepare("DELETE FROM user_groups").run();
    assert.throws(() => f.history.query("v", "d", params), /无权/);
  } finally {
    await f.close();
  }
});
test("历史轨迹游标冻结采样集合，范围/坐标/保留期限受控，旧库迁移不伪造轨迹", async () => {
  const f = fixture();
  try {
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      0,
    );
    const now = Date.now(),
      t = new Date(now - 60000).toISOString();
    for (let i = 0; i < 3; i++) f.events.handle(f.device, position(t, 116 + i));
    const params = new URLSearchParams({
      start: new Date(now - 120000).toISOString(),
      end: new Date(now).toISOString(),
      limit: "2",
    });
    const first = f.history.query("a", "d", params);
    assert.equal(first.total, 3);
    assert.ok(first.nextCursor);
    f.events.handle(
      f.device,
      position(new Date(now - 30000).toISOString(), 119),
    );
    params.set("cursor", first.nextCursor);
    const second = f.history.query("a", "d", params);
    assert.equal(second.total, 3);
    assert.equal(second.items.length, 1);
    assert.equal(
      new Set([...first.items, ...second.items].map((p) => p.id)).size,
      3,
    );
    params.set("cursor", "broken");
    assert.throws(() => f.history.query("a", "d", params), /游标/);
    assert.throws(() => f.events.handle(f.device, position(t, 200)), /坐标/);
    const old = new Date(now - 31 * 86400000).toISOString();
    f.events.handle(f.device, position(old, 110));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      4,
    );
    f.history.prune(now + 31 * 86400000);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT max(version) AS n FROM migrations").get().n,
      12,
    );
  } finally {
    await f.close();
  }
});
for (const transport of ["UDP", "TCP"])
  test(
    "真实本机" + transport + "：SUBSCRIBE/NOTIFY告警与位置、续订及取消闭环",
    async () => {
      const { db } = openStore(":memory:");
      seed(db);
      const config = loadConfig({ SIP_ENABLED: "1" });
      config.sip.port = 0;
      const sip = new SipGateway({ db, config: config.sip });
      await sip.start();
      let socket, send, remotePort;
      const received = [],
        requests = [],
        responses = [];
      try {
        const handler = (buf) => {
          const p = parseSip(buf);
          received.push(p);
          if (p.method === "SUBSCRIBE") {
            requests.push(p);
            const expires = p.headers.expires[0],
              kind = p.body.toString().match(/<CmdType>([^<]+)/)[1];
            send(response(p, 200, "OK", ["Expires: " + expires]));
            const body =
              expires === "0"
                ? ""
                : kind === "MobilePosition"
                  ? xmlOf(position())
                  : `<Notify><CmdType>Alarm</CmdType><SN>99</SN><DeviceID>${code}</DeviceID><AlarmPriority>2</AlarmPriority><AlarmMethod>5</AlarmMethod><AlarmTime>${new Date().toISOString()}</AlarmTime><AlarmDescription>订阅告警模拟</AlarmDescription></Notify>`;
            const fake = {
              from: p.headers.from[0],
              callId: p.headers["call-id"][0],
            };
            const packet = notice(fake, {
              seq: requests.length,
              state:
                expires === "0"
                  ? "terminated;reason=timeout"
                  : "active;expires=" + expires,
              body,
            });
            const wire = [
              `NOTIFY ${packet.uri} SIP/2.0`,
              ...Object.entries(packet.headers).flatMap(([k, v]) =>
                v.map((value) => k + ": " + value),
              ),
              "",
              body,
            ].join("\r\n");
            send(
              Buffer.from(
                wire.replace(
                  "SIP/2.0/UDP 127.0.0.1:15060",
                  "SIP/2.0/" + transport + " 127.0.0.1:" + remotePort,
                ),
              ),
            );
          } else if (p.method === "MESSAGE") send(response(p, 200, "OK"));
          else if (p.status) responses.push(p);
        };
        if (transport === "UDP") {
          socket = dgram.createSocket("udp4");
          socket.on("message", handler);
          await new Promise((r) => socket.bind(0, "127.0.0.1", r));
          remotePort = socket.address().port;
          send = (buf) => {
            if (buf.length) socket.send(buf, sip.config.port, "127.0.0.1");
          };
        } else {
          socket = net.connect(sip.config.port, "127.0.0.1");
          await new Promise((r) => socket.once("connect", r));
          remotePort = socket.localPort;
          const framer = new SipFramer(handler);
          socket.on("data", (b) => framer.push(b));
          send = (buf) => {
            if (buf.length) socket.write(buf);
          };
        }
        db.prepare(
          "UPDATE devices SET status='online',remoteAddress='127.0.0.1',registeredUntil=?,lastHeartbeat=?,remotePort=?,sipTransport=? WHERE id='d'",
        ).run(Date.now() + 3600000, Date.now(), remotePort, transport);
        const access = new Access(db),
          history = new PositionHistory({ db, access }),
          events = new SecurityEvents({ db, sip, access, history }),
          service = new Subscriptions({
            db,
            sip,
            access,
            events,
            autoStart: false,
          });
        sip.onDeviceNotify = (d, r, x) => service.notify(d, r, x);
        sip.onDeviceMessage = (d, x) => events.handle(d, x);
        try {
          const mobile = service.set("a", "d", "MobilePosition", settings),
            alarm = service.set("a", "d", "Alarm", settings);
          await until(
            () =>
              service.row(mobile.id).status === "active" &&
              service.row(alarm.id).status === "active",
          );
          assert.match(
            requests[0].headers.contact[0],
            new RegExp("transport=" + transport.toLowerCase()),
          );
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM alarms").get().n,
            1,
          );
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM position_history").get().n,
            1,
          );
          db.prepare(
            "UPDATE device_subscriptions SET nextAttempt=0 WHERE id=?",
          ).run(mobile.id);
          service.tick();
          await until(() => requests.length >= 3 && !service.jobs.size);
          assert.equal(
            requests[2].headers["call-id"][0],
            requests[0].headers["call-id"][0],
          );
          assert.match(requests[2].headers.to[0], /tag=guanlan/);
          for (const kind of ["MobilePosition", "Alarm"])
            service.set("a", "d", kind, { ...settings, enabled: false });
          await until(
            () =>
              service.row(mobile.id).status === "disabled" &&
              service.row(alarm.id).status === "disabled",
          );
          assert.ok(
            requests.filter((p) => p.headers.expires[0] === "0").length === 2,
          );
          await until(() => responses.length >= 5);
          assert.ok(responses.every((p) => p.status === 200));
        } finally {
          await service.close();
          await events.close();
        }
      } finally {
        if (transport === "UDP") socket?.close();
        else socket?.destroy();
        sip.close();
        db.close();
      }
    },
  );
test("HTTP订阅写权限/CSRF、查询隔离、轨迹游标及移组后的历史访问即时变化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl-sub-http-")),
    database = join(dir, "test.db"),
    { db } = openStore(database);
  seed(db);
  db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
    "hidden",
    "隐藏组",
    "",
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt,groupId) VALUES(?,?,?,?,?)",
  ).run(
    "hidden-device",
    "34020000001320000002",
    "隐藏设备",
    new Date().toISOString(),
    "hidden",
  );
  const history = new PositionHistory({ db, access: new Access(db) }),
    now = Date.now();
  history.record(
    "d",
    code,
    { longitude: 116, latitude: 39 },
    new Date(now - 60000).toISOString(),
  );
  db.close();
  const server = createServer({
    database,
    legacy: null,
    config: loadConfig({}),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  async function login(username) {
    const r = await fetch(origin + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "test-password-123" }),
    });
    const json = await r.json();
    return {
      Cookie: r.headers.get("set-cookie").split(";")[0],
      "X-CSRF-Token": json.data.csrf,
    };
  }
  async function call(path, headers, method = "GET", body) {
    const r = await fetch(origin + "/api/v1" + path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, ...(r.status === 204 ? {} : await r.json()) };
  }
  try {
    const a = await login("admin"),
      v = await login("viewer");
    assert.equal((await call("/devices/d/subscriptions/Alarm/guard", v, "POST", {})).status, 403);
    assert.equal((await call("/devices/d/subscriptions/Alarm/guard", { Cookie: a.Cookie }, "POST", {})).status, 403);
    assert.equal(
      (await call("/devices/d/subscriptions/Alarm", v, "PUT", settings)).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/devices/d/subscriptions/Alarm",
          { Cookie: a.Cookie },
          "PUT",
          settings,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/devices/d/subscriptions/Alarm", a, "PUT", settings)).status,
      202,
    );
    assert.equal(
      (
        await call(
          "/devices/hidden-device/subscriptions/MobilePosition",
          a,
          "PUT",
          settings,
        )
      ).status,
      202,
    );
    const list = await call("/subscriptions", v);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].deviceId, "d");
    assert.equal(JSON.stringify(list.data).includes("remoteAddress"), false);
    assert.equal((await call("/devices/d", a, "DELETE")).status, 409);
    const range = new URLSearchParams({
      start: new Date(now - 120000).toISOString(),
      end: new Date(now).toISOString(),
    });
    assert.equal(
      (await call("/devices/d/positions?" + range, v)).data.total,
      1,
    );
    assert.equal(
      (await call("/devices/hidden-device/positions?" + range, v)).status,
      404,
    );
    assert.equal(
      (await call("/devices/d/position-targets", v)).data.items[0].code,
      code,
    );
    assert.equal(
      (await call("/devices/d/positions?" + range + "&cursor=broken", v))
        .status,
      400,
    );
    assert.equal((await call("/devices/d/positions", v)).status, 400);
    assert.equal((await call("/map/config", v)).data.tileConfigured, false);
    await call("/groups/hidden/devices", a, "PUT", { deviceIds: ["d"] });
    assert.equal((await call("/devices/d/positions?" + range, v)).status, 404);
    assert.equal((await call("/subscriptions", v)).data.total, 0);
    assert.equal(
      (await call("/devices/d/positions?" + range, a)).data.total,
      1,
    );
    assert.equal(
      (
        await call("/devices/d/subscriptions/Alarm", a, "PUT", {
          ...settings,
          enabled: false,
        })
      ).status,
      202,
    );
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});

test("取消已被设备接受后，迟到active通知不恢复取消状态，也不新增历史点", async () => {
  const f = fixture();
  try {
    const { id } = f.service.set("a", "d", "MobilePosition", settings);
    await until(() => f.service.row(id).status === "awaiting_notify");
    const d = f.service.dialogs.get(id);
    f.service.set("a", "d", "MobilePosition", { ...settings, enabled: false });
    await until(() => f.service.row(id).status === "disabled");
    f.service.notify(f.device, notice(d, { seq: 2 }), position());
    assert.equal(f.service.row(id).status, "disabled");
    assert.equal(f.service.row(id).expiresAt, null);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM position_history").get().n,
      0,
    );
    f.service.tick(Date.now() + 33000);
    assert.equal(f.service.row(id).status, "disabled");
    assert.equal(f.service.dialogs.has(id), false);
  } finally {
    await f.close();
  }
});


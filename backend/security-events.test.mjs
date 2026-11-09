import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { Access } from "./services/access.mjs";
import { SecurityEvents, coordinates } from "./services/security-events.mjs";
function fixture() {
  const { db } = openStore(":memory:");
  for (const [id, role] of [
    ["a", "admin"],
    ["v", "viewer"],
  ])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(id, id, "unused", role);
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt) VALUES(?,?,?,?)",
  ).run("d", "34020000001320000001", "事件设备", new Date().toISOString());
  db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
    "c",
    "d",
    "34020000001310000001",
    "事件通道",
    "offline",
  );
  const access = new Access(db),
    requests = [],
    events = new SecurityEvents({
      db,
      access,
      sip: {
        state: "listening",
        requests: {
          async request(v) {
            requests.push(v);
            return { status: 200 };
          },
        },
      },
    }),
    device = db.prepare("SELECT * FROM devices WHERE id=?").get("d");
  const alarm = (changes = {}) => ({
    Notify: {
      CmdType: "Alarm",
      SN: "1",
      DeviceID: "34020000001310000001",
      AlarmPriority: "1",
      AlarmMethod: "5",
      AlarmTime: "2026-11-01T09:00:00",
      AlarmDescription: "移动侦测",
      Info: { AlarmType: "2" },
      ...changes,
    },
  });
  return {
    db,
    access,
    events,
    requests,
    device,
    alarm,
    async close() {
      await events.close();
      db.close();
    },
  };
}
test("国标告警规范化、业务应答与跨事务去重，不重开已处置事件", async () => {
  const f = fixture();
  try {
    assert.equal(f.events.handle(f.device, f.alarm()), true);
    const list = f.events.list("a", new URLSearchParams());
    assert.equal(list.total, 1);
    assert.equal(list.items[0].occurredAt, "2026-11-01T01:00:00.000Z");
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].body, /<CmdType>Alarm<\/CmdType>.*<Result>OK/);
    const id = list.items[0].id;
    let a = f.events.action(
      id,
      { userId: "a", username: "admin" },
      { action: "acknowledge", version: 1, note: "已核实" },
    );
    a = f.events.action(
      id,
      { userId: "a", username: "admin" },
      { action: "resolve", version: a.version, note: "已排除现场异常" },
    );
    f.events.handle(f.device, f.alarm({ SN: "2" }));
    a = f.events.get(id, "a");
    assert.equal(a.repeatCount, 2);
    assert.equal(a.status, "resolved");
    assert.equal(a.actions.length, 2);
    assert.equal(
      f.events.list("a", new URLSearchParams("status=new")).total,
      0,
    );
    assert.equal(
      f.events.list("a", new URLSearchParams("priority=1")).stats.resolved,
      1,
    );
  } finally {
    await f.close();
  }
});
test("告警拒绝错误通道/日期/坐标及非法处置，版本冲突不写重复记录", async () => {
  const f = fixture();
  try {
    for (const data of [
      { DeviceID: "34020000001310000002" },
      { AlarmPriority: "9" },
      { AlarmTime: "2026-02-30T00:00:00" },
      { Longitude: "", Latitude: "30" },
    ])
      assert.throws(() => f.events.handle(f.device, f.alarm(data)));
    f.events.handle(f.device, f.alarm());
    const id = f.events.list("a", new URLSearchParams()).items[0].id;
    assert.throws(() =>
      f.events.action(
        id,
        { userId: "a", username: "a" },
        { action: "resolve", version: 1, note: "跳步" },
      ),
    );
    f.events.action(
      id,
      { userId: "a", username: "a" },
      { action: "acknowledge", version: 1 },
    );
    assert.throws(() =>
      f.events.action(
        id,
        { userId: "a", username: "a" },
        { action: "acknowledge", version: 1 },
      ),
    );
    assert.throws(() =>
      f.events.action(
        id,
        { userId: "a", username: "a" },
        { action: "resolve", version: 2, note: " " },
      ),
    );
    assert.equal(f.events.get(id, "a").actions.length, 1);
  } finally {
    await f.close();
  }
});
test("位置校验、手动优先与过期定位保护，不把其他设备通道作为本设备定位", async () => {
  const f = fixture();
  try {
    assert.deepEqual(coordinates(0, 0), { longitude: 0, latitude: 0 });
    assert.throws(() => coordinates("0", "0"));
    assert.throws(() => coordinates(Infinity, 30));
    assert.throws(() => coordinates(181, 20));
    const xml = (time) => ({
      Notify: {
        CmdType: "MobilePosition",
        DeviceID: f.device.deviceId,
        Time: time,
        Longitude: "116.4",
        Latitude: "39.9",
      },
    });
    f.events.handle(f.device, xml("2026-01-01T00:00:00"));
    assert.equal(
      f.db.prepare("SELECT source FROM device_locations").get().source,
      "device",
    );
    f.events.position("d", {
      longitude: 110,
      latitude: 30,
      address: "人工位置",
    });
    f.events.handle(f.device, xml("2026-02-01T00:00:00"));
    assert.equal(
      f.db.prepare("SELECT longitude FROM device_locations").get().longitude,
      110,
    );
    f.db.prepare("DELETE FROM device_locations").run();
    f.events.handle(f.device, xml("2026-02-01T00:00:00"));
    f.events.handle(f.device, xml("2026-01-01T00:00:00"));
    assert.equal(
      f.db.prepare("SELECT updatedAt FROM device_locations").get().updatedAt,
      "2026-01-31T16:00:00.000Z",
    );
    assert.throws(() =>
      f.events.handle(f.device, {
        Notify: {
          ...xml("2026-01-01T00:00:00").Notify,
          DeviceID: "34020000001310000002",
        },
      }),
    );
  } finally {
    await f.close();
  }
});
test("告警和分组默认拒绝；授权/撤销即刻影响历史详情和统计", async () => {
  const f = fixture();
  try {
    f.events.handle(f.device, f.alarm());
    const id = f.events.list("a", new URLSearchParams()).items[0].id;
    assert.equal(f.access.device("v", "d"), false);
    assert.equal(f.events.list("v", new URLSearchParams()).total, 0);
    assert.throws(() => f.events.get(id, "v"));
    f.db.prepare("INSERT INTO user_groups VALUES(?,?)").run("v", "default");
    assert.equal(f.events.list("v", new URLSearchParams()).total, 1);
    assert.equal(f.access.channel("v", "c"), true);
    f.db.prepare("DELETE FROM user_groups WHERE userId=?").run("v");
    assert.throws(() => f.events.get(id, "v"));
    assert.equal(f.access.groups("v").length, 0);
  } finally {
    await f.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { openStore } from "./lib/store.mjs";
import { DeviceOperations, encodePtz } from "./services/device-operations.mjs";
import {
  RecordQueries,
  parseRecordTime,
  recordRange,
} from "./services/record-queries.mjs";
import { SipRequests } from "./sip/requests.mjs";
import { parseSip } from "./sip/protocol.mjs";
import { SipDialogs } from "./sip/dialogs.mjs";
function fixture() {
  const { db } = openStore(":memory:");
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "u",
    "admin",
    "unused",
    "admin",
  );
  const now = Date.now();
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat,remoteAddress,remotePort) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "d",
    "34020000001320000001",
    "设备",
    "online",
    new Date().toISOString(),
    now + 3600000,
    now,
    "127.0.0.1",
    15060,
  );
  db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
    "c",
    "d",
    "34020000001310000001",
    "通道",
    "online",
  );
  const sent = [];
  const sip = {
    state: "listening",
    seq: 1,
    config: {
      domain: "4101050000",
      serverId: "41010500002000000001",
      host: "127.0.0.1",
      port: 8116,
      heartbeatTimeout: 180000,
    },
    requests: {
      async request(value) {
        sent.push(value);
        return { status: 200 };
      },
    },
  };
  const operations = new DeviceOperations({ db, sip });
  return { db, sip, operations, sent };
}
test("云台指令编码使用已知校验向量并拒绝非法动作和速度", () => {
  assert.equal(encodePtz("stop"), "A50F0100000000B5");
  assert.equal(encodePtz("right", 128), "A50F010180000036");
  assert.equal(encodePtz("up", 128), "A50F01080080003D");
  assert.equal(encodePtz("zoomIn", 255), "A50F01100000F0B5");
  assert.throws(() => encodePtz("toString"));
  assert.throws(() => encodePtz("left", 0));
});
test("云台自动停止、控制锁以及迟到的开始指令不会覆盖已发送停止", async () => {
  const f = fixture();
  try {
    f.operations.ptz("c", "u", {
      action: "right",
      duration: 100,
      token: "press-001",
    });
    assert.throws(
      () =>
        f.operations.ptz("c", "other", {
          action: "left",
          token: "press-other",
        }),
      /其他用户/,
    );
    await delay(140);
    await Promise.all(f.operations.jobs);
    assert.equal(f.operations.active.size, 0);
    assert.match(f.sent.at(-1).body, /<PTZCmd>A50F0100000000B5/);
    f.operations.ptz("c", "u", { action: "stop", token: "cancel-001" });
    assert.throws(
      () => f.operations.ptz("c", "u", { action: "up", token: "cancel-001" }),
      /已取消/,
    );
    const a = f.operations.ptz("c", "u", {
      action: "left",
      token: "new-press",
    });
    assert.equal(
      f.operations.ptz("c", "u", { action: "left", token: "new-press" })
        .commandId,
      a.commandId,
    );
    assert.equal(
      f.operations.ptz("c", "u", { action: "stop", token: "old-press" }).status,
      "ignored",
    );
    assert.ok(f.operations.active.has("c"));
    await f.operations.stopUser("u");
    assert.equal(f.operations.active.size, 0);
  } finally {
    await f.operations.close();
    f.db.close();
  }
});
test("录像查询隔离用户、去重分批结果并裁剪查询范围", async () => {
  const f = fixture(),
    queries = new RecordQueries({ ...f, timeout: 1000 });
  try {
    const result = queries.create("c", "u", {
      start: "2026-10-31T08:00:00+08:00",
      end: "2026-10-31T09:00:00+08:00",
    });
    const sn = [...queries.pending.keys()][0];
    const response = (items) => ({
      Response: {
        CmdType: "RecordInfo",
        SN: sn,
        DeviceID: "34020000001310000001",
        SumNum: "2",
        RecordList: { Item: items },
      },
    });
    const a = {
        DeviceID: "34020000001310000001",
        Name: "录像1",
        StartTime: "2026-10-31T07:50:00",
        EndTime: "2026-10-31T08:30:00",
        FilePath: "/record-1",
        Type: "time",
      },
      b = {
        ...a,
        Name: "录像2",
        StartTime: "2026-10-31T08:30:00",
        EndTime: "2026-10-31T09:10:00",
        FilePath: "/record-2",
      };
    assert.equal(queries.handle({ id: "wrong" }, response(a)), false);
    queries.handle({ id: "d" }, response(a));
    queries.handle({ id: "d" }, response(a));
    assert.equal(queries.get(result.taskId, "u").status, "running");
    queries.handle({ id: "d" }, response(b));
    const data = queries.get(result.taskId, "u");
    assert.equal(data.status, "succeeded");
    assert.equal(data.items.length, 2);
    assert.equal(data.items[0].start, "2026-10-31T00:00:00.000Z");
    assert.equal(data.items[1].end, "2026-10-31T01:00:00.000Z");
    assert.throws(() => queries.get(result.taskId, "other"), /无权/);
  } finally {
    await queries.close();
    await f.operations.close();
    f.db.close();
  }
});
test("录像空结果与超时区分，日期和查询跨度严格校验", async () => {
  assert.throws(() => parseRecordTime("2026-02-31T00:00:00Z"));
  assert.throws(() =>
    recordRange("2026-10-31T01:00:00Z", "2026-10-31T00:00:00Z"),
  );
  assert.equal(
    parseRecordTime("2026-10-31T08:00:00"),
    Date.parse("2026-10-31T00:00:00Z"),
  );
  const f = fixture(),
    queries = new RecordQueries({ ...f, timeout: 30 });
  try {
    const a = queries.create("c", "u", {
      start: "2026-10-31T00:00:00Z",
      end: "2026-10-31T01:00:00Z",
    });
    queries.handle(
      { id: "d" },
      {
        Response: {
          CmdType: "RecordInfo",
          SN: [...queries.pending.keys()][0],
          DeviceID: "34020000001310000001",
          SumNum: "0",
        },
      },
    );
    assert.equal(queries.get(a.taskId, "u").status, "succeeded");
    assert.deepEqual(queries.get(a.taskId, "u").items, []);
    const b = queries.create("c", "u", {
      start: "2026-10-31T00:00:00Z",
      end: "2026-10-31T01:00:00Z",
    });
    await delay(60);
    assert.equal(queries.get(b.taskId, "u").status, "failed");
  } finally {
    await queries.close();
    await f.operations.close();
    f.db.close();
  }
});
test("通用SIP事务校验来源和Via分支，响应后清理事务", async () => {
  let buffer;
  const gateway = {
    state: "listening",
    seq: 1,
    config: {
      host: "127.0.0.1",
      port: 8116,
      domain: "4101050000",
      serverId: "41010500002000000001",
    },
    socket: {
      send(data) {
        buffer = data;
      },
    },
  };
  const requests = new SipRequests(gateway, { timeout: 100 });
  try {
    const promise = requests.request({
      uri: "sip:34020000001310000001@4101050000",
      remote: { remoteAddress: "127.0.0.1", remotePort: 15060 },
      body: "<test/>",
    });
    const original = parseSip(buffer);
    const result = { status: 200, headers: original.headers };
    assert.equal(
      requests.handle(result, { address: "127.0.0.2", port: 15060 }),
      false,
    );
    assert.equal(
      requests.handle(
        {
          ...result,
          headers: { ...original.headers, via: ["SIP/2.0/UDP x;branch=wrong"] },
        },
        { address: "127.0.0.1", port: 15060 },
      ),
      false,
    );
    assert.equal(
      requests.handle(result, { address: "127.0.0.1", port: 15060 }),
      true,
    );
    assert.equal((await promise).status, 200);
    assert.equal(requests.pending.size, 0);
  } finally {
    requests.close();
  }
});
test("回放SDP包含独立时间段，INFO使用递增CSeq并随后正确BYE", async () => {
  const sent = [],
    infos = [];
  const gateway = {
    state: "listening",
    config: {
      host: "127.0.0.1",
      port: 8116,
      domain: "4101050000",
      serverId: "41010500002000000001",
    },
    socket: {
      send(buffer) {
        sent.push(buffer);
      },
    },
    requests: {
      async request(value) {
        infos.push(value);
        return { status: 200 };
      },
    },
  };
  const dialogs = new SipDialogs(gateway);
  try {
    const work = dialogs.invite(
      { remoteAddress: "127.0.0.1", remotePort: 15060 },
      "34020000001310000001",
      {
        host: "127.0.0.1",
        port: 40000,
        ssrc: "1100000001",
        playback: {
          start: "2026-10-31T00:00:00Z",
          end: "2026-10-31T01:00:00Z",
        },
      },
    );
    const invite = parseSip(sent[0]);
    assert.match(
      invite.body.toString(),
      /s=Playback\r\nu=34020000001310000001:0/,
    );
    assert.match(
      invite.body.toString(),
      new RegExp(
        "t=" + Math.floor(Date.parse("2026-10-31T00:00:00Z") / 1000) + " ",
      ),
    );
    dialogs.handle(
      {
        status: 200,
        headers: {
          ...invite.headers,
          to: [invite.headers.to[0] + ";tag=remote"],
        },
      },
      { address: "127.0.0.1", port: 15060 },
    );
    const dialog = await work;
    await dialogs.control(dialog, { action: "pause" });
    await dialogs.control(dialog, { action: "speed", scale: 2 });
    await dialogs.control(dialog, { action: "seek", position: 120 });
    assert.deepEqual(
      infos.map((i) => i.cseq),
      [2, 3, 4],
    );
    assert.match(infos[0].body, /PAUSE RTSP\/1.0/);
    assert.match(infos[1].body, /Scale: 2/);
    assert.match(infos[2].body, /Range: npt=120-/);
    await dialogs.control(dialog, { action: "speed", scale: 16 });
    await dialogs.control(dialog, { action: "speed", scale: -8 });
    await dialogs.control(dialog, { action: "resume" });
    assert.match(infos[3].body, /Scale: 16/);
    assert.match(infos[4].body, /Scale: -8/);
    assert.match(infos[5].body, /Scale: -8/);
    assert.equal(dialog.playbackScale, -8);
    await assert.rejects(
      dialogs.control(dialog, { action: "speed", scale: 99 }),
      /倍速无效/,
    );
    await dialogs.end(dialog);
    assert.equal(parseSip(sent.at(-1)).headers.cseq[0], "8 BYE");
  } finally {
    dialogs.close();
  }
});

test("国标FI聚焦近远与停止使用标准向量，超时、显式停止和权限收回均停止正确指令族", async () => {
  assert.equal(encodePtz("focusNear", 96), "A50F014260000057");
  assert.equal(encodePtz("focusFar", 96), "A50F014160000056");
  assert.equal(encodePtz("stop", 128, { focusStop: true }), "A50F0140000000F5");
  const f = fixture();
  try {
    f.operations.ptz("c", "u", {
      action: "focusNear",
      speed: 96,
      duration: 100,
      token: "focus-001",
    });
    assert.match(f.sent.at(-1).body, /<PTZCmd>A50F014260000057/);
    await delay(140);
    await Promise.all(f.operations.jobs);
    assert.match(f.sent.at(-1).body, /<PTZCmd>A50F0140000000F5/);
    f.operations.ptz("c", "u", { action: "focusFar", token: "focus-002" });
    f.operations.ptz("c", "u", { action: "stop", token: "focus-002" });
    assert.match(f.sent.at(-1).body, /<PTZCmd>A50F0140000000F5/);
    f.operations.ptz("c", "u", { action: "focusNear", token: "focus-003" });
    await f.operations.revoke({ can: () => false, channel: () => false });
    assert.match(f.sent.at(-1).body, /<PTZCmd>A50F0140000000F5/);
    f.operations.ptz("c", "u", { action: "focusNear", token: "focus-004" });
    f.operations.ptz("c", "u", { action: "right", token: "move-005" });
    await Promise.all(f.operations.jobs);
    const packets = f.sent
      .slice(-2)
      .map((r) => r.body.match(/<PTZCmd>([^<]+)/)[1]);
    assert.deepEqual(packets, ["A50F0140000000F5", "A50F010180000036"]);
  } finally {
    await f.operations.close();
    f.db.close();
  }
});

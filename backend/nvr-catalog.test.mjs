import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { SipGateway } from "./sip/gateway.mjs";

function fixture(t) {
  const { db } = openStore(":memory:"),
    config = {
      enabled: false,
      domain: "4101050000",
      serverId: "41010500002000000001",
      host: "127.0.0.1",
      port: 8116,
      heartbeatTimeout: 180000,
    };
  for (let i = 1; i <= 2; i++)
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,status,createdAt,remoteAddress,remotePort,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      "nvr" + i,
      "3402000000111" + String(i).padStart(7, "0"),
      "模拟NVR" + i,
      "online",
      new Date().toISOString(),
      "127.0.0.1",
      16000 + i,
      Date.now() + 3600000,
      Date.now(),
    );
  const gateway = new SipGateway({ db, config });
  let output = "",
    seq = 0;
  gateway.state = "listening";
  gateway.socket = {
    send(buffer, port, address, callback) {
      output = buffer.toString();
      callback?.();
    },
    close() {},
  };
  t.after(async () => {
    await gateway.close();
    db.close();
  });
  const device = (id) => db.prepare("SELECT * FROM devices WHERE id=?").get(id);
  function sync(id) {
    const d = device(id),
      taskId = gateway.sync(d);
    return {
      d,
      taskId,
      sn: [...gateway.pending.values()].find((v) => v.id === taskId).sn,
    };
  }
  function receive(
    task,
    items,
    total,
    type = "Application/MANSCDP+xml",
    prefix = "",
  ) {
    const body = Buffer.concat([
      Buffer.from(
        prefix +
          `<Response><CmdType>Catalog</CmdType><SN>${task.sn}</SN><DeviceID>${task.d.deviceId}</DeviceID><SumNum>${total}</SumNum><DeviceList Num="${items.length}">`,
      ),
      ...items.map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(v))),
      Buffer.from("</DeviceList></Response>"),
    ]);
    const n = ++seq,
      head = Buffer.from(
        [
          `MESSAGE sip:${config.serverId}@${config.domain} SIP/2.0`,
          `Via: SIP/2.0/UDP 127.0.0.1:${task.d.remotePort};branch=z9hG4bK-nvr-${n}`,
          `From: <sip:${task.d.deviceId}@${config.domain}>;tag=nvr`,
          `To: <sip:${config.serverId}@${config.domain}>`,
          `Call-ID: nvr-${n}`,
          `CSeq: ${n} MESSAGE`,
          `Content-Type: ${type}`,
          `Content-Length: ${body.length}`,
          "",
          "",
        ].join("\r\n"),
      );
    gateway.receive(Buffer.concat([head, body]), {
      address: "127.0.0.1",
      port: task.d.remotePort,
    });
    return output;
  }
  return { db, gateway, sync, receive };
}
const code = (i) => "3402000000132" + String(i).padStart(7, "0");
const item = (i, name = "通道" + i) =>
  `<Item><DeviceID>${code(i)}</DeviceID><Name>${name}</Name><ParentID>34020000001110000001</ParentID><Status>${i % 5 === 0 ? "OFF" : "ON"}</Status></Item>`;

test("NVR目录：36通道乱序分批、重复报文、跨设备同编号及超时不覆盖旧目录", (t) => {
  const f = fixture(t),
    first = f.sync("nvr1"),
    second = f.sync("nvr2");
  const back = Array.from({ length: 18 }, (_, i) => item(i + 19));
  assert.match(f.receive(first, back, 36), /200 OK/);
  assert.match(f.receive(first, back, 36), /200 OK/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM channels").get().n, 0);
  assert.match(f.receive(second, [item(1, "第二台录像机")], 1), /200 OK/);
  assert.match(
    f.receive(
      first,
      Array.from({ length: 18 }, (_, i) => item(i + 1)),
      36,
    ),
    /200 OK/,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM channels WHERE deviceId=?").get("nvr1")
      .n,
    36,
  );
  assert.equal(
    f.db.prepare("SELECT channels FROM devices WHERE id=?").get("nvr1")
      .channels,
    36,
  );
  assert.equal(
    f.db
      .prepare("SELECT name FROM channels WHERE deviceId=? AND channelCode=?")
      .get("nvr2", code(1)).name,
    "第二台录像机",
  );
  assert.equal(
    f.db
      .prepare("SELECT status FROM channels WHERE deviceId=? AND channelCode=?")
      .get("nvr1", code(5)).status,
    "offline",
  );
  const interrupted = f.sync("nvr1");
  f.receive(interrupted, [item(1, "不完整的新名称")], 36);
  f.gateway.finish(interrupted.sn, "failed", "目录响应超时");
  assert.equal(
    f.db
      .prepare("SELECT name FROM channels WHERE deviceId=? AND channelCode=?")
      .get("nvr1", code(1)).name,
    "通道1",
  );
  const empty = f.sync("nvr1");
  assert.match(f.receive(empty, [], 0), /200 OK/);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM channels WHERE deviceId=?").get("nvr1")
      .n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM channels WHERE deviceId=?").get("nvr2")
      .n,
    1,
  );
});

test("NVR中文目录：支持仅MIME声明GB2312/GBK/GB18030以及带空格XML编码声明", (t) => {
  const f = fixture(t);
  const encoded = Buffer.concat([
    Buffer.from(`<Item><DeviceID>${code(1)}</DeviceID><Name>`),
    Buffer.from("b4f3ccfc", "hex"),
    Buffer.from("</Name><Status>ON</Status></Item>"),
  ]);
  for (const charset of ["GB2312", "GBK", "GB18030"]) {
    const task = f.sync("nvr1");
    assert.match(
      f.receive(
        task,
        [encoded],
        1,
        `Application/MANSCDP+xml; charset="${charset}"`,
      ),
      /200 OK/,
    );
    assert.equal(
      f.db.prepare("SELECT name FROM channels WHERE deviceId=?").get("nvr1")
        .name,
      "大厅",
    );
  }
  const task = f.sync("nvr1");
  assert.match(
    f.receive(
      task,
      [encoded],
      1,
      "Application/MANSCDP+xml",
      '<?xml version="1.0" encoding = "GB18030"?>',
    ),
    /200 OK/,
  );
});

test("NVR目录：UTF8 BOM优先于错误charset，未知编码不污染已存目录", (t) => {
  const f = fixture(t),
    task = f.sync("nvr1");
  assert.match(
    f.receive(
      task,
      [item(1, "大厅")],
      1,
      "Application/MANSCDP+xml; charset=GBK",
      "\ufeff",
    ),
    /200 OK/,
  );
  assert.equal(f.db.prepare("SELECT name FROM channels").get().name, "大厅");
  const invalid = f.sync("nvr1");
  assert.match(
    f.receive(
      invalid,
      [item(1, "wrong")],
      1,
      "Application/MANSCDP+xml; charset=x-unknown",
    ),
    /400 Bad Request/,
  );
  assert.equal(f.db.prepare("SELECT name FROM channels").get().name, "大厅");
});

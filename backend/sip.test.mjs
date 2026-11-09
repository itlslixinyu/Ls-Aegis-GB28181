import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { md5, parseSip } from "./sip/protocol.mjs";
const deviceId = "34020000001320000001",
  realm = "4101050000",
  password = "device-test-password";
function packet(
  method,
  {
    seq = 1,
    body = "",
    auth = "",
    type = "Application/MANSCDP+xml",
    expires = 3600,
  } = {},
) {
  return Buffer.from(
    [
      `${method} sip:${realm} SIP/2.0`,
      "Via: SIP/2.0/UDP 127.0.0.1:16000;branch=z9hG4bK" + seq,
      `From: <sip:${deviceId}@${realm}>;tag=camera`,
      `To: <sip:${deviceId}@${realm}>`,
      "Call-ID: simulator",
      `CSeq: ${seq} ${method}`,
      `Expires: ${expires}`,
      ...(auth ? ["Authorization: " + auth] : []),
      `Content-Type: ${type}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
}
test("SIP 注册认证、重放保护、心跳、分批目录和超时保持旧通道", () => {
  const { db } = openStore(":memory:");
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt,sipHa1) VALUES(?,?,?,?,?)",
  ).run(
    "device",
    deviceId,
    "模拟设备",
    new Date().toISOString(),
    md5(`${deviceId}:${realm}:${password}`),
  );
  const gateway = new SipGateway({
    db,
    config: {
      enabled: false,
      domain: realm,
      serverId: "41010500002000000001",
      host: "127.0.0.1",
      port: 8116,
      heartbeatTimeout: 180000,
    },
  });
  let output = "";
  gateway.state = "listening";
  gateway.socket = {
    send(buffer, port, address, callback) {
      output = buffer.toString();
      callback?.();
    },
    close() {},
  };
  const remote = { address: "127.0.0.1", port: 16000 };
  try {
    gateway.receive(packet("REGISTER"), remote);
    assert.match(output, /SIP\/2.0 401/);
    const nonce = output.match(/nonce="([^"]+)"/)[1];
    const uri = "sip:" + realm,
      nc = "00000001",
      cnonce = "camera";
    const response = md5(
      `${md5(deviceId + ":" + realm + ":" + password)}:${nonce}:${nc}:${cnonce}:auth:${md5("REGISTER:" + uri)}`,
    );
    const auth = `Digest username="${deviceId}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    const registration = packet("REGISTER", { seq: 2, auth });
    gateway.receive(registration, remote);
    assert.match(output, /SIP\/2.0 200/);
    assert.equal(
      db.prepare("SELECT status FROM devices").get().status,
      "online",
    );
    gateway.receive(registration, remote);
    assert.match(output, /SIP\/2.0 200/); // UDP retransmission uses cached response.
    gateway.receive(packet("REGISTER", { seq: 3, auth }), remote);
    assert.match(output, /SIP\/2.0 401/); // Reusing digest in a new transaction is rejected.
    const heartbeat = `<Notify><CmdType>Keepalive</CmdType><SN>2</SN><DeviceID>${deviceId}</DeviceID><Status>OK</Status></Notify>`;
    gateway.receive(packet("MESSAGE", { seq: 4, body: heartbeat }), {
      ...remote,
      port: 16001,
    });
    assert.match(output, /403/);
    gateway.receive(packet("MESSAGE", { seq: 4, body: heartbeat }), remote);
    assert.match(output, /200/);
    gateway.receive(
      packet("MESSAGE", {
        seq: 5,
        body: '<!DOCTYPE x [<!ENTITY a "b">]>' + heartbeat,
      }),
      remote,
    );
    assert.match(output, /400/);
    const device = db.prepare("SELECT * FROM devices").get();
    const taskId = gateway.sync(device);
    assert.match(output, /MESSAGE sip:/);
    const sn = [...gateway.pending.keys()][0];
    const catalog = (items) =>
      `<Response><CmdType>Catalog</CmdType><SN>${sn}</SN><DeviceID>${deviceId}</DeviceID><SumNum>2</SumNum><DeviceList>${items}</DeviceList></Response>`;
    const item = (code) =>
      `<Item><DeviceID>${code}</DeviceID><Name>通道</Name><Status>ON</Status></Item>`;
    gateway.receive(
      packet("MESSAGE", {
        seq: 6,
        body: catalog(item("34020000001310000001")),
      }),
      remote,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM channels").get().n, 0);
    gateway.receive(
      packet("MESSAGE", {
        seq: 7,
        body: catalog(item("34020000001310000002")),
      }),
      remote,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM channels").get().n, 2);
    assert.equal(
      db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status,
      "succeeded",
    );
    gateway.sync(db.prepare("SELECT * FROM devices").get());
    gateway.finish([...gateway.pending.keys()][0], "failed", "目录响应超时");
    assert.equal(db.prepare("SELECT count(*) n FROM channels").get().n, 2);
    db.prepare("UPDATE devices SET lastHeartbeat=0").run();
    gateway.sweep();
    assert.equal(
      db.prepare("SELECT status FROM devices").get().status,
      "offline",
    );
    assert.throws(() => parseSip(Buffer.from("broken")));
  } finally {
    gateway.close();
    db.close();
  }
});
import dgram from "node:dgram";
import { once } from "node:events";

function registeredFixture(t) {
  const { db } = openStore(":memory:"),
    config = {
      enabled: false,
      domain: realm,
      serverId: "41010500002000000001",
      host: "127.0.0.1",
      port: 8116,
      heartbeatTimeout: 180000,
    };
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt,sipHa1) VALUES(?,?,?,?,?)",
  ).run(
    "device",
    deviceId,
    "持久化注册测试",
    new Date().toISOString(),
    md5(`${deviceId}:${realm}:${password}`),
  );
  const gateways = [];
  let output = "";
  function make(c = config) {
    const gateway = new SipGateway({ db, config: { ...c } });
    gateway.state = "listening";
    gateway.socket = {
      send(buffer, port, address, callback) {
        output = buffer.toString();
        callback?.();
      },
      close() {},
    };
    gateways.push(gateway);
    return gateway;
  }
  const gateway = make(),
    remote = { address: "127.0.0.1", port: 16000 };
  gateway.receive(packet("REGISTER"), remote);
  const nonce = output.match(/nonce="([^"]+)"/)[1],
    uri = "sip:" + realm;
  const response = md5(
    `${md5(deviceId + ":" + realm + ":" + password)}:${nonce}:00000001:restart:auth:${md5("REGISTER:" + uri)}`,
  );
  gateway.receive(
    packet("REGISTER", {
      seq: 2,
      auth: `Digest username="${deviceId}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", qop=auth, nc=00000001, cnonce="restart"`,
    }),
    remote,
  );
  assert.match(output, /200 OK/);
  t.after(() => {
    gateways.forEach((g) => g.close());
    db.close();
  });
  return {
    db,
    gateway,
    make,
    remote,
    get output() {
      return output;
    },
  };
}

test("注册恢复：同一平台保留未过期UDP绑定，平台身份改变、过期和旧TCP绑定必须失效", (t) => {
  const f = registeredFixture(t);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sip_registrations").get().n,
    1,
  );
  f.gateway.close();
  const fresh = f.make();
  fresh.restoreRegistrations();
  let d = f.db.prepare("SELECT * FROM devices").get();
  assert.equal(d.status, "online");
  assert.equal(d.remoteAddress, "127.0.0.1");
  fresh.config.serverId = "41010500002000000002";
  fresh.restoreRegistrations();
  d = f.db.prepare("SELECT * FROM devices").get();
  assert.equal(d.status, "offline");
  assert.equal(d.remoteAddress, null);
  assert.equal(d.registeredUntil, null);
  fresh.config.serverId = "41010500002000000001";
  f.db
    .prepare(
      "UPDATE devices SET status='online',remoteAddress='127.0.0.1',remotePort=16000,registeredUntil=?,sipTransport='TCP'",
    )
    .run(Date.now() + 60000);
  fresh.restoreRegistrations();
  assert.equal(
    f.db.prepare("SELECT remoteAddress FROM devices").get().remoteAddress,
    null,
  );
  f.db
    .prepare(
      "UPDATE devices SET status='online',remoteAddress='127.0.0.1',remotePort=16000,registeredUntil=?,sipTransport='UDP'",
    )
    .run(Date.now() - 1);
  fresh.restoreRegistrations();
  assert.equal(
    f.db.prepare("SELECT registeredUntil FROM devices").get().registeredUntil,
    null,
  );
});

test("心跳恢复：心跳超时但注册未过期可恢复在线，错误来源与过期注册不能复活", (t) => {
  const f = registeredFixture(t);
  f.db.prepare("UPDATE devices SET lastHeartbeat=?").run(Date.now() - 200000);
  f.gateway.sweep();
  assert.equal(
    f.db.prepare("SELECT status FROM devices").get().status,
    "offline",
  );
  const heartbeat = `<Notify><CmdType>Keepalive</CmdType><SN>7</SN><DeviceID>${deviceId}</DeviceID><Status>OK</Status></Notify>`;
  f.gateway.receive(packet("MESSAGE", { seq: 5, body: heartbeat }), {
    ...f.remote,
    port: 16001,
  });
  assert.match(f.output, /403/);
  assert.equal(
    f.db.prepare("SELECT status FROM devices").get().status,
    "offline",
  );
  f.gateway.receive(
    packet("MESSAGE", {
      seq: 6,
      body: `<Notify><CmdType>Alarm</CmdType><DeviceID>${deviceId}</DeviceID></Notify>`,
    }),
    f.remote,
  );
  assert.match(f.output, /403/);
  f.gateway.receive(packet("MESSAGE", { seq: 7, body: heartbeat }), f.remote);
  assert.match(f.output, /200 OK/);
  assert.equal(
    f.db.prepare("SELECT status FROM devices").get().status,
    "online",
  );
  f.db
    .prepare("UPDATE devices SET status='offline',registeredUntil=?")
    .run(Date.now() - 1);
  f.gateway.receive(packet("MESSAGE", { seq: 8, body: heartbeat }), f.remote);
  assert.match(f.output, /403/);
  assert.equal(
    f.db.prepare("SELECT status FROM devices").get().status,
    "offline",
  );
});
test("UDP监听可接收注册并返回Digest挑战，关闭后回收端口", async () => {
  const { db } = openStore(":memory:");
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt,sipHa1) VALUES(?,?,?,?,?)",
  ).run(
    "device",
    deviceId,
    "UDP测试设备",
    new Date().toISOString(),
    md5(`${deviceId}:${realm}:${password}`),
  );
  const gateway = new SipGateway({
    db,
    config: {
      enabled: true,
      domain: realm,
      serverId: "41010500002000000001",
      host: "127.0.0.1",
      port: 0,
      heartbeatTimeout: 180000,
    },
  });
  const client = dgram.createSocket("udp4");
  try {
    await gateway.start();
    await new Promise((r) => client.bind(0, "127.0.0.1", r));
    const incoming = once(client, "message", {
      signal: AbortSignal.timeout(3000),
    });
    client.send(packet("REGISTER"), gateway.config.port, "127.0.0.1");
    const [data] = await incoming;
    assert.match(data.toString(), /SIP\/2.0 401 Unauthorized/);
    assert.match(data.toString(), /qop="auth"/);
    assert.equal(gateway.state, "listening");
  } finally {
    client.close();
    gateway.close();
    db.close();
  }
});

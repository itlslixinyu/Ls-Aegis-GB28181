import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { SipFramer } from "./sip/transport.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { openStore } from "./lib/store.mjs";
import { parseSip, response, md5 } from "./sip/protocol.mjs";
import { CascadeService } from "./services/cascade.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function packet(
  method,
  {
    id = "34020000001320000001",
    realm = "4101050000",
    seq = 1,
    body = "",
    headers = [],
  } = {},
) {
  return Buffer.from(
    [
      `${method} sip:${realm} SIP/2.0`,
      `Via: SIP/2.0/TCP 127.0.0.1:16000;branch=z9hG4bK${seq}`,
      `From: <sip:${id}@${realm}>;tag=test`,
      `To: <sip:${id}@${realm}>`,
      `Call-ID: tcp-test-${seq}`,
      `CSeq: ${seq} ${method}`,
      "Expires: 3600",
      "Content-Type: Application/MANSCDP+xml",
      ...headers,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
}
test("TCP消息分帧处理分片、粘包、UTF-8字节长度和保活，并拒绝歧义长度", () => {
  const packets = [],
    p = packet("MESSAGE", { body: "中文" });
  let keepalive = 0;
  const f = new SipFramer(
    (b) => packets.push(parseSip(b)),
    () => keepalive++,
  );
  f.push(p.subarray(0, 17));
  assert.equal(packets.length, 0);
  f.push(Buffer.concat([p.subarray(17), Buffer.from("\r\n\r\n"), p]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].body.toString(), "中文");
  assert.equal(keepalive, 1);
  assert.throws(() =>
    new SipFramer(() => {}).push(
      Buffer.from(
        "MESSAGE sip:x SIP/2.0\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
      ),
    ),
  );
  assert.throws(() =>
    new SipFramer(() => {}).push(
      Buffer.from("MESSAGE sip:x SIP/2.0\r\nContent-Length: 1000000\r\n\r\n"),
    ),
  );
});
test("真实TCP设备：同端口监听、Digest注册、连接复用、目录与断线离线", async () => {
  const { db } = openStore(":memory:"),
    id = "34020000001320000001",
    realm = "4101050000",
    password = "tcp-camera-test";
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt,sipHa1) VALUES(?,?,?,?,?)",
  ).run(
    "d",
    id,
    "TCP模拟器",
    new Date().toISOString(),
    md5(`${id}:${realm}:${password}`),
  );
  const gateway = new SipGateway({
    db,
    config: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      domain: realm,
      serverId: "41010500002000000001",
      heartbeatTimeout: 180000,
    },
  });
  await gateway.start();
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: gateway.config.port,
  });
  await once(socket, "connect");
  const inbox = [];
  socket.on("data", (chunk) => framer.push(chunk));
  const framer = new SipFramer((b) => {
    const m = parseSip(b);
    inbox.push(m);
    if (m.method === "MESSAGE") {
      socket.write(response(m, 200, "OK"));
      const sn = m.body.toString().match(/<SN>(\d+)<\/SN>/)?.[1];
      if (sn)
        socket.write(
          packet("MESSAGE", {
            seq: 7,
            body: `<Response><CmdType>Catalog</CmdType><SN>${sn}</SN><DeviceID>${id}</DeviceID><SumNum>0</SumNum></Response>`,
          }),
        );
    }
  });
  const wait = async (predicate) => {
    for (let n = 0; n < 100; n++) {
      const value = inbox.find(predicate);
      if (value) return value;
      await delay(5);
    }
    throw Error("TCP响应超时");
  };
  try {
    const first = packet("REGISTER");
    socket.write(first.subarray(0, 23));
    socket.write(first.subarray(23));
    const unauthorized = await wait((m) => m.status === 401),
      nonce =
        unauthorized.headers["www-authenticate"][0].match(/nonce="([^"]+)"/)[1],
      uri = "sip:" + realm,
      nc = "00000001",
      cnonce = "tcp-simulator";
    const hash = md5(
      `${md5(`${id}:${realm}:${password}`)}:${nonce}:${nc}:${cnonce}:auth:${md5("REGISTER:" + uri)}`,
    );
    socket.write(
      packet("REGISTER", {
        seq: 2,
        headers: [
          `Authorization: Digest username="${id}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${hash}", qop=auth, nc=${nc}, cnonce="${cnonce}"`,
        ],
      }),
    );
    await wait((m) => m.status === 200);
    const device = db.prepare("SELECT * FROM devices WHERE id=?").get("d");
    assert.equal(device.sipTransport, "TCP");
    assert.equal(device.status, "online");
    const task = gateway.sync(device);
    await wait((m) => m.method === "MESSAGE");
    for (
      let i = 0;
      i < 50 &&
      db.prepare("SELECT status FROM tasks WHERE id=?").get(task).status ===
        "running";
      i++
    )
      await delay(5);
    assert.equal(
      db.prepare("SELECT status FROM tasks WHERE id=?").get(task).status,
      "succeeded",
    );
    assert.match(
      inbox.find((m) => m.method === "MESSAGE").headers.via[0],
      /SIP\/2.0\/TCP/,
    );
    assert.equal(gateway.tcp.sockets.size, 1);
    socket.end();
    await once(socket, "close");
    for (
      let n = 0;
      n < 50 &&
      db.prepare("SELECT status FROM devices WHERE id=?").get("d").status ===
        "online";
      n++
    )
      await delay(5);
    assert.equal(
      db.prepare("SELECT status FROM devices WHERE id=?").get("d").status,
      "offline",
    );
  } finally {
    socket.destroy();
    gateway.close();
    db.close();
  }
});
test("真实TCP上级：注册事务复用一条连接，Digest与注销使用TCP Via", async () => {
  const { db } = openStore(":memory:");
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "a",
    "admin",
    "unused",
    "admin",
  );
  const incoming = [],
    sockets = new Set();
  let connects = 0;
  const server = net.createServer((socket) => {
    connects++;
    sockets.add(socket);
    const f = new SipFramer((b) => {
      const req = parseSip(b);
      incoming.push(req);
      if (req.method === "REGISTER" && !req.headers.authorization)
        socket.write(
          response(req, 401, "Unauthorized", [
            'WWW-Authenticate: Digest realm="4401000000", nonce="tcpnonce", algorithm=MD5, qop="auth"',
          ]),
        );
      else
        socket.write(
          response(
            req,
            200,
            "OK",
            req.method === "REGISTER"
              ? ["Expires: " + (req.headers.expires?.[0] || 3600)]
              : [],
          ),
        );
    });
    socket.on("data", (c) => f.push(c));
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    sip: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      domain: "4101050000",
      serverId: "41010500002000000001",
      heartbeatTimeout: 180000,
    },
    media: { rtpHost: "127.0.0.1" },
  };
  const sip = new SipGateway({ db, config: config.sip });
  await sip.start();
  const cascade = new CascadeService({
    db,
    sip,
    config,
    media: {},
    live: {},
    records: {},
    operations: { async stopUser() {} },
  });
  sip.onRequest = (req, remote) => cascade.handle(req, remote);
  try {
    const p = cascade.save(
      {
        name: "TCP上级模拟",
        serverId: "44010000002000000001",
        localId: "44010000002000000002",
        domain: "4401000000",
        host: "127.0.0.1",
        port: server.address().port,
        mediaHost: "127.0.0.1",
        sipTransport: "TCP",
        password: "tcp-secret-test",
      },
      "a",
    );
    await cascade.register(p.id);
    assert.equal(cascade.list()[0].status, "online");
    assert.equal(connects, 1);
    assert.match(incoming[1].headers.via[0], /SIP\/2.0\/TCP/);
    await cascade.unregister(p.id);
    assert.equal(incoming.at(-1).headers.expires[0], "0");
    assert.equal(connects, 1);
  } finally {
    await cascade.close();
    sip.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
    db.close();
  }
});

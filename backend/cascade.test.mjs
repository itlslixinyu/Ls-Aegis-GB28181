import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openStore } from "./lib/store.mjs";
import { loadConfig } from "./lib/config.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { parseSip, response, createDigest, md5 } from "./sip/protocol.mjs";
import { CascadeService } from "./services/cascade.mjs";
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    const result = predicate();
    if (result) return result;
    await delay(10);
  }
  throw Error("模拟上级等待响应超时");
}
function request(
  method,
  {
    uri,
    from,
    to,
    callId = randomUUID(),
    seq = 1,
    branch = "z9hG4bK" + randomUUID(),
    body = "",
    contentType = "Application/MANSCDP+xml",
  },
) {
  return Buffer.from(
    [
      `${method} ${uri} SIP/2.0`,
      "Via: SIP/2.0/UDP 127.0.0.1:15060;branch=" + branch,
      `From: ${from}`,
      `To: ${to || "<" + uri + ">"}`,
      `Call-ID: ${callId}`,
      `CSeq: ${seq} ${method}`,
      ...(body ? ["Content-Type: " + contentType] : []),
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
}
async function fixture() {
  const { db } = openStore(":memory:");
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "u",
    "admin",
    "unused",
    "admin",
  );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "d",
    "34020000001320000001",
    "设备",
    "online",
    new Date().toISOString(),
    Date.now() + 3600000,
    Date.now(),
  );
  for (const [id, code] of [
    ["c", "34020000001310000001"],
    ["hidden", "34020000001310000002"],
  ])
    db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
      id,
      "d",
      code,
      id === "c" ? "公开&通道" : "保密通道",
      "online",
    );
  const config = loadConfig({ SIP_ENABLED: "1" });
  config.sip.port = 0;
  const sip = new SipGateway({ db, config: config.sip });
  await sip.start();
  const upstream = dgram.createSocket("udp4");
  await new Promise((r) => upstream.bind(0, "127.0.0.1", r));
  const realm = "4401000000",
    localId = "44010000002000000002",
    serverId = "44010000002000000001",
    password = "upstream-password";
  const digest = createDigest(realm),
    received = [],
    auth = [];
  upstream.on("message", (buffer, remote) => {
    let req;
    try {
      req = parseSip(buffer);
    } catch {
      return;
    }
    received.push(req);
    if (req.status) return;
    if (req.method === "REGISTER") {
      const valid = digest.verify(
        req,
        localId,
        md5(`${localId}:${realm}:${password}`),
      );
      auth.push(valid);
      upstream.send(
        valid
          ? response(req, 200, "OK", [
              "Expires: " + (req.headers.expires?.[0] || 3600),
            ])
          : response(req, 401, "Unauthorized", [
              "WWW-Authenticate: " + digest.challenge(),
            ]),
        remote.port,
        remote.address,
      );
    } else upstream.send(response(req, 200, "OK"), remote.port, remote.address);
  });
  const calls = {
    forward: [],
    stop: [],
    leave: [],
    controls: [],
    ptz: [],
    recordQueries: [],
  };
  let n = 0;
  const live = {
    create(channel, userId, key, options) {
      const id = "source-" + ++n;
      db.prepare(
        "INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt,kind,options) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        channel.id,
        "d",
        "stream-" + n,
        "ready",
        new Date().toISOString(),
        options ? "playback" : "live",
        options ? JSON.stringify(options) : null,
      );
      return { sessionId: id, viewerId: "viewer-" + n };
    },
    snapshot() {
      return { state: "ready" };
    },
    renew() {
      return { state: "ready" };
    },
    async leave(...args) {
      calls.leave.push(args);
    },
    async control(...args) {
      calls.controls.push(args);
      return { accepted: true };
    },
  };
  const media = {
    async startForward(...args) {
      calls.forward.push(args);
      return { local_port: 50000 };
    },
    async stopForward(...args) {
      calls.stop.push(args);
    },
  };
  const operations = {
    async stopUser() {},
    ptz(...args) {
      calls.ptz.push(args);
      return { commandId: "ptz" };
    },
  };
  const records = {};
  const cascade = new CascadeService({
    db,
    sip,
    media,
    live,
    operations,
    records,
    config,
  });
  sip.onRequest = (req, remote) => cascade.handle(req, remote);
  const platform = cascade.save(
    {
      name: "测试上级",
      serverId,
      localId,
      domain: realm,
      host: "127.0.0.1",
      port: upstream.address().port,
      mediaHost: "127.0.0.1",
      password,
      expires: 3600,
      heartbeat: 60,
    },
    "u",
  );
  cascade.assign(platform.id, [
    { channelId: "c", alias: "44010000001310000001" },
  ]);
  const send = (buffer) => upstream.send(buffer, sip.config.port, "127.0.0.1");
  return {
    db,
    sip,
    upstream,
    cascade,
    platform,
    received,
    auth,
    calls,
    media,
    live,
    operations,
    records,
    send,
    serverId,
    localId,
    close: async () => {
      await cascade.close();
      sip.close();
      upstream.close();
      db.close();
    },
  };
}
test("真实UDP上级模拟：Digest注册、共享目录隔离、心跳及注销", async () => {
  const f = await fixture();
  try {
    await f.cascade.register(f.platform.id);
    assert.deepEqual(f.auth, [false, true]);
    assert.equal(f.cascade.list()[0].status, "online");
    assert.ok(!("ha1" in f.cascade.list()[0]));
    const from = `<sip:${f.serverId}@4401000000>;tag=upper`,
      uri = `sip:${f.localId}@4401000000`;
    const query = request("MESSAGE", {
      uri,
      from,
      callId: "catalog-1",
      body: `<Query><CmdType>Catalog</CmdType><SN>17</SN><DeviceID>${f.localId}</DeviceID></Query>`,
    });
    f.send(query);
    const catalog = await until(() =>
      f.received.find(
        (r) =>
          !r.status && r.body.toString().includes("<CmdType>Catalog</CmdType>"),
      ),
    );
    const xml = catalog.body.toString();
    assert.match(xml, /<SumNum>1<\/SumNum>/);
    assert.match(xml, /44010000001310000001/);
    assert.match(xml, /公开&amp;通道/);
    assert.ok(!xml.includes("保密通道"));
    assert.ok(!xml.includes("34020000001310000002"));
    f.send(query);
    await delay(40);
    assert.equal(
      f.received.filter(
        (r) =>
          !r.status && r.body.toString().includes("<CmdType>Catalog</CmdType>"),
      ).length,
      1,
    );
    const badId = "secret-query";
    f.send(
      request("MESSAGE", {
        uri,
        from,
        callId: badId,
        body: "<Query><CmdType>DeviceInfo</CmdType><SN>18</SN><DeviceID>34020000001310000002</DeviceID></Query>",
      }),
    );
    assert.equal(
      (
        await until(() =>
          f.received.find((r) => r.status && r.headers["call-id"][0] === badId),
        )
      ).status,
      403,
    );
    f.db
      .prepare("UPDATE cascade_platforms SET nextHeartbeat=0 WHERE id=?")
      .run(f.platform.id);
    await f.cascade.tick();
    assert.ok(
      f.received.some(
        (r) =>
          !r.status &&
          r.body.toString().includes("<CmdType>Keepalive</CmdType>"),
      ),
    );
    await f.cascade.unregister(f.platform.id);
    assert.equal(f.cascade.list()[0].enabled, 0);
    assert.ok(
      f.received.some(
        (r) =>
          r.method === "REGISTER" &&
          r.headers.expires[0] === "0" &&
          r.headers.authorization,
      ),
    );
  } finally {
    await f.close();
  }
});
test("真实UDP上级模拟：INVITE/ACK/BYE转发与错误目的地址拒绝", async () => {
  const f = await fixture();
  try {
    await f.cascade.register(f.platform.id);
    const from = `<sip:${f.serverId}@4401000000>;tag=upper`,
      uri = "sip:44010000001310000001@4401000000";
    const sdp = (host) =>
      [
        "v=0",
        "s=Play",
        `c=IN IP4 ${host}`,
        "t=0 0",
        "m=video 40000 RTP/AVP 96",
        "a=recvonly",
        "a=rtpmap:96 PS/90000",
        "y=0100000011",
        "",
      ].join("\r\n");
    f.send(
      request("INVITE", {
        uri,
        from,
        callId: "bad-target",
        body: sdp("192.0.2.1"),
        contentType: "application/sdp",
      }),
    );
    assert.equal(
      (
        await until(() =>
          f.received.find(
            (r) => r.status && r.headers["call-id"][0] === "bad-target",
          ),
        )
      ).status,
      488,
    );
    assert.equal(f.calls.forward.length, 0);
    const original = request("INVITE", {
      uri,
      from,
      callId: "invite-1",
      body: sdp("127.0.0.1"),
      contentType: "application/sdp",
    });
    f.send(original);
    const answer = await until(() =>
      f.received.find(
        (r) => r.status === 200 && r.headers["call-id"][0] === "invite-1",
      ),
    );
    assert.match(answer.body.toString(), /a=sendonly/);
    assert.equal(f.calls.forward.length, 1);
    assert.deepEqual(f.calls.forward[0].slice(1), [
      "0100000011",
      "127.0.0.1",
      40000,
      false,
    ]);
    const id = f.platform.id + ":invite-1";
    assert.equal(f.cascade.calls.get(id).state, "awaiting_ack");
    f.send(
      request("ACK", {
        uri,
        from,
        to: answer.headers.to[0],
        callId: "invite-1",
      }),
    );
    await until(() => f.cascade.calls.get(id)?.state === "streaming");
    const bye = request("BYE", {
      uri,
      from,
      to: answer.headers.to[0],
      callId: "invite-1",
      seq: 2,
    });
    f.send(bye);
    await until(() => f.calls.stop.length && f.calls.leave.length);
    assert.equal(f.calls.stop.length, 1);
    f.send(bye);
    await delay(40);
    assert.equal(f.calls.stop.length, 1);
    assert.equal(
      f.db.prepare("SELECT released FROM cascade_calls WHERE id=?").get(id)
        .released,
      1,
    );
  } finally {
    await f.close();
  }
});

test("级联取消等待中的转发，迟到分配仍会回收且不返回成功响应", async () => {
  const f = await fixture();
  let finishForward;
  try {
    await f.cascade.register(f.platform.id);
    f.media.startForward = (...args) => {
      f.calls.forward.push(args);
      return new Promise((r) => (finishForward = r));
    };
    const from = `<sip:${f.serverId}@4401000000>;tag=upper`,
      uri = "sip:44010000001310000001@4401000000",
      body = [
        "v=0",
        "s=Play",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        "m=video 40000 RTP/AVP 96",
        "a=rtpmap:96 PS/90000",
        "y=0100000022",
        "",
      ].join("\r\n");
    const invite = request("INVITE", {
      uri,
      from,
      callId: "cancelled-invite",
      branch: "z9hG4bKcancel",
      body,
      contentType: "application/sdp",
    });
    f.send(invite);
    await until(() => finishForward);
    f.send(
      request("CANCEL", {
        uri,
        from,
        callId: "cancelled-invite",
        branch: "z9hG4bKcancel",
      }),
    );
    await until(() =>
      f.received.find(
        (r) =>
          r.status === 487 && r.headers["call-id"][0] === "cancelled-invite",
      ),
    );
    finishForward({ local_port: 50000 });
    await until(() => f.calls.stop.length);
    assert.ok(
      !f.received.some(
        (r) =>
          r.status === 200 &&
          r.headers.cseq[0] === "1 INVITE" &&
          r.headers["call-id"][0] === "cancelled-invite",
      ),
    );
    assert.equal(
      f.db
        .prepare("SELECT released FROM cascade_calls WHERE callId=?")
        .get("cancelled-invite").released,
      1,
    );
  } finally {
    finishForward?.({ local_port: 50000 });
    await f.close();
  }
});
test("相同源流的SSRC冲突不能停止既有转发", async () => {
  const f = await fixture();
  try {
    await f.cascade.register(f.platform.id);
    const create = f.live.create;
    let shared;
    f.live.create = (...args) => {
      if (!shared) {
        const result = create(...args);
        shared = result.sessionId;
        return result;
      }
      return { sessionId: shared, viewerId: "second-viewer" };
    };
    const from = `<sip:${f.serverId}@4401000000>;tag=upper`,
      uri = "sip:44010000001310000001@4401000000",
      body = [
        "v=0",
        "s=Play",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        "m=video 40000 RTP/AVP 96",
        "a=rtpmap:96 PS/90000",
        "y=0100000033",
        "",
      ].join("\r\n");
    f.send(
      request("INVITE", {
        uri,
        from,
        callId: "first-shared",
        body,
        contentType: "application/sdp",
      }),
    );
    const answer = await until(() =>
      f.received.find(
        (r) => r.status === 200 && r.headers["call-id"][0] === "first-shared",
      ),
    );
    f.send(
      request("ACK", {
        uri,
        from,
        to: answer.headers.to[0],
        callId: "first-shared",
      }),
    );
    await until(
      () =>
        f.cascade.calls.get(f.platform.id + ":first-shared")?.state ===
        "streaming",
    );
    f.send(
      request("INVITE", {
        uri,
        from,
        callId: "conflicting-shared",
        body,
        contentType: "application/sdp",
      }),
    );
    await until(() =>
      f.received.find(
        (r) =>
          r.status === 480 && r.headers["call-id"][0] === "conflicting-shared",
      ),
    );
    await until(() => f.calls.leave.length);
    assert.equal(f.calls.forward.length, 1);
    assert.equal(f.calls.stop.length, 0);
    assert.equal(
      f.cascade.calls.get(f.platform.id + ":first-shared").state,
      "streaming",
    );
  } finally {
    await f.close();
  }
});

test("上级平台共享通道的云台、录像查询和回放INFO均映射到授权通道", async () => {
  const f = await fixture();
  try {
    await f.cascade.register(f.platform.id);
    const from = `<sip:${f.serverId}@4401000000>;tag=upper`,
      alias = "44010000001310000001",
      uri = `sip:${alias}@4401000000`;
    f.send(
      request("MESSAGE", {
        uri,
        from,
        callId: "ptz-query",
        body: `<Control><CmdType>DeviceControl</CmdType><SN>21</SN><DeviceID>${alias}</DeviceID><PTZCmd>A50F010180000036</PTZCmd></Control>`,
      }),
    );
    await until(() => f.calls.ptz.length);
    assert.equal(f.calls.ptz[0][0], "c");
    assert.equal(f.calls.ptz[0][2].action, "right");
    assert.equal(f.calls.ptz[0][2].speed, 128);
    f.records.create = (...args) => {
      f.calls.recordQueries.push(args);
      return { taskId: "records-test" };
    };
    f.records.get = () => ({
      status: "succeeded",
      items: [
        {
          name: "录像&测试",
          filePath: "record-file",
          start: "2026-10-31T00:00:00Z",
          end: "2026-10-31T01:00:00Z",
          type: "time",
        },
      ],
    });
    f.send(
      request("MESSAGE", {
        uri,
        from,
        callId: "record-query",
        body: `<Query><CmdType>RecordInfo</CmdType><SN>22</SN><DeviceID>${alias}</DeviceID><StartTime>2026-10-31T08:00:00</StartTime><EndTime>2026-10-31T09:00:00</EndTime><Secrecy>0</Secrecy><Type>all</Type></Query>`,
      }),
    );
    const records = await until(() =>
      f.received.find(
        (r) =>
          !r.status &&
          r.body.toString().includes("<CmdType>RecordInfo</CmdType>"),
      ),
    );
    assert.match(records.body.toString(), /<SN>22<\/SN>/);
    assert.match(records.body.toString(), /录像&amp;测试/);
    assert.ok(!records.body.toString().includes("34020000001310000001"));
    assert.equal(f.calls.recordQueries[0][0], "c");
    const start = Math.floor(Date.parse("2026-10-31T00:00:00Z") / 1000),
      body = [
        "v=0",
        "s=Playback",
        "c=IN IP4 127.0.0.1",
        `t=${start} ${start + 3600}`,
        "m=video 40000 RTP/AVP 96",
        "a=rtpmap:96 PS/90000",
        "y=1100000044",
        "",
      ].join("\r\n");
    f.send(
      request("INVITE", {
        uri,
        from,
        callId: "playback-upstream",
        body,
        contentType: "application/sdp",
      }),
    );
    const answer = await until(() =>
      f.received.find(
        (r) =>
          r.status === 200 && r.headers["call-id"][0] === "playback-upstream",
      ),
    );
    f.send(
      request("ACK", {
        uri,
        from,
        to: answer.headers.to[0],
        callId: "playback-upstream",
      }),
    );
    await until(
      () =>
        f.cascade.calls.get(f.platform.id + ":playback-upstream")?.state ===
        "streaming",
    );
    const info = request("INFO", {
      uri,
      from,
      to: answer.headers.to[0],
      callId: "playback-upstream",
      seq: 2,
      body: "PLAY RTSP/1.0\r\nCSeq: 2\r\nRange: npt=120-\r\n\r\n",
      contentType: "Application/MANSRTSP",
    });
    f.send(info);
    await until(() =>
      f.received.find(
        (r) =>
          r.status === 200 &&
          r.headers["call-id"][0] === "playback-upstream" &&
          r.headers.cseq[0] === "2 INFO",
      ),
    );
    f.send(info);
    await delay(30);
    assert.equal(f.calls.controls.length, 1);
    assert.equal(f.calls.controls[0][3].action, "seek");
    assert.equal(f.calls.controls[0][3].position, 120);
  } finally {
    await f.close();
  }
});

test("上级TCP媒体主被动协商选择正确转发模式并可结束", async () => {
  for (const setup of ["active", "passive"]) {
    const f = await fixture();
    try {
      await f.cascade.register(f.platform.id);
      const callId = "tcp-media-" + setup,
        uri = "sip:44010000001310000001@4401000000",
        from = `<sip:${f.serverId}@4401000000>;tag=upper`;
      f.send(
        request("INVITE", {
          uri,
          from,
          callId,
          contentType: "application/sdp",
          body: [
            "v=0",
            "s=Play",
            "c=IN IP4 127.0.0.1",
            "t=0 0",
            `m=video ${setup === "active" ? 9 : 40000} TCP/RTP/AVP 96`,
            `a=setup:${setup}`,
            "a=connection:new",
            "a=recvonly",
            "a=rtpmap:96 PS/90000",
            "y=0100000044",
            "",
          ].join("\r\n"),
        }),
      );
      const answer = await until(() =>
        f.received.find(
          (r) => r.status === 200 && r.headers["call-id"][0] === callId,
        ),
      );
      assert.match(answer.body.toString(), /TCP\/RTP\/AVP/);
      assert.ok(
        answer.body
          .toString()
          .includes(`a=setup:${setup === "active" ? "passive" : "active"}`),
      );
      assert.equal(
        f.calls.forward[0].at(-1),
        setup === "active" ? "passive" : true,
      );
      f.send(request("ACK", { uri, from, to: answer.headers.to[0], callId }));
      await until(
        () =>
          f.cascade.calls.get(f.platform.id + ":" + callId)?.state ===
          "streaming",
      );
      f.send(
        request("BYE", { uri, from, to: answer.headers.to[0], callId, seq: 2 }),
      );
      await until(() => f.calls.stop.length === 1);
      assert.equal(f.calls.leave.length, 1);
    } finally {
      await f.close();
    }
  }
});

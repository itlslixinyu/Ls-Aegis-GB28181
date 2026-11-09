import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./lib/store.mjs";
import { LiveSessions } from "./media/live-sessions.mjs";
import { SipDialogs } from "./sip/dialogs.mjs";
import { parseSip } from "./sip/protocol.mjs";
function fixture(overrides = {}) {
  const { db } = openStore(":memory:");
  let now = Date.now();
  for (const id of ["u1", "u2"])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      "unused",
      "viewer",
    );
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,status,createdAt,registeredUntil,lastHeartbeat) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "d",
    "34020000001320000001",
    "测试设备",
    "online",
    new Date().toISOString(),
    now + 3600000,
    now,
  );
  db.prepare(
    "INSERT INTO user_groups SELECT id,'default' FROM users WHERE role='viewer'",
  ).run();
  const channel = {
    id: "c",
    deviceId: "d",
    channelCode: "34020000001310000001",
    status: "online",
  };
  db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
    "c",
    "d",
    channel.channelCode,
    "测试通道",
    "online",
  );
  let stream;
  const calls = { allocate: 0, release: 0, invite: 0, end: 0 };
  const media = {
    async allocate(id) {
      calls.allocate++;
      stream = id;
      return { port: 40000 };
    },
    async release() {
      calls.release++;
    },
    async streams() {
      return [{ app: "rtp", schema: "rtmp", stream }];
    },
    ...overrides,
  };
  const sip = {
    state: "listening",
    dialogs: {
      async invite() {
        calls.invite++;
        return { id: "dialog" };
      },
      async end() {
        calls.end++;
      },
    },
  };
  const config = {
    sip: { heartbeatTimeout: 180000 },
    media: { configured: true, rtpHost: "127.0.0.1" },
    playTimeout: 1000,
  };
  const manager = new LiveSessions({
    db,
    media,
    sip,
    config,
    now: () => now,
    lease: 45000,
    poll: 1,
  });
  return {
    db,
    manager,
    channel,
    calls,
    advance: (n) => (now += n),
    media,
    sip,
  };
}
test("SSRC使用国标域标识，直播与历史流尾号回绕仍不冲突", async () => {
  const f = fixture(),
    sent = [];
  f.manager.ssrcSequence = 9998;
  f.sip.dialogs.invite = async (_d, _c, options) => {
    sent.push(options.ssrc);
    return { id: "ssrc-" + sent.length };
  };
  try {
    const main = f.manager.create(f.channel, "u1");
    await f.manager.running.get(main.sessionId).work;
    const options = {
      start: "2026-11-03T00:00:00Z",
      end: "2026-11-03T00:01:00Z",
    };
    const first = f.manager.create(f.channel, "u1", undefined, options);
    await f.manager.running.get(first.sessionId).work;
    f.manager.ssrcSequence = 9998;
    const second = f.manager.create(f.channel, "u1", undefined, options);
    await f.manager.running.get(second.sessionId).work;
    assert.deepEqual(sent, ["0105009998", "1105009999", "1105000000"]);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});

test("SIP码流：主子码流编号写入SDP，非法编号不发送请求", async () => {
  const sent = [];
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
  };
  const client = new SipDialogs(gateway);
  try {
    for (const streamNumber of [0, 1]) {
      const controller = new AbortController();
      const pending = client.invite(
        { remoteAddress: "127.0.0.1", remotePort: 15060 },
        "34020000001310000001",
        {
          host: "127.0.0.1",
          port: 40000,
          ssrc: "0100000001",
          streamNumber,
          signal: controller.signal,
        },
      );
      assert.match(
        parseSip(sent.at(-1)).body.toString(),
        new RegExp("a=streamnumber:" + streamNumber + "\\r\\n"),
      );
      assert.match(
        parseSip(sent.at(-1)).body.toString(),
        new RegExp("a=streamprofile:" + streamNumber + "\\r\\n"),
      );
      assert.doesNotMatch(parseSip(sent.at(-1)).body.toString(), /^f=\s*$/m);
      controller.abort();
      await assert.rejects(pending, /点播已取消/);
    }
    const count = sent.length;
    await assert.rejects(
      client.invite({}, "channel", {
        host: "127.0.0.1",
        port: 40000,
        ssrc: "0100000001",
        streamNumber: 9,
      }),
      /配置无效/,
    );
    assert.equal(sent.length, count);
  } finally {
    client.close();
  }
});

test("主子码流：同参数共享、不同参数隔离，切换不停止其他观看者", async () => {
  const streams = new Set(),
    invites = [];
  const f = fixture({
    async allocate(id) {
      streams.add(id);
      return { port: 40000 };
    },
    async streams() {
      return [...streams].map((stream) => ({
        app: "rtp",
        schema: "rtmp",
        stream,
      }));
    },
    async release(id) {
      streams.delete(id);
    },
  });
  f.sip.dialogs.invite = async (_d, _c, options) => {
    invites.push(options.streamNumber);
    return { id: "dialog-" + invites.length };
  };
  try {
    const main = f.manager.create(f.channel, "u1", "main");
    await f.manager.running.get(main.sessionId).work;
    const same = f.manager.create(f.channel, "u2", undefined, {
      kind: "live",
      streamNumber: 0,
    });
    assert.equal(main.sessionId, same.sessionId);
    const sub = f.manager.create(f.channel, "u1", "sub", {
      kind: "live",
      streamNumber: 1,
    });
    await f.manager.running.get(sub.sessionId).work;
    assert.notEqual(main.sessionId, sub.sessionId);
    assert.deepEqual(invites, [0, 1]);
    assert.equal(
      f.manager.create(f.channel, "u2", undefined, {
        kind: "live",
        streamNumber: 1,
      }).sessionId,
      sub.sessionId,
    );
    assert.throws(
      () =>
        f.manager.create(f.channel, "u1", "main", {
          kind: "live",
          streamNumber: 1,
        }),
      /幂等键/,
    );
    await f.manager.leave(main.sessionId, "u1", main.viewerId);
    assert.equal(
      f.manager.snapshot(same.sessionId, "u2", same.viewerId).state,
      "ready",
    );
    assert.equal(
      f.manager.snapshot(sub.sessionId, "u1", sub.viewerId).options
        .streamNumber,
      1,
    );
    assert.throws(
      () =>
        f.manager.create(f.channel, "u1", undefined, {
          kind: "live",
          streamNumber: 2,
        }),
      /码流编号/,
    );
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});

test("NVR 36路独立预览、同源共享及账号上限与逐路回收", async () => {
  const allocated = new Set(),
    ended = [];
  const f = fixture({
    async allocate(id) {
      allocated.add(id);
      return { port: 40000 + allocated.size * 2 };
    },
    async streams() {
      return [...allocated].map((stream) => ({
        app: "rtp",
        schema: "rtmp",
        stream,
      }));
    },
    async release(id) {
      allocated.delete(id);
    },
  });
  const invites = [];
  f.sip.dialogs.invite = async (device, channelCode) => {
    invites.push({ device: device.id, channelCode });
    return { id: channelCode };
  };
  f.sip.dialogs.end = async (dialog) => ended.push(dialog.id);
  try {
    const viewers = [];
    for (let i = 0; i < 36; i++) {
      const channel = {
        id: "nvr-" + i,
        deviceId: "d",
        channelCode: "3402000000132" + String(i + 1).padStart(7, "0"),
        status: "online",
      };
      f.db
        .prepare("INSERT INTO channels VALUES(?,?,?,?,?)")
        .run(channel.id, "d", channel.channelCode, "录像通道" + i, "online");
      viewers.push(f.manager.create(channel, "u1"));
    }
    await Promise.all([...f.manager.running.values()].map((task) => task.work));
    assert.equal(allocated.size, 36);
    assert.equal(new Set(invites.map((x) => x.channelCode)).size, 36);
    assert.ok(invites.every((x) => x.device === "d"));
    assert.ok(
      viewers.every(
        (v) =>
          f.manager.snapshot(v.sessionId, "u1", v.viewerId).state === "ready",
      ),
    );
    const channel = f.db
      .prepare("SELECT * FROM channels WHERE id=?")
      .get("nvr-0");
    for (let i = 36; i < 64; i++) viewers.push(f.manager.create(channel, "u1"));
    assert.throws(() => f.manager.create(channel, "u1"), /上限/);
    assert.equal(allocated.size, 36);
    const removed = viewers.splice(1, 1)[0];
    await f.manager.leave(removed.sessionId, "u1", removed.viewerId);
    assert.equal(allocated.size, 35);
    assert.ok(
      viewers.every(
        (v) =>
          f.manager.snapshot(v.sessionId, "u1", v.viewerId).state === "ready",
      ),
    );
    await Promise.all(
      viewers.map((v) => f.manager.leave(v.sessionId, "u1", v.viewerId)),
    );
    assert.equal(allocated.size, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM viewers").get().n, 0);
    assert.equal(ended.length, 36);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});

test("同通道复用源流、幂等请求、观看者隔离与最后一人退出回收", async () => {
  const f = fixture();
  try {
    const a = f.manager.create(f.channel, "u1", "key");
    assert.deepEqual(f.manager.create(f.channel, "u1", "key"), a);
    const b = f.manager.create(f.channel, "u2");
    assert.equal(a.sessionId, b.sessionId);
    await f.manager.running.get(a.sessionId).work;
    assert.equal(
      f.manager.snapshot(a.sessionId, "u1", a.viewerId).state,
      "ready",
    );
    assert.throws(
      () => f.manager.snapshot(a.sessionId, "u2", a.viewerId),
      /不存在或已过期/,
    );
    f.db
      .prepare("INSERT INTO channels VALUES(?,?,?,?,?)")
      .run("other", "d", "34020000001310000002", "另一个授权通道", "online");
    assert.throws(
      () => f.manager.create({ ...f.channel, id: "other" }, "u1", "key"),
      /其他通道/,
    );
    await assert.rejects(
      f.manager.leave(a.sessionId, "u2", a.viewerId),
      /无权/,
    );
    await f.manager.leave(a.sessionId, "u1", a.viewerId);
    assert.equal(f.calls.release, 0);
    assert.equal(f.manager.renew(b.sessionId, "u2", b.viewerId).state, "ready");
    await f.manager.leave(b.sessionId, "u2", b.viewerId);
    assert.equal(f.calls.allocate, 1);
    assert.equal(f.calls.invite, 1);
    assert.equal(f.calls.release, 1);
    assert.equal(f.calls.end, 1);
    assert.equal(
      f.db.prepare("SELECT state FROM live_sessions").get().state,
      "stopped",
    );
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("租约超时终止正在代理的连接并回收媒体资源", async () => {
  const f = fixture();
  try {
    const a = f.manager.create(f.channel, "u1");
    await f.manager.running.get(a.sessionId).work;
    const connection = new AbortController();
    f.manager.trackConnection(a.sessionId, a.viewerId, connection);
    f.advance(46000);
    await f.manager.reap();
    assert.equal(connection.signal.aborted, true);
    assert.equal(f.calls.release, 1);
    assert.throws(() => f.manager.renew(a.sessionId, "u1", a.viewerId), /过期/);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("退出发生在分配返回前，迟到资源仍被释放且不再发起INVITE", async () => {
  let allocate;
  const f = fixture({ allocate: () => new Promise((r) => (allocate = r)) });
  try {
    const a = f.manager.create(f.channel, "u1");
    const leaving = f.manager.leave(a.sessionId, "u1", a.viewerId);
    allocate({ port: 40000 });
    await leaving;
    assert.equal(f.calls.invite, 0);
    assert.equal(f.calls.release, 1);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("点播失败补偿以及回收失败后重试", async () => {
  const f = fixture();
  let allowRelease = false;
  f.sip.dialogs.invite = async () => {
    throw Error("设备拒绝点播");
  };
  f.media.release = async () => {
    f.calls.release++;
    if (!allowRelease) throw Error("offline");
  };
  try {
    const a = f.manager.create(f.channel, "u1");
    await f.manager.running.get(a.sessionId).work;
    assert.equal(
      f.db.prepare("SELECT state,released FROM live_sessions").get().released,
      0,
    );
    allowRelease = true;
    await f.manager.reap();
    assert.equal(
      f.db.prepare("SELECT released FROM live_sessions").get().released,
      1,
    );
    assert.equal(f.calls.release, 2);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("重启清理持久化残留会话，删除旧观看租约", async () => {
  const f = fixture();
  try {
    f.db
      .prepare(
        "INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,dialog,createdAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "old",
        "c",
        "d",
        "old_stream",
        "ready",
        JSON.stringify({ id: "old-dialog" }),
        new Date().toISOString(),
      );
    f.db
      .prepare("INSERT INTO viewers VALUES(?,?,?,?)")
      .run("old-viewer", "old", "u1", Date.now() + 10000);
    await f.manager.recover();
    assert.equal(f.calls.end, 1);
    assert.equal(f.calls.release, 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM viewers").get().n, 0);
    assert.equal(
      f.db.prepare("SELECT state,released FROM live_sessions").get().state,
      "failed",
    );
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("SIP INVITE成功ACK、重复成功重发ACK、结束发送BYE", async () => {
  const sent = [];
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
  };
  const client = new SipDialogs(gateway);
  try {
    const device = { remoteAddress: "127.0.0.1", remotePort: 15060 };
    const pending = client.invite(device, "34020000001310000001", {
      host: "127.0.0.1",
      port: 40000,
      ssrc: "0100000001",
    });
    const request = parseSip(sent[0]);
    assert.match(request.body.toString(), /m=video 40000 RTP\/AVP 96/);
    const reply = {
      status: 200,
      headers: {
        ...request.headers,
        to: [request.headers.to[0] + ";tag=remote"],
        contact: ["<sip:34020000001310000001@127.0.0.1:15060>"],
      },
    };
    assert.equal(
      client.handle(reply, { address: "127.0.0.2", port: 15060 }),
      false,
    );
    client.handle(reply, { address: "127.0.0.1", port: 15060 });
    const dialog = await pending;
    assert.equal(parseSip(sent.at(-1)).method, "ACK");
    client.handle(reply, { address: "127.0.0.1", port: 15060 });
    assert.equal(parseSip(sent.at(-1)).method, "ACK");
    await client.end(dialog);
    assert.equal(parseSip(sent.at(-1)).method, "BYE");
    assert.equal(parseSip(sent.at(-1)).headers.cseq[0], "2 BYE");
  } finally {
    client.close();
  }
});
test("SIP取消后收到迟到200仍发送ACK和BYE，不复活会话", async () => {
  const sent = [];
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
  };
  const client = new SipDialogs(gateway);
  try {
    const controller = new AbortController();
    const pending = client.invite(
      { remoteAddress: "127.0.0.1", remotePort: 15060 },
      "34020000001310000001",
      {
        host: "127.0.0.1",
        port: 40000,
        ssrc: "0100000001",
        signal: controller.signal,
      },
    );
    const request = parseSip(sent[0]);
    controller.abort();
    await assert.rejects(pending, /已取消/);
    assert.equal(parseSip(sent.at(-1)).method, "CANCEL");
    client.handle(
      {
        status: 200,
        headers: {
          ...request.headers,
          to: [request.headers.to[0] + ";tag=late"],
        },
      },
      { address: "127.0.0.1", port: 15060 },
    );
    assert.equal(parseSip(sent.at(-2)).method, "ACK");
    assert.equal(parseSip(sent.at(-1)).method, "BYE");
  } finally {
    client.close();
  }
});

test("媒体等待超时回收已建立的SIP会话和RTP端口", async () => {
  const f = fixture();
  f.media.streams = async () => {
    f.advance(2000);
    return [];
  };
  try {
    const a = f.manager.create(f.channel, "u1");
    await f.manager.running.get(a.sessionId).work;
    const row = f.db.prepare("SELECT * FROM live_sessions").get();
    assert.equal(row.state, "failed");
    assert.equal(row.error, "等待媒体流超时");
    assert.equal(row.released, 1);
    assert.equal(f.calls.end, 1);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("就绪后的媒体流断开触发停止和代理连接中断", async () => {
  const f = fixture();
  try {
    const a = f.manager.create(f.channel, "u1");
    await f.manager.running.get(a.sessionId).work;
    const connection = new AbortController();
    f.manager.trackConnection(a.sessionId, a.viewerId, connection);
    f.media.streams = async () => [];
    await f.manager.reap();
    assert.equal(connection.signal.aborted, true);
    const row = f.db
      .prepare("SELECT state,error,released FROM live_sessions")
      .get();
    assert.equal(row.state, "failed");
    assert.equal(row.error, "媒体流已断开");
    assert.equal(row.released, 1);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});

test("同通道直播和两个回放始终独立，回放使用历史流SSRC", async () => {
  const f = fixture();
  const original = f.sip.dialogs.invite,
    argumentsList = [];
  f.sip.dialogs.invite = async (...args) => {
    argumentsList.push(args);
    return original(...args);
  };
  try {
    const a = f.manager.create(f.channel, "u1");
    await f.manager.running.get(a.sessionId).work;
    const options = {
      start: "2026-10-31T00:00:00Z",
      end: "2026-10-31T01:00:00Z",
    };
    const b = f.manager.create(f.channel, "u1", undefined, options);
    await f.manager.running.get(b.sessionId).work;
    const c = f.manager.create(f.channel, "u1", undefined, options);
    await f.manager.running.get(c.sessionId).work;
    assert.equal(new Set([a.sessionId, b.sessionId, c.sessionId]).size, 3);
    assert.equal(argumentsList[0][2].ssrc[0], "0");
    assert.equal(argumentsList[1][2].ssrc[0], "1");
    assert.equal(
      f.manager.snapshot(b.sessionId, "u1", b.viewerId).kind,
      "playback",
    );
    assert.equal(f.calls.allocate, 3);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});
test("暂停保护RTP接收资源，设备拒绝暂停时回滚媒体检查状态", async () => {
  const f = fixture(),
    checks = [];
  f.media.setPaused = async (streamId, paused) => checks.push(paused);
  f.sip.dialogs.control = async () => {
    throw Error("设备不支持暂停");
  };
  try {
    const a = f.manager.create(f.channel, "u1", undefined, {
      start: "2026-10-31T00:00:00Z",
      end: "2026-10-31T01:00:00Z",
    });
    await f.manager.running.get(a.sessionId).work;
    await assert.rejects(
      f.manager.control(a.sessionId, "u1", a.viewerId, { action: "pause" }),
      /不支持暂停/,
    );
    assert.deepEqual(checks, [true, false]);
    f.sip.dialogs.control = async () => {};
    await f.manager.control(a.sessionId, "u1", a.viewerId, { action: "pause" });
    f.advance(31000);
    await f.manager.reap();
    assert.equal(checks.at(-1), true);
    await f.manager.control(a.sessionId, "u1", a.viewerId, {
      action: "resume",
    });
    assert.equal(checks.at(-1), false);
    assert.equal(f.manager.running.get(a.sessionId).paused, false);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});

test("录像结束通知按Call-ID精确关联，不停止同一通道的其他回放", async () => {
  const f = fixture();
  let n = 0;
  f.sip.dialogs.invite = async () => ({ id: "playback-call-" + ++n });
  try {
    const options = {
        start: "2026-10-31T00:00:00Z",
        end: "2026-10-31T01:00:00Z",
      },
      a = f.manager.create(f.channel, "u1", undefined, options);
    await f.manager.running.get(a.sessionId).work;
    const b = f.manager.create(f.channel, "u1", undefined, options);
    await f.manager.running.get(b.sessionId).work;
    assert.equal(
      await f.manager.endNotification(
        "d",
        f.channel.channelCode,
        "unknown-call",
      ),
      false,
    );
    assert.equal(
      await f.manager.endNotification(
        "d",
        f.channel.channelCode,
        "playback-call-1",
      ),
      true,
    );
    assert.equal(
      f.manager.snapshot(a.sessionId, "u1", a.viewerId).state,
      "completed",
    );
    assert.equal(
      f.manager.snapshot(b.sessionId, "u1", b.viewerId).state,
      "ready",
    );
    assert.equal(f.calls.release, 1);
  } finally {
    await f.manager.shutdown();
    f.db.close();
  }
});

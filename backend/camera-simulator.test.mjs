import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "./lib/store.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { SimulatedCameras } from "../scripts/simulate-cameras.mjs";
test("64台模拟摄像机经真实UDP认证注册、心跳及目录同步，停止后离线", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ls-camera-sim-"));
  const database = join(directory, "platform.db");
  const { db } = openStore(database);
  db.prepare("INSERT INTO users VALUES('a','a','unused','admin')").run();
  const config = {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    domain: "4101050000",
    serverId: "41010500002000000001",
    heartbeatTimeout: 180000,
  };
  const gateway = new SipGateway({ db, config });
  await gateway.start();
  const sim = new SimulatedCameras({ sip: config, database, count: 64 });
  t.after(async () => {
    await sim.stop();
    gateway.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await sim.start();
  assert.equal(
    db.prepare("SELECT count(*) n FROM devices WHERE status='online'").get().n,
    64,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM sip_registrations").get().n,
    64,
  );
  await sim.heartbeat();
  assert.equal(sim.stats.heartbeats, 64);
  for (const device of db.prepare("SELECT * FROM devices").all())
    gateway.sync(device);
  for (let i = 0; i < 100 && gateway.pending.size; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(gateway.pending.size, 0);
  assert.equal(
    db.prepare("SELECT count(*) n FROM channels WHERE status='online'").get().n,
    64,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM tasks WHERE status='succeeded'").get().n,
    64,
  );
  assert.equal(sim.stats.videoSource, false);
  await sim.stop();
  assert.equal(
    db.prepare("SELECT count(*) n FROM devices WHERE status='online'").get().n,
    0,
  );
});

test("模拟视频经INVITE协商PS/RTP，复用测试源，拒绝外部目标并在BYE回收", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ls-camera-video-"));
  const database = join(directory, "platform.db");
  const { db } = openStore(database);
  db.prepare("INSERT INTO users VALUES('a','a','unused','admin')").run();
  const config = {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    domain: "4101050000",
    serverId: "41010500002000000001",
    heartbeatTimeout: 180000,
  };
  const gateway = new SipGateway({ db, config });
  await gateway.start();
  let loaded = false,
    loads = 0;
  const forwarded = [],
    stopped = [];
  const media = {
    async streams() {
      return loaded
        ? [{ app: "rtp", stream: "ls_simulated_camera_source", schema: "rtmp" }]
        : [];
    },
    async call(action) {
      if (action === "loadMP4File") {
        loaded = true;
        loads++;
      }
      return {};
    },
    async startForward(...args) {
      forwarded.push(args);
      return { local_port: 16000 };
    },
    async stopForward(stream, ssrc) {
      stopped.push(ssrc);
    },
  };
  const sim = new SimulatedCameras({
    sip: config,
    database,
    count: 2,
    media,
    videoPath: "sample.mp4",
  });
  t.after(async () => {
    await sim.stop();
    gateway.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await sim.start();
  const devices = db.prepare("SELECT * FROM devices ORDER BY id").all();
  const calls = await Promise.all(
    devices.map((d, i) =>
      gateway.dialogs.invite(d, d.deviceId, {
        host: "127.0.0.1",
        port: 15000 + i * 2,
        ssrc: "000000010" + i,
      }),
    ),
  );
  assert.equal(loads, 1);
  assert.equal(forwarded.length, 2);
  assert.match(calls[0].answer, /a=rtpmap:96 PS\/90000/);
  await assert.rejects(
    gateway.dialogs.invite(devices[0], devices[0].deviceId, {
      host: "203.0.113.1",
      port: 15000,
      ssrc: "0000000200",
    }),
    /488/,
  );
  await gateway.dialogs.end(calls[0]);
  for (let i = 0; i < 100 && !stopped.includes("0000000100"); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(stopped.includes("0000000100"));
  assert.equal(sim.dialogs.size, 1);
  await sim.stop();
  assert.ok(stopped.includes("0000000101"));
});

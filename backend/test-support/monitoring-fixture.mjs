import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { openStore, hashPassword } from "../lib/store.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createServer } from "../server.mjs";

// Explicitly simulated SIP/media. This fixture never contacts real equipment
// or reads the installation .env/config/database.
export async function monitoringFixture({
  port = 0,
  delay = { channels: 0 },
  archiveSample = null,
  frontendDirectory = null,
  channelCount = 128,
  allOnline = false,
  aiSettings = null,
  aiFetcher = undefined,
  aiCapture = null,
  aiArchiveReader = null,
  aiLocalModel = null,
  qwenOptions = undefined,
} = {}) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > 10000
  )
    throw Error("Invalid simulated channel count");
  const directory = await mkdtemp(join(tmpdir(), "ls-monitoring-qa-"));
  const database = join(directory, "platform.db");
  const { db } = openStore(database, null);
  const password = "Isolated-monitor-test-2026";
  for (const [id, role] of [
    ["qa-admin", "admin"],
    ["qa-monitor", "viewer"],
  ])
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      hashPassword(password),
      role,
    );
  for (const id of ["qa-nvr", "qa-record", "qa-denied"]) {
    db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
      id,
      id,
      "隔离测试分组",
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO devices(id,deviceId,name,status,createdAt,groupId,registeredUntil,lastHeartbeat,remoteAddress,remotePort) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      id === "qa-nvr"
        ? "34020000001110000001"
        : id === "qa-record"
          ? "34020000001320000002"
          : "34020000001320000003",
      id === "qa-nvr"
        ? `QA 模拟录像机（${channelCount}路）`
        : id === "qa-record"
          ? "QA 后台录像保护"
          : "QA 无权设备",
      "online",
      new Date().toISOString(),
      id,
      Date.now() + 86400000,
      Date.now() + 3600000,
      "127.0.0.1",
      15060,
    );
  }
  db.prepare("INSERT INTO user_groups VALUES(?,?)").run("qa-monitor", "qa-nvr");
  for (let i = 1; i <= channelCount; i++)
    db.prepare(
      "INSERT INTO channels(id,deviceId,channelCode,name,status) VALUES(?,?,?,?,?)",
    ).run(
      "qa-ch-" + i,
      "qa-nvr",
      "3402000000131" + String(i).padStart(7, "0"),
      "QA 通道 " + String(i).padStart(3, "0"),
      !allOnline && i <= 64 ? "offline" : "online",
    );
  for (const id of ["qa-record", "qa-denied"])
    db.prepare(
      "INSERT INTO channels(id,deviceId,channelCode,name,status) VALUES(?,?,?,?,?)",
    ).run(
      id,
      id,
      id === "qa-record" ? "34020000001310000200" : "34020000001310000201",
      id,
      "online",
    );
  db.exec(
    "UPDATE devices SET channels=(SELECT COUNT(*) FROM channels WHERE deviceId=devices.id)",
  );
  db.prepare(
    "INSERT INTO recording_plans(id,name,channelId,ownerId,days,startTime,endTime,enabled,retentionDays,segmentSeconds,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "qa-plan",
    "QA 后台录像哨兵",
    "qa-record",
    "qa-admin",
    "[1,2,3,4,5,6,7]",
    "00:00",
    "00:00",
    1,
    7,
    300,
    new Date().toISOString(),
  );
  const streams = new Set(),
    calls = {
      allocated: 0,
      released: 0,
      recordStarted: 0,
      recordStopped: 0,
      channelRequests: [],
      ptzPackets: [],
      recordingReads: [],
    };
  const media = {
    config: {},
    status: { state: "ready" },
    async allocate(id) {
      streams.add(id);
      calls.allocated++;
      return { port: 40000 };
    },
    async release(id) {
      if (streams.delete(id)) calls.released++;
    },
    async streams() {
      return [...streams].map((stream) => ({
        app: "rtp",
        schema: "rtmp",
        stream,
      }));
    },
    async startRecord() {
      calls.recordStarted++;
    },
    async stopRecord() {
      calls.recordStopped++;
    },
    async recordFiles() {
      return [];
    },
    async openRecording(_stream, _file, range) {
      calls.recordingReads.push({
        stream: _stream,
        file: _file,
        range: range || "",
      });
      if (!archiveSample) throw Error("No archive sample configured");
      const match = /^bytes=(\d+)-(\d*)$/.exec(range || "");
      const start = match ? Number(match[1]) : 0;
      const end =
        match && match[2]
          ? Math.min(Number(match[2]), archiveSample.length - 1)
          : archiveSample.length - 1;
      if (start > end)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${archiveSample.length}` },
        });
      return new Response(archiveSample.subarray(start, end + 1), {
        status: match ? 206 : 200,
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(match
            ? {
                "Content-Range": `bytes ${start}-${end}/${archiveSample.length}`,
              }
            : {}),
        },
      });
    },
    async openFlv(_id, signal) {
      let controller;
      const body = new ReadableStream({
        start(c) {
          controller = c;
          c.enqueue(new Uint8Array([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]));
        },
        cancel() {
          controller = null;
        },
      });
      signal.addEventListener(
        "abort",
        () => {
          try {
            controller?.close();
          } catch {}
          controller = null;
        },
        { once: true },
      );
      return new Response(body, { headers: { "Content-Type": "video/x-flv" } });
    },
  };
  if (archiveSample) {
    const day = new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Shanghai",
    });
    for (const channel of [65, 66])
      for (const attempt of [1, 2]) {
        const id = `qa-archive-${channel}-${attempt}`;
        db.prepare(
          "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,streamId,createdAt,finishedAt,start,end,attempt,occurrence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          "qa-monitor",
          `qa-ch-${channel}`,
          "scheduled",
          "succeeded",
          Date.now(),
          id,
          `${day}T04:00:00.000Z`,
          `${day}T04:10:00.000Z`,
          `${day}T04:00:00.000Z`,
          `${day}T04:10:00.000Z`,
          attempt,
          `qa-archive-${channel}`,
        );
        db.prepare("INSERT INTO recording_files VALUES(?,?,?,?)").run(
          id,
          id,
          day,
          `${day}-12-0${attempt - 1}-${channel === 66 ? "05" : "00"}-0.mp4`,
        );
      }
  }
  const sip = {
    state: "listening",
    seq: 1,
    config: { heartbeatTimeout: 86400000 },
    requests: {
      async request(value) {
        value.signal?.throwIfAborted();
        calls.ptzPackets.push(value.body.match(/<PTZCmd>([^<]+)/)?.[1] || "");
        return { status: 200 };
      },
    },
    dialogs: {
      async invite() {
        return { id: crypto.randomUUID() };
      },
      async end() {},
    },
    async start() {},
    async close() {},
  };
  const config = loadConfig({
    MEDIA_URL: "http://127.0.0.1:1",
    MEDIA_SECRET: "isolated-qa-secret",
  });
  config.playTimeout = 3600000;
  const app = createServer({
    aiSettings,
    aiFetcher,
    aiCapture,
    aiArchiveReader,
    aiLocalModel,
    qwenOptions,
    database,
    legacy: null,
    configFile: null,
    config,
    sipGateway: sip,
    mediaAdapter: media,
  });
  const handler = app.listeners("request")[0];
  app.removeListener("request", handler);
  app.on("request", (req, res) => {
    // Optional isolated build, leaving the running installation's dist untouched.
    const asset = req.url.match(/^\/assets\/([a-zA-Z0-9_.-]+\.(?:js|css))$/);
    if (
      frontendDirectory &&
      req.method === "GET" &&
      (req.url === "/" || asset)
    ) {
      readFile(
        join(frontendDirectory, asset ? "assets/" + asset[1] : "index.html"),
      )
        .then((bytes) => {
          res.writeHead(200, {
            "Content-Type": asset
              ? asset[1].endsWith(".css")
                ? "text/css"
                : "text/javascript"
              : "text/html",
            "Cache-Control": "no-store",
          });
          res.end(bytes);
        })
        .catch(() => {
          res.writeHead(404);
          res.end();
        });
      return;
    }
    if (req.url.startsWith("/api/v1/channels?")) {
      calls.channelRequests.push(req.url);
      if (delay.channels) {
        setTimeout(() => {
          if (!res.destroyed) handler(req, res);
        }, delay.channels).unref();
        return;
      }
    }
    handler(req, res);
  });
  app.listen(port, "127.0.0.1");
  await once(app, "listening");
  await app.startSip();
  function stats() {
    return {
      simulated: true,
      streams: streams.size,
      nvrViewers: db
        .prepare(
          "SELECT COUNT(*) n FROM viewers v JOIN live_sessions s ON v.sessionId=s.id WHERE s.deviceId='qa-nvr'",
        )
        .get().n,
      liveSources: db
        .prepare("SELECT COUNT(*) n FROM live_sessions WHERE released=0")
        .get().n,
      plan: db
        .prepare("SELECT enabled FROM recording_plans WHERE id='qa-plan'")
        .get(),
      planFingerprint: createHash("sha256")
        .update(
          JSON.stringify(
            db
              .prepare("SELECT * FROM recording_plans WHERE id='qa-plan'")
              .get(),
          ),
        )
        .digest("hex"),
      background: db
        .prepare(
          "SELECT id,status,sessionId,viewerId FROM recording_jobs WHERE planId='qa-plan' ORDER BY createdAt DESC LIMIT 1",
        )
        .get(),
      ...calls,
    };
  }
  return {
    app,
    db,
    directory,
    password,
    base: "http://127.0.0.1:" + app.address().port,
    stats,
    delay,
    async close() {
      await new Promise((r, j) => app.close((e) => (e ? j(e) : r())));
      db.close();
      if (
        dirname(resolve(directory)) === resolve(tmpdir()) &&
        basename(directory).startsWith("ls-monitoring-qa-")
      )
        await rm(directory, { recursive: true, force: true });
    },
  };
}

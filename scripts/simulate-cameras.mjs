// Explicitly labelled, local-only GB28181 simulator with optional synthetic video.
import dgram from "node:dgram";
import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { md5, parseSip, response } from "../backend/sip/protocol.mjs";
import { loadConfig } from "../backend/lib/config.mjs";
import { AccessSettings } from "../backend/lib/access-settings.mjs";
import { MediaAdapter } from "../backend/media/adapter.mjs";

export class SimulatedCameras {
  constructor({
    sip,
    count = 64,
    database,
    output,
    media = null,
    videoPath = null,
  }) {
    if (!Number.isInteger(count) || count < 1 || count > 64)
      throw Error("模拟数量须为1至64");
    this.sip = sip;
    this.count = count;
    this.output = output;
    this.db = new DatabaseSync(database);
    this.media = media;
    this.videoPath = videoPath;
    this.sourceStream = "ls_simulated_camera_source";
    this.dialogs = new Map();
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    this.socket = dgram.createSocket("udp4");
    this.pending = new Map();
    this.cameras = new Map();
    this.stopped = false;
    this.stats = {
      simulated: true,
      count,
      registered: 0,
      heartbeats: 0,
      catalogsAnswered: 0,
      errors: 0,
      videoSource: !!(media && videoPath),
    };
    this.socket.on("message", (bytes, remote) => this.receive(bytes, remote));
    this.socket.on("error", () => {
      this.stats.errors++;
    });
  }
  provision() {
    const now = new Date().toISOString(),
      groupId = "simulated-cameras";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const group = this.db
        .prepare("SELECT * FROM device_groups WHERE id=?")
        .get(groupId);
      if (
        group &&
        !["模拟摄像机（无视频源）", "模拟摄像机（测试视频）"].includes(
          group.name,
        )
      )
        throw Error("模拟分组标识被其它分组占用");
      if (!group)
        this.db
          .prepare("INSERT INTO device_groups VALUES(?,?,?,?)")
          .run(
            groupId,
            "模拟摄像机（无视频源）",
            "本机GB28181信令模拟，非真实摄像机；模拟器停止后离线",
            now,
          );
      if (this.videoPath)
        this.db
          .prepare("UPDATE device_groups SET name=?,description=? WHERE id=?")
          .run(
            "模拟摄像机（测试视频）",
            "明确标注的测试图案；非真实摄像机现场；由模拟器按需发送国标PS/RTP",
            groupId,
          );
      const admin = this.db
        .prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")
        .get();
      if (!admin) throw Error("须先初始化管理员");
      for (let i = 1; i <= this.count; i++) {
        const id = "sim-camera-" + String(i).padStart(3, "0"),
          code = "9999990000132" + String(i).padStart(7, "0"),
          name = "模拟摄像机 " + String(i).padStart(3, "0");
        const old = this.db
          .prepare("SELECT * FROM devices WHERE id=? OR deviceId=?")
          .all(id, code);
        if (
          old.length &&
          (old.length !== 1 ||
            old[0].id !== id ||
            old[0].deviceId !== code ||
            old[0].groupId !== groupId ||
            old[0].name !== name)
        )
          throw Error("模拟编号冲突，未修改现有设备");
        if (
          old.length &&
          this.db
            .prepare(
              "SELECT 1 FROM live_sessions WHERE deviceId=? AND released=0",
            )
            .get(id)
        )
          throw Error("模拟设备仍有点播，请先关闭模拟预览");
        const ha1 = md5(
          `${code}:${this.sip.domain}:${randomBytes(24).toString("hex")}`,
        );
        if (!old.length)
          this.db
            .prepare(
              "INSERT INTO devices(id,deviceId,name,createdAt,groupId,sipHa1) VALUES(?,?,?,?,?,?)",
            )
            .run(id, code, name, now, groupId, ha1);
        else
          this.db
            .prepare("UPDATE devices SET sipHa1=? WHERE id=?")
            .run(ha1, id);
        this.db
          .prepare("INSERT INTO audit VALUES(?,?,?,?,?)")
          .run(randomUUID(), admin.id, "device.simulator.provision", id, now);
        this.cameras.set(code, { id, code, name, ha1, seq: 0 });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  packet(
    camera,
    method,
    { body = "", auth = "", expires = 300, to = this.sip.serverId } = {},
  ) {
    const uri = `sip:${to}@${this.sip.domain}`,
      call = randomUUID(),
      seq = ++camera.seq;
    return {
      call,
      bytes: Buffer.from(
        [
          `${method} ${uri} SIP/2.0`,
          `Via: SIP/2.0/UDP ${this.host}:${this.socket.address().port};rport;branch=z9hG4bK${randomUUID()}`,
          `From: <sip:${camera.code}@${this.sip.domain}>;tag=sim-${camera.id}`,
          `To: <sip:${to}@${this.sip.domain}>`,
          `Call-ID: ${call}`,
          `CSeq: ${seq} ${method}`,
          `Contact: <sip:${camera.code}@${this.host}:${this.socket.address().port}>`,
          "Max-Forwards: 70",
          `Expires: ${expires}`,
          ...(auth ? ["Authorization: " + auth] : []),
          "Content-Type: Application/MANSCDP+xml",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "",
          body,
        ].join("\r\n"),
      ),
    };
  }
  request(camera, method, options) {
    const { call, bytes } = this.packet(camera, method, options);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(call);
        reject(Error("模拟信令响应超时"));
      }, 4000);
      this.pending.set(call, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.socket.send(bytes, this.sip.port, this.host, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(call);
          reject(error);
        }
      });
    });
  }
  async register(camera, expires = 300) {
    const challenge = await this.request(camera, "REGISTER", { expires });
    if (challenge.status !== 401) throw Error("未收到注册认证挑战");
    const nonce =
      challenge.headers["www-authenticate"]?.[0]?.match(/nonce="([^"]+)"/)?.[1];
    if (!nonce) throw Error("认证挑战无效");
    const uri = `sip:${this.sip.serverId}@${this.sip.domain}`,
      nc = "00000001",
      cnonce = randomBytes(12).toString("hex");
    const hash = md5(
      `${camera.ha1}:${nonce}:${nc}:${cnonce}:auth:${md5("REGISTER:" + uri)}`,
    );
    const auth = `Digest username="${camera.code}", realm="${this.sip.domain}", nonce="${nonce}", uri="${uri}", response="${hash}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    const answer = await this.request(camera, "REGISTER", { auth, expires });
    if (answer.status !== 200) throw Error("模拟注册未成功");
  }
  receive(bytes, remote) {
    if (remote.address !== this.host || remote.port !== this.sip.port) return;
    let msg;
    try {
      msg = parseSip(bytes);
    } catch {
      return;
    }
    if (msg.status) {
      const waiter = this.pending.get(msg.headers["call-id"][0]);
      if (waiter) {
        this.pending.delete(msg.headers["call-id"][0]);
        waiter.resolve(msg);
      }
      return;
    }
    const code = msg.uri.match(/sip:(\d{20})@/)?.[1],
      camera = this.cameras.get(code);
    if (!camera) return;
    if (msg.method === "ACK") return;
    if (msg.method === "INVITE" && this.media && this.videoPath) {
      void this.invite(camera, msg, remote);
      return;
    }
    if (msg.method === "BYE") {
      const id = msg.headers["call-id"][0],
        dialog = this.dialogs.get(id);
      if (dialog?.camera === camera.code) {
        this.dialogs.delete(id);
        void dialog.work
          .finally(() => this.media.stopForward(this.sourceStream, dialog.ssrc))
          .catch(() => this.stats.errors++);
      }
      this.socket.send(response(msg, 200, "OK"), remote.port, remote.address);
      return;
    }
    const text = msg.body.toString("utf8"),
      sn = text.match(/<SN>\s*(\d+)\s*<\/SN>/)?.[1];
    if (
      msg.method === "MESSAGE" &&
      /<CmdType>\s*Catalog\s*<\/CmdType>/.test(text) &&
      sn
    ) {
      this.socket.send(response(msg, 200, "OK"), remote.port, remote.address);
      const body = `<?xml version="1.0" encoding="UTF-8"?><Response><CmdType>Catalog</CmdType><SN>${sn}</SN><DeviceID>${code}</DeviceID><SumNum>1</SumNum><DeviceList Num="1"><Item><DeviceID>${code}</DeviceID><Name>${camera.name}</Name><Manufacturer>Ls-Aegis Simulator</Manufacturer><Status>ON</Status></Item></DeviceList></Response>`;
      this.request(camera, "MESSAGE", { body })
        .then((answer) => {
          if (answer.status === 200) this.stats.catalogsAnswered++;
          else this.stats.errors++;
        })
        .catch(() => this.stats.errors++);
    } else
      this.socket.send(
        response(
          msg,
          msg.method === "BYE" ? 200 : 488,
          msg.method === "BYE" ? "OK" : "Not Acceptable Here",
        ),
        remote.port,
        remote.address,
      );
  }
  async ensureSource() {
    if (this.sourcePreparing) return this.sourcePreparing;
    this.sourcePreparing = (async () => {
      const sources = await this.media.streams();
      if (
        sources.some(
          (s) =>
            s.app === "rtp" &&
            s.stream === this.sourceStream &&
            s.schema === "rtmp",
        )
      )
        return;
      await this.media.call("loadMP4File", {
        vhost: "__defaultVhost__",
        app: "rtp",
        stream: this.sourceStream,
        file_path: this.videoPath,
        file_repeat: "1",
        enable_hls: "0",
        enable_mp4: "0",
      });
    })().finally(() => {
      this.sourcePreparing = null;
    });
    return this.sourcePreparing;
  }
  async invite(camera, msg, remote) {
    const id = msg.headers["call-id"][0],
      existing = this.dialogs.get(id);
    if (existing) {
      if (existing.answer)
        this.socket.send(existing.answer, remote.port, remote.address);
      return;
    }
    const text = msg.body.toString("utf8"),
      host = text.match(/^c=IN IP4 ([\d.]+)\r?$/m)?.[1],
      port = Number(text.match(/^m=video (\d+) RTP\/AVP 96\r?$/m)?.[1]),
      ssrc = text.match(/^y=(\d{10})\r?$/m)?.[1];
    const locals = new Set([
      "127.0.0.1",
      ...Object.values(networkInterfaces())
        .flat()
        .filter(Boolean)
        .map((n) => n.address),
    ]);
    if (
      !locals.has(host) ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      !ssrc ||
      !/^s=Play\r?$/m.test(text)
    ) {
      this.socket.send(
        response(msg, 488, "Not Acceptable Here"),
        remote.port,
        remote.address,
      );
      return;
    }
    const dialog = { camera: camera.code, ssrc, work: null, answer: null };
    this.dialogs.set(id, dialog);
    dialog.work = (async () => {
      await this.ensureSource();
      if (this.stopped || this.dialogs.get(id) !== dialog) return;
      const allocation = await this.media.startForward(
        this.sourceStream,
        ssrc,
        host,
        port,
        false,
      );
      if (this.stopped || this.dialogs.get(id) !== dialog) {
        await this.media.stopForward(this.sourceStream, ssrc);
        return;
      }
      const body = `v=0\r\no=${camera.code} 0 0 IN IP4 ${this.host}\r\ns=Play\r\nc=IN IP4 ${this.host}\r\nt=0 0\r\nm=video ${allocation.local_port} RTP/AVP 96\r\na=sendonly\r\na=rtpmap:96 PS/90000\r\ny=${ssrc}\r\n`;
      dialog.answer = Buffer.from(
        response(msg, 200, "OK")
          .toString()
          .replace(
            "Content-Length: 0\r\n\r\n",
            `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          ),
      );
      this.socket.send(dialog.answer, remote.port, remote.address);
    })();
    try {
      await dialog.work;
    } catch {
      this.stats.errors++;
      this.dialogs.delete(id);
      await this.media.stopForward(this.sourceStream, ssrc).catch(() => {});
      this.socket.send(
        response(msg, 500, "Media Unavailable"),
        remote.port,
        remote.address,
      );
    }
  }
  async start() {
    const locals = new Set([
      "127.0.0.1",
      ...Object.values(networkInterfaces())
        .flat()
        .filter(Boolean)
        .map((n) => n.address),
    ]);
    this.host = this.sip.host === "0.0.0.0" ? "127.0.0.1" : this.sip.host;
    if (!this.sip.enabled || !locals.has(this.host))
      throw Error("模拟器仅允许连接已启用的本机SIP服务");
    await new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, this.host, resolve);
    });
    this.provision();
    for (const camera of this.cameras.values()) {
      await this.register(camera);
      this.stats.registered++;
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 15000);
    this.registerTimer = setInterval(() => void this.renew(), 120000);
    await this.report();
    this.reportTimer = setInterval(() => void this.report(), 2000);
    return this.stats;
  }
  async heartbeat() {
    if (this.stopped || this.beating) return;
    this.beating = true;
    try {
      for (const camera of this.cameras.values()) {
        if (this.stopped) break;
        const body = `<Notify><CmdType>Keepalive</CmdType><SN>${++camera.seq}</SN><DeviceID>${camera.code}</DeviceID><Status>OK</Status></Notify>`;
        try {
          const r = await this.request(camera, "MESSAGE", { body });
          if (r.status === 200) this.stats.heartbeats++;
          else this.stats.errors++;
        } catch {
          this.stats.errors++;
        }
      }
    } finally {
      this.beating = false;
    }
  }
  async renew() {
    if (this.stopped || this.renewing) return;
    this.renewing = true;
    try {
      for (const c of this.cameras.values()) {
        if (this.stopped) break;
        try {
          await this.register(c);
        } catch {
          this.stats.errors++;
        }
      }
    } finally {
      this.renewing = false;
    }
  }
  async report() {
    if (!this.output || this.stopped) return;
    await writeFile(
      join(this.output, "status.json"),
      JSON.stringify(
        {
          ...this.stats,
          mediaDialogs: this.dialogs.size,
          at: new Date().toISOString(),
          running: true,
        },
        null,
        2,
      ),
    );
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.registerTimer);
    clearInterval(this.reportTimer);
    const dialogs = [...this.dialogs.values()];
    this.dialogs.clear();
    await Promise.allSettled(
      dialogs.map(async (d) => {
        await d.work;
        await this.media.stopForward(this.sourceStream, d.ssrc);
      }),
    );
    await Promise.allSettled(
      [...this.cameras.values()].map((c) => this.register(c, 0)),
    );
    if (this.media)
      await this.media
        .call("close_streams", {
          vhost: "__defaultVhost__",
          app: "rtp",
          stream: this.sourceStream,
          force: "1",
        })
        .catch(() => {});
    try {
      this.socket.close();
    } catch {}
    this.db.close();
    if (this.output)
      await writeFile(
        join(this.output, "status.json"),
        JSON.stringify({ ...this.stats, running: false }),
      );
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href) {
  const root = resolve(import.meta.dirname, ".."),
    database = join(root, "data/platform.db"),
    output = join(root, ".tmp/simulated-cameras");
  await mkdir(output, { recursive: true });
  const control = join(output, "control.json");
  await writeFile(control, '{"stop":false}');
  const target = join(
    root,
    "backups",
    "simulated-cameras-" + Date.now(),
    "platform.db",
  );
  await mkdir(resolve(target, ".."), { recursive: true });
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(source, target);
  } finally {
    source.close();
  }
  const config = new AccessSettings(
    loadConfig(),
    join(root, "data/access-config.json"),
  ).active;
  const withVideo = process.env.SIMULATED_CAMERA_VIDEO === "1";
  // The native media process runs in data/media/native-runtime. Relative paths
  // avoid its Windows narrow-character file API failing on the Chinese root.
  const simulator = new SimulatedCameras({
    sip: config.sip,
    count: 64,
    database,
    output,
    media: withVideo ? new MediaAdapter(config.media) : null,
    videoPath: withVideo ? "../../../.tmp/simulated-cameras/sample.mp4" : null,
  });
  try {
    await simulator.start();
    console.log(
      JSON.stringify({
        simulated: true,
        devices: 64,
        videoSource: withVideo,
        backup: target,
      }),
    );
  } catch (error) {
    console.error(error.message);
    await simulator.stop();
    process.exit(1);
  }
  const controlTimer = setInterval(async () => {
    try {
      if (JSON.parse(await readFile(control, "utf8")).stop) {
        clearInterval(controlTimer);
        await simulator.stop();
      }
    } catch {}
  }, 1000);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      clearInterval(controlTimer);
      await simulator.stop();
    });
}

import { TcpSipTransport, sendSip, transportOf } from "./transport.mjs";
import { SipRequests, decodeXmlBody } from "./requests.mjs";
import { SipDialogs } from "./dialogs.mjs";
import dgram from "node:dgram";
import { randomUUID, randomBytes, randomInt } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseSip, response, createDigest } from "./protocol.mjs";
const parser = new XMLParser({
  parseTagValue: false,
  ignoreAttributes: false,
  processEntities: false,
});
export class SipGateway {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
    this.state = "disabled";
    this.digest = createDigest(config.domain);
    this.cache = new Map();
    this.pending = new Map();
    this.seq = 1;
    this.requests = new SipRequests(this);
    this.dialogs = new SipDialogs(this);
  }
  async start() {
    if (!this.config.enabled) return;
    const requestedPort = this.config.port;
    // Dynamic dual-protocol listeners need a port available in both namespaces.
    // Windows TCP and UDP exclusions differ, so retry bounded random candidates.
    for (let attempt = 0; attempt < 32; attempt++) {
      this.socket = dgram.createSocket("udp4");
      this.socket.on("message", (buffer, remote) =>
        this.receive(buffer, remote),
      );
      this.tcp = new TcpSipTransport(this);
      try {
        await this.tcp.start(
          this.config.host,
          attempt === 0 ? requestedPort : randomInt(1024, 49152),
        );
        this.config.port = this.tcp.server.address().port;
        await new Promise((resolve, reject) => {
          this.socket.once("error", reject);
          this.socket.bind(this.config.port, this.config.host, () => {
            this.socket.removeListener("error", reject);
            resolve();
          });
        });
        break;
      } catch (error) {
        this.tcp.close();
        try {
          this.socket.close();
        } catch {}
        this.socket = null;
        this.config.port = requestedPort;
        if (
          requestedPort !== 0 ||
          !["EACCES", "EADDRINUSE"].includes(error.code) ||
          attempt === 31
        )
          throw error;
      }
    }
    this.socket.on("error", (e) => {
      this.state = "error";
      console.error("SIP socket:", e.message);
    });
    this.state = "listening";
    this.restoreRegistrations();
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  registrarIdentity() {
    const c = this.config;
    return JSON.stringify([
      c.domain,
      c.serverId,
      c.host,
      c.advertisedHost || c.host,
      c.port,
    ]);
  }
  restoreRegistrations() {
    this.db
      .prepare(
        `UPDATE devices SET status='offline',registeredUntil=NULL,remoteAddress=NULL,remotePort=NULL
      WHERE status IN ('online','offline') AND (registeredUntil IS NULL OR registeredUntil<=? OR remoteAddress IS NULL OR remotePort IS NULL OR sipHa1 IS NULL OR sipTransport<>'UDP'
      OR NOT EXISTS(SELECT 1 FROM sip_registrations r WHERE r.deviceId=devices.id AND r.registrar=?))`,
      )
      .run(Date.now(), this.registrarIdentity());
    this.sweep();
  }
  close() {
    this.tcp?.close();
    this.requests.close();
    this.dialogs.close();
    clearInterval(this.timer);
    for (const sn of [...this.pending.keys()])
      this.finish(sn, "failed", "服务正在关闭");
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.state = "disabled";
  }
  send(buffer, remote, callback = () => {}) {
    if (transportOf(remote) === "TCP") {
      if (this.tcp) return this.tcp.send(buffer, remote, callback);
      return callback(Error("TCP未启动"));
    }
    this.socket?.send(
      buffer,
      remote.remotePort ?? remote.port,
      remote.remoteAddress ?? remote.address,
      callback,
    );
  }
  sweep() {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE devices SET status='offline' WHERE status='online' AND (registeredUntil<? OR lastHeartbeat<?)",
      )
      .run(now, now - this.config.heartbeatTimeout);
    for (const [k, v] of this.cache) if (v.until < now) this.cache.delete(k);
  }
  receive(buffer, remote) {
    let req;
    try {
      req = parseSip(buffer);
    } catch {
      return;
    }
    if (req.status) {
      if (this.requests.handle(req, remote)) return;
      if (this.dialogs.handle(req, remote)) return;
      const task = [...this.pending.values()].find(
        (t) =>
          t.callId === req.headers["call-id"][0] &&
          t.cseq === req.headers.cseq[0] &&
          t.device.remoteAddress === remote.address &&
          t.device.remotePort === remote.port &&
          transportOf(t.device) === transportOf(remote),
      );
      if (task && req.status >= 200) {
        clearTimeout(task.retry);
        if (req.status >= 300)
          this.finish(task.sn, "failed", "设备拒绝目录查询：" + req.status);
      }
      return;
    }
    if (this.onRequest?.(req, remote)) return;
    if (this.dialogs.handleBye(req, remote)) return;
    const key =
      transportOf(remote) +
      ":" +
      remote.address +
      ":" +
      remote.port +
      ":" +
      req.headers["call-id"][0] +
      ":" +
      req.headers.cseq[0] +
      ":" +
      req.headers.via[0];
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      sendSip(this, cached.buffer, remote);
      return;
    }
    const reply = (code, reason, headers = []) => {
      const out = response(req, code, reason, headers);
      if (this.cache.size > 10000)
        this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { buffer: out, until: Date.now() + 32000 });
      sendSip(this, out, remote);
    };
    try {
      const id = req.headers.from[0].match(/sip:(\d{20})@/)?.[1];
      const device = id
        ? this.db.prepare("SELECT * FROM devices WHERE deviceId=?").get(id)
        : null;
      if (!device) {
        reply(403, "Forbidden");
        return;
      }
      if (req.method === "REGISTER") {
        if (!device.sipHa1) {
          reply(403, "Forbidden");
          return;
        }
        if (!this.digest.verify(req, id, device.sipHa1)) {
          reply(401, "Unauthorized", [
            "WWW-Authenticate: " + this.digest.challenge(),
          ]);
          return;
        }
        const expires = Number(
          req.headers.contact?.[0]?.match(/;expires=(\d+)/i)?.[1] ??
            req.headers.expires?.[0] ??
            3600,
        );
        if (!Number.isInteger(expires) || expires < 0 || expires > 86400) {
          reply(400, "Bad Request");
          return;
        }
        const now = Date.now();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db
            .prepare(
              "UPDATE devices SET status=?,remoteAddress=?,remotePort=?,registeredUntil=?,lastHeartbeat=?,sipTransport=? WHERE id=?",
            )
            .run(
              expires ? "online" : "offline",
              remote.address,
              remote.port,
              now + expires * 1000,
              now,
              transportOf(remote),
              device.id,
            );
          if (expires)
            this.db
              .prepare(
                "INSERT INTO sip_registrations VALUES(?,?) ON CONFLICT(deviceId) DO UPDATE SET registrar=excluded.registrar",
              )
              .run(device.id, this.registrarIdentity());
          else
            this.db
              .prepare("DELETE FROM sip_registrations WHERE deviceId=?")
              .run(device.id);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        reply(200, "OK", [
          ...(req.headers.contact?.[0]
            ? ["Contact: " + req.headers.contact[0]]
            : []),
          "Expires: " + expires,
        ]);
        return;
      }
      if (
        device.registeredUntil <= Date.now() ||
        device.remoteAddress !== remote.address ||
        device.remotePort !== remote.port ||
        device.sipTransport !== transportOf(remote)
      ) {
        reply(403, "Forbidden");
        return;
      }
      if (
        device.status !== "online" &&
        (req.method !== "MESSAGE" || device.sipTransport !== "UDP")
      ) {
        reply(403, "Forbidden");
        return;
      }
      if (!["MESSAGE", "NOTIFY"].includes(req.method)) {
        reply(405, "Method Not Allowed", ["Allow: REGISTER, MESSAGE, NOTIFY"]);
        return;
      }
      if (req.method === "NOTIFY" && !req.body.length) {
        if (!this.onDeviceNotify) {
          reply(481, "Subscription Does Not Exist");
          return;
        }
        this.onDeviceNotify(device, req, null);
        reply(200, "OK");
        return;
      }
      if (
        !req.headers["content-type"]?.[0]
          .toLowerCase()
          .includes("application/manscdp+xml")
      ) {
        reply(415, "Unsupported Media Type");
        return;
      }
      const xml = decodeXmlBody(req, parser, XMLValidator);
      if (
        device.status !== "online" &&
        !(xml.Notify?.CmdType === "Keepalive" && xml.Notify.DeviceID === id)
      ) {
        reply(403, "Forbidden");
        return;
      }
      if (req.method === "NOTIFY") {
        if (!this.onDeviceNotify) {
          reply(481, "Subscription Does Not Exist");
          return;
        }
        this.onDeviceNotify(device, req, xml);
        reply(200, "OK");
        return;
      }
      const data = xml.Notify || xml.Response;
      if (this.onDeviceMessage?.(device, xml, req)) {
        reply(200, "OK");
        return;
      }
      if (!data || data.DeviceID !== id) {
        reply(400, "Bad Request");
        return;
      }
      if (data.CmdType === "Keepalive" && xml.Notify) {
        this.db
          .prepare(
            "UPDATE devices SET lastHeartbeat=?,status='online' WHERE id=?",
          )
          .run(Date.now(), device.id);
        reply(200, "OK");
        return;
      }
      if (data.CmdType === "Catalog" && xml.Response) {
        this.catalogResult(device, data);
        reply(200, "OK");
        return;
      }
      reply(400, "Bad Request");
    } catch (e) {
      console.error("SIP handler:", e.message);
      reply(
        [400, 481, 486, 489, 500].includes(e.sipStatus) ? e.sipStatus : 400,
        e.sipStatus === 486 ? "Busy Here" : "Bad Request",
      );
    }
  }
  sync(device) {
    if (this.state !== "listening") throw Error("SIP服务未启用");
    if (device.status !== "online") throw Error("设备未在线");
    if ([...this.pending.values()].some((t) => t.device.id === device.id))
      throw Error("目录同步正在进行");
    const id = randomUUID(),
      sn = String(this.seq++),
      callId = randomUUID(),
      body = `<?xml version="1.0" encoding="UTF-8"?><Query><CmdType>Catalog</CmdType><SN>${sn}</SN><DeviceID>${device.deviceId}</DeviceID></Query>`;
    const text = [
      `MESSAGE sip:${device.deviceId}@${this.config.domain} SIP/2.0`,
      `Via: SIP/2.0/${transportOf(device)} ${this.config.host}:${this.config.port};rport;branch=z9hG4bK${randomBytes(10).toString("hex")}`,
      `From: <sip:${this.config.serverId}@${this.config.domain}>;tag=${randomBytes(8).toString("hex")}`,
      `To: <sip:${device.deviceId}@${this.config.domain}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${this.seq} MESSAGE`,
      "Max-Forwards: 70",
      "Content-Type: Application/MANSCDP+xml",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n");
    this.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)")
      .run(id, device.id, "catalog", "running", new Date().toISOString(), null);
    const task = {
      id,
      device,
      sn,
      callId,
      cseq: this.seq + " MESSAGE",
      items: new Map(),
      total: null,
      timer: setTimeout(() => this.finish(sn, "failed", "目录响应超时"), 20000),
    };
    task.timer.unref();
    this.pending.set(sn, task);
    let delay = 500;
    const send = () => {
      if (!this.pending.has(sn)) return;
      sendSip(this, Buffer.from(text), device, (e) => {
        if (e) this.finish(sn, "failed", "目录请求发送失败");
      });
      if (transportOf(device) === "TCP") return;
      task.retry = setTimeout(() => {
        delay = Math.min(delay * 2, 4000);
        send();
      }, delay);
      task.retry.unref();
    };
    send();
    return id;
  }
  catalogResult(device, data) {
    const task = this.pending.get(String(data.SN));
    if (!task || task.device.id !== device.id) return;
    const total = Number(data.SumNum);
    if (!Number.isInteger(total) || total < 0 || total > 100000)
      throw Error("Invalid catalog count");
    if (task.total !== null && task.total !== total) {
      this.finish(task.sn, "failed", "目录总数不一致");
      return;
    }
    task.total = total;
    const list = data.DeviceList?.Item;
    for (const item of list ? (Array.isArray(list) ? list : [list]) : []) {
      if (typeof item.DeviceID !== "string" || !/^\d{20}$/.test(item.DeviceID))
        throw Error("Invalid channel code");
      task.items.set(item.DeviceID, {
        code: item.DeviceID,
        name: String(item.Name || item.DeviceID).slice(0, 100),
        status: item.Status === "ON" ? "online" : "offline",
      });
    }
    if (task.items.size > total) {
      this.finish(task.sn, "failed", "目录条目超出声明总数");
      return;
    }
    if (task.items.size === total) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM channels WHERE deviceId=?").run(device.id);
        for (const item of task.items.values())
          this.db
            .prepare("INSERT INTO channels VALUES(?,?,?,?,?)")
            .run(
              device.id + ":" + item.code,
              device.id,
              item.code,
              item.name,
              item.status,
            );
        this.db
          .prepare("UPDATE devices SET channels=? WHERE id=?")
          .run(total, device.id);
        this.finish(task.sn, "succeeded");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  finish(sn, status, error = null) {
    const task = this.pending.get(sn);
    if (!task) return;
    clearTimeout(task.timer);
    clearTimeout(task.retry);
    this.db
      .prepare("UPDATE tasks SET status=?,error=? WHERE id=?")
      .run(status, error, task.id);
    this.pending.delete(sn);
  }
}

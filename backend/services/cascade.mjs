import { sendSip, transportOf } from "../sip/transport.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { md5, response } from "../sip/protocol.mjs";
import { decodeXmlBody, xmlEscape, expectSuccess } from "../sip/requests.mjs";
import { recordRange, deviceTime } from "./record-queries.mjs";
const parser = new XMLParser({
  parseTagValue: false,
  ignoreAttributes: false,
  processEntities: false,
});
const publicFields =
  "id,name,serverId,domain,localId,host,port,mediaHost,expires,heartbeat,enabled,status,registeredUntil,lastError,ownerId,sipTransport";
const tag = (value) => value?.match(/;tag=([^;\s]+)/)?.[1];
function packet(req, status, reason, { body = "", toTag, extra = [] } = {}) {
  let head = response(req, status, reason, extra).toString();
  if (toTag)
    head = head.replace(
      /^To: .*$/m,
      "To: " + req.headers.to[0].replace(/;tag=[^;\s]+/, "") + ";tag=" + toTag,
    );
  head = head.replace(
    "Content-Length: 0",
    `${body ? "Content-Type: application/sdp\r\n" : ""}Content-Length: ${Buffer.byteLength(body)}`,
  );
  return Buffer.from(head + body);
}
export class CascadeService {
  constructor({ db, sip, media, live, operations, records, config }) {
    Object.assign(this, { db, sip, media, live, operations, records, config });
    this.calls = new Map();
    this.cache = new Map();
    this.inflight = new Map();
    this.jobs = new Set();
    this.closing = false;
  }
  list() {
    return this.db
      .prepare(`SELECT ${publicFields} FROM cascade_platforms ORDER BY name,id`)
      .all();
  }
  platform(id) {
    const row = this.db
      .prepare("SELECT * FROM cascade_platforms WHERE id=?")
      .get(id);
    if (!row) throw Error("上级平台不存在");
    return row;
  }
  save(value, userId) {
    const old = value.id ? this.platform(value.id) : null;
    if (
      old &&
      this.db
        .prepare(
          "SELECT 1 FROM cascade_calls WHERE platformId=? AND released=0",
        )
        .get(old.id)
    )
      throw Error("级联资源尚未回收，请稍后再修改");
    if (
      old?.status === "online" ||
      [...this.calls.values()].some((c) => c.platform.id === old?.id)
    )
      throw Error("请先注销并结束级联会话再修改平台");
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 100 ||
      typeof value.serverId !== "string" ||
      typeof value.localId !== "string" ||
      typeof value.domain !== "string" ||
      !/^\d{20}$/.test(value.serverId) ||
      !/^\d{20}$/.test(value.localId) ||
      !/^\d{10}$/.test(value.domain) ||
      !isIPv4(value.host) ||
      !isIPv4(value.mediaHost || value.host) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535
    )
      throw Error("平台名称、国标编号、域、IPv4地址或端口无效");
    if (value.localId === value.serverId)
      throw Error("本级编号与上级编号不能相同");
    if (!["UDP", "TCP"].includes(value.sipTransport || "UDP"))
      throw Error("信令传输方式无效");
    const expires = value.expires ?? 3600,
      heartbeat = value.heartbeat ?? 60;
    if (
      !Number.isInteger(expires) ||
      expires < 60 ||
      expires > 86400 ||
      !Number.isInteger(heartbeat) ||
      heartbeat < 10 ||
      heartbeat > 300
    )
      throw Error("注册周期须为60至86400秒，心跳周期须为10至300秒");
    let ha1 = old?.ha1;
    if (value.password !== undefined && value.password !== "") {
      if (
        typeof value.password !== "string" ||
        value.password.length < 8 ||
        value.password.length > 128
      )
        throw Error("级联密码须为8至128位");
      ha1 = md5(`${value.localId}:${value.domain}:${value.password}`);
    } else if (
      !old ||
      old.localId !== value.localId ||
      old.domain !== value.domain
    )
      throw Error("请设置与上级平台一致的注册密码");
    const id = old?.id || randomUUID();
    this.db
      .prepare(
        "INSERT INTO cascade_platforms(id,name,serverId,domain,localId,host,port,mediaHost,expires,heartbeat,ha1,ownerId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,serverId=excluded.serverId,domain=excluded.domain,localId=excluded.localId,host=excluded.host,port=excluded.port,mediaHost=excluded.mediaHost,expires=excluded.expires,heartbeat=excluded.heartbeat,ha1=excluded.ha1",
      )
      .run(
        id,
        value.name.trim(),
        value.serverId,
        value.domain,
        value.localId,
        value.host,
        value.port,
        value.mediaHost || value.host,
        expires,
        heartbeat,
        ha1,
        old?.ownerId || userId,
      );
    this.db
      .prepare("UPDATE cascade_platforms SET sipTransport=? WHERE id=?")
      .run(value.sipTransport || "UDP", id);
    return this.list().find((p) => p.id === id);
  }
  channels(id) {
    this.platform(id);
    return this.db
      .prepare(
        "SELECT a.channelId,a.alias,c.name,c.channelCode,c.status,d.status AS deviceStatus,d.name AS deviceName FROM cascade_channels a LEFT JOIN channels c ON a.channelId=c.id LEFT JOIN devices d ON c.deviceId=d.id WHERE a.platformId=? ORDER BY a.alias",
      )
      .all(id);
  }
  assign(id, items) {
    this.platform(id);
    if (!Array.isArray(items) || items.length > 5000)
      throw Error("共享通道列表须不超过5000条");
    if ([...this.calls.values()].some((c) => c.platform.id === id))
      throw Error("存在级联会话，暂不能修改共享通道");
    const aliases = new Set(),
      ids = new Set();
    for (const item of items) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.channelId !== "string" ||
        typeof item.alias !== "string" ||
        !/^\d{20}$/.test(item.alias) ||
        item.alias === this.platform(id).localId ||
        item.alias === this.platform(id).serverId ||
        aliases.has(item.alias) ||
        ids.has(item.channelId) ||
        !this.db
          .prepare("SELECT 1 FROM channels WHERE id=?")
          .get(item.channelId)
      )
        throw Error("共享通道不存在、编号无效或有重复");
      aliases.add(item.alias);
      ids.add(item.channelId);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM cascade_channels WHERE platformId=?")
        .run(id);
      for (const item of items)
        this.db
          .prepare("INSERT INTO cascade_channels VALUES(?,?,?)")
          .run(id, item.channelId, item.alias);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async registration(p, expires) {
    const callId = randomUUID(),
      from = `<sip:${p.localId}@${p.domain}>;tag=${randomBytes(8).toString("hex")}`,
      uri = `sip:${p.serverId}@${p.domain}`,
      remote = {
        remoteAddress: p.host,
        remotePort: p.port,
        sipTransport: p.sipTransport,
      };
    const request = (headers) =>
      this.sip.requests.request({
        method: "REGISTER",
        uri,
        from,
        to: `<sip:${p.localId}@${p.domain}>`,
        remote,
        callId,
        headers: [
          `Expires: ${expires}`,
          `Contact: <sip:${p.localId}@${this.config.sip.advertisedHost || this.config.sip.host}:${this.config.sip.port}>`,
          ...headers,
        ],
      });
    let result = await request([]);
    if (result.status === 401) {
      const challenge = result.headers["www-authenticate"]?.[0] || "",
        parts = {};
      for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
        parts[m[1]] = m[2] ?? m[3];
      if (
        !challenge.startsWith("Digest ") ||
        parts.realm !== p.domain ||
        !parts.nonce ||
        /[\r\n"]/.test(parts.nonce) ||
        (parts.algorithm && parts.algorithm.toUpperCase() !== "MD5") ||
        (parts.qop &&
          !parts.qop
            .split(",")
            .map((s) => s.trim())
            .includes("auth"))
      )
        throw Error("上级认证域或Digest算法不匹配");
      const nc = "00000001",
        cnonce = randomBytes(12).toString("hex"),
        auth = md5(
          parts.qop
            ? `${p.ha1}:${parts.nonce}:${nc}:${cnonce}:auth:${md5("REGISTER:" + uri)}`
            : `${p.ha1}:${parts.nonce}:${md5("REGISTER:" + uri)}`,
        );
      result = await request([
        `Authorization: Digest username="${p.localId}", realm="${p.domain}", nonce="${parts.nonce}", uri="${uri}", response="${auth}"${parts.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ""}${parts.opaque ? `, opaque="${parts.opaque.replace(/["\r\n]/g, "")}"` : ""}`,
      ]);
    }
    if (result.status < 200 || result.status >= 300)
      throw Error("上级平台拒绝注册：" + result.status);
    const accepted = Number(result.headers.expires?.[0] ?? expires);
    if (!Number.isInteger(accepted) || accepted < 0 || accepted > 86400)
      throw Error("上级返回注册周期无效");
    return accepted;
  }
  async register(id) {
    if (this.closing) throw Error("服务正在关闭");
    if (this.inflight.has(id)) throw Error("平台信令操作正在进行");
    const p = this.platform(id);
    this.inflight.set(id, true);
    try {
      const expires = await this.registration(p, p.expires);
      if (!expires) throw Error("上级返回无效注册有效期");
      this.db
        .prepare(
          "UPDATE cascade_platforms SET enabled=1,status='online',registeredUntil=?,nextRegister=?,nextHeartbeat=?,lastError=NULL WHERE id=?",
        )
        .run(
          Date.now() + expires * 1000,
          Date.now() + Math.max(10000, expires * 800),
          Date.now() + p.heartbeat * 1000,
          id,
        );
      return this.list().find((p) => p.id === id);
    } catch (error) {
      this.db
        .prepare(
          "UPDATE cascade_platforms SET status='offline',registeredUntil=0,nextRegister=?,lastError=? WHERE id=?",
        )
        .run(Date.now() + 30000, error.message, id);
      throw error;
    } finally {
      this.inflight.delete(id);
    }
  }
  async unregister(id) {
    const p = this.platform(id);
    if (this.inflight.has(id)) throw Error("平台信令操作正在进行");
    this.db
      .prepare(
        "UPDATE cascade_platforms SET enabled=0,status='offline',registeredUntil=0 WHERE id=?",
      )
      .run(id);
    await this.stopPlatform(id);
    try {
      if (p.enabled && this.sip.state === "listening")
        await this.registration(p, 0);
    } finally {
      if (p.sipTransport === "TCP") this.sip.tcp?.disconnect(p.host, p.port);
    }
  }
  async remove(id) {
    this.platform(id);
    await this.unregister(id);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM cascade_calls WHERE platformId=? AND released=0",
        )
        .get(id)
    )
      throw Error("级联资源尚未回收，不能删除");
    this.db.prepare("DELETE FROM cascade_platforms WHERE id=?").run(id);
  }
  start() {
    if (this.timer) return;
    this.db
      .prepare(
        "UPDATE cascade_platforms SET status='offline',registeredUntil=0,nextRegister=0 WHERE enabled=1",
      )
      .run();
    this.timer = setInterval(() => {
      const work = this.tick().catch(() => {});
      this.track(work);
    }, 1000);
    this.timer.unref();
  }
  track(work) {
    this.jobs.add(work);
    work.finally(() => this.jobs.delete(work)).catch(() => {});
  }
  async tick() {
    if (this.ticking || this.closing || this.sip.state !== "listening") return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const p of this.db
        .prepare("SELECT * FROM cascade_platforms WHERE enabled=1")
        .all()) {
        if (this.inflight.has(p.id)) continue;
        if (
          p.nextRegister <= now ||
          (p.status === "online" && p.registeredUntil <= now)
        ) {
          await this.register(p.id).catch(() => {});
          continue;
        }
        if (p.status !== "online") continue;
        if (p.nextHeartbeat <= now) {
          this.inflight.set(p.id, true);
          try {
            await this.message(
              p,
              `<Notify><CmdType>Keepalive</CmdType><SN>${++this.sip.seq}</SN><DeviceID>${p.localId}</DeviceID><Status>OK</Status></Notify>`,
            );
            this.db
              .prepare(
                "UPDATE cascade_platforms SET nextHeartbeat=? WHERE id=?",
              )
              .run(now + p.heartbeat * 1000, p.id);
          } catch (error) {
            this.db
              .prepare(
                "UPDATE cascade_platforms SET status='offline',registeredUntil=0,nextRegister=?,lastError=? WHERE id=?",
              )
              .run(now + 30000, error.message, p.id);
            await this.stopPlatform(p.id);
          } finally {
            this.inflight.delete(p.id);
          }
        }
      }
      for (const call of [...this.calls.values()]) {
        if (call.cancelled) continue;
        const p = this.db
          .prepare("SELECT * FROM cascade_platforms WHERE id=?")
          .get(call.platform.id);
        if (!p?.enabled || p.status !== "online" || p.registeredUntil <= now) {
          await this.stopCall(call);
          continue;
        }
        if (call.viewer)
          try {
            if (
              call.state === "streaming" &&
              this.media.senders &&
              now - (call.lastSenderCheck || 0) > 10000
            ) {
              call.lastSenderCheck = now;
              if (
                !(await this.media.senders(call.streamId)).includes(
                  String(call.ssrc),
                )
              )
                throw Error("媒体转发已结束");
            }
            this.live.renew(
              call.viewer.sessionId,
              p.ownerId,
              call.viewer.viewerId,
            );
          } catch {
            if (
              call.playback &&
              !call.completionNotified &&
              this.db
                .prepare("SELECT state FROM live_sessions WHERE id=?")
                .get(call.viewer.sessionId)?.state === "completed"
            ) {
              call.completionNotified = true;
              await this.sip.requests
                .request({
                  uri: `sip:${p.serverId}@${p.domain}`,
                  from: `<sip:${p.localId}@${p.domain}>;tag=${randomBytes(8).toString("hex")}`,
                  remote: {
                    remoteAddress: p.host,
                    remotePort: p.port,
                    sipTransport: p.sipTransport,
                  },
                  callId: call.req.headers["call-id"][0],
                  body: `<Notify><CmdType>MediaStatus</CmdType><SN>${++this.sip.seq}</SN><DeviceID>${call.alias}</DeviceID><NotifyType>121</NotifyType></Notify>`,
                })
                .catch(() => {});
            }
            await this.stopCall(call);
          }
      }
      for (const row of this.db
        .prepare("SELECT * FROM cascade_calls WHERE released=0")
        .all()) {
        if (this.calls.has(row.id)) continue;
        try {
          const p = this.db
            .prepare("SELECT ownerId FROM cascade_platforms WHERE id=?")
            .get(row.platformId);
          const results = await Promise.allSettled([
            ...(row.dialog ? [this.endUpstream(JSON.parse(row.dialog))] : []),
            ...(row.streamId && row.ssrc
              ? [this.media.stopForward(row.streamId, row.ssrc)]
              : []),
            ...(row.viewerId && p
              ? [this.live.leave(row.sessionId, p.ownerId, row.viewerId)]
              : []),
          ]);
          if (results.some((r) => r.status === "rejected"))
            throw Error("回收失败");
          this.db
            .prepare("UPDATE cascade_calls SET released=1 WHERE id=?")
            .run(row.id);
        } catch {}
      }
      for (const [key, item] of this.cache)
        if (item.until < now) this.cache.delete(key);
    } finally {
      this.ticking = false;
    }
  }
  async message(p, body, method = "MESSAGE", headers = []) {
    return expectSuccess(
      this.sip.requests.request({
        method,
        uri: `sip:${p.serverId}@${p.domain}`,
        from: `<sip:${p.localId}@${p.domain}>;tag=${randomBytes(8).toString("hex")}`,
        remote: {
          remoteAddress: p.host,
          remotePort: p.port,
          sipTransport: p.sipTransport,
        },
        body,
        headers,
      }),
    );
  }
  send(buffer, remote) {
    sendSip(this.sip, buffer, remote, () => {});
  }
  handle(req, remote) {
    const p = this.db
      .prepare("SELECT * FROM cascade_platforms WHERE host=? AND port=?")
      .get(remote.address, remote.port);
    if (!p || transportOf(p) !== transportOf(remote)) return false;
    const key =
      p.id +
      ":" +
      req.headers["call-id"][0] +
      ":" +
      req.headers.cseq[0] +
      ":" +
      req.headers.via[0];
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      this.send(cached.buffer, remote);
      return true;
    }
    const existing = this.calls.get(p.id + ":" + req.headers["call-id"][0]);
    if (existing && ["ACK", "BYE", "CANCEL", "INFO"].includes(req.method)) {
      this.handleDialog(existing, req, remote);
      return true;
    }
    if (req.method === "ACK") return true;
    const sender = req.headers.from[0].match(/sip:(\d{20})@/)?.[1];
    if (sender !== p.serverId) return false;
    if (
      transportOf(p) !== transportOf(remote) ||
      !p.enabled ||
      p.status !== "online" ||
      p.registeredUntil <= Date.now()
    ) {
      this.send(packet(req, 403, "Forbidden"), remote);
      return true;
    }
    const reply = (status, reason, options = {}) => {
      const buffer = packet(req, status, reason, options);
      if (this.cache.size >= 10000)
        this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { buffer, until: Date.now() + 64000 });
      this.send(buffer, remote);
      return buffer;
    };
    if (req.method === "INVITE") {
      this.invite(p, req, remote, reply, key);
      return true;
    }
    if (req.method !== "MESSAGE") {
      reply(405, "Method Not Allowed");
      return true;
    }
    if (this.jobs.size >= 64) {
      reply(503, "Service Unavailable");
      return true;
    }
    if (
      !req.headers["content-type"]?.[0]?.toLowerCase().includes("manscdp+xml")
    ) {
      reply(415, "Unsupported Media Type");
      return true;
    }
    try {
      const xml = decodeXmlBody(req, parser, XMLValidator),
        data = xml.Query || xml.Control;
      if (!data || !/^\d{1,10}$/.test(String(data.SN)))
        throw Error("查询格式错误");
      const assignment = this.db
        .prepare(
          "SELECT c.*,d.status AS deviceStatus FROM cascade_channels a JOIN channels c ON a.channelId=c.id JOIN devices d ON c.deviceId=d.id WHERE a.platformId=? AND a.alias=?",
        )
        .get(p.id, data.DeviceID);
      if (data.DeviceID !== p.localId && !assignment) {
        reply(403, "Forbidden");
        return true;
      }
      if (xml.Query && data.CmdType === "Catalog") {
        reply(200, "OK");
        const work = this.catalog(p, data.SN, data.DeviceID).catch((e) =>
          this.note(p.id, e),
        );
        this.track(work);
        return true;
      }
      if (xml.Query && ["DeviceInfo", "DeviceStatus"].includes(data.CmdType)) {
        reply(200, "OK");
        const body = `<Response><CmdType>${data.CmdType}</CmdType><SN>${data.SN}</SN><DeviceID>${xmlEscape(data.DeviceID)}</DeviceID><Result>OK</Result>${data.CmdType === "DeviceInfo" ? `<DeviceName>${xmlEscape(assignment?.name || "雷铄御警")}</DeviceName><Manufacturer>Ls-Aegis</Manufacturer><Model>GB28181</Model><Firmware>0.4</Firmware><Channel>${assignment ? 1 : this.channels(p.id).filter((c) => c.channelCode).length}</Channel>` : `<Online>${!assignment || (assignment.status === "online" && assignment.deviceStatus === "online") ? "ONLINE" : "OFFLINE"}</Online><Status>OK</Status><DeviceTime>${deviceTime(new Date().toISOString())}</DeviceTime>`}</Response>`;
        this.track(this.message(p, body).catch((e) => this.note(p.id, e)));
        return true;
      }
      if (xml.Query && data.CmdType === "RecordInfo" && assignment) {
        const task = this.records.create(assignment.id, p.ownerId, {
          start: data.StartTime,
          end: data.EndTime,
        });
        reply(200, "OK");
        this.track(
          this.relayRecords(p, data, task.taskId).catch((e) =>
            this.note(p.id, e),
          ),
        );
        return true;
      }
      if (xml.Control && data.CmdType === "DeviceControl" && assignment) {
        const cmd = String(data.PTZCmd || "");
        if (!/^[A-Fa-f0-9]{16}$/.test(cmd)) throw Error("云台指令格式无效");
        const bytes = Buffer.from(cmd, "hex");
        if (
          bytes[0] !== 0xa5 ||
          bytes[1] !== 0x0f ||
          bytes[2] !== 1 ||
          bytes.subarray(0, 7).reduce((a, b) => a + b, 0) % 256 !== bytes[7]
        )
          throw Error("云台校验码错误");
        const actions = {
          0: "stop",
          1: "right",
          2: "left",
          4: "down",
          8: "up",
          9: "upRight",
          10: "upLeft",
          5: "downRight",
          6: "downLeft",
          16: "zoomIn",
          32: "zoomOut",
        };
        if (!Object.hasOwn(actions, bytes[3])) {
          reply(501, "Not Implemented");
          return true;
        }
        this.operations.ptz(assignment.id, "cascade:" + p.id, {
          action: actions[bytes[3]],
          speed: Math.max(
            1,
            bytes[4],
            bytes[5],
            Math.round(bytes[6] / 16) * 17,
          ),
          duration: 2000,
        });
        reply(200, "OK");
        return true;
      }
      reply(501, "Not Implemented");
    } catch {
      reply(400, "Bad Request");
    }
    return true;
  }
  note(id, error) {
    if (!this.closing)
      this.db
        .prepare("UPDATE cascade_platforms SET lastError=? WHERE id=?")
        .run(error.message, id);
  }
  async catalog(p, sn, deviceId) {
    const all = this.channels(p.id)
      .filter((c) => c.channelCode)
      .filter((c) => deviceId === p.localId || c.alias === deviceId);
    const batches = all.length
      ? Array.from({ length: Math.ceil(all.length / 10) }, (_, i) =>
          all.slice(i * 10, i * 10 + 10),
        )
      : [[]];
    for (const items of batches) {
      const body = `<Response><CmdType>Catalog</CmdType><SN>${xmlEscape(sn)}</SN><DeviceID>${deviceId}</DeviceID><SumNum>${all.length}</SumNum><DeviceList Num="${items.length}">${items.map((c) => `<Item><DeviceID>${c.alias}</DeviceID><Name>${xmlEscape(c.name || c.alias)}</Name><Manufacturer>Ls-Aegis</Manufacturer><Owner>Ls-Aegis</Owner><CivilCode>${c.alias.slice(0, 6)}</CivilCode><Parental>0</Parental><ParentID>${p.localId}</ParentID><RegisterWay>1</RegisterWay><Secrecy>0</Secrecy><Status>${c.status === "online" && c.deviceStatus === "online" ? "ON" : "OFF"}</Status></Item>`).join("")}</DeviceList></Response>`;
      await this.message(p, body);
    }
  }
  async relayRecords(p, query, id) {
    for (let n = 0; n < 45 && !this.closing; n++) {
      const task = this.records.get(id, p.ownerId);
      if (task.status === "failed") throw Error(task.error || "录像查询失败");
      if (task.status === "succeeded") {
        const all = task.items,
          batches = all.length
            ? Array.from({ length: Math.ceil(all.length / 5) }, (_, i) =>
                all.slice(i * 5, i * 5 + 5),
              )
            : [[]];
        for (const items of batches)
          await this.message(
            p,
            `<Response><CmdType>RecordInfo</CmdType><SN>${query.SN}</SN><DeviceID>${query.DeviceID}</DeviceID><Name>Record</Name><SumNum>${all.length}</SumNum><RecordList Num="${items.length}">${items.map((r) => `<Item><DeviceID>${query.DeviceID}</DeviceID><Name>${xmlEscape(r.name)}</Name><FilePath>${xmlEscape(r.filePath)}</FilePath><Address></Address><StartTime>${deviceTime(r.start)}</StartTime><EndTime>${deviceTime(r.end)}</EndTime><Secrecy>0</Secrecy><Type>${xmlEscape(r.type)}</Type></Item>`).join("")}</RecordList></Response>`,
          );
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("录像查询转发超时");
  }
  invite(p, req, remote, reply, key) {
    const alias = req.uri.match(/^sip:(\d{20})@/)?.[1],
      channel = this.db
        .prepare(
          "SELECT c.* FROM cascade_channels a JOIN channels c ON a.channelId=c.id WHERE a.platformId=? AND a.alias=?",
        )
        .get(p.id, alias);
    if (!channel) {
      reply(403, "Forbidden");
      return;
    }
    try {
      if (
        !req.headers["content-type"]?.[0]
          ?.toLowerCase()
          .includes("application/sdp")
      )
        throw Error("SDP类型无效");
      const text = req.body.toString("utf8"),
        mode = text.match(/^s=(.+)\r?$/m)?.[1],
        host = text.match(/^c=IN IP4 ([\d.]+)\r?$/m)?.[1],
        media = text.match(/^m=video (\d+) (\S+) (.+)\r?$/m),
        ssrc = text.match(/^y=(\d{10})\r?$/m)?.[1];
      if (
        !["Play", "Playback"].includes(mode) ||
        host !== p.mediaHost ||
        !media ||
        !["RTP/AVP", "TCP/RTP/AVP"].includes(media[2]) ||
        (media[2] === "TCP/RTP/AVP" &&
          !/^a=setup:(active|passive)\r?$/m.test(text)) ||
        !media[3].trim().split(/\s+/).includes("96") ||
        !/^a=rtpmap:96 PS\/90000\r?$/m.test(text) ||
        !ssrc ||
        (Number(media[1]) < 1024 &&
          !(
            media[2] === "TCP/RTP/AVP" &&
            /^a=setup:active\r?$/m.test(text) &&
            Number(media[1]) === 9
          )) ||
        Number(media[1]) > 65535
      )
        throw Error("不支持的SDP");
      let playback = null;
      if (mode === "Playback") {
        const times = text.match(/^t=(\d+) (\d+)\r?$/m);
        if (!times) throw Error("缺少回放时间");
        playback = recordRange(
          new Date(Number(times[1]) * 1000).toISOString(),
          new Date(Number(times[2]) * 1000).toISOString(),
        );
      }
      const id = p.id + ":" + req.headers["call-id"][0];
      if (this.calls.has(id)) {
        reply(482, "Loop Detected");
        return;
      }
      const call = {
        id,
        platform: p,
        req,
        remote,
        channel,
        alias,
        ssrc,
        host,
        port: Number(media[1]),
        tcp: media[2] === "TCP/RTP/AVP",
        passive:
          media[2] === "TCP/RTP/AVP" && /^a=setup:active\r?$/m.test(text),
        playback,
        tag: randomBytes(12).toString("hex"),
        state: "preparing",
        preparing: true,
        reply,
        key,
      };
      if (this.db.prepare("SELECT 1 FROM cascade_calls WHERE id=?").get(id)) {
        reply(482, "Loop Detected");
        return;
      }
      this.db
        .prepare(
          "INSERT INTO cascade_calls(id,platformId,callId,state,ssrc,createdAt) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          p.id,
          req.headers["call-id"][0],
          "preparing",
          ssrc,
          new Date().toISOString(),
        );
      this.calls.set(id, call);
      reply(100, "Trying");
      call.work = this.prepare(call).catch((e) => this.note(p.id, e));
      this.track(call.work);
    } catch {
      reply(488, "Not Acceptable Here");
    }
  }
  async prepare(call) {
    try {
      call.viewer = this.live.create(
        call.channel,
        call.platform.ownerId,
        undefined,
        call.playback,
      );
      this.db
        .prepare("UPDATE cascade_calls SET sessionId=?,viewerId=? WHERE id=?")
        .run(call.viewer.sessionId, call.viewer.viewerId, call.id);
      const deadline = Date.now() + 25000;
      let ready = false;
      while (!call.cancelled && Date.now() < deadline) {
        const state = this.live.snapshot(
          call.viewer.sessionId,
          call.platform.ownerId,
          call.viewer.viewerId,
        );
        if (state.state === "ready") {
          ready = true;
          break;
        }
        if (["failed", "stopped", "completed"].includes(state.state))
          throw Error(state.error || "下级点播失败");
        await new Promise((r) => setTimeout(r, 200));
      }
      if (call.cancelled) return;
      if (!ready) throw Error("级联点播准备超时");
      const sourceStreamId = this.db
        .prepare("SELECT streamId FROM live_sessions WHERE id=?")
        .get(call.viewer.sessionId).streamId;
      if (
        [...this.calls.values()].some(
          (c) =>
            c !== call &&
            c.streamId === sourceStreamId &&
            c.ssrc === call.ssrc &&
            !c.cancelled,
        )
      )
        throw Error("相同源流SSRC已被占用");
      call.streamId = sourceStreamId;
      this.db
        .prepare("UPDATE cascade_calls SET streamId=? WHERE id=?")
        .run(call.streamId, call.id);
      const result = await this.media.startForward(
        call.streamId,
        call.ssrc,
        call.host,
        call.port,
        call.passive ? "passive" : call.tcp,
      );
      if (call.cancelled) return;
      call.endRequest = {
        method: "BYE",
        uri:
          call.req.headers.contact?.[0]?.match(/<?(sip:[^\s>]+)>?/i)?.[1] ||
          `sip:${call.platform.serverId}@${call.platform.domain}`,
        from:
          call.req.headers.to[0].replace(/;tag=[^;\s]+/, "") +
          ";tag=" +
          call.tag,
        to: call.req.headers.from[0],
        remote: {
          sipTransport: call.platform.sipTransport,
          remoteAddress: call.platform.host,
          remotePort: call.platform.port,
        },
        callId: call.req.headers["call-id"][0],
        cseq: 1,
      };
      this.db
        .prepare("UPDATE cascade_calls SET dialog=? WHERE id=?")
        .run(JSON.stringify(call.endRequest), call.id);
      call.state = "awaiting_ack";
      this.db
        .prepare("UPDATE cascade_calls SET state='awaiting_ack' WHERE id=?")
        .run(call.id);
      const body = [
        "v=0",
        `o=${call.platform.localId} 0 0 IN IP4 ${this.config.media.rtpHost}`,
        call.playback ? "s=Playback" : "s=Play",
        `c=IN IP4 ${this.config.media.rtpHost}`,
        "t=0 0",
        `m=video ${result.local_port} ${call.tcp ? "TCP/RTP/AVP" : "RTP/AVP"} 96`,
        ...(call.tcp
          ? [
              `a=setup:${call.passive ? "passive" : "active"}`,
              "a=connection:new",
            ]
          : []),
        "a=sendonly",
        "a=rtpmap:96 PS/90000",
        `y=${call.ssrc}`,
        "",
      ].join("\r\n");
      call.answer = call.reply(200, "OK", {
        body,
        toTag: call.tag,
        extra: [
          `Contact: <sip:${call.platform.localId}@${this.config.sip.advertisedHost || this.config.sip.host}:${this.config.sip.port}>`,
        ],
      });
      let delay = 500;
      const resend = () => {
        if (call.state !== "awaiting_ack") return;
        this.send(call.answer, call.remote);
        call.retry = setTimeout(() => {
          delay = Math.min(delay * 2, 4000);
          resend();
        }, delay);
        call.retry.unref();
      };
      call.retry = setTimeout(resend, delay);
      call.retry.unref();
      call.deadline = setTimeout(() => {
        this.track(this.stopCall(call));
      }, 32000);
      call.deadline.unref();
    } catch (error) {
      if (!call.cancelled) {
        call.reply(480, "Temporarily Unavailable", { toTag: call.tag });
        this.note(call.platform.id, error);
      }
      call.cancelled = true;
    } finally {
      call.preparing = false;
      if (call.cancelled) await this.cleanup(call);
    }
  }
  handleDialog(call, req, remote) {
    const respond = (status, reason) => {
      const buffer = packet(req, status, reason, { toTag: call.tag });
      this.cache.set(
        call.platform.id +
          ":" +
          req.headers["call-id"][0] +
          ":" +
          req.headers.cseq[0] +
          ":" +
          req.headers.via[0],
        { buffer, until: Date.now() + 64000 },
      );
      this.send(buffer, remote);
    };
    const valid = tag(req.headers.from[0]) === tag(call.req.headers.from[0]);
    if (!valid) {
      this.send(packet(req, 481, "Call/Transaction Does Not Exist"), remote);
      return;
    }
    if (req.method === "CANCEL") {
      const cseq = req.headers.cseq[0].split(" ")[0],
        original = call.req.headers.cseq[0].split(" ")[0];
      if (
        call.state !== "preparing" ||
        cseq !== original ||
        req.headers.via[0] !== call.req.headers.via[0]
      ) {
        this.send(packet(req, 481, "Call/Transaction Does Not Exist"), remote);
        return;
      }
      respond(200, "OK");
      call.reply(487, "Request Terminated", { toTag: call.tag });
      this.track(this.stopCall(call));
      return;
    }
    if (tag(req.headers.to[0]) !== call.tag) {
      if (req.method !== "ACK")
        this.send(packet(req, 481, "Call/Transaction Does Not Exist"), remote);
      return;
    }
    if (req.method === "ACK") {
      if (
        req.headers.cseq[0].split(/\s+/)[0] !==
        call.req.headers.cseq[0].split(/\s+/)[0]
      )
        return;
      if (call.state === "awaiting_ack") {
        clearTimeout(call.retry);
        clearTimeout(call.deadline);
        call.state = "streaming";
        this.db
          .prepare("UPDATE cascade_calls SET state='streaming' WHERE id=?")
          .run(call.id);
      }
      return;
    }
    const requestSeq = Number(req.headers.cseq[0].split(/\s+/)[0]);
    if (
      !Number.isSafeInteger(requestSeq) ||
      requestSeq <=
        (call.remoteSeq || Number(call.req.headers.cseq[0].split(/\s+/)[0]))
    ) {
      respond(500, "Server Internal Error");
      return;
    }
    call.remoteSeq = requestSeq;
    if (req.method === "BYE") {
      call.remoteEnded = true;
      this.db
        .prepare("UPDATE cascade_calls SET dialog=NULL WHERE id=?")
        .run(call.id);
      respond(200, "OK");
      this.track(this.stopCall(call));
      return;
    }
    if (req.method === "INFO" && call.playback && call.viewer) {
      const text = req.body.toString("utf8"),
        action = text.startsWith("PAUSE ")
          ? "pause"
          : text.startsWith("PLAY ")
            ? /Scale:/i.test(text)
              ? "speed"
              : /Range: npt=\d/i.test(text)
                ? "seek"
                : "resume"
            : null;
      if (!action) {
        this.send(packet(req, 400, "Bad Request"), remote);
        return;
      }
      const operation = {
        action,
        scale: Number(text.match(/Scale:\s*([\d.]+)/i)?.[1]),
        position: Number(text.match(/Range: npt=([\d.]+)/i)?.[1]),
      };
      respond(100, "Trying");
      this.track(
        this.live
          .control(
            call.viewer.sessionId,
            call.platform.ownerId,
            call.viewer.viewerId,
            operation,
          )
          .then(() => respond(200, "OK"))
          .catch(() => respond(500, "Server Internal Error")),
      );
      return;
    }
    this.send(packet(req, 405, "Method Not Allowed"), remote);
  }
  async stopCall(call) {
    call.cancelled = true;
    clearTimeout(call.retry);
    clearTimeout(call.deadline);
    if (call.preparing) {
      if (call.viewer)
        await this.live
          .leave(
            call.viewer.sessionId,
            call.platform.ownerId,
            call.viewer.viewerId,
          )
          .catch(() => {});
      return;
    }
    await this.cleanup(call);
  }
  async endUpstream(spec) {
    if (!spec) return;
    const result = await this.sip.requests.request(spec);
    if (result.status !== 481 && (result.status < 200 || result.status >= 300))
      throw Error("上级未确认结束会话：" + result.status);
  }
  async cleanup(call) {
    if (call.cleaning) return call.cleaning;
    call.cleaning = (async () => {
      try {
        const results = await Promise.allSettled([
          ...(!call.remoteEnded && call.endRequest
            ? [this.endUpstream(call.endRequest)]
            : []),
          ...(call.streamId
            ? [this.media.stopForward(call.streamId, call.ssrc)]
            : []),
          ...(call.viewer
            ? [
                this.live.leave(
                  call.viewer.sessionId,
                  call.platform.ownerId,
                  call.viewer.viewerId,
                ),
              ]
            : []),
        ]);
        if (results.some((r) => r.status === "rejected"))
          throw Error("回收失败");
        this.db
          .prepare(
            "UPDATE cascade_calls SET state='stopped',released=1 WHERE id=?",
          )
          .run(call.id);
        this.calls.delete(call.id);
      } catch {
        this.db
          .prepare(
            "UPDATE cascade_calls SET state='failed',error='级联资源回收失败',released=0 WHERE id=?",
          )
          .run(call.id);
        this.calls.delete(call.id);
      } finally {
        call.cleaning = null;
      }
    })();
    return call.cleaning;
  }
  async stopPlatform(id) {
    for (const call of [...this.calls.values()])
      if (call.platform.id === id) await this.stopCall(call);
    await this.operations.stopUser("cascade:" + id);
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const call of [...this.calls.values()]) await this.stopCall(call);
    await Promise.all(this.jobs);
  }
}

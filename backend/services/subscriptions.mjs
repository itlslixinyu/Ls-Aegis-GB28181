import { randomUUID, randomBytes } from "node:crypto";
import { xmlEscape, decodeXmlBody } from "../sip/requests.mjs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AlarmGuard } from "./alarm-guard.mjs";
const tag = (h) => h?.match(/(?:^|;)\s*tag=([^;\s>]+)/i)?.[1];
const issue = (text, code = 481) =>
  Object.assign(Error(text), { sipStatus: code });
const publicFields =
  "s.id,s.deviceId,s.kind,s.enabled,s.expires,s.interval,s.status,s.error,s.acceptedAt,s.expiresAt,s.lastNotifyAt,s.nextAttempt,s.failures,s.updatedAt,d.name AS deviceName,d.deviceId AS deviceCode,d.status AS deviceStatus,d.groupId,g.name AS groupName";
export class Subscriptions {
  constructor({
    db,
    sip,
    access,
    events,
    timeout = 8000,
    notifyTimeout = 32000,
    autoStart = true,
  }) {
    Object.assign(this, { db, sip, access, events, timeout, notifyTimeout });
    this.dialogs = new Map();
    this.jobs = new Map();
    this.closed = false;
    this.guard = new AlarmGuard({ db, sip, access });
    db.prepare(
      "UPDATE device_subscriptions SET status=CASE WHEN enabled=1 THEN 'waiting' ELSE 'disabled' END,error=NULL,expiresAt=NULL,nextAttempt=0",
    ).run();
    if (autoStart) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref();
    }
  }
  list(userId, params = new URLSearchParams()) {
    const page = Number(params.get("page") || 1),
      pageSize = Number(params.get("pageSize") || 20),
      kind = params.get("kind") || "",
      q = params.get("q") || "",
      group = params.get("groupId") || "";
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !["", "Alarm", "MobilePosition"].includes(kind) ||
      q.length > 100
    )
      throw Error("订阅筛选参数无效");
    const where =
        this.access.sql(userId, "s.deviceId") +
        " AND (?='' OR s.kind=?) AND (?='' OR d.groupId=?) AND instr(lower(d.name||d.deviceId),lower(?))>0",
      args = [kind, kind, group, group, q];
    const join =
      " FROM device_subscriptions s JOIN devices d ON d.id=s.deviceId JOIN device_groups g ON g.id=d.groupId WHERE " +
      where;
    return {
      items: this.db
        .prepare(
          "SELECT " +
            publicFields +
            join +
            " ORDER BY s.updatedAt DESC,s.id LIMIT ? OFFSET ?",
        )
        .all(...args, pageSize, (page - 1) * pageSize)
        .map(row => ({ ...row, guard: row.kind === "Alarm" ? this.guard.latest(row.deviceId) : null })),
      total: this.db.prepare("SELECT count(*) AS n" + join).get(...args).n,
      page,
      pageSize,
    };
  }
  set(userId, deviceId, kind, v) {
    if (!this.access.can(userId, "subscriptions.manage"))
      throw Error("没有订阅维护权限");
    this.access.requireDevice(userId, deviceId);
    if (
      !["Alarm", "MobilePosition"].includes(kind) ||
      typeof v.enabled !== "boolean" ||
      !Number.isInteger(v.expires) ||
      v.expires < 30 ||
      v.expires > 86400 ||
      !Number.isInteger(v.interval) ||
      v.interval < 1 ||
      v.interval > 3600 ||
      v.interval > v.expires
    )
      throw Error("订阅有效期30～86400秒，上报间隔1～3600秒且不超过有效期");
    const old = this.db
        .prepare(
          "SELECT * FROM device_subscriptions WHERE deviceId=? AND kind=?",
        )
        .get(deviceId, kind),
      id = old?.id || randomUUID();
    if (
      !old &&
      this.db.prepare("SELECT count(*) AS n FROM device_subscriptions").get()
        .n >= 10000
    )
      throw Error("订阅配置数量已达实例上限");
    this.jobs.get(id)?.controller.abort();
    if (v.enabled && (!old?.enabled || this.dialogs.get(id)?.stopped))
      this.dialogs.delete(id);
    this.db
      .prepare(
        "INSERT INTO device_subscriptions(id,deviceId,kind,enabled,expires,interval,status,updatedAt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(deviceId,kind) DO UPDATE SET enabled=excluded.enabled,expires=excluded.expires,interval=excluded.interval,status=excluded.status,error=NULL,failures=0,nextAttempt=0,updatedAt=excluded.updatedAt",
      )
      .run(
        id,
        deviceId,
        kind,
        Number(v.enabled),
        v.expires,
        v.interval,
        v.enabled ? "waiting" : "stopping",
        new Date().toISOString(),
      );
    queueMicrotask(() => this.tick());
    return { id, status: v.enabled ? "waiting" : "stopping" };
  }
  row(id) {
    return this.db
      .prepare("SELECT * FROM device_subscriptions WHERE id=?")
      .get(id);
  }
  online(d) {
    return (
      this.sip.state === "listening" &&
      d?.status === "online" &&
      d.registeredUntil > Date.now() &&
      d.remoteAddress &&
      d.remotePort
    );
  }
  tick(now = Date.now()) {
    if (this.closed) return;
    for (const [id, d] of this.dialogs) {
      const row = this.row(id);
      if (!row) {
        this.dialogs.delete(id);
        continue;
      }
      if (d.notifyDeadline && d.notifyDeadline <= now) {
        d.notifyDeadline = 0;
        if (d.stopped) {
          this.dialogs.delete(id);
          continue;
        }
        this.failure(id, "设备未在期限内发送订阅通知");
      }
      if (row.expiresAt && row.expiresAt <= now && !this.jobs.has(id)) {
        this.dialogs.delete(id);
        this.db
          .prepare(
            "UPDATE device_subscriptions SET status=?,error=?,nextAttempt=0,expiresAt=NULL WHERE id=?",
          )
          .run(
            row.enabled ? "waiting" : "disabled",
            row.enabled ? "订阅已到期，等待重新建立" : null,
            id,
          );
      }
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM device_subscriptions WHERE nextAttempt<=? AND (enabled=1 OR status='stopping') ORDER BY nextAttempt LIMIT 100",
      )
      .all(now);
    for (const row of rows) {
      if (this.jobs.size >= 8) break;
      if (this.jobs.has(row.id)) continue;
      const device = this.db
          .prepare("SELECT * FROM devices WHERE id=?")
          .get(row.deviceId),
        dialog = this.dialogs.get(row.id);
      if (
        !row.enabled &&
        (!dialog ||
          (!dialog.remoteTag && (!row.expiresAt || row.expiresAt <= now)))
      ) {
        this.db
          .prepare(
            "UPDATE device_subscriptions SET status='disabled',error=NULL WHERE id=?",
          )
          .run(row.id);
        continue;
      }
      if (row.enabled && !this.online(device)) {
        this.db
          .prepare(
            "UPDATE device_subscriptions SET status='waiting',error=?,nextAttempt=? WHERE id=?",
          )
          .run(
            this.sip.state === "listening"
              ? "设备离线，等待注册"
              : "SIP服务未启用",
            now + 5000,
            row.id,
          );
        continue;
      }
      if (!row.enabled && !dialog?.remoteTag) {
        this.db
          .prepare("UPDATE device_subscriptions SET nextAttempt=? WHERE id=?")
          .run(now + 1000, row.id);
        continue;
      }
      const job = { controller: new AbortController() };
      this.jobs.set(row.id, job);
      job.promise = this.attempt(row, device, job).finally(() => {
        if (this.jobs.get(row.id) === job) this.jobs.delete(row.id);
      });
    }
  }
  failure(id, message) {
    const row = this.row(id);
    if (!row) return;
    const n = Math.min(row.failures + 1, 10);
    this.db
      .prepare(
        "UPDATE device_subscriptions SET status=?,error=?,failures=?,nextAttempt=? WHERE id=?",
      )
      .run(
        row.enabled ? "failed" : "stopping",
        message,
        n,
        Date.now() + Math.min(300000, 5000 * 2 ** (n - 1)),
        id,
      );
  }
  contact(headers, device, fallback) {
    if (headers["record-route"]?.length)
      throw Error("当前订阅仅支持直连设备，暂不支持Record-Route");
    const c = headers.contact?.[0];
    if (!c) return fallback;
    const uri = c.match(/<?(sip:[^>\s]+)>?/)?.[1],
      m = uri?.match(
        /^sip:(\d{20})@([\d.]+)(?::(\d+))?(?:;transport=(udp|tcp))?$/i,
      );
    if (
      !m ||
      m[2] !== device.remoteAddress ||
      Number(m[3] || 5060) !== device.remotePort ||
      (m[4] && m[4].toUpperCase() !== (device.sipTransport || "UDP"))
    )
      throw Error("订阅Contact必须指向已注册设备端点");
    return uri;
  }
  headers(d, expires) {
    const config = this.sip.config;
    return [
      "Event: presence",
      "Expires: " + expires,
      `Contact: <sip:${config.serverId}@${config.advertisedHost || config.host}:${config.port};transport=${d.remote.sipTransport === "TCP" ? "tcp" : "udp"}>`,
    ];
  }
  async attempt(row, device, job) {
    let d = this.dialogs.get(row.id);
    if (
      d &&
      row.enabled &&
      (d.remote.remoteAddress !== device.remoteAddress ||
        d.remote.remotePort !== device.remotePort ||
        d.remote.sipTransport !== device.sipTransport)
    ) {
      this.dialogs.delete(row.id);
      d = null;
    }
    if (!d) {
      const localTag = randomBytes(12).toString("hex");
      d = {
        callId: randomUUID(),
        localTag,
        from: `<sip:${this.sip.config.serverId}@${this.sip.config.domain}>;tag=${localTag}`,
        to: `<sip:${device.deviceId}@${this.sip.config.domain}>`,
        remote: { ...device },
        uri: `sip:${device.deviceId}@${device.remoteAddress}:${device.remotePort}`,
        cseq: 0,
        notifySeq: 0,
        noticeCount: 0,
      };
      this.dialogs.set(row.id, d);
    }
    const count = d.noticeCount,
      expires = row.enabled ? row.expires : 0,
      sn = ++this.sip.seq;
    this.db
      .prepare("UPDATE device_subscriptions SET status=?,error=NULL WHERE id=?")
      .run(row.enabled ? "subscribing" : "stopping", row.id);
    if (row.enabled && !row.expiresAt)
      this.db
        .prepare("UPDATE device_subscriptions SET expiresAt=? WHERE id=?")
        .run(Date.now() + expires * 1000, row.id);
    try {
      const result = await this.sip.requests.request({
        method: "SUBSCRIBE",
        uri: d.uri,
        from: d.from,
        to: d.to,
        remote: d.remote,
        callId: d.callId,
        cseq: ++d.cseq,
        headers: this.headers(d, expires),
        body: `<?xml version="1.0" encoding="UTF-8"?><Query><CmdType>${row.kind}</CmdType><SN>${sn}</SN><DeviceID>${xmlEscape(d.remote.deviceId)}</DeviceID>${row.kind === "MobilePosition" ? "<Interval>" + row.interval + "</Interval>" : "<StartAlarmPriority>1</StartAlarmPriority><EndAlarmPriority>4</EndAlarmPriority><AlarmMethod>0</AlarmMethod>"}</Query>`,
        signal: job.controller.signal,
        timeout: this.timeout,
      });
      if (
        job.controller.signal.aborted ||
        this.closed ||
        this.jobs.get(row.id) !== job
      )
        return;
      if (result.status < 200 || result.status >= 300) {
        if (result.status === 481) this.dialogs.delete(row.id);
        throw Error(
          "设备拒绝订阅：" +
            result.status +
            (result.status === 423 ? "（有效期低于设备要求）" : ""),
        );
      }
      if (result.body?.length) {
        const data = decodeXmlBody(
          result,
          new XMLParser({ parseTagValue: false }),
          XMLValidator,
        ).Response;
        if (
          !data ||
          data.CmdType !== row.kind ||
          data.DeviceID !== device.deviceId ||
          String(data.SN) !== String(sn) ||
          (data.Result && data.Result !== "OK")
        )
          throw Error("设备返回无效或失败的订阅业务应答");
      }
      const remoteTag = tag(result.headers.to?.[0]);
      if (!remoteTag) throw Error("订阅响应缺少To标签");
      if (d.remoteTag && remoteTag !== d.remoteTag)
        throw Error("订阅响应对话标签不一致");
      d.remoteTag = remoteTag;
      d.to = result.headers.to[0];
      d.uri = this.contact(result.headers, d.remote, d.uri);
      const seconds = Number(result.headers.expires?.[0]);
      if (
        !/^\d+$/.test(result.headers.expires?.[0] || "") ||
        !Number.isInteger(seconds) ||
        seconds < 0 ||
        seconds > expires ||
        (row.enabled && seconds === 0)
      )
        throw Error("设备返回无效订阅有效期");
      if (!row.enabled) {
        this.db
          .prepare(
            "UPDATE device_subscriptions SET status='disabled',error=NULL,expiresAt=NULL,failures=0 WHERE id=?",
          )
          .run(row.id);
        d.stopped = true;
        d.notifyDeadline = Date.now() + this.notifyTimeout;
        return;
      }
      if (d.terminated) throw Error("设备已终止该订阅");
      const proposedEnd = Date.now() + seconds * 1000;
      const end =
        d.noticeCount > count && d.noticeExpiresAt
          ? Math.min(proposedEnd, d.noticeExpiresAt)
          : proposedEnd;
      this.db
        .prepare(
          "UPDATE device_subscriptions SET status=?,acceptedAt=?,expiresAt=?,nextAttempt=?,failures=0,error=NULL WHERE id=?",
        )
        .run(
          d.noticeCount > count ? d.lastState || "active" : "awaiting_notify",
          new Date().toISOString(),
          end,
          Date.now() + Math.max(1000, (end - Date.now()) * 0.8),
          row.id,
        );
      d.notifyDeadline =
        d.noticeCount > count ? 0 : Date.now() + this.notifyTimeout;
    } catch (e) {
      if (
        !job.controller.signal.aborted &&
        !this.closed &&
        this.jobs.get(row.id) === job
      )
        this.failure(row.id, e.message);
    }
  }
  check(device, req, xml) {
    const pair = [...this.dialogs].find(
      ([, d]) => d.callId === req.headers["call-id"][0],
    );
    if (!pair) throw issue("订阅对话不存在");
    const [id, d] = pair,
      row = this.row(id);
    if (
      !row ||
      device.id !== row.deviceId ||
      tag(req.headers.to?.[0]) !== d.localTag ||
      req.headers.event?.[0]?.trim().toLowerCase() !== "presence"
    )
      throw issue("订阅身份或事件不匹配");
    const rt = tag(req.headers.from?.[0]);
    if (!rt || (d.remoteTag && d.remoteTag !== rt))
      throw issue("通知对话标签不匹配");
    if (
      d.remote.remoteAddress !== device.remoteAddress ||
      d.remote.remotePort !== device.remotePort ||
      d.remote.sipTransport !== device.sipTransport
    )
      throw issue("设备端点已变化");
    const state = req.headers["subscription-state"]?.[0],
      m = state?.match(/^(active|pending|terminated)(?:;|$)/i);
    if (!m) throw issue("通知缺少有效订阅状态", 400);
    const expires = state.match(/;\s*expires=(\d+)(?:;|$)/i)?.[1];
    if (
      expires &&
      (!Number.isSafeInteger(Number(expires)) || Number(expires) > row.expires)
    )
      throw issue("通知有效期无效", 400);
    const seq = Number(req.headers.cseq[0].split(" ")[0]);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq < d.notifySeq)
      throw issue("通知序号已过期", 500);
    if (req.body.length && xml?.Notify?.CmdType !== row.kind)
      throw issue("通知内容与订阅类型不一致", 400);
    const uri = this.contact(req.headers, device, d.uri),
      duplicate = seq === d.notifySeq;
    return {
      id,
      d,
      row,
      rt,
      uri,
      seq,
      state: m[1].toLowerCase(),
      seconds: expires ? Number(expires) : null,
      duplicate,
    };
  }
  notify(device, req, xml) {
    const n = this.check(device, req, xml);
    if (n.duplicate) return true;
    if (n.d.stopped && n.state !== "terminated") {
      n.d.notifySeq = n.seq;
      this.db
        .prepare("UPDATE device_subscriptions SET lastNotifyAt=? WHERE id=?")
        .run(new Date().toISOString(), n.id);
      return true;
    }
    if (
      !this.closed &&
      n.row.enabled &&
      req.body.length &&
      !this.events.handle(device, xml, { businessAck: false })
    )
      throw issue("订阅通知内容无效", 400);
    const { d } = n;
    d.remoteTag = n.rt;
    d.to = `<sip:${device.deviceId}@${this.sip.config.domain}>;tag=${n.rt}`;
    d.uri = n.uri;
    d.notifySeq = n.seq;
    d.noticeCount++;
    d.notifyDeadline = 0;
    d.lastState = n.state;
    d.noticeExpiresAt =
      n.seconds === null ? null : Date.now() + n.seconds * 1000;
    const row = this.row(n.id),
      now = Date.now();
    this.db
      .prepare("UPDATE device_subscriptions SET lastNotifyAt=? WHERE id=?")
      .run(new Date(now).toISOString(), n.id);
    if (n.state === "terminated") {
      d.terminated = true;
      this.dialogs.delete(n.id);
      if (row.enabled) this.failure(n.id, "设备终止订阅");
      else
        this.db
          .prepare(
            "UPDATE device_subscriptions SET status='disabled',error=NULL,expiresAt=NULL WHERE id=?",
          )
          .run(n.id);
    } else {
      const end = n.seconds === null ? row.expiresAt : now + n.seconds * 1000;
      this.db
        .prepare(
          "UPDATE device_subscriptions SET status=?,expiresAt=?,nextAttempt=?,error=NULL WHERE id=?",
        )
        .run(
          row.enabled ? n.state : "stopping",
          end,
          row.enabled
            ? Math.min(
                row.nextAttempt || Infinity,
                now + Math.max(1000, (end - now) * 0.8),
              )
            : 0,
          n.id,
        );
    }
    return true;
  }
  async close() {
    await this.guard.close();
    this.closed = true;
    clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
    this.jobs.clear();
    // Best effort for established dialogs; unconfirmed/overflow dialogs expire remotely.
    if (this.sip.state === "listening")
      await Promise.allSettled(
        [...this.dialogs.values()]
          .filter((d) => d.remoteTag && !d.stopped)
          .slice(0, 256)
          .map((d) =>
            this.sip.requests.request({
              method: "SUBSCRIBE",
              uri: d.uri,
              from: d.from,
              to: d.to,
              remote: d.remote,
              callId: d.callId,
              cseq: ++d.cseq,
              headers: this.headers(d, 0),
              timeout: 1500,
            }),
          ),
      );
    this.dialogs.clear();
  }
}

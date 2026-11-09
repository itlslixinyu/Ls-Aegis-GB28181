import { randomUUID, createHash } from "node:crypto";
import { parseRecordTime } from "./record-queries.mjs";
import { xmlEscape } from "../sip/requests.mjs";
export function coordinates(longitude, latitude, strings = false) {
  const convert = (v) =>
    strings && typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  const lon = convert(longitude),
    lat = convert(latitude);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  )
    throw Error("经纬度须为有效WGS84坐标");
  return { longitude: lon, latitude: lat };
}
export class SecurityEvents {
  constructor({ db, sip, access, history }) {
    Object.assign(this, { db, sip, access, history });
    this.jobs = new Set();
    this.rates = new Map();
  }
  target(device, code) {
    if (code === device.deviceId) return null;
    const c = this.db
      .prepare("SELECT id FROM channels WHERE deviceId=? AND channelCode=?")
      .get(device.id, code);
    if (!c) throw Error("通知通道不属于已注册设备");
    return c.id;
  }
  position(
    deviceId,
    value,
    source = "manual",
    time = new Date().toISOString(),
  ) {
    const point = coordinates(value.longitude, value.latitude),
      address = value.address ?? "";
    if (typeof address !== "string" || address.length > 300)
      throw Error("位置说明须不超过300字符");
    const old = this.db
      .prepare("SELECT * FROM device_locations WHERE deviceId=?")
      .get(deviceId);
    if (
      source === "device" &&
      old &&
      (old.source === "manual" || old.updatedAt >= time)
    )
      return old;
    this.db
      .prepare(
        "INSERT INTO device_locations VALUES(?,?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET longitude=excluded.longitude,latitude=excluded.latitude,address=excluded.address,source=excluded.source,updatedAt=excluded.updatedAt",
      )
      .run(deviceId, point.longitude, point.latitude, address, source, time);
    return this.db
      .prepare("SELECT * FROM device_locations WHERE deviceId=?")
      .get(deviceId);
  }
  handle(device, xml, { businessAck = true } = {}) {
    const data = xml.Notify;
    if (!data || !["Alarm", "MobilePosition"].includes(data.CmdType))
      return false;
    const channelId = this.target(device, data.DeviceID);
    if (data.CmdType === "MobilePosition") {
      const time = new Date(parseRecordTime(data.Time)).toISOString();
      if (Date.parse(time) > Date.now() + 300000)
        throw Error("定位时间超出允许时钟偏差");
      const point = coordinates(data.Longitude, data.Latitude, true);
      this.history?.record(device.id, data.DeviceID, point, time);
      this.position(device.id, point, "device", time);
      return true;
    }
    if (
      !/^\d{1,20}$/.test(String(data.SN)) ||
      !["1", "2", "3", "4"].includes(String(data.AlarmPriority)) ||
      !/^\d{1,8}$/.test(String(data.AlarmMethod))
    )
      throw Error("告警序号、级别或方式无效");
    const occurredAt = new Date(parseRecordTime(data.AlarmTime)).toISOString(),
      description = data.AlarmDescription ?? "",
      type = String(data.Info?.AlarmType ?? data.AlarmType ?? "");
    if (
      typeof description !== "string" ||
      description.length > 2000 ||
      type.length > 32
    )
      throw Error("告警描述或类型过长");
    const point =
      data.Longitude !== undefined && data.Latitude !== undefined
        ? coordinates(data.Longitude, data.Latitude, true)
        : {};
    const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            device.id,
            data.DeviceID,
            occurredAt,
            String(data.AlarmMethod),
            type,
            description,
          ]),
        )
        .digest("hex"),
      now = new Date().toISOString();
    const old = this.db
      .prepare("SELECT id FROM alarms WHERE fingerprint=?")
      .get(fingerprint);
    if (old)
      this.db
        .prepare(
          "UPDATE alarms SET repeatCount=repeatCount+1,lastReceivedAt=? WHERE id=?",
        )
        .run(now, old.id);
    else {
      let rate = this.rates.get(device.id);
      if (!rate || Date.now() - rate.at > 60000) {
        rate = { at: Date.now(), count: 0 };
        this.rates.set(device.id, rate);
      }
      if (++rate.count > 100)
        throw Object.assign(Error("告警接收频率过高"), { sipStatus: 486 });
      if (this.rates.size > 10000)
        for (const [id, r] of this.rates)
          if (Date.now() - r.at > 60000) this.rates.delete(id);
      this.db
        .prepare(
          "INSERT INTO alarms(id,deviceId,deviceName,targetCode,channelId,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint,longitude,latitude) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          device.id,
          device.name,
          data.DeviceID,
          channelId,
          Number(data.AlarmPriority),
          String(data.AlarmMethod),
          type,
          description,
          occurredAt,
          now,
          now,
          fingerprint,
          point.longitude ?? null,
          point.latitude ?? null,
        );
    }
    if (businessAck && this.sip.state === "listening" && this.sip.requests) {
      const work = this.sip.requests
        .request({
          uri: `sip:${device.deviceId}@${device.remoteAddress}:${device.remotePort}`,
          remote: device,
          body: `<Response><CmdType>Alarm</CmdType><SN>${xmlEscape(data.SN)}</SN><DeviceID>${xmlEscape(data.DeviceID)}</DeviceID><Result>OK</Result></Response>`,
          timeout: 4000,
        })
        .catch(() => {});
      this.jobs.add(work);
      work.finally(() => this.jobs.delete(work));
    }
    if (String(data.AlarmMethod) === "5" && type === "2") {
      const alarm = this.db.prepare("SELECT id FROM alarms WHERE fingerprint=?").get(fingerprint);
      try { this.snapshots?.schedule(alarm.id, device, data.DeviceID); }
      catch { /* Snapshot failures must not fail SIP alarm acknowledgement. */ }
    }
    return true;
  }
  list(userId, params) {
    const page = Number(params.get("page") || 1),
      pageSize = Number(params.get("pageSize") || 20),
      status = params.get("status") || "",
      priority = params.get("priority") || "",
      q = params.get("q") || "",
      groupId = params.get("groupId") || "",
      from = params.get("from") || "",
      to = params.get("to") || "";
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      q.length > 100 ||
      !["", "new", "acknowledged", "resolved"].includes(status) ||
      !["", "1", "2", "3", "4"].includes(priority)
    )
      throw Error("告警筛选或分页参数无效");
    const start = from ? new Date(parseRecordTime(from)).toISOString() : "",
      end = to ? new Date(parseRecordTime(to)).toISOString() : "";
    if (start && end && start > end) throw Error("开始时间须早于结束时间");
    const scope = this.access.sql(userId, "a.deviceId"),
      filter = `${scope} AND (?='' OR a.status=?) AND (?='' OR a.priority=?) AND (?='' OR d.groupId=?) AND (?='' OR a.occurredAt>=?) AND (?='' OR a.occurredAt<=?) AND (instr(lower(a.deviceName||a.targetCode||a.description),lower(?))>0)`,
      args = [
        status,
        status,
        priority,
        priority,
        groupId,
        groupId,
        start,
        start,
        end,
        end,
        q,
      ];
    const items = this.db
      .prepare(
        `SELECT a.*,g.name AS groupName FROM alarms a LEFT JOIN devices d ON d.id=a.deviceId LEFT JOIN device_groups g ON g.id=d.groupId WHERE ${filter} ORDER BY a.occurredAt DESC,a.id LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize);
    const total = this.db
      .prepare(
        `SELECT count(*) AS n FROM alarms a LEFT JOIN devices d ON d.id=a.deviceId WHERE ${filter}`,
      )
      .get(...args).n;
    const stats = this.db
      .prepare(
        `SELECT count(*) AS total,coalesce(sum(status='new'),0) AS pending,coalesce(sum(status='acknowledged'),0) AS acknowledged,coalesce(sum(status='resolved'),0) AS resolved FROM alarms a WHERE ${scope}`,
      )
      .get();
    return { items, total, page, pageSize, stats };
  }
  get(id, userId) {
    const a = this.db.prepare("SELECT * FROM alarms WHERE id=?").get(id);
    if (!a || !this.access.device(userId, a.deviceId))
      throw Error("告警不存在或无权访问");
    const snapshot = this.snapshots?.get(id) ?? null;
    const link = this.db.prepare("SELECT jobId FROM alarm_ai_jobs WHERE snapshotId=? OR alarmId=? ORDER BY queuedAt DESC LIMIT 1").get(snapshot?.id || "", id);
    let analysis = null;
    if (link?.jobId && this.ai && this.access.can(userId, "ai.view")) {
      try { analysis = this.ai.get(userId, link.jobId); } catch { /* Current AI scope and expiry apply. */ }
    }
    return {
      ...a,
      snapshot,
      analysis,
      actions: this.db
        .prepare(
          "SELECT * FROM alarm_actions WHERE alarmId=? ORDER BY createdAt,rowid",
        )
        .all(id),
    };
  }
  action(id, user, value) {
    if (!this.access.can(user.userId, "alarms.handle"))
      throw Error("没有告警处置权限");
    const a = this.get(id, user.userId),
      next =
        value.action === "acknowledge"
          ? "acknowledged"
          : value.action === "resolve"
            ? "resolved"
            : null,
      note = value.note ?? "";
    if (
      !next ||
      !Number.isInteger(value.version) ||
      typeof note !== "string" ||
      note.length > 1000 ||
      (next === "resolved" && !note.trim())
    )
      throw Error("请选择有效操作并填写处置意见");
    if (value.version !== a.version)
      throw Error("告警已被其他操作更新，请刷新");
    if (
      (next === "acknowledged" && a.status !== "new") ||
      (next === "resolved" && a.status !== "acknowledged")
    )
      throw Error("告警须依次确认、处置，不可重复变更");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE alarms SET status=?,version=version+1 WHERE id=? AND version=?",
        )
        .run(next, id, a.version);
      if (changed.changes !== 1) throw Error("告警已被更新，请刷新");
      this.db
        .prepare("INSERT INTO alarm_actions VALUES(?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          id,
          user.userId,
          user.username,
          value.action,
          note.trim(),
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.get(id, user.userId);
  }
  async close() {
    await this.snapshots?.close();
    await Promise.all(this.jobs);
  }
}

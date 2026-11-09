import { randomUUID } from "node:crypto";
import { parseRecordTime } from "./record-queries.mjs";
export class PositionHistory {
  constructor({ db, access, retentionDays = 30 }) {
    Object.assign(this, { db, access, retentionDays });
    this.rates = new Map();
    this.lastPrune = 0;
  }
  record(deviceId, targetCode, point, time) {
    const now = Date.now();
    if (Date.parse(time) < now - this.retentionDays * 86400000) return;
    const exists = this.db
      .prepare(
        "SELECT 1 FROM position_history WHERE deviceId=? AND targetCode=? AND occurredAt=? AND longitude=? AND latitude=?",
      )
      .get(deviceId, targetCode, time, point.longitude, point.latitude);
    if (exists) return;
    let rate = this.rates.get(deviceId);
    if (!rate || now - rate.at >= 60000) {
      rate = { at: now, n: 0 };
      this.rates.set(deviceId, rate);
    }
    if (++rate.n > 600)
      throw Object.assign(Error("位置上报频率过高"), { sipStatus: 486 });
    if (this.rates.size > 10000)
      for (const [id, r] of this.rates)
        if (now - r.at >= 60000) this.rates.delete(id);
    this.db
      .prepare("INSERT OR IGNORE INTO position_history VALUES(?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        deviceId,
        targetCode,
        point.longitude,
        point.latitude,
        time,
        new Date(now).toISOString(),
      );
  }
  prune(now = Date.now()) {
    if (now - this.lastPrune < 60000) return;
    this.lastPrune = now;
    this.db
      .prepare(
        "DELETE FROM position_history WHERE rowid IN (SELECT rowid FROM position_history WHERE occurredAt<? LIMIT 10000)",
      )
      .run(new Date(now - this.retentionDays * 86400000).toISOString());
  }
  targets(deviceId) {
    const d = this.db
      .prepare("SELECT deviceId,name FROM devices WHERE id=?")
      .get(deviceId);
    return {
      items: [
        { code: d.deviceId, name: "设备本体" },
        ...this.db
          .prepare(
            "SELECT code,max(name) AS name FROM (SELECT channelCode AS code,name FROM channels WHERE deviceId=? UNION SELECT targetCode AS code,'历史通道' AS name FROM position_history WHERE deviceId=? AND targetCode<>?) GROUP BY code ORDER BY code",
          )
          .all(deviceId, deviceId, d.deviceId),
      ],
    };
  }
  query(userId, deviceId, params) {
    this.access.requireDevice(userId, deviceId);
    const device = this.db
        .prepare("SELECT deviceId FROM devices WHERE id=?")
        .get(deviceId),
      targetCode = params.get("targetCode") || device.deviceId;
    if (
      targetCode !== device.deviceId &&
      !this.db
        .prepare(
          "SELECT 1 FROM channels WHERE deviceId=? AND channelCode=? UNION SELECT 1 FROM position_history WHERE deviceId=? AND targetCode=? LIMIT 1",
        )
        .get(deviceId, targetCode, deviceId, targetCode)
    )
      throw Error("轨迹目标不属于该设备");
    const start = new Date(parseRecordTime(params.get("start"))).toISOString(),
      end = new Date(parseRecordTime(params.get("end"))).toISOString(),
      limit = Number(params.get("limit") || 1000);
    if (
      start > end ||
      Date.parse(end) - Date.parse(start) > 7 * 86400000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 2000
    )
      throw Error("轨迹范围最多7天，每页1～2000点");
    let cursor = null;
    if (params.get("cursor")) {
      try {
        if (params.get("cursor").length > 1200) throw Error();
        cursor = JSON.parse(Buffer.from(params.get("cursor"), "base64url"));
        if (
          cursor.deviceId !== deviceId ||
          cursor.targetCode !== targetCode ||
          cursor.start !== start ||
          cursor.end !== end ||
          !/^[-a-z0-9]{36}$/.test(cursor.id) ||
          new Date(parseRecordTime(cursor.time)).toISOString() !==
            cursor.time ||
          !Number.isSafeInteger(cursor.snapshot) ||
          cursor.snapshot < 0
        )
          throw Error();
      } catch {
        throw Error("轨迹分页游标无效，请重新查询");
      }
    }
    const snapshot =
      cursor?.snapshot ??
      this.db
        .prepare("SELECT coalesce(max(rowid),0) AS n FROM position_history")
        .get().n;
    const cutoff = new Date(
      Date.now() - this.retentionDays * 86400000,
    ).toISOString();
    const base =
        "deviceId=? AND targetCode=? AND occurredAt>=? AND occurredAt<=? AND occurredAt>=? AND rowid<=?",
      args = [deviceId, targetCode, start, end, cutoff, snapshot];
    const total = this.db
      .prepare("SELECT count(*) AS n FROM position_history WHERE " + base)
      .get(...args).n;
    const points = this.db
      .prepare(
        "SELECT id,targetCode,longitude,latitude,occurredAt,receivedAt FROM position_history WHERE " +
          base +
          (cursor ? " AND (occurredAt>? OR (occurredAt=? AND id>?))" : "") +
          " ORDER BY occurredAt,id LIMIT ?",
      )
      .all(
        ...args,
        ...(cursor ? [cursor.time, cursor.time, cursor.id] : []),
        limit + 1,
      );
    const more = points.length > limit;
    if (more) points.pop();
    const last = points.at(-1);
    return {
      items: points,
      total,
      start,
      end,
      targetCode,
      retentionDays: this.retentionDays,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              deviceId,
              targetCode,
              start,
              end,
              snapshot,
              time: last.occurredAt,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
    };
  }
}

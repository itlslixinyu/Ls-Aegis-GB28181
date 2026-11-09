import { Access } from "./access.mjs";
import { randomUUID } from "node:crypto";
import { recordRange } from "./record-queries.mjs";
const active = ["starting", "recording", "finalizing"];
const iso = (ms) => new Date(ms).toISOString();
const minute = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
// Schedules use explicit Asia/Shanghai civil time, independent of the server OS.
export function occurrence(plan, now) {
  const local = new Date(now + 8 * 3600000),
    today =
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) -
      8 * 3600000;
  for (const midnight of [today, today - 86400000]) {
    const day = new Date(midnight + 8 * 3600000).getUTCDay() || 7,
      days = JSON.parse(plan.days);
    const start = midnight + minute(plan.startTime) * 60000,
      end =
        midnight +
        minute(plan.endTime) * 60000 +
        (minute(plan.endTime) <= minute(plan.startTime) ? 86400000 : 0);
    if (days.includes(day) && now >= start && now < end)
      return { start, end, key: plan.id + ":" + iso(start) };
  }
  return null;
}
export class Recordings {
  constructor({ db, live, media, now = () => Date.now() }) {
    Object.assign(this, { db, live, media, now });
    this.access = new Access(db);
    this.locks = new Set();
    this.closing = false;
    this.recoveryReservations = new Map();
  }
  plans() {
    return this.db
      .prepare(
        "SELECT p.*,c.name AS channelName,d.name AS deviceName FROM recording_plans p LEFT JOIN channels c ON p.channelId=c.id LEFT JOIN devices d ON c.deviceId=d.id ORDER BY p.createdAt DESC",
      )
      .all()
      .map((p) => ({ ...p, days: JSON.parse(p.days) }));
  }
  savePlan(value, userId, id) {
    const old = id
      ? this.db.prepare("SELECT * FROM recording_plans WHERE id=?").get(id)
      : null;
    if (id && !old) throw Error("录像计划不存在");
    if (
      old &&
      this.db
        .prepare(
          "SELECT 1 FROM recording_jobs WHERE planId=? AND status IN ('starting','recording','finalizing')",
        )
        .get(id)
    )
      throw Error("计划仍有执行任务，请先停用并等待任务结束");
    const p = {
      ...value,
      id: id || randomUUID(),
      ownerId: old?.ownerId || userId,
    };
    if (
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 100 ||
      typeof p.channelId !== "string" ||
      !this.db.prepare("SELECT 1 FROM channels WHERE id=?").get(p.channelId)
    )
      throw Error("请填写计划名称并选择有效通道");
    if (
      !Array.isArray(p.days) ||
      !p.days.length ||
      p.days.length > 7 ||
      new Set(p.days).size !== p.days.length ||
      p.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
    )
      throw Error("请选择有效执行星期");
    if (
      typeof p.startTime !== "string" ||
      typeof p.endTime !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.endTime)
    )
      throw Error("计划时间格式须为HH:mm");
    if (
      typeof p.enabled !== "boolean" ||
      !Number.isInteger(p.retentionDays) ||
      p.retentionDays < 1 ||
      p.retentionDays > 365 ||
      !Number.isInteger(p.segmentSeconds) ||
      p.segmentSeconds < 60 ||
      p.segmentSeconds > 3600
    )
      throw Error("启用状态、保留天数或分段长度无效");
    if (p.enabled) {
      const intervals = (q) =>
        q.days.flatMap((d) => {
          const a = (d - 1) * 1440 + minute(q.startTime),
            b =
              a +
              ((minute(q.endTime) - minute(q.startTime) + 1440) % 1440 || 1440);
          return [
            [a, b],
            [a - 10080, b - 10080],
            [a + 10080, b + 10080],
          ];
        });
      for (const q of this.plans().filter(
        (q) => q.enabled && q.channelId === p.channelId && q.id !== p.id,
      ))
        if (
          intervals(p).some(([a, b]) =>
            intervals(q).some(([c, d]) => a < d && c < b),
          )
        )
          throw Error("同一通道的启用计划时间重叠");
    }
    this.db
      .prepare(
        "INSERT INTO recording_plans(id,name,channelId,ownerId,days,startTime,endTime,enabled,retentionDays,segmentSeconds,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,channelId=excluded.channelId,days=excluded.days,startTime=excluded.startTime,endTime=excluded.endTime,enabled=excluded.enabled,retentionDays=excluded.retentionDays,segmentSeconds=excluded.segmentSeconds",
      )
      .run(
        p.id,
        p.name.trim(),
        p.channelId,
        p.ownerId,
        JSON.stringify(p.days),
        p.startTime,
        p.endTime,
        Number(p.enabled),
        p.retentionDays,
        p.segmentSeconds,
        old?.createdAt || iso(this.now()),
      );
    return this.plans().find((q) => q.id === p.id);
  }
  enablePlan(id, enabled) {
    if (typeof enabled !== "boolean") throw Error("启用状态无效");
    if (enabled) {
      const p = this.plans().find((p) => p.id === id);
      if (!p) throw Error("录像计划不存在");
      return this.savePlan({ ...p, enabled: true }, p.ownerId, id);
    }
    const result = this.db
      .prepare("UPDATE recording_plans SET enabled=0 WHERE id=?")
      .run(id);
    if (!result.changes) throw Error("录像计划不存在");
  }
  removePlan(id) {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM recording_jobs WHERE planId=? AND status IN ('starting','recording','finalizing')",
        )
        .get(id)
    )
      throw Error("请先停用计划并等待任务结束");
    if (
      !this.db.prepare("DELETE FROM recording_plans WHERE id=?").run(id).changes
    )
      throw Error("录像计划不存在");
  }
  list(userId, admin = false, kind = "", daily = false) {
    if (!["", "download", "scheduled"].includes(kind))
      throw Error("录像任务类型无效");
    if (daily && kind === "scheduled") return this.daily(userId, admin);
    return this.db
      .prepare(
        `SELECT j.*,c.name AS channelName,p.name AS planName FROM recording_jobs j LEFT JOIN channels c ON j.channelId=c.id LEFT JOIN recording_plans p ON j.planId=p.id WHERE (?='' OR j.kind=?) ${admin ? "" : `AND (j.ownerId=? OR j.kind='scheduled') AND ${this.access.sql(userId, "c.deviceId")}`} ORDER BY j.createdAt DESC LIMIT 200`,
      )
      .all(kind, kind, ...(admin ? [] : [userId]))
      .map((j) => this.publicJob(j));
  }
  daily(userId, admin, planIds = null) {
    if (planIds && !planIds.length) return [];
    const rows = this.db
      .prepare(
        `WITH scoped AS (
      SELECT j.*,j.rowid AS sequence,c.name AS channelName,p.name AS planName,
      date(COALESCE(j.start,j.createdAt),'+8 hours') AS executionDate
      FROM recording_jobs j LEFT JOIN channels c ON j.channelId=c.id
      LEFT JOIN recording_plans p ON j.planId=p.id WHERE j.kind='scheduled'
      ${planIds ? `AND j.planId IN (${planIds.map(() => "?").join(",")})` : ""}
      ${planIds ? `AND date(COALESCE(j.start,j.createdAt),'+8 hours')=(SELECT max(date(COALESCE(k.start,k.createdAt),'+8 hours')) FROM recording_jobs k WHERE k.planId=j.planId AND k.kind='scheduled')` : ""}
      ${admin ? "" : `AND ${this.access.sql(userId, "c.deviceId")}`}
    ), ranked AS (SELECT *,DENSE_RANK() OVER (ORDER BY executionDate DESC,channelId) AS dayRank FROM scoped)
    SELECT * FROM ranked WHERE ${planIds ? "1=1" : "dayRank<=200"} ORDER BY createdAt,sequence`,
      )
      .all(...(planIds || []));
    return this.aggregateDays(rows);
  }
  aggregateDays(rows) {
    const groups = new Map();
    for (const row of rows) {
      const { dayRank, sequence, ...job } = row;
      const key = job.channelId + ":" + job.executionDate;
      const group = groups.get(key) || { files: [], attempts: [] };
      const value = this.publicJob(job);
      group.files.push(
        ...value.files.map((file) => ({ ...file, jobId: job.id })),
      );
      group.attempts.push({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        error: job.error,
      });
      // An active attempt remains the operation target even for legacy overlapping plans.
      if (
        !group.id ||
        active.includes(job.status) ||
        !active.includes(group.status)
      )
        Object.assign(group, {
          ...value,
          files: group.files,
          attempts: group.attempts,
        });
      groups.set(key, group);
      group.dailyKey = key;
    }
    return [...groups.values()].reverse();
  }
  interruption(j, reason) {
    if (j.kind !== "scheduled") return;
    const channel = this.db
      .prepare(
        `SELECT c.*,d.name AS deviceName FROM channels c
      JOIN devices d ON d.id=c.deviceId WHERE c.id=?`,
      )
      .get(j.channelId);
    if (!channel) return;
    const now = iso(this.now());
    this.db
      .prepare(
        `INSERT OR IGNORE INTO alarms
      (id,deviceId,deviceName,targetCode,channelId,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint)
      VALUES(?,?,?,?,?,2,'platform','recording-interrupted',?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        channel.deviceId,
        channel.deviceName,
        channel.channelCode,
        channel.id,
        `平台录像中断：${channel.name}；${reason}。执行时段内将自动重试。`,
        now,
        now,
        now,
        "recording:" + j.id,
      );
  }
  publicJob(j) {
    const { streamId, viewerId, sessionId, ...data } = j;
    return {
      ...data,
      files: this.db
        .prepare(
          "SELECT id,date,name FROM recording_files WHERE jobId=? ORDER BY date,name",
        )
        .all(j.id),
    };
  }
  job(id, userId, admin = false) {
    const j = this.db
      .prepare("SELECT * FROM recording_jobs WHERE id=?")
      .get(id);
    if (!j || (!admin && j.ownerId !== userId && j.kind !== "scheduled"))
      throw Error("录像任务不存在或无权访问");
    if (!admin) this.access.requireChannel(userId, j.channelId);
    return j;
  }
  download(value, userId, key) {
    if (this.closing) throw Error("服务正在关闭");
    if (!this.media.config?.hookToken)
      throw Error("设备录像导出需配置媒体发布回调，请查看接入说明");
    const r = this.db
      .prepare(
        "SELECT r.* FROM record_items r JOIN record_queries q ON q.id=r.queryId WHERE r.id=? AND q.userId=? AND q.status='succeeded'",
      )
      .get(value.recordId || "", userId);
    if (!r) throw Error("录像不存在或无权访问");
    this.access.requireChannel(userId, r.channelId);
    const speed = value.speed ?? 1;
    if (![1, 2, 4].includes(speed)) throw Error("下载速度无效");
    const range = recordRange(value.start || r.start, value.end || r.end);
    if (range.start < r.start || range.end > r.end)
      throw Error("下载时间超出录像范围");
    if (
      key !== undefined &&
      key !== null &&
      (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key))
    )
      throw Error("幂等编号无效");
    const occurrence = key ? "download:" + userId + ":" + key : null;
    if (occurrence) {
      const old = this.db
        .prepare("SELECT * FROM recording_jobs WHERE occurrence=?")
        .get(occurrence);
      if (old) {
        if (
          old.channelId !== r.channelId ||
          old.start !== range.start ||
          old.end !== range.end ||
          old.speed !== speed
        )
          throw Error("幂等编号已用于其他下载参数");
        return this.publicJob(old);
      }
    }
    return this.create({
      ownerId: userId,
      channelId: r.channelId,
      kind: "download",
      ...range,
      speed,
      occurrence,
      deadline:
        this.now() +
        ((Date.parse(range.end) - Date.parse(range.start)) / speed) * 1.3 +
        180000,
    });
  }
  create(value) {
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM recording_jobs WHERE status IN ('starting','recording','finalizing')",
        )
        .get().n >= 8
    )
      throw Error("已达到8个录像任务并发上限");
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM recording_jobs WHERE ownerId=? AND status IN ('starting','recording','finalizing')",
        )
        .get(value.ownerId).n >= 4
    )
      throw Error("已达到账号4个录像任务并发上限");
    const j = {
      id: randomUUID(),
      attempt: 1,
      start: null,
      end: null,
      planId: null,
      occurrence: null,
      speed: 1,
      retentionDays: 7,
      segmentSeconds: 900,
      ...value,
      status: "starting",
      createdAt: iso(this.now()),
    };
    this.db
      .prepare(
        "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,planId,occurrence,attempt,start,end,deadline,speed,retentionDays,segmentSeconds,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ...[
          "id",
          "ownerId",
          "channelId",
          "kind",
          "status",
          "planId",
          "occurrence",
          "attempt",
          "start",
          "end",
          "deadline",
          "speed",
          "retentionDays",
          "segmentSeconds",
          "createdAt",
        ].map((k) => j[k]),
      );
    try {
      const channel = this.db
        .prepare("SELECT * FROM channels WHERE id=?")
        .get(j.channelId);
      if (!channel) throw Error("通道不存在");
      const viewer = this.live.create(
        channel,
        j.ownerId,
        undefined,
        j.kind === "download"
          ? { kind: "download", start: j.start, end: j.end, speed: j.speed }
          : { kind: "recording" },
      );
      const source = this.db
        .prepare("SELECT streamId FROM live_sessions WHERE id=?")
        .get(viewer.sessionId);
      this.db
        .prepare(
          "UPDATE recording_jobs SET sessionId=?,viewerId=?,streamId=? WHERE id=?",
        )
        .run(viewer.sessionId, viewer.viewerId, source.streamId, j.id);
    } catch (error) {
      this.db
        .prepare(
          "UPDATE recording_jobs SET status='failed',error=?,finishedAt=? WHERE id=?",
        )
        .run(error.message, iso(this.now()), j.id);
      this.interruption(j, error.message);
    }
    return this.publicJob(this.job(j.id, j.ownerId));
  }
  async discover(j) {
    for (const file of (await this.media.recordFiles(j.streamId)).slice(
      0,
      2000,
    ))
      this.db
        .prepare("INSERT OR IGNORE INTO recording_files VALUES(?,?,?,?)")
        .run(randomUUID(), j.id, file.date, file.name);
  }
  async finish(j, status, error = null) {
    if (!active.includes(j.status) || j.status === "finalizing") return;
    if (["failed", "interrupted"].includes(status))
      this.interruption(j, error || "录像源中断");
    this.db
      .prepare(
        "UPDATE recording_jobs SET status='finalizing',resultStatus=?,error=?,finalizeUntil=? WHERE id=?",
      )
      .run(status, error, this.now() + 30000, j.id);
    if (j.streamId) await this.media.stopRecord(j.streamId).catch(() => {});
    if (j.sessionId)
      await this.live.leave(j.sessionId, j.ownerId, j.viewerId).catch(() => {});
  }
  async cancel(id, userId, admin = false) {
    const j = this.job(id, userId, admin);
    if (!admin && j.kind === "scheduled")
      throw Error("仅管理员可结束计划录像任务");
    if (this.locks.has(id)) throw Error("任务正在处理中，请稍后重试");
    this.locks.add(id);
    try {
      await this.finish(j, "cancelled", "用户结束任务");
    } finally {
      this.locks.delete(id);
    }
  }
  async process(j) {
    if (this.locks.has(j.id)) return;
    this.locks.add(j.id);
    try {
      if (j.status === "finalizing") {
        if (j.streamId) await this.discover(j);
        const count = this.db
          .prepare("SELECT count(*) AS n FROM recording_files WHERE jobId=?")
          .get(j.id).n;
        if (this.now() >= j.finalizeUntil) {
          const status =
            j.resultStatus === "succeeded" && !count
              ? "failed"
              : j.resultStatus || "failed";
          this.db
            .prepare(
              "UPDATE recording_jobs SET status=?,error=?,finishedAt=? WHERE id=?",
            )
            .run(
              status,
              j.error || (!count ? "未取得已完成的MP4文件" : null),
              iso(this.now()),
              j.id,
            );
        }
        return;
      }
      if (
        j.planId &&
        !this.db
          .prepare("SELECT enabled FROM recording_plans WHERE id=?")
          .get(j.planId)?.enabled
      )
        return await this.finish(j, "cancelled", "录像计划已停用");
      const source = j.sessionId
        ? this.live.snapshot(j.sessionId, j.ownerId, j.viewerId)
        : null;
      if (!source || ["failed", "stopped"].includes(source.state))
        return await this.finish(j, "failed", source?.error || "录像源已停止");
      if (
        source.state === "completed" &&
        j.kind === "download" &&
        !j.publishSeen
      )
        return await this.finish(
          j,
          "failed",
          "媒体发布回调未到达，无法确认完整导出",
        );
      if (source.state === "completed")
        return await this.finish(
          j,
          j.kind === "download" ? "succeeded" : "failed",
          j.kind === "download" ? null : "设备提前结束录像流",
        );
      if (this.now() >= j.deadline)
        return await this.finish(
          j,
          j.kind === "download" ? "failed" : "succeeded",
          j.kind === "download" ? "设备下载结束通知超时" : null,
        );
      this.live.renew(j.sessionId, j.ownerId, j.viewerId);
      if (j.status === "starting" && source.state === "ready") {
        if (j.kind === "download" && !j.publishSeen)
          throw Error("媒体发布回调未到达，已停止导出以免丢失录像开头");
        await this.media.startRecord(j.streamId, j.segmentSeconds);
        this.db
          .prepare(
            "UPDATE recording_jobs SET status='recording' WHERE id=? AND status='starting'",
          )
          .run(j.id);
      }
    } catch (error) {
      if (j.status === "finalizing") {
        if (this.now() > j.finalizeUntil)
          this.db
            .prepare(
              "UPDATE recording_jobs SET status='failed',error=?,finishedAt=? WHERE id=?",
            )
            .run("录像文件确认失败：" + error.message, iso(this.now()), j.id);
      } else await this.finish(j, "failed", error.message);
    } finally {
      this.locks.delete(j.id);
    }
  }
  async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      await Promise.all(
        this.db
          .prepare(
            "SELECT * FROM recording_jobs WHERE status IN ('starting','recording','finalizing')",
          )
          .all()
          .map((j) => this.process(j)),
      );
      const enabledPlans = this.db
        .prepare("SELECT * FROM recording_plans WHERE enabled=1")
        .all();
      for (const [id, reservation] of this.recoveryReservations) {
        if (
          reservation.until <= this.now() ||
          !enabledPlans.some((p) => p.id === id)
        )
          this.recoveryReservations.delete(id);
      }
      enabledPlans.sort(
        (a, b) =>
          Number(this.recoveryReservations.has(b.id)) -
            Number(this.recoveryReservations.has(a.id)) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
      for (const p of enabledPlans) {
        const o = occurrence(p, this.now());
        if (!o) continue;
        const last = this.db
          .prepare(
            "SELECT * FROM recording_jobs WHERE occurrence=? ORDER BY attempt DESC LIMIT 1",
          )
          .get(o.key);
        if (
          last &&
          !(last.status === "cancelled" && last.error === "录像计划已停用") &&
          (!["failed", "interrupted"].includes(last.status) ||
            this.now() - Date.parse(last.finishedAt || last.createdAt) <
              (last.status === "interrupted"
                ? 60000
                : Math.min(
                    300000,
                    60000 * 2 ** Math.min(3, Math.max(0, last.attempt - 1)),
                  )))
        )
          continue;
        // Keep capacity for interrupted recordings during their retry delay.
        // Otherwise newly added plans can occupy every slot before recovery is due.
        if (
          !this.recoveryReservations.has(p.id) &&
          this.recoveryReservations.size
        ) {
          const running = this.db
            .prepare(
              "SELECT ownerId,planId FROM recording_jobs WHERE status IN ('starting','recording','finalizing')",
            )
            .all();
          const waiting = [...this.recoveryReservations].filter(
            ([id]) => !running.some((j) => j.planId === id),
          );
          if (
            running.length + waiting.length >= 8 ||
            running.filter((j) => j.ownerId === p.ownerId).length +
              waiting.filter(([, r]) => r.ownerId === p.ownerId).length >=
              4
          )
            continue;
        }
        try {
          const created = this.create({
            ownerId: p.ownerId,
            channelId: p.channelId,
            kind: "scheduled",
            planId: p.id,
            occurrence: o.key,
            attempt: (last?.attempt || 0) + 1,
            start: iso(o.start),
            end: iso(o.end),
            deadline: o.end,
            retentionDays: p.retentionDays,
            segmentSeconds: p.segmentSeconds,
          });
          if (active.includes(created.status))
            this.recoveryReservations.delete(p.id);
        } catch {
          /* Capacity is reconsidered next tick. */
        }
      }
      if (!this.lastRetention || this.now() - this.lastRetention > 60000) {
        if (!this.retentionTask)
          this.retentionTask = this.retention().finally(() => {
            this.retentionTask = null;
          });
        this.lastRetention = this.now();
      }
      if (
        !this.discoveryTask &&
        (this.lastDiscovery === undefined ||
          this.now() - this.lastDiscovery >= 30000)
      ) {
        this.lastDiscovery = this.now();
        const recording = this.db
          .prepare(
            "SELECT * FROM recording_jobs WHERE kind='scheduled' AND status='recording' AND streamId IS NOT NULL",
          )
          .all();
        this.discoveryTask = Promise.allSettled(
          recording.map((job) => this.discover(job)),
        ).finally(() => {
          this.discoveryTask = null;
        });
      }
    } finally {
      this.ticking = false;
    }
  }
  async retention() {
    const files = this.db
      .prepare(
        "SELECT f.*,j.streamId FROM recording_files f JOIN recording_jobs j ON f.jobId=j.id WHERE j.status NOT IN ('starting','recording','finalizing') AND julianday(?)-julianday(COALESCE(j.finishedAt,j.createdAt))>=j.retentionDays ORDER BY j.createdAt,f.id LIMIT 20",
      )
      .all(iso(this.now()));
    await Promise.all(
      files.map(async (f) => {
        try {
          await this.media.deleteRecordFile(f.streamId, f);
          this.db.prepare("DELETE FROM recording_files WHERE id=?").run(f.id);
        } catch {}
      }),
    );
  }
  published(stream) {
    const j = this.db
      .prepare(
        "SELECT id,segmentSeconds FROM recording_jobs WHERE streamId=? AND status IN ('starting','recording')",
      )
      .get(stream);
    if (!j) return null;
    this.db
      .prepare("UPDATE recording_jobs SET publishSeen=1 WHERE id=?")
      .run(j.id);
    return j;
  }
  start() {
    if (this.timer) return;
    // Recover the established recordings first, including a recent interrupted
    // attempt. Reservations expire so an unavailable source cannot block new work.
    const candidates = [];
    for (const plan of this.db
      .prepare("SELECT * FROM recording_plans WHERE enabled=1")
      .all()) {
      const period = occurrence(plan, this.now());
      if (!period) continue;
      const latest = this.db
        .prepare(
          "SELECT status,resultStatus FROM recording_jobs WHERE planId=? AND occurrence=? ORDER BY attempt DESC LIMIT 1",
        )
        .get(plan.id, period.key);
      if (
        !latest ||
        ![
          "starting",
          "recording",
          "finalizing",
          "failed",
          "interrupted",
        ].includes(latest.status)
      )
        continue;
      if (
        latest.status === "finalizing" &&
        !["failed", "interrupted"].includes(latest.resultStatus)
      )
        continue;
      const previous = this.db
        .prepare(
          "SELECT min(j.createdAt) AS first FROM recording_jobs j WHERE j.planId=? AND j.occurrence=? AND (j.status IN ('starting','recording','finalizing') OR EXISTS(SELECT 1 FROM recording_files f WHERE f.jobId=j.id))",
        )
        .get(plan.id, period.key);
      if (previous.first)
        candidates.push({
          id: plan.id,
          ownerId: plan.ownerId,
          first: previous.first,
          until: Math.min(period.end, this.now() + 300000),
        });
    }
    const counts = new Map();
    for (const candidate of candidates.sort(
      (a, b) => a.first.localeCompare(b.first) || a.id.localeCompare(b.id),
    )) {
      const count = counts.get(candidate.ownerId) || 0;
      if (this.recoveryReservations.size >= 8 || count >= 4) continue;
      this.recoveryReservations.set(candidate.id, candidate);
      counts.set(candidate.ownerId, count + 1);
    }
    for (const job of this.db
      .prepare(
        "SELECT * FROM recording_jobs WHERE status IN ('starting','recording')",
      )
      .all())
      this.interruption(job, "服务重启，原任务已中断");
    this.db
      .prepare(
        "UPDATE recording_jobs SET status='finalizing',resultStatus='interrupted',error='服务重启，原任务已中断',finalizeUntil=? WHERE status IN ('starting','recording')",
      )
      .run(this.now() + 30000);
    this.db
      .prepare(
        "UPDATE recording_jobs SET finalizeUntil=? WHERE status='finalizing'",
      )
      .run(this.now() + 30000);
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    while (this.ticking) await new Promise((r) => setTimeout(r, 10));
    if (this.retentionTask) await this.retentionTask;
    if (this.discoveryTask) await this.discoveryTask;
    for (const j of this.db
      .prepare(
        "SELECT * FROM recording_jobs WHERE status IN ('starting','recording')",
      )
      .all())
      await this.finish(j, "interrupted", "服务关闭，任务已中断");
  }
}

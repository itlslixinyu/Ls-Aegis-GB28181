import { Access } from "./access.mjs";
import { randomUUID } from "node:crypto";
import { expectSuccess, xmlEscape } from "../sip/requests.mjs";
// Device timestamps without an offset are interpreted using this platform's configured local offset.
export function parseRecordTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(
      value,
    )
  )
    throw Error("录像时间格式无效");
  const parts = value
    .slice(0, 19)
    .match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)$/);
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (
    year < 1970 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw Error("录像日期或时间无效");
  const time = Date.parse(
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + "+08:00",
  );
  if (!Number.isFinite(time)) throw Error("录像时间无效");
  return time;
}
export function recordRange(start, end) {
  const a = parseRecordTime(start),
    b = parseRecordTime(end);
  if (b <= a || b - a > 86400000)
    throw Error("录像查询范围须大于0且不超过24小时");
  return { start: new Date(a).toISOString(), end: new Date(b).toISOString() };
}
export function deviceTime(value) {
  return new Date(parseRecordTime(value) + 8 * 3600000)
    .toISOString()
    .slice(0, 19);
}
export class RecordQueries {
  constructor({ db, sip, operations, timeout = 20000 }) {
    Object.assign(this, { db, sip, operations, timeout });
    this.access = new Access(db);
    this.pending = new Map();
    this.jobs = new Set();
  }
  create(channelId, userId, { start, end }) {
    this.access.requireChannel(userId, channelId);
    if (this.closing) throw Error("服务正在关闭");
    const range = recordRange(start, end);
    const channel = this.operations.channel(channelId);
    if (this.pending.size >= 32) throw Error("录像查询任务过多，请稍后重试");
    if (this.sip.state !== "listening") throw Error("SIP服务未启用");
    const id = randomUUID(),
      sn = String(++this.sip.seq);
    this.db
      .prepare("INSERT INTO record_queries VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        userId,
        channelId,
        "running",
        range.start,
        range.end,
        null,
        new Date().toISOString(),
      );
    const task = {
      id,
      sn,
      channel,
      range,
      items: new Map(),
      controller: new AbortController(),
      total: null,
    };
    task.timer = setTimeout(
      () => this.finish(sn, "failed", "设备录像查询超时"),
      this.timeout,
    );
    task.timer.unref();
    this.pending.set(sn, task);
    const body = `<Query><CmdType>RecordInfo</CmdType><SN>${sn}</SN><DeviceID>${channel.channelCode}</DeviceID><StartTime>${deviceTime(range.start)}</StartTime><EndTime>${deviceTime(range.end)}</EndTime><Secrecy>0</Secrecy><Type>all</Type></Query>`;
    const work = expectSuccess(
      this.sip.requests.request({
        uri: `sip:${channel.code}@${channel.remoteAddress}:${channel.remotePort}`,
        remote: channel,
        body,
        signal: task.controller.signal,
      }),
    ).catch((error) => this.finish(sn, "failed", error.message));
    this.jobs.add(work);
    work.finally(() => this.jobs.delete(work)).catch(() => {});
    return { taskId: id, status: "running" };
  }
  handle(device, xml) {
    const data = xml.Response;
    if (data?.CmdType !== "RecordInfo") return false;
    const task = this.pending.get(String(data.SN));
    if (
      !task ||
      task.channel.deviceId !== device.id ||
      data.DeviceID !== task.channel.channelCode
    )
      return false;
    const total = Number(data.SumNum);
    if (!Number.isInteger(total) || total < 0 || total > 10000) {
      this.finish(task.sn, "failed", "录像总数无效");
      return true;
    }
    if (task.total !== null && task.total !== total) {
      this.finish(task.sn, "failed", "录像总数不一致");
      return true;
    }
    task.total = total;
    const list = data.RecordList?.Item;
    try {
      for (const item of list ? (Array.isArray(list) ? list : [list]) : []) {
        if (item.DeviceID !== task.channel.channelCode)
          throw Error("录像通道不匹配");
        const fileStart = new Date(
            parseRecordTime(item.StartTime),
          ).toISOString(),
          fileEnd = new Date(parseRecordTime(item.EndTime)).toISOString();
        const start =
            fileStart < task.range.start ? task.range.start : fileStart,
          end = fileEnd > task.range.end ? task.range.end : fileEnd;
        if (start >= end) throw Error("录像时间范围错误");
        const key = JSON.stringify([
          item.FilePath || "",
          fileStart,
          fileEnd,
          item.Type || "all",
          item.RecorderID || "",
        ]);
        task.items.set(key, {
          name: String(item.Name || task.channel.name).slice(0, 200),
          filePath: String(item.FilePath || "").slice(0, 1000),
          start,
          end,
          type: String(item.Type || "all").slice(0, 32),
        });
      }
      if (task.items.size > total) throw Error("录像条目超过声明总数");
      if (task.items.size === total) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const item of task.items.values())
            this.db
              .prepare("INSERT INTO record_items VALUES(?,?,?,?,?,?,?,?)")
              .run(
                randomUUID(),
                task.id,
                task.channel.id,
                item.name,
                item.filePath,
                item.start,
                item.end,
                item.type,
              );
          this.db
            .prepare("UPDATE record_queries SET status='succeeded' WHERE id=?")
            .run(task.id);
          this.db.exec("COMMIT");
          this.finish(task.sn, "succeeded");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      }
    } catch (error) {
      this.finish(task.sn, "failed", error.message);
    }
    return true;
  }
  finish(sn, status, error = null) {
    const task = this.pending.get(sn);
    if (!task) return;
    clearTimeout(task.timer);
    this.pending.delete(sn);
    task.controller.abort();
    this.db
      .prepare("UPDATE record_queries SET status=?,error=? WHERE id=?")
      .run(status, error, task.id);
  }
  get(id, userId) {
    const row = this.db
      .prepare("SELECT * FROM record_queries WHERE id=? AND userId=?")
      .get(id, userId);
    if (!row) throw Error("录像查询不存在或无权访问");
    this.access.requireChannel(userId, row.channelId);
    return {
      ...row,
      items:
        row.status === "succeeded"
          ? this.db
              .prepare(
                "SELECT * FROM record_items WHERE queryId=? ORDER BY start,id",
              )
              .all(id)
          : [],
    };
  }
  async close() {
    this.closing = true;
    for (const sn of [...this.pending.keys()])
      this.finish(sn, "failed", "服务关闭，查询已中断");
    await Promise.all(this.jobs);
  }
}

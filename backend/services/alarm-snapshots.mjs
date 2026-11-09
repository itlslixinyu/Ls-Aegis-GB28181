import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { AiCapture } from "../ai/capture.mjs";
export class AlarmSnapshots {
  constructor({
    db,
    media,
    decode,
    enabled = process.env.ALARM_SNAPSHOT_ENABLED !== "0",
    cooldownMs = 30000,
  }) {
    Object.assign(this, { db, enabled, cooldownMs });
    this.decoder =
      decode ||
      ((stream, signal) =>
        new AiCapture({ media, lowPriority: true }).decode(stream, signal));
    this.current = null;
    this.recent = new Map();
    this.closed = false;
    db.prepare(
      "UPDATE alarm_snapshots SET status='failed',error='服务重启，抓图中断' WHERE status='capturing'",
    ).run();
    this.prune();
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref();
  }
  prune() {
    this.db
      .prepare("DELETE FROM alarm_snapshots WHERE requestedAt<?")
      .run(new Date(Date.now() - 7 * 86400000).toISOString());
    const rows = this.db
      .prepare(
        "SELECT id,length(image) bytes FROM alarm_snapshots WHERE image IS NOT NULL ORDER BY capturedAt DESC",
      )
      .all();
    let size = 0;
    for (let i = 0; i < rows.length; i++) {
      size += rows[i].bytes;
      if (i >= 500 || size > 100 * 1024 * 1024)
        this.db
          .prepare("DELETE FROM alarm_snapshots WHERE id=?")
          .run(rows[i].id);
    }
    for (const [key, v] of this.recent)
      if (Date.now() - v.at > this.cooldownMs) this.recent.delete(key);
  }
  schedule(alarmId, device, targetCode) {
    if (
      this.closed ||
      !this.enabled ||
      this.db
        .prepare("SELECT 1 FROM alarm_snapshot_links WHERE alarmId=?")
        .get(alarmId)
    )
      return;
    const channel = this.db
      .prepare("SELECT id FROM channels WHERE deviceId=? AND channelCode=?")
      .get(device.id, targetCode);
    const key = channel?.id || device.id;
    const recent = this.recent.get(key);
    if (
      recent &&
      Date.now() - recent.at < this.cooldownMs &&
      this.db.prepare("SELECT 1 FROM alarm_snapshots WHERE id=?").get(recent.id)
    ) {
      this.db
        .prepare("INSERT INTO alarm_snapshot_links VALUES(?,?)")
        .run(alarmId, recent.id);
      return;
    }
    const id = randomUUID(),
      stream =
        channel &&
        this.db
          .prepare(
            "SELECT streamId FROM live_sessions WHERE channelId=? AND kind IN ('live','recording') AND state='ready' AND released=0 ORDER BY createdAt DESC LIMIT 1",
          )
          .get(channel.id);
    const reason = this.current
      ? "抓图繁忙，已保护现有视频业务"
      : !stream
        ? "没有可复用的就绪视频源，未额外点播设备"
        : null;
    this.db
      .prepare("INSERT INTO alarm_snapshots VALUES(?,?,?,?,?,?)")
      .run(
        id,
        reason ? "skipped" : "capturing",
        reason,
        new Date().toISOString(),
        null,
        null,
      );
    this.db
      .prepare("INSERT INTO alarm_snapshot_links VALUES(?,?)")
      .run(alarmId, id);
    this.recent.set(key, { id, at: Date.now() });
    if (reason) return;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000);
    timer.unref();
    const job = { controller, promise: null };
    this.current = job;
    job.promise = Promise.resolve()
      .then(async () => {
        const raw = await this.decoder(stream.streamId, controller.signal);
        controller.signal.throwIfAborted();
        const image = await sharp(raw, { limitInputPixels: 16000000 })
          .resize({
            width: 960,
            height: 960,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 75 })
          .toBuffer();
        controller.signal.throwIfAborted();
        if (image.length > 512 * 1024) throw Error("抓图图片超出大小限制");
        if (!this.db.prepare("SELECT 1 FROM devices WHERE id=?").get(device.id))
          throw Error("设备已删除");
        this.db
          .prepare(
            "UPDATE alarm_snapshots SET status='ready',image=?,capturedAt=? WHERE id=?",
          )
          .run(image, new Date().toISOString(), id);
      })
      .catch(() => {
        this.db
          .prepare(
            "UPDATE alarm_snapshots SET status='failed',error=? WHERE id=?",
          )
          .run(
            controller.signal.aborted
              ? "抓图超时或已取消"
              : "抓图失败，请检查媒体流及FFmpeg配置",
            id,
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.current === job) this.current = null;
      });
  }
  get(alarmId) {
    const row = this.db
      .prepare(
        "SELECT s.id,s.status,s.error,s.requestedAt,s.capturedAt FROM alarm_snapshot_links l LEFT JOIN alarm_snapshots s ON s.id=l.snapshotId WHERE l.alarmId=?",
      )
      .get(alarmId);
    if (!row) return null;
    return {
      ...row,
      status: row.status || "expired",
      url:
        row.status === "ready"
          ? "/api/v1/alarms/" + alarmId + "/snapshot"
          : null,
    };
  }
  image(alarmId) {
    return this.db
      .prepare(
        "SELECT s.image FROM alarm_snapshot_links l JOIN alarm_snapshots s ON s.id=l.snapshotId WHERE l.alarmId=? AND s.status='ready'",
      )
      .get(alarmId)?.image;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.current?.controller.abort();
    await this.current?.promise;
  }
}

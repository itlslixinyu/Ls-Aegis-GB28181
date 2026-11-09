import { cpus, freemem } from "node:os";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { archiveTimestamp } from "./archive-reader.mjs";
import { prepareAiImage } from "./images.mjs";
import { LOCAL_VERSION, localModelReady, cosine } from "./local-model.mjs";
import { packVector, unpackVector } from "./history-samples.mjs";
export const INDEX_VERSION = LOCAL_VERSION + ":idle30-v1";
const iso = (n) => new Date(n).toISOString();
const cpu = () =>
  cpus().reduce(
    (s, c) => ({
      total: s.total + Object.values(c.times).reduce((a, b) => a + b, 0),
      idle: s.idle + c.times.idle,
    }),
    { total: 0, idle: 0 },
  );
// One durable frame per step. Decode/model work never runs inside a SQL transaction.
export class LocalIndex {
  constructor(h) {
    this.h = h;
    this.db = h.db;
    this.now = h.now;
    this.current = null;
    this.closed = false;
    this.reason = "等待空闲";
    this.lastScan = 0;
    this.lastCPU = cpu();
    this.cpuLoad = 0;
    this.lastProbe = 0;
    this.playbacks = 0;
    this.deferUntil = 0;
    this.db
      .prepare(
        "UPDATE ai_index_files SET state='pending' WHERE state='indexing'",
      )
      .run();
    this.timer = setInterval(
      () =>
        void this.tick().catch(() => {
          this.reason = "索引暂不可用，稍后重试";
        }),
      2000,
    );
    this.timer.unref();
  }
  config() {
    return this.h.ai.settings.state;
  }
  owner() {
    const id = this.config().indexOwnerId;
    return id &&
      this.h.access.can(id, "ai.configure") &&
      this.h.access.can(id, "ai.analyze") &&
      this.h.access.can(id, "recording.view")
      ? id
      : null;
  }
  blocked() {
    const h = this.h,
      db = this.db,
      s = this.config();
    if (this.closed || !s.indexEnabled || s.localEnabled === false)
      return "已暂停";
    if (!this.owner()) return "启用账号权限已变化";
    if (!h.injectedLocal && !localModelReady()) return "本地检索模型未就绪";
    if (
      h.running ||
      h.ai.running.size ||
      h.ai.alarmAnalysis?.current ||
      db
        .prepare(
          "SELECT 1 FROM ai_history_searches WHERE status IN ('queued','running') LIMIT 1",
        )
        .get() ||
      db
        .prepare(
          "SELECT 1 FROM ai_jobs WHERE status IN ('queued','running') LIMIT 1",
        )
        .get()
    )
      return "前台分析优先";
    if (
      this.playbacks ||
      this.now() < this.deferUntil ||
      db
        .prepare(
          "SELECT 1 FROM viewers v WHERE expiresAt>? AND NOT EXISTS(SELECT 1 FROM recording_jobs r WHERE r.viewerId=v.id AND r.status IN ('starting','recording','finalizing')) LIMIT 1",
        )
        .get(this.now())
    )
      return "预览与回放优先";
    if (
      db
        .prepare(
          "SELECT 1 FROM recording_jobs WHERE status IN ('starting','finalizing') LIMIT 1",
        )
        .get() ||
      db
        .prepare(
          "SELECT count(*) n FROM recording_jobs WHERE status='recording'",
        )
        .get().n >= 4
    )
      return "录像优先";
    if (h.injectedLocal) return null;
    if (this.now() - this.lastProbe > 2000) {
      const next = cpu(),
        delta = next.total - this.lastCPU.total;
      this.cpuLoad =
        delta > 0 ? 1 - (next.idle - this.lastCPU.idle) / delta : 0;
      this.lastCPU = next;
      this.lastProbe = this.now();
      const path = db.prepare("PRAGMA database_list").get()?.file;
      try {
        const v = statfsSync(dirname(path));
        this.diskFree = v.bavail * v.bsize;
      } catch {
        this.diskFree = 0;
      }
    }
    if (freemem() < 2 * 1024 ** 3) return "内存不足，等待空闲";
    if (this.cpuLoad > 0.45) return "CPU繁忙，等待空闲";
    if ((this.diskFree || 0) < 2 * 1024 ** 3) return "磁盘空间不足";
    return null;
  }
  status() {
    const db = this.db;
    return {
      enabled: !!this.config().indexEnabled,
      state: this.current ? "建立中" : this.reason,
      bytes: db.prepare("SELECT bytes FROM ai_index_storage WHERE id=1").get()
        .bytes,
      files: db
        .prepare("SELECT count(*) n FROM ai_index_files WHERE state='ready'")
        .get().n,
      pending: db
        .prepare(
          "SELECT count(*) n FROM ai_index_files WHERE state IN ('pending','indexing','error')",
        )
        .get().n,
      frames: db.prepare("SELECT count(*) n FROM ai_index_frames").get().n,
      capacityMiB: this.config().indexCapacityMiB,
      retentionDays: this.config().indexRetentionDays,
    };
  }
  async suspend() {
    const item = this.current;
    if (item) {
      item.controller.abort();
      await item.promise;
    }
  }
  maintain() {
    const s = this.config(),
      now = this.now(),
      cutoff = iso(now - s.indexRetentionDays * 86400000);
    // Recalculate expiry when retention changes, using the source recording time.
    const signature = s.indexCapacityMiB + ":" + s.indexRetentionDays;
    if (this.signature !== signature) {
      for (const row of this.db
        .prepare("SELECT fileId FROM ai_index_files")
        .all()) {
        const source = this.h.file(row.fileId),
          at = source && archiveTimestamp(source);
        if (at !== null && at !== undefined)
          this.db
            .prepare("UPDATE ai_index_files SET expiresAt=? WHERE fileId=?")
            .run(at + s.indexRetentionDays * 86400000, row.fileId);
      }
      if (this.signature)
        this.db
          .prepare(
            "UPDATE ai_index_files SET state='pending',retryAt=0 WHERE state='evicted'",
          )
          .run();
      this.signature = signature;
    }
    // Bounded cleanup avoids a large BLOB purge blocking the platform event loop.
    const expired = this.db
      .prepare("SELECT fileId FROM ai_index_files WHERE expiresAt<=? LIMIT 1")
      .get(now);
    if (expired) {
      this.db
        .prepare(
          "DELETE FROM ai_index_frames WHERE rowid IN (SELECT rowid FROM ai_index_frames WHERE fileId=? LIMIT 32)",
        )
        .run(expired.fileId);
      this.db
        .prepare(
          "DELETE FROM ai_index_files WHERE fileId=? AND NOT EXISTS(SELECT 1 FROM ai_index_frames WHERE fileId=?)",
        )
        .run(expired.fileId, expired.fileId);
    }
    return this.room(0);
  }
  room(extra, exclude = "") {
    const limit = this.config().indexCapacityMiB * 1048576;
    if (
      this.db.prepare("SELECT bytes FROM ai_index_storage WHERE id=1").get()
        .bytes +
        extra >
      limit
    ) {
      const old = this.db
        .prepare(
          "SELECT fileId FROM ai_index_files WHERE fileId!=? AND EXISTS(SELECT 1 FROM ai_index_frames f WHERE f.fileId=ai_index_files.fileId) ORDER BY updatedAt LIMIT 1",
        )
        .get(exclude);
      if (!old) return false;
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare(
            "DELETE FROM ai_index_frames WHERE rowid IN (SELECT rowid FROM ai_index_frames WHERE fileId=? LIMIT 32)",
          )
          .run(old.fileId);
        this.db
          .prepare(
            "UPDATE ai_index_files SET state='evicted',nextOffset=0,pendingOffsets='[]',scanEnd=0,retryAt=? WHERE fileId=?",
          )
          .run(this.now() + 86400000, old.fileId);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    return (
      this.db.prepare("SELECT bytes FROM ai_index_storage WHERE id=1").get()
        .bytes +
        extra <=
      limit
    );
  }
  async tick() {
    if (this.current || this.closed) return;
    const reason = this.blocked();
    this.reason = reason || "等待新录像";
    if (reason) return;
    if (!this.maintain()) {
      this.reason = "容量整理中";
      return;
    }
    const owner = this.owner(),
      now = this.now();
    if (
      !this.files ||
      this.scanOwner !== owner ||
      this.scanSignature !== this.signature ||
      now - this.lastScan >= 30000
    ) {
      this.files = this.h.inventory(owner, {
        from: iso(now - this.config().indexRetentionDays * 86400000),
        to: iso(now),
        channelIds: [],
      }).files;
      this.lastScan = now;
      this.scanOwner = owner;
      this.scanSignature = this.signature;
    }
    const rows = new Map(
      this.db
        .prepare("SELECT fileId,state,retryAt,updatedAt FROM ai_index_files")
        .all()
        .map((r) => [r.fileId, r]),
    );
    // Finish one file per channel before opening its next file; rotate channels
    // between frames, so a long archive cannot monopolize background time.
    const heads = new Map(),
      revalidate = [];
    for (const source of this.files) {
      if (source.timestamp < now - this.config().indexRetentionDays * 86400000)
        continue;
      const index = rows.get(source.id),
        entry = { ...source, index };
      if (index?.state === "ready") {
        if (index.updatedAt < now - 3600000) revalidate.push(entry);
      } else if (!index || index.retryAt <= now) {
        const old = heads.get(source.channelId);
        if (!old || source.timestamp < old.timestamp)
          heads.set(source.channelId, entry);
      }
    }
    const queue = heads.size ? [...heads.values()] : revalidate;
    const file = queue.sort(
      (a, b) =>
        (a.index?.updatedAt || 0) - (b.index?.updatedAt || 0) ||
        a.timestamp - b.timestamp,
    )[0];
    if (!file) return;
    if (!this.h.file(file.id)) {
      this.files = null;
      return;
    }
    const item = { controller: new AbortController(), promise: null };
    this.current = item;
    item.promise = this.step(file, owner, item.controller).finally(() => {
      if (this.current === item) this.current = null;
    });
    await item.promise;
  }
  async step(file, owner, controller) {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45000),
    ]);
    const check = () => {
      signal.throwIfAborted();
      const reason = this.blocked();
      if (
        reason ||
        this.owner() !== owner ||
        !this.h.allowed(owner, this.h.file(file.id))
      )
        throw Error("资源或权限变化");
    };
    const monitor = setInterval(() => {
      if (this.blocked() || !this.h.allowed(owner, this.h.file(file.id)))
        controller.abort();
    }, 250);
    monitor.unref();
    try {
      check();
      const version = await this.h.reader.fingerprint(file, signal);
      check();
      if (!version) throw Error("缺少稳定文件版本");
      file.sourceVersion = version + ":sample960-v1";
      let row = this.db
        .prepare("SELECT * FROM ai_index_files WHERE fileId=?")
        .get(file.id);
      if (
        row &&
        (row.sourceVersion !== file.sourceVersion ||
          row.modelVersion !== INDEX_VERSION)
      ) {
        this.db
          .prepare("DELETE FROM ai_index_files WHERE fileId=?")
          .run(file.id);
        row = null;
      }
      if (row?.state === "ready") {
        this.db
          .prepare("UPDATE ai_index_files SET updatedAt=? WHERE fileId=?")
          .run(this.now(), file.id);
        return;
      }
      if (!row) {
        const duration = await this.h.reader.duration(file, signal);
        check();
        if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
          throw Error("录像时长无效");
        this.db
          .prepare(
            "INSERT INTO ai_index_files(fileId,sourceVersion,modelVersion,duration,updatedAt,expiresAt) VALUES(?,?,?,?,?,?)",
          )
          .run(
            file.id,
            file.sourceVersion,
            INDEX_VERSION,
            duration,
            this.now(),
            file.timestamp + this.config().indexRetentionDays * 86400000,
          );
        row = this.db
          .prepare("SELECT * FROM ai_index_files WHERE fileId=?")
          .get(file.id);
      }
      file.duration = row.duration;
      // ffprobe durations often include a fractional tail after the last frame.
      // Complete the sparse index without asking motion/FFmpeg for a subsecond window.
      if (
        row.nextOffset > 0 &&
        row.duration - row.nextOffset < 1 &&
        JSON.parse(row.pendingOffsets).length === 0
      ) {
        this.db
          .prepare(
            "UPDATE ai_index_files SET nextOffset=duration,state='ready',updatedAt=?,retryAt=0 WHERE fileId=?",
          )
          .run(this.now(), file.id);
        return;
      }
      this.db
        .prepare("UPDATE ai_index_files SET state='indexing' WHERE fileId=?")
        .run(file.id);
      let offsets = JSON.parse(row.pendingOffsets),
        scanEnd = row.scanEnd;
      if (!offsets.length) {
        const start = row.nextOffset;
        scanEnd = Math.min(row.duration, start + 30);
        const events = this.h
          .deviceEventCues(file, start, scanEnd)
          .events.map((e) => e.offset);
        if (this.h.reader.motion && scanEnd - start >= 1) {
          const motion = await this.h.reader.motion(
            file,
            start,
            scanEnd,
            signal,
          );
          check();
          events.push(
            ...motion.events
              .filter(
                (e) =>
                  Number.isFinite(e.offset) &&
                  e.offset >= start &&
                  e.offset < scanEnd,
              )
              .map((e) => e.offset),
          );
        }
        // One change representative per 5 seconds plus a regular safety frame.
        const bins = new Set();
        offsets = [
          start,
          ...events
            .sort((a, b) => a - b)
            .filter((at) => {
              const bin = Math.floor(at / 5);
              if (bins.has(bin)) return false;
              bins.add(bin);
              return true;
            }),
        ];
        offsets = [
          ...new Set(
            offsets.map(
              (at) =>
                Math.round(
                  Math.min(at, Math.max(0, row.duration - 0.1)) * 100,
                ) / 100,
            ),
          ),
        ].sort((a, b) => a - b);
        this.db
          .prepare(
            "UPDATE ai_index_files SET pendingOffsets=?,scanEnd=? WHERE fileId=?",
          )
          .run(JSON.stringify(offsets), scanEnd, file.id);
      }
      const offset = offsets[0];
      const cached =
        this.h.cache.get(file.id, file.sourceVersion, offset) ||
        this.h.samples.reuse(file, offset);
      const prepared =
        cached ||
        (await prepareAiImage(
          await this.h.reader.frame(file, offset, signal),
          960,
        ));
      check();
      const vector =
        cached?.embedding ||
        (
          await this.h.local.run(
            { image: prepared.image.toString("base64") },
            signal,
          )
        ).embedding;
      check();
      if (vector.length !== 512 || vector.some((n) => !Number.isFinite(n)))
        throw Error("索引特征无效");
      const bytes = prepared.image.length + 2048 + 128;
      if (!this.room(bytes, file.id)) {
        this.reason = "容量已满";
        this.db
          .prepare(
            "UPDATE ai_index_files SET state='evicted',retryAt=?,updatedAt=? WHERE fileId=?",
          )
          .run(this.now() + 86400000, this.now(), file.id);
        return;
      }
      const remaining = offsets.slice(1);
      const next = remaining.length ? row.nextOffset : scanEnd;
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ai_index_frames VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            file.id,
            offset,
            prepared.image,
            prepared.hash,
            prepared.width,
            prepared.height,
            packVector(vector),
          );
        this.db
          .prepare(
            "UPDATE ai_index_files SET nextOffset=?,state=?,updatedAt=?,retryAt=0,pendingOffsets=?,scanEnd=? WHERE fileId=?",
          )
          .run(
            next,
            next >= row.duration ? "ready" : "pending",
            this.now(),
            JSON.stringify(remaining),
            scanEnd,
            file.id,
          );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.reason = "等待空闲";
    } catch (e) {
      this.reason = controller.signal.aborted
        ? "前台业务优先，进度已保存"
        : "稍后重试";
      if (this.h.file(file.id))
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ai_index_files(fileId,sourceVersion,modelVersion,duration,updatedAt,expiresAt) VALUES(?,'',?,0,?,?)",
          )
          .run(
            file.id,
            INDEX_VERSION,
            this.now(),
            this.now() + this.config().indexRetentionDays * 86400000,
          );
      this.db
        .prepare(
          "UPDATE ai_index_files SET state=?,retryAt=?,updatedAt=? WHERE fileId=? AND state!='ready'",
        )
        .run(
          controller.signal.aborted ? "pending" : "error",
          controller.signal.aborted ? 0 : this.now() + 60000,
          this.now(),
          file.id,
        );
    } finally {
      clearInterval(monitor);
    }
  }
  compatible(file) {
    return (
      file.sourceVersion &&
      this.db
        .prepare(
          "SELECT * FROM ai_index_files WHERE fileId=? AND sourceVersion=? AND modelVersion=? AND expiresAt>?",
        )
        .get(file.id, file.sourceVersion, INDEX_VERSION, this.now())
    );
  }
  get(file, offset) {
    if (!this.compatible(file)) return null;
    const r = this.db
      .prepare("SELECT * FROM ai_index_frames WHERE fileId=? AND offset=?")
      .get(file.id, offset);
    return r
      ? {
          image: Buffer.from(r.image),
          hash: r.imageHash,
          width: r.width,
          height: r.height,
          embedding: unpackVector(r.embedding),
        }
      : null;
  }
  ranked(file, begin, end, embedding) {
    if (!this.compatible(file)) return [];
    const best = [];
    for (const row of this.db
      .prepare(
        "SELECT offset,embedding FROM ai_index_frames WHERE fileId=? AND offset>=? AND offset<?",
      )
      .iterate(file.id, begin, end)) {
      const vector = unpackVector(row.embedding);
      if (!vector || vector.some((n) => !Number.isFinite(n))) continue;
      best.push({ offset: row.offset, score: cosine(embedding, vector) });
      best.sort((a, b) => b.score - a.score);
      best.splice(24);
    }
    return best;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.suspend();
  }
}

import { randomUUID } from "node:crypto";
import { LOCAL_VERSION } from "./local-model.mjs";
import { aiProblem } from "./settings.mjs";
export const SAMPLE_MODEL_VERSION = LOCAL_VERSION + ":sample960-v1";
export const packVector = (vector) => {
  const out = Buffer.alloc(512 * 4);
  vector.forEach((v, i) => out.writeFloatLE(v, i * 4));
  return out;
};
export const unpackVector = (bytes) => {
  const b = Buffer.from(bytes);
  return b.length === 2048
    ? Array.from({ length: 512 }, (_, i) => b.readFloatLE(i * 4))
    : null;
};
export class HistorySamples {
  constructor(history) {
    this.h = history;
    this.db = history.db;
    this.bytes = 0;
    this.maxBytes = 2 * 1024 ** 3;
  }
  resetStorage() {
    this.bytes = this.db
      .prepare("SELECT bytes FROM ai_analysis_storage WHERE id=1")
      .get().bytes;
  }
  frame(job, file, offset) {
    const row=this.db.prepare('SELECT * FROM ai_history_samples WHERE searchId=? AND fileId=? AND offset=? LIMIT 1').get(job.id,file.id,offset);
    if(!row)return null;
    const embedding=unpackVector(row.embedding);
    if(!embedding||embedding.some(x=>!Number.isFinite(x)))return null;
    return {file,offset:row.offset,capturedAt:row.capturedAt,sampleId:row.id,image:Buffer.from(row.image),hash:row.imageHash,width:row.width,height:row.height,embedding};
  }
  reuse(file, offset) {
    if (!file.sourceVersion) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM ai_history_samples WHERE fileId=? AND sourceVersion=? AND modelVersion=? AND offset=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(file.id, file.sourceVersion, SAMPLE_MODEL_VERSION, offset);
    if (!row) return null;
    const embedding = unpackVector(row.embedding);
    if (!embedding || embedding.some((x) => !Number.isFinite(x))) return null;
    return {
      image: Buffer.from(row.image),
      hash: row.imageHash,
      width: row.width,
      height: row.height,
      embedding,
    };
  }
  insert(job, frame, reason) {
    this.resetStorage();
    const needed = frame.image.length + 2048;
    if (this.bytes + needed > this.maxBytes)
      throw aiProblem(
        409,
        "AI_ANALYSIS_STORAGE_FULL",
        "分析存储空间不足，已保留完成的画面，请清理历史分析后继续",
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO ai_history_samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        job.id,
        frame.file.id,
        frame.file.sourceVersion,
        SAMPLE_MODEL_VERSION,
        frame.offset,
        frame.capturedAt,
        reason,
        frame.image,
        frame.hash,
        frame.width,
        frame.height,
        packVector(frame.embedding),
        frame.rankScore,
        new Date(this.h.now()).toISOString(),
      );
    this.bytes += needed;
    return id;
  }
  row(user, searchId, id) {
    this.h.require(user);
    const row = this.db
      .prepare(
        "SELECT s.* FROM ai_history_samples s JOIN ai_history_searches q ON q.id=s.searchId WHERE s.id=? AND s.searchId=? AND q.ownerId=? AND q.expiresAt>?",
      )
      .get(id, searchId, user, new Date(this.h.now()).toISOString());
    if (!row || !this.h.allowed(user, this.h.file(row.fileId)))
      throw aiProblem(
        404,
        "AI_SAMPLE_NOT_FOUND",
        "分析画面不存在、已过期或无权访问",
      );
    return row;
  }
  public(row) {
    const file = this.h.file(row.fileId);
    return {
      id: row.id,
      historySample: { searchId: row.searchId, reason: row.reason },
      sourceType: "channel",
      sourceName: file.channelName,
      channelId: file.channelId,
      status: "succeeded",
      question: "",
      model: LOCAL_VERSION,
      usage: null,
      createdAt: row.createdAt,
      capturedAt: row.capturedAt,
      width: row.width,
      height: row.height,
      imageUrl: `/api/v1/ai/history-searches/${row.searchId}/samples/${row.id}/image`,
      result: {
        summary: "录像采样画面",
        tags: [],
        objects: [],
        observations: [],
      },
      error: null,
      recording: {
        fileId: file.id,
        jobId: file.jobId,
        name: file.name,
        offsetSeconds: row.offset,
        url: `/api/v1/recording-jobs/${file.jobId}/files/${file.id}?play=1`,
      },
      score: null,
      visualScore: null,
      textScore: 0,
      matchedTerms: [],
    };
  }
  list(user, id, page = 1) {
    this.h.require(user);
    this.h.ai.pagination(page, 12);
    const query = this.db
      .prepare("SELECT ownerId,expiresAt FROM ai_history_searches WHERE id=?")
      .get(id);
    if (
      !query ||
      query.ownerId !== user ||
      query.expiresAt <= new Date(this.h.now()).toISOString()
    )
      throw aiProblem(
        404,
        "HISTORY_SEARCH_NOT_FOUND",
        "分析记录不存在或无权访问",
      );
    const where = `s.searchId=? AND ${this.h.access.sql(user, "c.deviceId")} AND (r.kind='scheduled' OR r.ownerId=? OR ?=1)`;
    const join =
      " FROM ai_history_samples s JOIN recording_files f ON f.id=s.fileId JOIN recording_jobs r ON r.id=f.jobId JOIN channels c ON c.id=r.channelId ";
    const args = [id, user, Number(this.h.access.admin(user))];
    const total = this.db
      .prepare("SELECT count(*) n" + join + "WHERE " + where)
      .get(...args).n;
    const rows = this.db
      .prepare(
        "SELECT s.id,s.searchId,s.fileId,s.offset,s.capturedAt,s.reason,s.width,s.height,s.createdAt" +
          join +
          "WHERE " +
          where +
          " ORDER BY s.capturedAt,s.rowid LIMIT 12 OFFSET ?",
      )
      .all(...args, (page - 1) * 12);
    return { items: rows.map((r) => this.public(r)), total, page };
  }
}

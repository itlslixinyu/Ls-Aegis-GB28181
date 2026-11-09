import { LocalIndex } from "./local-index.mjs";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { AiArchiveReader, archiveTimestamp } from "./archive-reader.mjs";
import { aiProblem } from "./settings.mjs";
import {
  LocalModel,
  LOCAL_VERSION,
  LOCAL_STARTUP_MIB,
  localModelReady,
  localText,
  cosine,
} from "./local-model.mjs";
import { FeatureCache } from "./feature-cache.mjs";
import { freemem } from "node:os";
import { HistorySamples } from "./history-samples.mjs";
import { analyzeHistory } from "./history-analysis.mjs";
import { QueryCache, parseLocalQuery } from "./query-cache.mjs";
const iso = (ms) => new Date(ms).toISOString();
const pending = ["queued", "running"];
export class AiHistory {
  constructor({ ai, media, reader, localModel, now = () => Date.now() }) {
    Object.assign(this, { ai, db: ai.db, access: ai.access, now });
    this.reader = reader || new AiArchiveReader(media);
    this.local = localModel || new LocalModel();
    this.injectedLocal = !!localModel;
    this.cache = new FeatureCache(ai.db, now);
    this.queryCache = new QueryCache(ai.db, now);
    this.samples = new HistorySamples(this);
    this.index = new LocalIndex(this);
    this.closed = false;
    this.running = null;
    this.db
      .prepare(
        "UPDATE ai_history_searches SET status='interrupted',phase='finished',error='平台重启，检索已中断，可重新发起',finishedAt=? WHERE status IN ('queued','running')",
      )
      .run(iso(now()));
    this.timer = setInterval(() => void this.drain().catch(() => {}), 1500);
    this.timer.unref();
  }
  require(user) {
    this.ai.require(user);
    this.ai.require(user, "recording.view");
  }
  file(id) {
    return this.db
      .prepare(
        "SELECT f.*,r.streamId,r.channelId,r.ownerId,r.kind,r.status jobStatus,r.segmentSeconds,c.name channelName,c.deviceId FROM recording_files f JOIN recording_jobs r ON r.id=f.jobId JOIN channels c ON c.id=r.channelId WHERE f.id=?",
      )
      .get(id);
  }
  allowed(user, file) {
    return (
      !!file &&
      this.access.can(user, "recording.view") &&
      this.access.channel(user, file.channelId) &&
      (file.kind === "scheduled" ||
        file.ownerId === user ||
        this.access.admin(user))
    );
  }
  valid(row) {
    return (
      this.access.can(row.ownerId, "ai.analyze") &&
      this.allowed(row.ownerId, this.file(row.recordingFileId))
    );
  }
  inventory(user, params) {
    const files = this.db
      .prepare(
        `SELECT f.*,r.streamId,r.channelId,r.ownerId,r.kind,r.status jobStatus,r.segmentSeconds,c.name channelName,c.deviceId FROM recording_files f JOIN recording_jobs r ON r.id=f.jobId JOIN channels c ON c.id=r.channelId WHERE r.streamId IS NOT NULL AND r.status!='finalizing' AND f.date>=? AND f.date<=? AND ${this.access.sql(user, "c.deviceId")} ORDER BY f.date,f.name`,
      )
      .all(
        iso(Date.parse(params.from) - 86400000 + 8 * 3600000).slice(0, 10),
        iso(Date.parse(params.to) + 8 * 3600000).slice(0, 10),
      );
    let unparsed = false;
    const seen = new Set(),
      before = new Map(),
      inside = [];
    for (const f of files) {
      if (
        !this.allowed(user, f) ||
        (params.channelIds.length && !params.channelIds.includes(f.channelId))
      )
        continue;
      const start = archiveTimestamp(f);
      if (start === null) {
        unparsed = true;
        continue;
      }
      if (start > Date.parse(params.to)) continue;
      // Leave the open tail of an active recording untouched.
      if (
        ["starting", "recording"].includes(f.jobStatus) &&
        this.now() < start + (Math.max(30, f.segmentSeconds || 900) + 60) * 1000
      )
        continue;
      const key = f.streamId + ":" + f.date + ":" + f.name;
      if (seen.has(key)) continue;
      seen.add(key);
      f.timestamp = start;
      if (start < Date.parse(params.from)) {
        const old = before.get(f.channelId);
        if (!old || old.timestamp < start) before.set(f.channelId, f);
      } else inside.push(f);
    }
    return {
      files: [...before.values(), ...inside].sort(
        (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
      ),
      truncated: unparsed,
    };
  }
  create(user, value, key) {
    this.require(user);
    this.ai.require(user, "ai.analyze");
    if (this.ai.settings.state.localEnabled === false)
      throw aiProblem(409, "AI_DISABLED", "请先启用本地接入");
    if (!this.injectedLocal && !localModelReady())
      throw aiProblem(
        503,
        "AI_LOCAL_NOT_READY",
        "本地检索模型未安装，请先运行 npm run ai:setup",
      );
    if (value?.verify !== undefined && typeof value.verify !== "boolean")
      throw aiProblem(400, "INVALID_HISTORY_SEARCH", "复核选项格式错误");
    if (
      !value ||
      typeof value.question !== "string" ||
      value.question.length > 500 ||
      typeof value.from !== "string" ||
      typeof value.to !== "string" ||
      !Number.isFinite(Date.parse(value.from)) ||
      !Number.isFinite(Date.parse(value.to)) ||
      Date.parse(value.to) <= Date.parse(value.from) ||
      Date.parse(value.to) - Date.parse(value.from) > 86400000 ||
      !Array.isArray(value.channelIds) ||
      value.channelIds.length > 64 ||
      value.channelIds.some((c) => typeof c !== "string" || c.length > 200) ||
      typeof (value.referenceId || "") !== "string" ||
      (value.referenceId || "").length > 100 ||
      (key !== undefined &&
        (typeof key !== "string" || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)))
    )
      throw aiProblem(
        400,
        "INVALID_HISTORY_SEARCH",
        "请选择有效通道与起止时间；每次最多检索24小时、64个通道",
      );
    const params = {
      question: value.question.trim(),
      from: iso(Date.parse(value.from)),
      to: iso(Date.parse(value.to)),
      channelIds: [...new Set(value.channelIds)].sort(),
      referenceId: value.referenceId || "",
      verify:
        value.verify === true ||
        (value.verify === undefined &&
          this.ai.settings.state.enabled &&
          this.ai.settings.public().hasKey),
    };
    if (!params.referenceId && params.question) localText(params.question);
    if (
      params.verify &&
      (!this.ai.settings.state.enabled || !this.ai.settings.public().hasKey)
    )
      throw aiProblem(
        409,
        "AI_KEY_REQUIRED",
        "DeepSeek复核需要密钥，也可关闭复核使用本地候选检索",
      );
    if (!params.question && !params.referenceId)
      throw aiProblem(
        400,
        "HISTORY_CLUE_REQUIRED",
        "请输入查找线索或选择参考图片",
      );
    for (const id of params.channelIds)
      if (!this.access.channel(user, id))
        throw aiProblem(404, "AI_CHANNEL_NOT_FOUND", "通道不存在或无权访问");
    if (params.referenceId) {
      const reference = this.referenceJob(user, params.referenceId);
      if (reference.status !== "succeeded" || !reference.imageUrl)
        throw aiProblem(409, "AI_REFERENCE_PENDING", "参考画面尚未完成分析");
    }
    const inventory = this.inventory(user, params),
      requestHash = createHash("sha256")
        .update(
          JSON.stringify({
            params,
            files: inventory.files.map((f) => f.id),
            model: [LOCAL_VERSION, this.ai.settings.state.model],
          }),
        )
        .digest("hex");
    if (!inventory.files.length)
      throw aiProblem(
        409,
        "HISTORY_NO_RECORDINGS",
        "所选时段没有平台录像，请调整时间或通道",
      );
    const duplicate = key
      ? this.db
          .prepare(
            "SELECT id,requestHash FROM ai_history_searches WHERE ownerId=? AND requestKey=?",
          )
          .get(user, key)
      : null;
    if (duplicate) {
      if (duplicate.requestHash !== requestHash)
        throw aiProblem(
          409,
          "AI_IDEMPOTENCY_CONFLICT",
          "该请求标识已用于其他检索或录像范围已更新",
        );
      return this.get(user, duplicate.id);
    }
    const cached = this.db
      .prepare(
        "SELECT id FROM ai_history_searches WHERE ownerId=? AND requestHash=? AND status IN ('queued','running') AND expiresAt>? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(user, requestHash, iso(this.now()));
    if (cached) return { ...this.get(user, cached.id), reused: true };
    if (
      this.db
        .prepare(
          "SELECT count(*) n FROM ai_history_searches WHERE status IN ('queued','running')",
        )
        .get().n >= 3 ||
      this.db
        .prepare(
          "SELECT 1 FROM ai_history_searches WHERE ownerId=? AND status IN ('queued','running')",
        )
        .get(user)
    )
      throw aiProblem(
        429,
        "HISTORY_QUEUE_FULL",
        "已有录像检索进行中，请等待或取消后重试",
      );
    const id = randomUUID(),
      createdAt = iso(this.now());
    this.db
      .prepare(
        "INSERT INTO ai_history_searches(id,ownerId,requestKey,requestHash,params,status,candidateFiles,truncated,createdAt,expiresAt) VALUES(?,?,?,?,?,'queued',?,?,?,?)",
      )
      .run(
        id,
        user,
        key || randomUUID(),
        requestHash,
        JSON.stringify(params),
        inventory.files.length,
        Number(inventory.truncated),
        createdAt,
        iso(this.now() + this.ai.settings.state.retentionDays * 86400000),
      );
    void this.drain();
    return this.get(user, id);
  }
  get(user, id, page = 1, view = "matches") {
    this.require(user);
    this.ai.pagination(page, 12);
    if (!["matches", "samples"].includes(view))
      throw aiProblem(400, "INVALID_AI_QUERY", "结果类型无效");
    const row = this.db
      .prepare(
        "SELECT * FROM ai_history_searches WHERE id=? AND ownerId=? AND expiresAt>?",
      )
      .get(id, user, iso(this.now()));
    if (!row)
      throw aiProblem(
        404,
        "HISTORY_SEARCH_NOT_FOUND",
        "录像检索不存在、已过期或无权访问",
      );
    const matches = this.db
      .prepare(
        "SELECT analysisId FROM ai_history_matches WHERE searchId=? ORDER BY rowid",
      )
      .all(id);
    const results = [];
    for (const m of matches) {
      try {
        results.push({
          ...this.ai.get(user, m.analysisId),
          score: null,
          textScore: 0,
          visualScore: null,
          matchedTerms: [],
        });
      } catch {}
    }
    const { ownerId, requestKey, requestHash, ...safe } = row;
    const params = JSON.parse(row.params),
      metrics = JSON.parse(row.localMetrics || "{}");
    const sampleData = this.samples.list(user, id, page);
    const legacy = !sampleData.total && metrics.mode !== "stream";
    const useSamples = view === "samples" && !legacy;
    return {
      ...safe,
      params,
      truncated: !!row.truncated,
      total: useSamples ? sampleData.total : results.length,
      page,
      items: useSamples
        ? sampleData.items
        : results.slice((page - 1) * 12, page * 12),
      analyzedCount: sampleData.total,
      matchedCount: results.length,
      localMetrics: metrics,
      method: params.verify === false ? "相似画面" : "复核候选",
      limits: {
        batched: true,
        sampleIntervalSeconds: metrics.sampleIntervalSeconds || 10,
        maxModelCalls: 1,
      },
    };
  }
  cancel(user, id) {
    this.require(user);
    this.ai.require(user, "ai.analyze");
    const job = this.get(user, id);
    if (pending.includes(job.status)) {
      if (this.running?.id === id) this.running.controller.abort();
      this.db
        .prepare(
          "UPDATE ai_history_searches SET status='cancelled',phase='finished',error='检索已取消',finishedAt=? WHERE id=? AND status IN ('queued','running')",
        )
        .run(iso(this.now()), id);
    }
    return this.get(user, id);
  }
  async drain() {
    if (this.closed || this.running) return;
    for (const table of [
      "ai_feature_cache",
      "ai_duration_cache",
      "ai_verification_cache",
      "ai_motion_cache",
      "ai_query_cache",
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE expiresAt<=?`)
        .run(iso(this.now()));
    this.db
      .prepare(
        "DELETE FROM ai_history_searches WHERE expiresAt<=? AND status NOT IN ('queued','running')",
      )
      .run(iso(this.now()));
    const job = this.db
      .prepare(
        "SELECT * FROM ai_history_searches WHERE status='queued' ORDER BY createdAt,rowid LIMIT 1",
      )
      .get();
    if (!job) return;
    const controller = new AbortController(),
      item = { id: job.id, controller, promise: null };
    this.running = item;
    item.promise = (async () => {
      if (this.index.current) await this.index.suspend();
      return this.work(job, controller);
    })().finally(() => {
      this.running = null;
    });
  }
  guard(job, signal) {
    signal.throwIfAborted();
    this.require(job.ownerId);
    this.ai.require(job.ownerId, "ai.analyze");
    if (this.ai.settings.state.localEnabled === false)
      throw aiProblem(409, "AI_DISABLED", "本地接入已停用");
  }
  async capacity(job, signal, needsModel = false) {
    while (true) {
      this.guard(job, signal);
      const recordings = this.db
          .prepare(
            "SELECT count(*) n FROM recording_jobs WHERE status IN ('starting','recording','finalizing')",
          )
          .get().n,
        viewers = this.db
          .prepare("SELECT count(*) n FROM viewers WHERE expiresAt>?")
          .get(this.now()).n;
      if (
        !this.ai.alarmAnalysis?.current &&
        !this.ai.running.size &&
        !this.db
          // Qwen already yields to this history search. Do not wait on its
          // queued jobs here, otherwise both queues wait for each other.
          .prepare(
            "SELECT 1 FROM ai_jobs a WHERE status='queued' AND coalesce(model,'') NOT LIKE 'local-qwen%' AND NOT EXISTS(SELECT 1 FROM alarm_ai_jobs q WHERE q.jobId=a.id) LIMIT 1",
          )
          .get() &&
        recordings < 4 &&
        viewers < 9 &&
        (this.injectedLocal ||
          freemem() >
            1024 ** 3 +
              (needsModel && !this.local.child
                ? LOCAL_STARTUP_MIB * 1024 ** 2
                : 0))
      )
        return;
      this.db
        .prepare(
          "UPDATE ai_history_searches SET phase='waiting-resources' WHERE id=?",
        )
        .run(job.id);
      await wait(1500, undefined, { signal });
    }
  }
  referenceJob(user, id) {
    const match = /^sample:([a-zA-Z0-9-]+):([a-zA-Z0-9-]+)$/.exec(id);
    return match
      ? this.samples.public(this.samples.row(user, match[1], match[2]))
      : this.ai.get(user, id);
  }
  referenceImage(user, id) {
    const match = /^sample:([a-zA-Z0-9-]+):([a-zA-Z0-9-]+)$/.exec(id);
    return match
      ? Buffer.from(this.samples.row(user, match[1], match[2]).image)
      : this.ai.image(user, id);
  }
  deviceEventCues(file, begin, end) {
    const from = iso(file.timestamp + begin * 1000),
      to = iso(file.timestamp + end * 1000);
    const rows = this.db
      .prepare(
        "SELECT occurredAt,receivedAt,description FROM alarms WHERE method!='platform' AND (channelId=? OR (channelId IS NULL AND deviceId=? AND (SELECT count(*) FROM channels WHERE deviceId=?)=1)) AND ((occurredAt>=? AND occurredAt<?) OR (receivedAt>=? AND receivedAt<?)) ORDER BY occurredAt",
      )
      .all(file.channelId, file.deviceId, file.deviceId, from, to, from, to);
    const cues = [];
    let trustedMotion = false;
    for (const row of rows) {
      const skew =
        Math.abs(Date.parse(row.occurredAt) - Date.parse(row.receivedAt)) >
        300000;
      const time = Date.parse(skew ? row.receivedAt : row.occurredAt),
        offset = Math.round((time - file.timestamp) / 1000);
      if (!Number.isFinite(offset) || offset < begin || offset >= end) continue;
      cues.push({
        offset,
        reason: skew ? "device-event-received" : "device-event",
      });
      if (!skew && /移动|运动|motion|VMD/i.test(row.description))
        trustedMotion = true;
    }
    return {
      events: [...new Map(cues.map((x) => [x.offset, x])).values()].sort(
        (a, b) => a.offset - b.offset,
      ),
      trustedMotion,
    };
  }
  list(user) {
    this.require(user);
    return {
      items: this.db
        .prepare(
          "SELECT id,params,status,createdAt,sampleCount FROM ai_history_searches WHERE ownerId=? AND expiresAt>? ORDER BY createdAt DESC,rowid DESC LIMIT 50",
        )
        .all(user, iso(this.now()))
        .map((r) => ({ ...r, params: JSON.parse(r.params) })),
    };
  }
  async work(job, controller) {
    return analyzeHistory(this, job, controller);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.running?.controller.abort();
    await this.index.close();
    this.local.close();
    if (this.running) await this.running.promise;
    this.db
      .prepare(
        "UPDATE ai_history_searches SET status='interrupted',phase='finished',error='平台关闭，检索已中断',finishedAt=? WHERE status='queued'",
      )
      .run(iso(this.now()));
  }
}

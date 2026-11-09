import { randomUUID, createHash } from "node:crypto";
import { AiSettings, aiProblem } from "./settings.mjs";
import { DeepSeekClient } from "./deepseek.mjs";
import { prepareAiImage, decodeAiImage, imageDistance } from "./images.mjs";
import { QwenRunner, QWEN_MODEL } from "./qwen-runner.mjs";
import { freemem } from "node:os";
import { AiHistory } from "./history-search.mjs";
import { AiCapture } from "./capture.mjs";
import { archiveTimestamp } from "./archive-reader.mjs";
const columns =
  "j.id,j.ownerId,j.recordingFileId,j.frameOffset,j.channelId,j.sourceName,j.sourceType,j.status,j.question,j.width,j.height,j.result,j.model,j.usage,j.error,j.createdAt,j.capturedAt,j.finishedAt,j.expiresAt,j.imageHash,j.image IS NOT NULL AS hasImage";
const terminal = ["succeeded", "failed", "cancelled", "interrupted"];
const plain = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/汽车|轿车|车辆|小车/g, "车")
    .replace(/自行车|单车/g, "自行车")
    .replace(/摩托车|电动车/g, "两轮车");
const segments = new Intl.Segmenter("zh-CN", { granularity: "word" });
function terms(text) {
  const ignored = new Set([
    "我",
    "想",
    "要",
    "找",
    "寻找",
    "查找",
    "搜索",
    "一个",
    "一些",
    "这个",
    "那个",
    "的",
    "了",
    "有",
    "没有",
    "有没有",
    "图片",
    "画面",
    "请",
    "帮我",
    "看",
    "一下",
    "所有",
  ]);
  const words = [];
  let single = "";
  const flush = () => {
    if (single) words.push(single);
    single = "";
  };
  for (const item of segments.segment(plain(text))) {
    if (!item.isWordLike || ignored.has(item.segment)) {
      flush();
      continue;
    }
    if (/^\p{Script=Han}$/u.test(item.segment)) single += item.segment;
    else {
      flush();
      words.push(item.segment);
    }
  }
  flush();
  return [...new Set(words)].slice(0, 30);
}
export class AiService {
  constructor({
    db,
    access,
    live,
    media,
    settings,
    client,
    capture,
    archiveReader,
    localModel,
    qwenRunner,
    now = () => Date.now(),
  }) {
    Object.assign(this, { db, access, now });
    this.settings = settings || new AiSettings();
    this.client = client || new DeepSeekClient({ settings: this.settings });
    this.capture = capture || new AiCapture({ db, live, media });
    this.running = new Map();
    this.closed = false;
    if (this.settings.state.lastTest?.status === "testing")
      this.settings.tested(
        {
          status: "failed",
          connection: false,
          vision: false,
          message: "上次模型测试被平台重启中断，请重新测试",
        },
        this.settings.state.version,
      );
    db.prepare(
      "UPDATE ai_jobs SET status='interrupted',error='平台重启，任务未完成；请按需重新分析',finishedAt=? WHERE status IN ('queued','running')",
    ).run(new Date(now()).toISOString());
    this.history = new AiHistory({
      ai: this,
      media,
      reader: archiveReader,
      localModel,
      now,
    });
    this.qwenRunner = qwenRunner || new QwenRunner();
    this.timer = setInterval(() => void this.drain(), 1000);
    this.timer.unref();
  }
  require(userId, permission = "ai.view") {
    if (!this.access.can(userId, permission))
      throw aiProblem(403, "AI_FORBIDDEN", "当前角色没有此AI功能权限");
  }
  scope(userId) {
    const user = "'" + String(userId).replaceAll("'", "''") + "'";
    return `(j.recordingFileId IS NULL OR (${this.access.can(userId, "recording.view") ? 1 : 0}=1 AND EXISTS(SELECT 1 FROM recording_files af JOIN recording_jobs ar ON ar.id=af.jobId WHERE af.id=j.recordingFileId AND (ar.kind='scheduled' OR ar.ownerId=${user} OR ${this.access.admin(userId) ? 1 : 0}=1)))) AND ((j.channelId IS NULL AND j.ownerId=${user}) OR EXISTS(SELECT 1 FROM channels c WHERE c.id=j.channelId AND ${this.access.sql(userId, "c.deviceId")}))`;
  }
  public(row) {
    const { ownerId, imageHash, hasImage, result, usage, ...safe } = row;
    const archive = row.recordingFileId
      ? this.db
          .prepare("SELECT jobId,date,name FROM recording_files WHERE id=?")
          .get(row.recordingFileId)
      : null;
    return {
      ...safe,
      alarm:
        this.db
          .prepare(
            "SELECT alarmId,deviceId,snapshotId FROM alarm_ai_jobs WHERE jobId=?",
          )
          .get(row.id) || null,
      recording: archive
        ? {
            fileId: row.recordingFileId,
            jobId: archive.jobId,
            name: archive.name,
            offsetSeconds: row.frameOffset,
            url: `/api/v1/recording-jobs/${archive.jobId}/files/${row.recordingFileId}?play=1`,
          }
        : null,
      result: result ? JSON.parse(result) : null,
      usage: usage ? JSON.parse(usage) : null,
      imageUrl: hasImage ? `/api/v1/ai/analyses/${row.id}/image` : null,
    };
  }
  get(userId, id) {
    this.require(userId);
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM ai_jobs j WHERE j.id=? AND j.expiresAt>? AND ${this.scope(userId)}`,
      )
      .get(id, new Date(this.now()).toISOString());
    if (!row)
      throw aiProblem(
        404,
        "AI_JOB_NOT_FOUND",
        "分析记录不存在、已过期或无权访问",
      );
    return this.public(row);
  }
  image(userId, id) {
    this.get(userId, id);
    const image = this.db
      .prepare("SELECT image FROM ai_jobs WHERE id=?")
      .get(id)?.image;
    if (!image)
      throw aiProblem(404, "AI_IMAGE_NOT_FOUND", "当前任务尚无可用图片");
    return Buffer.from(image);
  }
  pagination(page, pageSize) {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isSafeInteger((page - 1) * pageSize)
    )
      throw aiProblem(400, "INVALID_AI_QUERY", "分页参数无效");
  }
  list(userId, { page = 1, pageSize = 20, q = "", status = "" } = {}) {
    this.require(userId);
    this.pagination(page, pageSize);
    if (
      typeof q !== "string" ||
      q.length > 100 ||
      !["", "queued", "running", ...terminal].includes(status)
    )
      throw aiProblem(400, "INVALID_AI_QUERY", "搜索或任务状态无效");
    const where = `j.sourceType!='text-search' AND j.expiresAt>? AND ${this.scope(userId)} AND (?='' OR j.status=?) AND (instr(lower(j.sourceName),lower(?))>0 OR instr(lower(COALESCE(j.result,'')),lower(?))>0)`;
    const args = [
      new Date(this.now()).toISOString(),
      status,
      status,
      q.trim(),
      q.trim(),
    ];
    const total = this.db
      .prepare(`SELECT count(*) n FROM ai_jobs j WHERE ${where}`)
      .get(...args).n;
    const items = this.db
      .prepare(
        `SELECT ${columns} FROM ai_jobs j WHERE ${where} ORDER BY j.createdAt DESC,j.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize)
      .map((row) => this.public(row));
    return { items, total, page, pageSize };
  }
  async create(userId, value, key) {
    this.require(userId, "ai.analyze");
    if (
      !value ||
      typeof value.question !== "string" ||
      value.question.length > 1000 ||
      (key !== undefined &&
        (typeof key !== "string" || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)))
    )
      throw aiProblem(400, "INVALID_AI_REQUEST", "分析要求或请求标识无效");
    const localAnalysis = value.localAnalysis === true;
    if (
      value.localAnalysis !== undefined &&
      (typeof value.localAnalysis !== "boolean" ||
        (localAnalysis &&
          (value.reference || value.localReference || value.textSearch)))
    )
      throw aiProblem(400, "INVALID_AI_SOURCE", "本地分析参数无效");
    const localReference = value.localReference === true;
    if (
      value.localReference !== undefined &&
      (typeof value.localReference !== "boolean" ||
        (localReference &&
          (!value.reference || value.channelId || value.textSearch)))
    )
      throw aiProblem(400, "INVALID_AI_SOURCE", "本地参考图参数无效");
    const textSearch = value.textSearch === true;
    if (
      (value.textSearch !== undefined &&
        typeof value.textSearch !== "boolean") ||
      (textSearch &&
        (!value.question.trim() ||
          value.question.length > 500 ||
          value.channelId ||
          value.image ||
          value.reference))
    )
      throw aiProblem(400, "INVALID_AI_QUERY", "文字检索条件无效");
    const recordingFileId = value.recordingFileId ?? null;
    const frameOffset = value.frameOffset ?? null;
    if (
      (recordingFileId !== null &&
        (typeof recordingFileId !== "string" ||
          !/^[a-zA-Z0-9-]{1,100}$/.test(recordingFileId) ||
          typeof frameOffset !== "number" ||
          !Number.isFinite(frameOffset) ||
          frameOffset < 0 ||
          frameOffset > 86400 ||
          value.channelId ||
          value.image ||
          value.reference ||
          value.localReference ||
          value.textSearch)) ||
      (recordingFileId === null && frameOffset !== null)
    )
      throw aiProblem(400, "INVALID_RECORDING_FRAME", "请选择有效的录像时间点");
    let archive = null;
    if (recordingFileId) {
      archive = this.history.file(recordingFileId);
      if (!this.history.allowed(userId, archive))
        throw aiProblem(404, "AI_RECORDING_NOT_FOUND", "录像不存在或无权访问");
      const timestamp = archiveTimestamp(archive);
      if (
        timestamp === null ||
        archive.jobStatus === "finalizing" ||
        (["starting", "recording"].includes(archive.jobStatus) &&
          this.now() <
            timestamp +
              (Math.max(30, archive.segmentSeconds || 900) + 60) * 1000)
      )
        throw aiProblem(
          409,
          "AI_RECORDING_NOT_READY",
          "此录像尚未完成，请选择已完成的时段",
        );
      archive.timestamp = timestamp;
    }
    const channelId = archive?.channelId ?? value.channelId ?? null;
    if (
      (channelId !== null &&
        (typeof channelId !== "string" ||
          !channelId ||
          channelId.length > 200)) ||
      (channelId && value.image) ||
      (!textSearch && !channelId && !value.image) ||
      (value.reference !== undefined && typeof value.reference !== "boolean")
    )
      throw aiProblem(400, "INVALID_AI_SOURCE", "请选择一个通道或上传一张图片");
    if (
      channelId &&
      !archive &&
      (!this.access.can(userId, "live.preview") ||
        !this.access.channel(userId, channelId))
    )
      throw aiProblem(404, "AI_CHANNEL_NOT_FOUND", "通道不存在或无权抓拍");
    const sourceType = textSearch
      ? "text-search"
      : channelId
        ? "channel"
        : value.reference === true
          ? "image-search"
          : "upload";
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          channelId,
          ...(recordingFileId ? { recordingFileId, frameOffset } : {}),
          image: value.image || "",
          question: value.question,
          sourceType,
          localReference,
          localAnalysis,
        }),
      )
      .digest("hex");
    if (key) {
      const existing = this.db
        .prepare(
          "SELECT id,requestHash FROM ai_jobs WHERE ownerId=? AND requestKey=?",
        )
        .get(userId, key);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw aiProblem(
            409,
            "AI_IDEMPOTENCY_CONFLICT",
            "该请求标识已经用于其他内容",
          );
        return this.get(userId, existing.id);
      }
    }
    if (
      (localReference || localAnalysis
        ? this.settings.state.localEnabled === false
        : !this.settings.state.enabled) ||
      (!localReference && !localAnalysis && !this.settings.public().hasKey)
    )
      throw aiProblem(
        503,
        "AI_NOT_ENABLED",
        "AI尚未启用，请先配置并测试DeepSeek模型",
      );
    if (localAnalysis && !this.qwenRunner.ready())
      throw aiProblem(503, "QWEN_NOT_READY", "千问本地模型未就绪");
    const recent = this.db
      .prepare(
        "SELECT ownerId FROM ai_jobs WHERE createdAt>=? AND (recordingFileId IS NULL OR requestHash IS NOT NULL)",
      )
      .all(new Date(this.now() - 3600000).toISOString());
    if (
      recent.length >= 300 ||
      recent.filter((j) => j.ownerId === userId).length >= 60
    )
      throw aiProblem(
        429,
        "AI_RATE_LIMIT",
        "已达到AI分析每小时保护限额，请稍后再试",
      );
    const pending = this.db
      .prepare(
        "SELECT ownerId FROM ai_jobs WHERE status IN ('queued','running')",
      )
      .all();
    if (
      pending.length >= 20 ||
      pending.filter((j) => j.ownerId === userId).length >= 5
    )
      throw aiProblem(429, "AI_QUEUE_FULL", "分析队列已满，请等待当前任务完成");
    if (
      this.db
        .prepare(
          "SELECT count(*) n,COALESCE(sum(length(image)),0) bytes FROM ai_jobs",
        )
        .get().bytes >=
        512 * 1024 * 1024 ||
      this.db.prepare("SELECT count(*) n FROM ai_jobs").get().n >= 5000
    )
      throw aiProblem(
        409,
        "AI_STORAGE_FULL",
        "AI记录存储已达上限，请等待保留期清理或联系管理员",
      );
    const id = randomUUID(),
      createdAt = new Date(this.now()).toISOString(),
      expiresAt = new Date(
        this.now() + this.settings.state.retentionDays * 86400000,
      ).toISOString();
    let prepared = null,
      sourceName = "上传图片";
    if (channelId) {
      const c = this.db
        .prepare("SELECT name FROM channels WHERE id=?")
        .get(channelId);
      sourceName = c?.name || "摄像机通道";
    } else if (textSearch) {
      sourceName = "文字检索条件";
    } else {
      prepared = await prepareAiImage(decodeAiImage(value.image));
      sourceName =
        sourceType === "image-search"
          ? "检索参考图"
          : typeof value.name === "string"
            ? value.name.trim().slice(0, 100) || "上传图片"
            : "上传图片";
    }
    // Validate rights and queue limits again after asynchronous image decoding.
    this.require(userId, "ai.analyze");
    if (channelId && !this.access.channel(userId, channelId))
      throw aiProblem(404, "AI_CHANNEL_NOT_FOUND", "通道不存在或无权抓拍");
    if (
      (localReference || localAnalysis) &&
      this.settings.state.localEnabled === false
    )
      throw aiProblem(409, "AI_DISABLED", "本地分析已停用");
    const queued = this.db
      .prepare(
        "SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running') AND ownerId=?",
      )
      .get(userId).n;
    if (
      queued >= 5 ||
      this.db
        .prepare(
          "SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running')",
        )
        .get().n >= 20
    )
      throw aiProblem(429, "AI_QUEUE_FULL", "分析队列已满，请等待当前任务完成");
    if (key) {
      const existing = this.db
        .prepare(
          "SELECT id,requestHash FROM ai_jobs WHERE ownerId=? AND requestKey=?",
        )
        .get(userId, key);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw aiProblem(
            409,
            "AI_IDEMPOTENCY_CONFLICT",
            "该请求标识已经用于其他内容",
          );
        return this.get(userId, existing.id);
      }
    }
    this.db
      .prepare(
        "INSERT INTO ai_jobs(id,ownerId,channelId,sourceName,sourceType,status,question,requestKey,requestHash,image,imageHash,width,height,createdAt,capturedAt,expiresAt,recordingFileId,frameOffset) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        userId,
        channelId,
        sourceName,
        sourceType,
        value.question.trim(),
        key || null,
        requestHash,
        prepared?.image || null,
        prepared?.hash || null,
        prepared?.width || null,
        prepared?.height || null,
        createdAt,
        archive
          ? new Date(archive.timestamp + frameOffset * 1000).toISOString()
          : prepared
            ? createdAt
            : null,
        expiresAt,
        recordingFileId,
        frameOffset,
      );
    if (localAnalysis)
      this.db
        .prepare("UPDATE ai_jobs SET model=? WHERE id=?")
        .run(QWEN_MODEL, id);
    if (localReference) {
      this.db
        .prepare(
          "UPDATE ai_jobs SET status='succeeded',result=?,model='local-reference',usage='{}',finishedAt=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            summary: "检索参考图",
            tags: [],
            objects: [],
            observations: [],
          }),
          createdAt,
          id,
        );
    } else void this.drain();
    return this.get(userId, id);
  }
  async drain() {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      for (const [id, item] of this.running) {
        const row = this.db
          .prepare(
            "SELECT ownerId,channelId,recordingFileId,model FROM ai_jobs WHERE id=?",
          )
          .get(id);
        if (
          !row ||
          (row.recordingFileId && !this.history.valid(row)) ||
          !this.access.can(row.ownerId, "ai.analyze") ||
          (row.channelId && !this.access.channel(row.ownerId, row.channelId))
        )
          item.controller.abort(
            aiProblem(403, "AI_SCOPE_REVOKED", "分析或设备访问权限已撤销"),
          );
        else if (
          row.model === QWEN_MODEL
            ? this.settings.state.localEnabled === false
            : !this.settings.state.enabled
        )
          item.controller.abort(aiProblem(409, "AI_DISABLED", "AI功能已停用"));
      }
      this.db
        .prepare(
          "DELETE FROM ai_jobs WHERE id IN (SELECT id FROM ai_jobs WHERE expiresAt<=? AND status NOT IN ('queued','running') LIMIT 20)",
        )
        .run(new Date(this.now()).toISOString());
      this.db
        .prepare(
          "UPDATE ai_jobs SET status='failed',error='本地分析排队超时，请稍后重试',finishedAt=? WHERE status='queued' AND model=? AND createdAt<? AND NOT EXISTS(SELECT 1 FROM alarm_ai_jobs q WHERE q.jobId=ai_jobs.id)",
        )
        .run(
          new Date(this.now()).toISOString(),
          QWEN_MODEL,
          new Date(this.now() - 900000).toISOString(),
        );
      if (
        this.db
          .prepare("SELECT 1 FROM ai_jobs WHERE status='queued' LIMIT 1")
          .get()
      )
        await this.history.index.suspend();
      for (const row of this.db
        .prepare(
          "SELECT id,ownerId,recordingFileId,model FROM ai_jobs WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM alarm_ai_jobs q WHERE q.jobId=ai_jobs.id) ORDER BY recordingFileId IS NOT NULL,createdAt,rowid LIMIT 20",
        )
        .all()) {
        if (this.running.size >= 4) break;
        if (
          row.model === QWEN_MODEL &&
          (this.running.size ||
            this.alarmAnalysis?.current ||
            this.history.running ||
            this.localResourceReason())
        )
          continue;
        if ([...this.running.values()].some((item) => item.local)) continue;
        if (row.recordingFileId && this.running.size) continue;
        if (
          [...this.running.values()].filter((r) => r.ownerId === row.ownerId)
            .length >= 2
        )
          continue;
        const controller = new AbortController(),
          item = {
            ownerId: row.ownerId,
            local: row.model === QWEN_MODEL,
            controller,
            promise: null,
          };
        this.running.set(row.id, item);
        item.promise = this.work(row.id, controller).finally(() =>
          this.running.delete(row.id),
        );
      }
    } finally {
      this.draining = false;
    }
  }
  localResourceReason(starting = true) {
    const multithread = (this.qwenRunner.profile?.threads || 1) > 1;
    if (freemem() < (starting ? (this.qwenRunner.profile?.startMemoryMiB || 3072) : 1024) * 1048576)
      return "内存不足，等待本地分析";
    if (
      this.db
        .prepare(
          "SELECT count(*) n FROM recording_jobs WHERE status IN ('starting','recording','finalizing')",
        )
        .get().n >= (multithread ? 2 : 4) ||
      this.db
        .prepare("SELECT count(*) n FROM viewers WHERE expiresAt>?")
        .get(this.now()).n >= (multithread ? 4 : 9)
    )
      return "预览和录像优先，等待本地分析";
    return null;
  }
  async work(id, controller) {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120000),
    ]);
    let row = this.db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(id);
    const local = row.model === QWEN_MODEL;
    let resourceTimer;
    try {
      this.require(row.ownerId, "ai.analyze");
      if (row.channelId && !this.access.channel(row.ownerId, row.channelId))
        throw aiProblem(403, "AI_SCOPE_REVOKED", "通道访问权限已撤销");
      if (
        local
          ? this.settings.state.localEnabled === false
          : !this.settings.state.enabled
      )
        throw aiProblem(503, "AI_NOT_ENABLED", "AI功能已停用");
      this.db
        .prepare(
          "UPDATE ai_jobs SET status='running' WHERE id=? AND status='queued'",
        )
        .run(id);
      if (row.recordingFileId && !this.history.valid(row))
        throw aiProblem(
          403,
          "AI_HISTORY_SCOPE_REVOKED",
          "历史分析已暂停或权限已撤销",
        );
      let output;
      if (row.sourceType === "text-search") {
        output = await this.client.interpret(row.question, signal);
      } else {
        let prepared;
        if (row.recordingFileId) {
          const file = this.history.file(row.recordingFileId);
          if (!this.history.allowed(row.ownerId, file))
            throw aiProblem(
              403,
              "AI_HISTORY_SCOPE_REVOKED",
              "录像访问权限已撤销",
            );
          const duration = await this.history.reader.duration(file, signal);
          if (!Number.isFinite(duration) || row.frameOffset >= duration)
            throw aiProblem(
              400,
              "AI_RECORDING_GAP",
              "当前时间点不在这段录像内，请重新定位",
            );
          prepared = await prepareAiImage(
            await this.history.reader.frame(file, row.frameOffset, signal),
          );
        } else if (row.channelId) {
          const channel = this.db
            .prepare("SELECT * FROM channels WHERE id=?")
            .get(row.channelId);
          prepared = await prepareAiImage(
            await this.capture.frame(channel, row.ownerId, signal),
          );
        } else
          prepared = {
            image: Buffer.from(row.image),
            hash: row.imageHash,
            width: row.width,
            height: row.height,
          };
        signal.throwIfAborted();
        this.require(row.ownerId, "ai.analyze");
        if (row.channelId && !this.access.channel(row.ownerId, row.channelId))
          throw aiProblem(403, "AI_SCOPE_REVOKED", "通道访问权限已撤销");
        const capturedAt = row.capturedAt || new Date(this.now()).toISOString();
        this.db
          .prepare(
            "UPDATE ai_jobs SET image=?,imageHash=?,width=?,height=?,capturedAt=? WHERE id=? AND status='running'",
          )
          .run(
            prepared.image,
            prepared.hash,
            prepared.width,
            prepared.height,
            capturedAt,
            id,
          );
        if (row.recordingFileId && !this.history.valid(row))
          throw aiProblem(
            403,
            "AI_HISTORY_SCOPE_REVOKED",
            "历史分析权限已撤销",
          );
        if (local) {
          // Exact image bytes and owner/model scope: never reuse a perceptual hash as an identity.
          const cached = this.db
            .prepare(
              "SELECT result FROM ai_jobs WHERE ownerId=? AND model=? AND status='succeeded' AND expiresAt>? AND image=? AND question=? ORDER BY finishedAt DESC LIMIT 1",
            )
            .get(
              row.ownerId,
              QWEN_MODEL,
              new Date(this.now()).toISOString(),
              prepared.image,
              row.question,
            );
          if (cached)
            output = {
              analysis: JSON.parse(cached.result),
              model: QWEN_MODEL,
              usage: { local: true, cached: true },
            };
          else {
            resourceTimer = setInterval(() => {
              const reason = this.localResourceReason(false);
              if (reason)
                controller.abort(aiProblem(429, "QWEN_RESOURCE_BUSY", reason));
            }, 1000);
            resourceTimer.unref();
            const out = await this.qwenRunner.run(
              prepared.image,
              signal,
              row.question,
            );
            output = {
              analysis: out.result,
              model: out.model || QWEN_MODEL,
              usage: { local: true, ...out.metrics },
            };
          }
        } else
          output = await this.client.analyze(
            prepared.image,
            row.question,
            signal,
          );
      }
      signal.throwIfAborted();
      this.require(row.ownerId, "ai.analyze");
      if (row.channelId && !this.access.channel(row.ownerId, row.channelId))
        throw aiProblem(403, "AI_SCOPE_REVOKED", "通道访问权限已撤销");
      if (row.recordingFileId && !this.history.valid(row))
        throw aiProblem(403, "AI_HISTORY_SCOPE_REVOKED", "历史分析权限已撤销");
      if (local && this.settings.state.localEnabled === false)
        throw aiProblem(409, "AI_DISABLED", "本地分析已停用");
      this.db
        .prepare(
          "UPDATE ai_jobs SET status='succeeded',result=?,model=?,usage=?,finishedAt=?,error=NULL WHERE id=? AND status='running'",
        )
        .run(
          JSON.stringify(output.analysis),
          String(output.model).slice(0, 100),
          JSON.stringify(output.usage),
          new Date(this.now()).toISOString(),
          id,
        );
    } catch (error) {
      const failure = controller.signal.reason?.status
          ? controller.signal.reason
          : error,
        revoked = failure.status === 403;
      if (local && !this.closed && failure.code === "QWEN_RESOURCE_BUSY") {
        this.db
          .prepare(
            "UPDATE ai_jobs SET status='queued',error=?,finishedAt=NULL WHERE id=? AND status='running'",
          )
          .run(failure.message, id);
        return;
      }
      this.db
        .prepare(
          "UPDATE ai_jobs SET status=?,error=?,finishedAt=?,image=CASE WHEN ? THEN NULL ELSE image END WHERE id=? AND status IN ('queued','running')",
        )
        .run(
          this.closed || failure.code === "AI_DISABLED"
            ? "interrupted"
            : controller.signal.aborted && !controller.signal.reason?.status
              ? "cancelled"
              : "failed",
          this.closed
            ? "平台关闭，任务已中断"
            : failure.status
              ? failure.message
              : controller.signal.aborted
                ? "任务已取消"
                : signal.aborted
                  ? "分析超时，请稍后重试"
                  : "分析失败，请检查图片、设备或模型配置",
          new Date(this.now()).toISOString(),
          Number(revoked),
          id,
        );
    } finally {
      clearInterval(resourceTimer);
    }
  }
  cancel(userId, id) {
    this.require(userId, "ai.analyze");
    const row = this.get(userId, id);
    const owner = this.db
      .prepare("SELECT ownerId FROM ai_jobs WHERE id=?")
      .get(id)?.ownerId;
    if (owner !== userId && !this.access.admin(userId))
      throw aiProblem(403, "AI_JOB_FORBIDDEN", "只能取消自己发起的分析任务");
    if (terminal.includes(row.status)) return row;
    this.alarmAnalysis?.cancel(id);
    this.running.get(id)?.controller.abort();
    this.db
      .prepare(
        "UPDATE ai_jobs SET status='cancelled',error='任务已取消',finishedAt=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(new Date(this.now()).toISOString(), id);
    return this.get(userId, id);
  }
  search(
    userId,
    {
      text = "",
      referenceId = "",
      queryId = "",
      source = "",
      from = "",
      to = "",
      page = 1,
      pageSize = 20,
    } = {},
  ) {
    this.require(userId);
    this.pagination(page, pageSize);
    if (
      !["", "history", "manual"].includes(source) ||
      typeof text !== "string" ||
      text.length > 500 ||
      typeof queryId !== "string" ||
      queryId.length > 100 ||
      typeof referenceId !== "string" ||
      referenceId.length > 100 ||
      typeof from !== "string" ||
      typeof to !== "string" ||
      from.length > 40 ||
      to.length > 40 ||
      (from && !Number.isFinite(Date.parse(from))) ||
      (to && !Number.isFinite(Date.parse(to))) ||
      (from && to && Date.parse(from) > Date.parse(to))
    )
      throw aiProblem(400, "INVALID_AI_QUERY", "检索描述或时间范围无效");
    let query = null;
    if (queryId) {
      const job = this.get(userId, queryId);
      if (
        job.sourceType !== "text-search" ||
        job.status !== "succeeded" ||
        !job.result?.query
      )
        throw aiProblem(409, "AI_QUERY_PENDING", "检索条件尚未准备完成");
      query = job.result.query;
    }
    let reference = null;
    if (referenceId) {
      const allowed = this.get(userId, referenceId);
      if (allowed.status !== "succeeded" || !allowed.imageUrl)
        throw aiProblem(409, "AI_REFERENCE_PENDING", "请等待参考图片分析完成");
      reference = this.db
        .prepare("SELECT imageHash,result FROM ai_jobs WHERE id=?")
        .get(referenceId);
    }
    if (!text.trim() && !reference && !query)
      throw aiProblem(
        400,
        "AI_QUERY_REQUIRED",
        "请输入物体或场景描述，或上传参考图片",
      );
    const now = new Date(this.now()).toISOString(),
      args = [
        now,
        from ? new Date(from).toISOString() : "",
        from ? new Date(from).toISOString() : "",
        to ? new Date(to).toISOString() : "",
        to ? new Date(to).toISOString() : "",
      ];
    const where = `${source === "history" ? "j.recordingFileId IS NOT NULL AND" : source === "manual" ? "j.recordingFileId IS NULL AND" : ""} j.status='succeeded' AND j.sourceType NOT IN ('image-search','text-search') AND j.expiresAt>? AND ${this.scope(userId)} AND (?='' OR j.capturedAt>=?) AND (?='' OR j.capturedAt<=?)`;
    const candidates = this.db
      .prepare(
        `SELECT ${columns} FROM ai_jobs j WHERE ${where} ORDER BY j.capturedAt DESC LIMIT 1000`,
      )
      .all(...args);
    const referenceResult = reference ? JSON.parse(reference.result) : null,
      keywords = query
        ? [...new Set(query.groups.flat().map(plain))]
        : terms(text.trim() || referenceResult?.tags.join(" ") || "");
    const scored = candidates
      .map((row) => {
        const result = JSON.parse(row.result),
          corpus = plain(
            [
              result.summary,
              ...result.tags,
              ...result.objects.map((x) => x.label + " " + x.color),
            ].join(" "),
          );
        const matched = keywords.filter((k) => corpus.includes(k)),
          textScore = query
            ? query.exclude.some((k) => corpus.includes(plain(k)))
              ? 0
              : query.groups.every((g) =>
                    g.some((k) => corpus.includes(plain(k))),
                  )
                ? 100
                : 0
            : keywords.length
              ? Math.round((matched.length / keywords.length) * 100)
              : 0,
          visualScore = reference
            ? Math.round(
                (1 - imageDistance(reference.imageHash, row.imageHash) / 64) *
                  100,
              )
            : null;
        const score = reference
          ? Math.round(visualScore * 0.65 + textScore * 0.35)
          : textScore;
        return {
          ...this.public(row),
          score,
          textScore,
          visualScore,
          matchedTerms: matched,
        };
      })
      .filter((row) => (reference ? row.score >= 45 : row.textScore > 0))
      .sort(
        (a, b) => b.score - a.score || b.capturedAt.localeCompare(a.capturedAt),
      );
    const count = this.db
      .prepare(`SELECT count(*) n FROM ai_jobs j WHERE ${where}`)
      .get(...args).n;
    return {
      items: scored.slice((page - 1) * pageSize, page * pageSize),
      total: scored.length,
      page,
      pageSize,
      candidateCount: candidates.length,
      truncated: count > 1000,
      method: reference
        ? "图像结构相似度与画面描述匹配"
        : query
          ? "DeepSeek意图解析与画面描述匹配"
          : "画面描述关键词匹配",
      keywords,
    };
  }
  async close() {
    this.closed = true;
    await this.alarmAnalysis?.close();

    await this.history.close();
    clearInterval(this.timer);
    this.testController?.abort();
    if (this.testPromise) await this.testPromise;
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    this.db
      .prepare(
        "UPDATE ai_jobs SET status='interrupted',error='平台关闭，排队任务未完成',finishedAt=? WHERE status='queued'",
      )
      .run(new Date(this.now()).toISOString());
  }
}

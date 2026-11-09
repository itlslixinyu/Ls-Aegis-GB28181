import { randomUUID, createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import sharp from "sharp";
import { LOCAL_VERSION, cosine } from "./local-model.mjs";
import { parseLocalQuery } from "./query-cache.mjs";
import { prepareAiImage } from "./images.mjs";
import { MOTION_VERSION } from "./motion.mjs";
import { aiProblem } from "./settings.mjs";
import {
  samplingPolicy,
  periodicPlan,
  coarseMotionWindows,
  groupCandidateFrames,
  SAMPLING_POLICY_VERSION,
} from "./sampling-policy.mjs";
const iso = (ms) => new Date(ms).toISOString();
const fatal = (e, signal) =>
  signal.aborted ||
  e.status === 403 ||
  String(e.code || "").startsWith("AI_LOCAL_") ||
  e.code === "AI_ANALYSIS_STORAGE_FULL";
export async function analyzeHistory(h, job, controller) {
  const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(6 * 3600000),
    ]),
    params = JSON.parse(job.params),
    db = h.db;
  const policy = samplingPolicy(params.from, params.to);
  const eventBins = new Set(),
    refineFrames = [],
    eventFrames = [];
  const metrics = {
    mode: "stream",
    samplingPolicy: SAMPLING_POLICY_VERSION,
    sampleIntervalSeconds: policy.interval,
    coarseSampling: policy.coarse,
    mergedDeviceEvents: 0,
    engine: LOCAL_VERSION,
    indexHits: 0,
    indexedFiles: 0,
    cacheHits: 0,
    cacheMisses: 0,
    localMs: 0,
    peakWorkerMiB: 0,
    shortlist: 0,
    motionEvents: 0,
    motionScannedSeconds: 0,
    motionCacheHits: 0,
    periodicSamples: 0,
    refinedSamples: 0,
    focusSamples: 0,
    deviceEvents: 0,
    queryCacheHit: false,
    verified: params.verify !== false,
  };
  let refining = false;
  let errors = 0,
    incomplete = !!job.truncated || policy.coarse;
  const indexedCandidates = [];
  const seenTimes = new Set();
  const seen = new Set(),
    top = [],
    recent = [];
  const report = () =>
    db
      .prepare("UPDATE ai_history_searches SET localMetrics=? WHERE id=?")
      .run(JSON.stringify(metrics), job.id);
  const check = (file) => {
    h.guard(job, signal);
    if (file && !h.allowed(job.ownerId, h.file(file.id)))
      throw aiProblem(403, "AI_SCOPE_REVOKED", "录像权限已撤销");
  };
  const embed = async (input) => {
    await h.capacity(job, signal, true);
    const value = await h.local.run(input, signal);
    metrics.localMs += value.ms || 0;
    metrics.peakWorkerMiB = Math.max(
      metrics.peakWorkerMiB,
      Math.round((value.rss || 0) / 1048576),
    );
    report();
    await wait(h.injectedLocal ? 0 : 100, undefined, { signal });
    return value.embedding;
  };
  let reference = null,
    queryEmbedding;
  const parsed = params.question.trim()
    ? parseLocalQuery(params.question)
    : { text: "", parts: [], parser: "reference-image-v1" };
  const remember = (frame) => {
    frame.rankScore = Math.max(
      cosine(queryEmbedding, frame.embedding),
      frame.focusEmbedding ? cosine(queryEmbedding, frame.focusEmbedding) : -1,
    );
    const at = top.findIndex((x) => x.sampleId === frame.sampleId);
    if (at >= 0) top.splice(at, 1);
    top.push(frame);
    top.sort((a, b) => b.rankScore - a.rankScore);
    top.splice(24);
  };
  try {
    db.prepare(
      "UPDATE ai_history_searches SET status='running',phase='planning' WHERE id=?",
    ).run(job.id);
    check();
    h.samples.resetStorage();
    const inventory = h.inventory(job.ownerId, params);
    incomplete ||= inventory.truncated;
    db.prepare(
      "UPDATE ai_history_searches SET candidateFiles=? WHERE id=?",
    ).run(inventory.files.length, job.id);
    if (params.referenceId)
      reference = h.referenceImage(job.ownerId, params.referenceId);
    const key = reference
      ? "image:" +
        createHash("sha256").update(reference).digest("hex") +
        ":" +
        parsed.text
      : "text:" + parsed.text;
    const cachedQuery = h.queryCache.get(job.ownerId, key);
    queryEmbedding = cachedQuery?.embedding;
    metrics.queryCacheHit = !!cachedQuery;
    metrics.queryParts = parsed.parts.length;
    const ensureQuery = async () => {
      if (queryEmbedding) return;
      queryEmbedding = await embed(
        reference
          ? { image: reference.toString("base64") }
          : { text: parsed.text },
      );
      if (reference && parsed.text) {
        const v = await embed({ text: parsed.text }),
          a = Math.hypot(...queryEmbedding) || 1,
          b = Math.hypot(...v) || 1;
        queryEmbedding = queryEmbedding.map((x, i) => x / a + v[i] / b);
      }
      check();
      if (params.referenceId) h.referenceJob(job.ownerId, params.referenceId);
      h.queryCache.put(job.ownerId, key, parsed, queryEmbedding, job.expiresAt);
    };
    const sample = async (file, offset, reason) => {
      offset = Math.round(offset * 100) / 100;
      const sampleKey = file.id + ":" + offset;
      const instantKey =
        file.channelId + ":" + Math.round(file.timestamp + offset * 1000);
      if (seen.has(sampleKey) || seenTimes.has(instantKey)) return null;
      seen.add(sampleKey);
      await h.capacity(job, signal);
      check(file);
      db.prepare("UPDATE ai_history_searches SET phase=? WHERE id=?").run(
        refining ? "refining" : "sampling",
        job.id,
      );
      const cached =
        h.index.get(file, offset) ||
        h.cache.get(file.id, file.sourceVersion, offset) ||
        h.samples.reuse(file, offset);
      const prepared = cached
        ? {
            image: cached.image,
            hash: cached.hash,
            width: cached.width,
            height: cached.height,
          }
        : await prepareAiImage(await h.reader.frame(file, offset, signal), 960);
      await ensureQuery();
      const embedding =
        cached?.embedding ||
        (await embed({ image: prepared.image.toString("base64") }));
      check(file);
      const frame = {
        ...prepared,
        embedding,
        file,
        offset,
        capturedAt: iso(file.timestamp + offset * 1000),
      };
      frame.rankScore = cosine(queryEmbedding, embedding);
      frame.sampleId = h.samples.insert(job, frame, reason);
      seenTimes.add(instantKey);
      if (cached) metrics.cacheHits++;
      else {
        metrics.cacheMisses++;
        h.cache.put(
          file.id,
          file.sourceVersion,
          offset,
          prepared,
          embedding,
          job.expiresAt,
        );
      }
      remember(frame);
      recent.push(frame);
      if (recent.length > 64) recent.splice(0, 32);
      db.prepare(
        "UPDATE ai_history_searches SET sampleCount=sampleCount+1 WHERE id=?",
      ).run(job.id);
      report();
      return frame;
    };
    const safeSample = async (f, at, reason) => {
      try {
        return await sample(f, at, reason);
      } catch (e) {
        if (fatal(e, signal)) throw e;
        errors++;
        incomplete = true;
        return null;
      }
    };
    for (const file of inventory.files) {
      recent.length = 0;
      await h.capacity(job, signal);
      check(file);
      try {
        const version = h.reader.fingerprint
          ? await h.reader.fingerprint(file, signal)
          : null;
        file.sourceVersion = version ? version + ":sample960-v1" : null;
        file.duration =
          h.index.compatible(file)?.duration ??
          h.cache.duration(file.id, file.sourceVersion) ??
          (await h.reader.duration(file, signal));
        h.cache.saveDuration(
          file.id,
          file.sourceVersion,
          file.duration,
          job.expiresAt,
        );
        const begin = Math.max(
            0,
            (Date.parse(params.from) - file.timestamp) / 1000,
          ),
          end = Math.min(
            file.duration,
            (Date.parse(params.to) - file.timestamp) / 1000,
          );
        if (end <= begin) continue;
        // Rank persistent vectors first; only materialize the best authorized images.
        const indexed = h.index.compatible(file);
        if (indexed) {
          await ensureQuery();
          for (const hit of h.index.ranked(file, begin, end, queryEmbedding))
            indexedCandidates.push({ ...hit, file });
          indexedCandidates.sort((a, b) => b.score - a.score);
          indexedCandidates.splice(24);
          if (indexed.state === "ready") {
            metrics.indexedFiles++;
            // Sparse indexing is a candidate search, never proof of absence.
            incomplete = true;
            db.prepare(
              "UPDATE ai_history_searches SET fileCount=fileCount+1 WHERE id=?",
            ).run(job.id);
            report();
            continue;
          }
        }
        const cues = h.deviceEventCues(file, begin, end),
          events = cues.events.map((x) => x.offset);
        metrics.deviceEvents += events.length;
        for (const cue of cues.events) {
          const bin =
            file.channelId +
            ":" +
            Math.floor(
              (file.timestamp + cue.offset * 1000 - policy.start) /
                Math.max(5000, (policy.seconds * 1000) / 96),
            );
          if (policy.coarse && eventBins.has(bin)) {
            metrics.mergedDeviceEvents++;
            continue;
          }
          eventBins.add(bin);
          const frame = await safeSample(file, cue.offset, cue.reason);
          if (frame) {
            eventFrames.push(frame);
            eventFrames.sort(
              (a, b) =>
                b.rankScore - a.rankScore ||
                Date.parse(b.capturedAt) - Date.parse(a.capturedAt),
            );
            eventFrames.splice(3);
          }
        }
        for (const at of periodicPlan(policy, file, begin, end))
          if (await safeSample(file, at, "periodic")) metrics.periodicSamples++;
        if (h.reader.motion) {
          let windows = null;
          if (cues.trustedMotion) {
            windows = [];
            for (const at of events) {
              const start = Math.max(begin, at - 3),
                stop = Math.min(end, at + 4),
                last = windows.at(-1);
              if (last && start <= last[1]) last[1] = Math.max(last[1], stop);
              else windows.push([start, stop]);
            }
          }
          if (policy.coarse)
            windows = coarseMotionWindows(policy, file, begin, end);
          const scanWindows = (function* () {
            for (const [start, stop] of windows || [[begin, end]])
              for (let at = start; at < stop; at += 30)
                yield [at, Math.min(stop, at + 30)];
          })();
          for (const [from, to] of scanWindows) {
            await h.capacity(job, signal);
            check(file);
            if (to - from < 1) continue;
            const cacheKey = createHash("sha256")
              .update(
                JSON.stringify([
                  file.id,
                  file.sourceVersion,
                  from,
                  to,
                  MOTION_VERSION,
                ]),
              )
              .digest("hex");
            const old = file.sourceVersion
              ? db
                  .prepare(
                    "SELECT output FROM ai_motion_cache WHERE cacheKey=? AND expiresAt>?",
                  )
                  .get(cacheKey, iso(h.now()))
              : null;
            let motion;
            try {
              motion = old
                ? JSON.parse(old.output)
                : await h.reader.motion(file, from, to, signal);
            } catch (e) {
              if (fatal(e, signal)) throw e;
              errors++;
              incomplete = true;
              continue;
            }
            check(file);
            if (old) metrics.motionCacheHits++;
            else {
              metrics.motionScannedSeconds += motion.scannedSeconds;
              if (file.sourceVersion) {
                db.prepare(
                  "DELETE FROM ai_motion_cache WHERE cacheKey IN (SELECT cacheKey FROM ai_motion_cache ORDER BY expiresAt LIMIT max(0,(SELECT count(*) FROM ai_motion_cache)-1999))",
                ).run();
                db.prepare(
                  "INSERT OR REPLACE INTO ai_motion_cache VALUES(?,?,?,?)",
                ).run(cacheKey, file.id, JSON.stringify(motion), job.expiresAt);
              }
            }
            metrics.motionEvents += motion.events.length;
            const selectedEvents = policy.coarse
              ? motion.events.filter(
                  (event, index, items) =>
                    items.findIndex(
                      (x) =>
                        Math.floor(x.offset / 10) ===
                        Math.floor(event.offset / 10),
                    ) === index,
                )
              : motion.events;
            for (const event of selectedEvents) {
              if (
                !Number.isFinite(event.offset) ||
                event.offset < from ||
                event.offset >= to ||
                event.offset < begin ||
                event.offset >= end
              )
                continue;
              let frame =
                recent.find(
                  (f) => f.file.id === file.id && f.offset === event.offset,
                ) ||
                top.find(
                  (f) => f.file.id === file.id && f.offset === event.offset,
                );
              frame ||= h.samples.frame(job, file, event.offset);
              frame ||= await safeSample(file, event.offset, "motion");
              if (!frame) continue;
              const r = event.region;
              if (
                !r ||
                ![r.x, r.y, r.right, r.bottom].every(Number.isFinite) ||
                r.x < 0 ||
                r.y < 0 ||
                r.right > 1 ||
                r.bottom > 1 ||
                r.right <= r.x ||
                r.bottom <= r.y
              )
                continue;
              const focusVersion = file.sourceVersion
                  ? file.sourceVersion + ":focus-v1:" + JSON.stringify(r)
                  : null,
                cached = h.cache.get(file.id, focusVersion, frame.offset);
              const left = Math.floor(r.x * frame.width),
                y = Math.floor(r.y * frame.height),
                width = Math.max(
                  1,
                  Math.min(
                    frame.width - left,
                    Math.ceil((r.right - r.x) * frame.width),
                  ),
                ),
                height = Math.max(
                  1,
                  Math.min(
                    frame.height - y,
                    Math.ceil((r.bottom - r.y) * frame.height),
                  ),
                );
              const prepared =
                cached ||
                (await prepareAiImage(
                  await sharp(frame.image)
                    .extract({ left, top: y, width, height })
                    .jpeg({ quality: 82 })
                    .toBuffer(),
                ));
              frame.focusImage = prepared.image;
              frame.focusEmbedding =
                cached?.embedding ||
                (await embed({ image: prepared.image.toString("base64") }));
              check(file);
              if (!cached)
                h.cache.put(
                  file.id,
                  focusVersion,
                  frame.offset,
                  prepared,
                  frame.focusEmbedding,
                  job.expiresAt,
                );
              metrics.focusSamples++;
              remember(frame);
            }
            report();
            await wait(25, undefined, { signal });
          }
        }
        // Refine after all coarse files, so every recorder file cannot trigger
        // its own independent expansion and monopolize the work budget.
        db.prepare(
          "UPDATE ai_history_searches SET fileCount=fileCount+1 WHERE id=?",
        ).run(job.id);
        report();
      } catch (e) {
        if (fatal(e, signal)) throw e;
        errors++;
        incomplete = true;
      }
    }
    for (const hit of indexedCandidates)
      if (await safeSample(hit.file, hit.offset, "index")) metrics.indexHits++;
    check();
    const best = top[0]?.rankScore ?? -1;
    for (const frame of [...eventFrames, ...top]) {
      if (frame.rankScore < Math.max(0.18, best - 0.05)) continue;
      if (
        refineFrames.some(
          (old) =>
            old.file.channelId === frame.file.channelId &&
            Math.abs(
              Date.parse(old.capturedAt) - Date.parse(frame.capturedAt),
            ) < 30000,
        )
      )
        continue;
      refineFrames.push(frame);
      if (refineFrames.length === 6) break;
    }
    refining = true;
    db.prepare(
      "UPDATE ai_history_searches SET phase='refining' WHERE id=?",
    ).run(job.id);
    for (const anchor of refineFrames) {
      for (const delta of [-5, -2, 2, 5]) {
        const target = anchor.file.timestamp + (anchor.offset + delta) * 1000;
        if (target < policy.start || target >= policy.stop) continue;
        const file = inventory.files
          .filter(
            (f) =>
              f.channelId === anchor.file.channelId &&
              f.timestamp <= target &&
              target < f.timestamp + f.duration * 1000,
          )
          .sort((a, b) => b.timestamp - a.timestamp)[0];
        if (
          file &&
          (await safeSample(
            file,
            Math.round((target - file.timestamp) / 10) / 100,
            "refined",
          ))
        )
          metrics.refinedSamples++;
      }
    }

    const groups = groupCandidateFrames(top);
    metrics.candidateSegments = groups.length;
    const batch = groups.slice(0, 4);

    metrics.shortlist = batch.length;
    report();
    if (batch.length) {
      const storage = db
        .prepare(
          "SELECT count(*) n,coalesce(sum(length(image)),0) bytes FROM ai_jobs",
        )
        .get();
      if (
        storage.n + batch.length > 5000 ||
        storage.bytes + batch.reduce((n, f) => n + f.image.length, 0) >
          512 * 1024 ** 2
      )
        throw aiProblem(
          409,
          "AI_RESULT_STORAGE_FULL",
          "分析画面已保存，候选记录存储空间不足",
        );

      for (const f of batch) check(f.file);
      if (params.referenceId) h.referenceJob(job.ownerId, params.referenceId);
      const verificationKey = createHash("sha256")
        .update(
          JSON.stringify([
            "stream-analysis-v2-adaptive",
            job.ownerId,
            params.question,
            h.ai.settings.state.model,
            reference
              ? createHash("sha256").update(reference).digest("hex")
              : null,
            batch.map((f) =>
              createHash("sha256")
                .update(f.image)
                .update(f.focusImage || Buffer.alloc(0))
                .digest("hex"),
            ),
          ]),
        )
        .digest("hex");
      const cached =
        params.verify !== false
          ? db
              .prepare(
                "SELECT output FROM ai_verification_cache WHERE cacheKey=? AND ownerId=? AND expiresAt>?",
              )
              .get(verificationKey, job.ownerId, iso(h.now()))
          : null;
      if (params.verify !== false && !cached) {
        if (!h.ai.settings.state.enabled || !h.ai.settings.public().hasKey)
          throw aiProblem(
            409,
            "AI_CLOUD_DISABLED",
            "本地分析已保存，大模型接入已停用，未执行云端复核",
          );
        const used = db
          .prepare(
            "SELECT coalesce(sum(modelCalls),0) n FROM ai_history_searches WHERE createdAt>=?",
          )
          .get(
            iso(
              Date.parse(
                iso(h.now() + 8 * 3600000).slice(0, 10) + "T00:00:00+08:00",
              ),
            ),
          ).n;
        if (used >= 120)
          throw aiProblem(
            429,
            "HISTORY_MODEL_BUDGET",
            "本地分析已保存，云端复核暂不可用",
          );
        db.prepare(
          "UPDATE ai_history_searches SET phase='matching',modelCalls=modelCalls+1 WHERE id=?",
        ).run(job.id);
      }
      const output = cached
        ? JSON.parse(cached.output)
        : params.verify !== false
          ? await h.ai.client.searchFrames(
              batch,
              params.question,
              reference,
              signal,
            )
          : batch.map((_, index) => ({
              index,
              analysis: {
                summary: "相似画面",
                tags: [],
                objects: [],
                observations: [],
              },
              model: LOCAL_VERSION,
              usage: {},
            }));
      check();
      for (const f of batch) check(f.file);
      if (params.referenceId) h.referenceJob(job.ownerId, params.referenceId);
      if (cached) metrics.verificationCacheHit = true;
      else if (params.verify !== false) {
        db.prepare(
          "DELETE FROM ai_verification_cache WHERE cacheKey IN (SELECT cacheKey FROM ai_verification_cache ORDER BY expiresAt LIMIT max(0,(SELECT count(*) FROM ai_verification_cache)-499))",
        ).run();
        db.prepare(
          "INSERT OR REPLACE INTO ai_verification_cache VALUES(?,?,?,?)",
        ).run(
          verificationKey,
          job.ownerId,
          JSON.stringify(output.map((x) => ({ ...x, usage: {} }))),
          job.expiresAt,
        );
      }
      for (const match of output) {
        const f = batch[match.index];
        if (!f) continue;
        const id = randomUUID();
        db.prepare(
          "INSERT INTO ai_jobs(id,ownerId,channelId,sourceName,sourceType,status,question,image,imageHash,width,height,result,model,usage,createdAt,capturedAt,finishedAt,expiresAt,recordingFileId,frameOffset) VALUES(?,?,?,?,'channel','succeeded',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          job.ownerId,
          f.file.channelId,
          f.file.channelName,
          params.question,
          f.image,
          f.hash,
          f.width,
          f.height,
          JSON.stringify(match.analysis),
          match.model,
          JSON.stringify({ ...match.usage, segment: f.segment }),
          iso(h.now()),
          f.capturedAt,
          iso(h.now()),
          job.expiresAt,
          f.file.id,
          f.offset,
        );
        db.prepare("INSERT INTO ai_history_matches VALUES(?,?)").run(
          job.id,
          id,
        );
      }
    }
    report();
    db.prepare(
      "UPDATE ai_history_searches SET status=?,phase='finished',truncated=?,error=?,finishedAt=? WHERE id=? AND status='running'",
    ).run(
      incomplete ? "partial" : "succeeded",
      Number(incomplete),
      errors ? "部分录像未能读取，已保存可用画面" : null,
      iso(h.now()),
      job.id,
    );
  } catch (e) {
    const samples = db
      .prepare("SELECT count(*) n FROM ai_history_samples WHERE searchId=?")
      .get(job.id).n;
    db.prepare(
      "UPDATE ai_history_searches SET status=?,phase='finished',error=?,finishedAt=? WHERE id=? AND status IN ('queued','running')",
    ).run(
      h.closed
        ? "interrupted"
        : controller.signal.aborted
          ? "cancelled"
          : samples && e.status !== 403
            ? "partial"
            : "failed",
      h.closed
        ? "平台关闭，分析已中断"
        : controller.signal.aborted
          ? "已取消，已完成的分析画面仍可查看"
          : e.status
            ? e.message
            : signal.aborted
              ? "分析已暂停，已完成的画面仍可查看"
              : "分析失败，请稍后重试",
      iso(h.now()),
      job.id,
    );
  }
}

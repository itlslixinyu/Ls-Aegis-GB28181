export interface AiResult {
  query?: { groups: string[][]; exclude: string[]; all: boolean };
  summary: string;
  tags: string[];
  objects: {
    label: string;
    color: string;
    count: number | null;
    position: string;
    confidence?: number | null;
  }[];
  observations: string[];
}
export interface AiJob {
  alarm?: { alarmId: string; deviceId: string; snapshotId: string } | null;
  historySample?: { searchId: string; reason: string };
  recording?: {
    fileId: string;
    jobId: string;
    name: string;
    offsetSeconds: number;
    url: string;
  } | null;
  id: string;
  channelId: string | null;
  sourceName: string;
  sourceType: "upload" | "channel" | "image-search" | "text-search";
  status: string;
  question: string;
  createdAt: string;
  capturedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
  imageUrl: string | null;
  result: AiResult | null;
  error: string | null;
  model: string | null;
  usage: {
    cached?: boolean;
    segment?: { from: string; to: string; sampleCount: number };
    inputTokens?: number;
    outputTokens?: number;
    local?: boolean;
    elapsedMs?: number;
    peakWorkingSetMiB?: number;
  } | null;
  width: number | null;
  height: number | null;
}
export interface LocalAiModel {
  id: string;
  name: string;
  purpose: string;
  license: string;
  installed: boolean;
  selected: boolean;
  ready: boolean;
  bytes: number;
  benchmark: {
    checkedAt: string;
    warmAverageMs: number;
    peakRssMiB: number;
    detectionCount: number;
  } | null;
}
export interface AiSettings {
  provider: string;
  baseUrl: string;
  version: number;
  enabled: boolean;
  indexEnabled?: boolean;
  indexCapacityMiB?: number;
  indexRetentionDays?: number;
  localEnabled?: boolean;
  qwenAlarmEnabled?: boolean;
  qwenAlarmIntervalSeconds?: number;
  model: string;
  hasKey: boolean;
  timeoutSeconds: number;
  retentionDays: number;
  lastTest: {
    status: string;
    message: string;
    checkedAt: string;
    sampleSummary?: string;
  } | null;
}
export interface AiMatch extends AiJob {
  score: number | null;
  textScore: number;
  visualScore: number | null;
  matchedTerms: string[];
}
export const aiLabels: Record<string, string> = {
  queued: "排队中",
  running: "分析中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
export const aiDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const aiPending = (job: AiJob) =>
  ["queued", "running"].includes(job.status);

export interface AiHistorySearch {
  params: {
    from: string;
    to: string;
    question: string;
    channelIds: string[];
    referenceId?: string;
    verify?: boolean;
  };
  analyzedCount?: number;
  matchedCount?: number;
  localMetrics?: {
    engine: string;
    coarseSampling?: boolean;
    sampleIntervalSeconds?: number;
    motionEvents?: number;
    motionScannedSeconds?: number;
    motionCacheHits?: number;
    periodicSamples?: number;
    refinedSamples?: number;
    focusSamples?: number;
    queryCacheHit?: boolean;
    queryParts?: number;
    cacheHits: number;
    cacheMisses: number;
    localMs: number;
    peakWorkerMiB: number;
    shortlist: number;
    verified: boolean;
  };
  id: string;
  status: string;
  phase: string;
  fileCount: number;
  candidateFiles: number;
  sampleCount: number;
  modelCalls: number;
  truncated: boolean;
  error: string | null;
  items: AiMatch[];
  total: number;
  method: string;
  reused?: boolean;
}

export function aiResultKind(job: AiJob): string {
  if (job.model === "local-reference") return "检索参考图";
  if (job.historySample) return "录像采样画面";
  if (job.model?.startsWith("local-qwen")) return "千问分析结果";
  if (
    job.model?.includes("clip") ||
    /本地相似候选|尚未复核|^相似画面$/.test(job.result?.summary || "")
  )
    return "相似画面";
  return "画面分析结果";
}
export function aiResultSummary(job: AiJob): string {
  const kind = aiResultKind(job);
  if (["检索参考图", "录像采样画面", "相似画面"].includes(kind)) return kind;
  return (
    job.result?.summary || job.error || (aiPending(job) ? "等待分析结果" : "—")
  );
}
export function aiTargetCount(job: AiJob): string {
  const objects = job.result?.objects || [];
  if (
    !objects.length ||
    objects.some((o) => !Number.isInteger(o.count) || o.count! < 0)
  )
    return "未提供";
  return objects.reduce((sum, o) => sum + o.count!, 0) + " 个";
}
export function aiConfidence(value: number | null | undefined): string {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? Math.round(value * 100) + "%"
    : "未提供";
}

export function aiResultStatus(job: AiJob): string {
  if (job.status !== "succeeded") return aiLabels[job.status] || job.status;
  const kind = aiResultKind(job);
  return kind === "检索参考图"
    ? "已保存"
    : kind === "相似画面"
      ? "已匹配"
      : kind === "录像采样画面"
        ? "已采样"
        : "分析完成";
}
export function aiModelName(job: AiJob): string {
  if (job.model === "local-reference") return "参考图片";
  if (job.model?.startsWith("local-qwen")) return "千问 · 本地分析";
  if (job.model?.includes("clip")) return "本地相似检索";
  return job.model || "等待分析";
}

export function aiCandidateTime(job: AiJob): string {
  const segment = job.usage?.segment;
  return segment && segment.from !== segment.to
    ? aiDate(segment.from) +
        " — " +
        new Date(segment.to).toLocaleTimeString("zh-CN", { hour12: false })
    : aiDate(job.capturedAt);
}

<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { api, messageOf } from "../api";
import type { AiHistorySearch, AiJob, AiMatch } from "../ai-types";
import { aiCandidateTime } from "../ai-types";
const emit = defineEmits<{
  details: [job: AiJob];
  running: [value: boolean];
  search: [id: string];
}>();
const job = ref<AiHistorySearch | null>(null),
  error = ref(""),
  loading = ref(false),
  page = ref(1),
  existingQuestion = ref("");
let alive = true,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  key = "",
  signature = "",
  referenceImage = "",
  referenceId = "",
  referenceKey = "";
async function read(id: string, gen: number) {
  try {
    const result = await api<AiHistorySearch>(
      `/ai/history-searches/${id}?page=${page.value}&view=matches`,
    );
    if (!alive || gen !== generation) return;
    job.value = result;
    emit("search", result.id);
    error.value = result.error || "";
    loading.value = ["queued", "running"].includes(result.status);
    emit("running", loading.value);
    if (loading.value) timer = setTimeout(() => void read(id, gen), 2000);
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      loading.value = false;
      emit("running", false);
    }
  }
}
async function start(value: {
  channelId: string;
  from: string;
  to: string;
  question: string;
  verify: boolean;
  reference?: { image: string; name: string };
}) {
  if (loading.value) return;
  const from = Date.parse(value.from),
    to = Date.parse(value.to);
  if (
    !value.channelId ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    to - from > 86400000
  )
    throw Error("请选择通道和有效起止时间，每次不超过24小时");
  if (
    (!value.question.trim() && !value.reference) ||
    value.question.length > 500
  )
    throw Error("请填写要查找的物品或特征，最多500字");
  const nextSignature = JSON.stringify(value);
  if (signature !== nextSignature) {
    signature = nextSignature;
    key = "";
  }
  clearTimeout(timer);
  const gen = ++generation;
  job.value = null;
  error.value = "";
  existingQuestion.value = "";
  page.value = 1;
  loading.value = true;
  emit("running", true);
  try {
    let selectedReference = "";
    if (value.reference) {
      if (referenceImage !== value.reference.image) {
        referenceImage = value.reference.image;
        referenceId = "";
        referenceKey = crypto.randomUUID();
      }
      if (!referenceId) {
        const reference = await api<AiJob>(
          "/ai/analyses",
          "POST",
          {
            image: value.reference.image,
            name: value.reference.name,
            question: "检索参考图片",
            reference: true,
            localReference: true,
          },
          { "Idempotency-Key": referenceKey },
        );
        if (!alive || gen !== generation) return;
        if (reference.status !== "succeeded")
          throw Error("参考图片尚未准备完成，请稍后重试");
        referenceId = reference.id;
      }
      selectedReference = referenceId;
    }
    const result = await api<AiHistorySearch>(
      "/ai/history-searches",
      "POST",
      {
        channelIds: [value.channelId],
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        question: value.question.trim(),
        verify: value.verify,
        referenceId: selectedReference,
      },
      { "Idempotency-Key": key || (key = crypto.randomUUID()) },
    );
    if (!alive || gen !== generation) return;
    key = "";
    job.value = result;
    await read(result.id, gen);
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      loading.value = false;
      emit("running", false);
    }
  }
}
async function resume() {
  try {
    const list = await api<{
      items: (AiHistorySearch & { params?: { question?: string } })[];
    }>("/ai/history-searches");
    if (!alive) return;
    const pending = list.items.find((item) =>
      ["queued", "running"].includes(item.status),
    );
    if (!pending) {
      error.value = "没有正在进行的检索，可重新提交";
      return;
    }
    existingQuestion.value = pending.params?.question || "已有检索";
    error.value = "";
    clearTimeout(timer);
    await read(pending.id, ++generation);
  } catch (e) {
    if (alive) error.value = messageOf(e);
  }
}
async function cancel() {
  if (!job.value) return;
  try {
    await api(`/ai/history-searches/${job.value.id}/cancel`, "POST", {});
    await read(job.value.id, ++generation);
  } catch (e) {
    error.value = messageOf(e);
  }
}
async function turn(delta: number) {
  if (!job.value) return;
  page.value += delta;
  clearTimeout(timer);
  await read(job.value.id, ++generation);
}
async function details(item: AiMatch) {
  try {
    const result = await api<AiJob>(
      item.historySample
        ? `/ai/history-searches/${item.historySample.searchId}/samples/${item.id}`
        : "/ai/analyses/" + item.id,
    );
    if (alive) emit("details", result);
  } catch (e) {
    if (alive) error.value = messageOf(e);
  }
}
async function open(id: string) {
  clearTimeout(timer);
  page.value = 1;
  await read(id, ++generation);
  return job.value;
}
defineExpose({ start, open });
onUnmounted(() => {
  alive = false;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <div class="range-results">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button
      v-if="error.includes('已有录像检索')"
      type="button"
      class="link"
      @click="resume"
    >
      查看进行中任务
    </button>
    <p v-if="existingQuestion" class="range-existing">
      正在查看已有任务：{{ existingQuestion }}
    </p>
    <div v-if="loading" class="range-progress" role="status">
      {{
        job?.status === "queued"
          ? "任务排队中，尚未开始检查"
          : job?.phase === "waiting-resources"
            ? "预览和录像优先，等待空闲资源"
            : job?.phase === "refining"
              ? "正在精查候选前后的录像…"
              : "正在逐段检查录像，尚未完成…"
      }}<button type="button" class="link" :disabled="!job" @click="cancel">
        取消
      </button>
    </div>
    <p v-if="job?.truncated" class="range-warning">
      {{
        job.localMetrics?.coarseSampling
          ? "长时段采用粗筛，短暂目标可能遗漏；可缩小候选时段精查。"
          : "本次检查覆盖不完整，请缩小时间范围继续查找。"
      }}
    </p>
    <div v-if="job?.items.length" class="range-candidates">
      <button
        v-for="item in job.items"
        :key="item.id"
        type="button"
        class="range-candidate"
        @click="details(item)"
      >
        <img
          v-if="item.imageUrl"
          :src="item.imageUrl"
          :alt="item.sourceName + '候选画面'"
          loading="lazy"
        />
        <span
          ><strong>{{ aiCandidateTime(item) }}</strong
          ><small>{{
            item.usage?.segment && item.usage.segment.sampleCount > 1
              ? "相近候选片段，点击核对原录像"
              : item.matchedTerms?.join("、") || "相似候选，点击核对原录像"
          }}</small></span
        >
      </button>
    </div>
    <div v-else-if="!loading && !error" class="range-empty">
      {{
        job
          ? ["succeeded", "partial"].includes(job.status)
            ? "已检查范围内未找到匹配候选"
            : "本次分析未完成"
          : "选择通道、时间段和查找目标后开始分析"
      }}
    </div>
    <nav v-if="job && job.total > 12" aria-label="分析候选分页">
      <button type="button" :disabled="page <= 1" @click="turn(-1)">
        上一页</button
      ><span>{{ page }} / {{ Math.ceil(job.total / 12) }}</span
      ><button
        type="button"
        :disabled="page * 12 >= job.total"
        @click="turn(1)"
      >
        下一页
      </button>
    </nav>
  </div>
</template>
<style scoped>
.range-results {
  padding: 14px;
  min-height: 0;
  overflow: auto;
  flex: 1;
  box-sizing: border-box;
  color: var(--text-secondary, #63728a);
}
.range-progress,
.range-results nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.range-warning {
  padding: 8px;
  background: #fff7e8;
  color: #ad6800;
  font-size: 12px;
}
.range-empty {
  display: grid;
  place-items: center;
  min-height: 150px;
  text-align: center;
  font-size: 13px;
}
.range-candidates {
  display: grid;
  gap: 10px;
}
.range-candidate {
  height: auto;
  min-height: 78px;
  line-height: 1.5;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  background: white;
  border: 1px solid #e5ebf3;
  border-radius: 6px;
  text-align: left;
  color: inherit;
}
.range-candidate img {
  width: 110px;
  aspect-ratio: 16/9;
  object-fit: contain;
  background: #182332;
}
.range-candidate span {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.range-candidate strong {
  font-size: 13px;
  color: #253858;
}
.range-candidate small {
  font-size: 12px;
}
.range-results nav {
  margin-top: 12px;
}
</style>

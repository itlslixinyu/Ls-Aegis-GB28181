<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { api, can, messageOf, ApiError } from "../api";
import type { AiJob, AiMatch, AiHistorySearch } from "../ai-types";
import {
  aiResultSummary,
  aiDate,
  aiPending,
  aiCandidateTime,
} from "../ai-types";
import AiChannelPicker from "./AiChannelPicker.vue";
import { rememberFilter } from "../remember-filter";
import AiImageInput from "./AiImageInput.vue";
import AiResultDialog from "./AiResultDialog.vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps<{ materials?: boolean }>();
const mode = rememberFilter<"text" | "image">("ai.search.mode", "text"),
  text = rememberFilter<string>("ai.search.text", ""),
  reference = ref<{ image: string; name: string } | null>(null),
  referenceId = ref(""),
  referenceMode = ref<"record" | "upload">("record"),
  referenceChoices = ref<AiJob[]>([]),
  results = ref<AiMatch[]>([]),
  total = ref(0),
  page = ref(1),
  busy = ref(false),
  searched = ref(false),
  error = ref(""),
  stage = ref(""),
  method = ref(""),
  truncated = ref(false),
  selected = ref<AiJob | null>(null),
  from = rememberFilter<string>("ai.search.from", ""),
  to = rememberFilter<string>("ai.search.to", "");
const semantic = ref(false);
const verifyHistory = ref(false);
const reasonLabels: Record<string, string> = {
  periodic: "定期采样",
  motion: "画面变化",
  refined: "候选精查",
  "device-event": "设备事件",
  "device-event-received": "设备事件",
};
const resultView = ref<"samples" | "matches">("matches");
const emit = defineEmits<{ navigate: [page: string] }>();
function showRecords() {
  emit("navigate", "aiRecords");
}
async function openHistory(id: string) {
  clearTimeout(timer);
  results.value = [];
  total.value = 0;
  searched.value = false;
  historyJob.value = null;
  method.value = "";
  error.value = "";
  page.value = 1;
  target.value = "history";
  await waitHistory(id, ++generation);
}
async function changeView(view: "samples" | "matches") {
  resultView.value = view;
  page.value = 1;
  if (historyJob.value) await waitHistory(historyJob.value.id, ++generation);
}
const target = ref<"history" | "indexed">(
    props.materials
      ? "indexed"
      : can("ai.analyze") && can("recording.view")
        ? "history"
        : "indexed",
  ),
  historyJob = ref<AiHistorySearch | null>(null),
  historyId = rememberFilter<string>("ai.historySearch.id", ""),
  historyChannel = ref<{
    id: string;
    name: string;
    deviceName: string;
    channelCode: string;
    status: string;
  } | null>(null);
const savedChannel = rememberFilter<string>("ai.historySearch.channel", "");
try {
  const value = JSON.parse(savedChannel.value);
  if (
    value &&
    ["id", "name", "deviceName", "channelCode", "status"].every(
      (k) => typeof value[k] === "string",
    )
  )
    historyChannel.value = value;
} catch {}
watch(historyChannel, (value) => {
  savedChannel.value = value ? JSON.stringify(value) : "";
});
const phases: Record<string, string> = {
  queued: "等待检索",
  planning: "整理录像范围",
  sampling: "读取录像采样",
  matching: "按线索比对画面",
  refining: "精查候选前后录像",
  "waiting-resources": "预览或录像优先，等待空闲资源",
  finished: "检索结束",
};
async function waitHistory(id: string, gen: number) {
  try {
    const result = await api<AiHistorySearch>(
      `/ai/history-searches/${id}?page=${page.value}&view=${resultView.value}`,
    );
    if (!alive || gen !== generation) return;
    historyJob.value = result;
    historyId.value = id;
    results.value = result.items;
    total.value = result.total;
    method.value = result.method;
    truncated.value = result.truncated;
    searched.value = true;
    if (["queued", "running"].includes(result.status)) {
      stage.value = phases[result.phase] || "正在分析录像";
      timer = setTimeout(() => void waitHistory(id, gen), 1500);
      return;
    }
    busy.value = false;
    stage.value = "";
    if (result.error) error.value = result.error;
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      busy.value = false;
      stage.value = "";
    }
  }
}
async function startHistory(gen: number) {
  if (!from.value || !to.value)
    throw Error("检索录像请先选择开始时间和结束时间");
  const range = dates();
  if (
    Date.parse(range.to) <= Date.parse(range.from) ||
    Date.parse(range.to) - Date.parse(range.from) > 86400000
  )
    throw Error("每次检索请选择24小时以内的有效时间段");
  if (mode.value === "image" && !referenceId.value)
    throw Error("请先完成参考图片分析，或选择已有参考画面");
  const result = await api<AiHistorySearch>(
    "/ai/history-searches",
    "POST",
    {
      question: text.value,
      referenceId: mode.value === "image" ? referenceId.value : "",
      ...range,
      channelIds: historyChannel.value ? [historyChannel.value.id] : [],
      verify: verifyHistory.value,
    },
    { "Idempotency-Key": crypto.randomUUID() },
  );
  if (!alive || gen !== generation) return;
  historyJob.value = result;
  historyId.value = result.id;
  await waitHistory(result.id, gen);
}
async function cancelHistory() {
  if (!historyJob.value) return;
  try {
    await api(`/ai/history-searches/${historyJob.value.id}/cancel`, "POST", {});
    await waitHistory(historyJob.value.id, generation);
  } catch (e) {
    error.value = messageOf(e);
  }
}
onMounted(() => {
  if (!props.materials && historyId.value) {
    busy.value = true;
    void waitHistory(historyId.value, ++generation);
  }
});
let queryId = "",
  queryText = "";
const pages = computed(() => Math.max(1, Math.ceil(total.value / 12)));
let alive = true,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  requestKey = "";
function changedReference(value: { image: string; name: string } | null) {
  reference.value = value;
  referenceId.value = "";
  requestKey = "";
}
async function loadReferences() {
  try {
    const response = await api<{ items: AiJob[] }>(
      "/ai/analyses?status=succeeded&pageSize=100",
    );
    if (alive)
      referenceChoices.value = response.items.filter(
        (j) => j.imageUrl && j.sourceType !== "image-search",
      );
  } catch (e) {
    if (alive) error.value = messageOf(e);
  }
}
function dates() {
  if (from.value && to.value && Date.parse(from.value) > Date.parse(to.value))
    throw Error("开始时间不能晚于结束时间");
  return {
    from: from.value ? new Date(from.value).toISOString() : "",
    to: to.value ? new Date(to.value).toISOString() : "",
  };
}
async function execute(gen: number) {
  if (target.value === "history") {
    await startHistory(gen);
    return;
  }
  const range = dates();
  const response = await api<{
    items: AiMatch[];
    total: number;
    method: string;
    truncated: boolean;
  }>("/ai/search", "POST", {
    text: text.value,
    queryId: mode.value === "text" && semantic.value ? queryId : "",
    referenceId: mode.value === "image" ? referenceId.value : "",
    ...range,
    page: page.value,
    pageSize: 12,
  });
  if (alive && gen === generation) {
    results.value = response.items;
    total.value = response.total;
    method.value = response.method;
    truncated.value = response.truncated;
    searched.value = true;
    busy.value = false;
    stage.value = "";
  }
}
async function waitReference(
  id: string,
  gen: number,
  deadline: number,
  isQuery = false,
) {
  try {
    if (!alive || gen !== generation) return;
    if (Date.now() > deadline)
      throw Error("参考图分析等待超时，可在画面分析记录中确认结果后重试");
    const job = await api<AiJob>("/ai/analyses/" + id);
    if (!alive || gen !== generation) return;
    if (aiPending(job)) {
      timer = setTimeout(
        () => void waitReference(id, gen, deadline, isQuery),
        1000,
      );
      return;
    }
    if (job.status !== "succeeded")
      throw Error(job.error || "参考图分析未完成");
    if (isQuery) {
      queryId = job.id;
      queryText = text.value;
    } else referenceId.value = job.id;
    stage.value = "正在检索画面…";
    await execute(gen);
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      busy.value = false;
      stage.value = "";
    }
  }
}
async function search(reset = true) {
  if (busy.value) return;
  const gen = ++generation;
  error.value = "";
  stage.value = "";
  if (reset) {
    results.value = [];
    total.value = 0;
    searched.value = false;
    method.value = "";
    truncated.value = false;
    historyJob.value = null;
  }
  try {
    dates();
    if (mode.value === "text" && !text.value.trim())
      throw Error("请输入要检索的物体或场景");
    if (
      mode.value === "image" &&
      referenceMode.value === "record" &&
      !referenceId.value
    )
      throw Error("请先选择一条已完成的分析画面");
    if (
      mode.value === "image" &&
      referenceMode.value === "upload" &&
      !reference.value
    )
      throw Error("请先选择参考图片");
    if (!reset && target.value === "history" && historyJob.value) {
      busy.value = true;
      await waitHistory(historyJob.value.id, gen);
      return;
    }
    if (reset) page.value = 1;
    busy.value = true;
    if (
      target.value === "history" &&
      (mode.value === "text" || referenceId.value)
    ) {
      await startHistory(gen);
    } else if (
      mode.value === "text" &&
      semantic.value &&
      can("ai.analyze") &&
      (!queryId || queryText !== text.value)
    ) {
      stage.value = "DeepSeek正在理解查询条件…";
      const job = await api<AiJob>(
        "/ai/query-plans",
        "POST",
        { text: text.value },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      if (!alive || gen !== generation) return;
      await waitReference(job.id, gen, Date.now() + 130000, true);
    } else if (mode.value === "image" && !referenceId.value) {
      if (!can("ai.analyze")) throw Error("参考图片分析需要AI画面分析权限");
      stage.value = "正在准备参考图片…";
      const job = await api<AiJob>(
        "/ai/analyses",
        "POST",
        {
          image: reference.value!.image,
          name: reference.value!.name,
          question:
            "描述参考图片中的物体、颜色、场景与位置，用于查找相似画面。",
          reference: true,
          localReference: true,
        },
        { "Idempotency-Key": requestKey || (requestKey = crypto.randomUUID()) },
      );
      if (!alive || gen !== generation) return;
      await waitReference(job.id, gen, Date.now() + 130000);
    } else {
      stage.value = "正在检索画面…";
      await execute(gen);
    }
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      busy.value = false;
      stage.value = "";
    }
  }
}
async function details(item: AiJob) {
  try {
    const job = await api<AiJob>(
      item.historySample
        ? `/ai/history-searches/${item.historySample.searchId}/samples/${item.id}`
        : "/ai/analyses/" + item.id,
    );
    if (alive) selected.value = job;
  } catch (e) {
    if (alive) {
      error.value = messageOf(e);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        selected.value = null;
    }
  }
}
function imageFailed(event: Event) {
  (event.target as HTMLImageElement).style.visibility = "hidden";
}
onUnmounted(() => {
  alive = false;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="business-page ai-search-page">
    <div class="title">
      <div>
        <h1>{{ materials ? "检索已有画面" : "录像检索" }}</h1>
        <p>按线索查找录像，定位关键画面。</p>
      </div>
    </div>
    <div class="panel ai-search-shell">
      <header class="ai-workspace-header">
        <div class="ai-workspace-tabs">
          <button
            v-if="materials"
            type="button"
            class="link"
            @click="emit('navigate', 'aiSearch')"
          >
            返回录像检索</button
          ><span v-else class="workspace-current">录像检索</span>
        </div>
        <button type="button" class="secondary" @click="showRecords">
          分析记录
        </button>
        <span class="workspace-note">{{
          materials ? "已保存画面 · 本地匹配" : "本地检索 · 按需分析"
        }}</span>
      </header>
      <div class="ai-search-layout">
        <aside class="ai-search-controls">
          <div class="ai-resource-heading">
            <h3>{{ target === "history" ? "通道资源" : "检索素材" }}</h3>
            <span>{{ mode === "image" ? "参考图片" : "选择范围" }}</span>
          </div>
          <div class="ai-search-source-scroll">
            <div v-if="target === 'history'" class="ai-channel-field">
              <label>通道范围</label
              ><AiChannelPicker
                v-model="historyChannel"
                :disabled="busy"
                allow-offline
              />
              <p class="panel-note">
                {{
                  historyChannel
                    ? "已选：" + historyChannel.name
                    : "未指定时查询当前授权通道"
                }}
                <button
                  v-if="historyChannel"
                  type="button"
                  class="text-button"
                  :disabled="busy"
                  @click="historyChannel = null"
                >
                  清除
                </button>
              </p>
            </div>
            <label class="ai-ref-source-field" v-if="mode === 'image'"
              >参考来源<select
                v-model="referenceMode"
                :disabled="busy"
                @change="
                  referenceId = '';
                  referenceMode === 'record' && loadReferences();
                "
              >
                <option value="record">使用已有分析画面</option>
                <option value="upload">上传新的参考图片</option>
              </select></label
            >
            <label
              class="ai-ref-record-field"
              v-if="mode === 'image' && referenceMode === 'record'"
              >参考画面<select v-model="referenceId" :disabled="busy">
                <option value="">请选择已完成的分析画面</option>
                <option
                  v-for="item in referenceChoices"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.sourceName }} · {{ aiCandidateTime(item) }}
                </option></select
              ><small
                >从最近100条已完成记录中选择，不重新上传或调用模型。</small
              ></label
            >
            <div
              v-if="mode === 'image' && referenceMode === 'upload'"
              class="ai-ref-upload-field"
            >
              <AiImageInput
                :disabled="busy || !can('ai.analyze')"
                @change="changedReference"
                @error="error = $event"
              />
            </div>

            <div
              v-if="target === 'indexed' && mode === 'text'"
              class="ai-resource-note"
            >
              <AppIcon name="ai" :size="25" /><b>已有分析画面</b>
              <p>按描述查找已保存的画面与中文分析结果。</p>
            </div>
          </div>
        </aside>
        <div class="ai-search-right">
          <form class="ai-query-panel" @submit.prevent="search()">
            <div class="ai-query-heading">
              <div class="ai-search-modes">
                <button
                  type="button"
                  :class="{ active: mode === 'text' }"
                  :disabled="busy"
                  @click="mode = 'text'"
                >
                  文字找物</button
                ><button
                  type="button"
                  :class="{ active: mode === 'image' }"
                  :disabled="busy"
                  @click="
                    mode = 'image';
                    loadReferences();
                  "
                >
                  以图找图
                </button>
              </div>
              <label v-if="!materials" class="ai-scope-field"
                >查找范围<select v-model="target" :disabled="busy">
                  <option
                    value="history"
                    :disabled="!can('ai.analyze') || !can('recording.view')"
                  >
                    按线索检索历史录像
                  </option>
                  <option value="indexed">仅查已有分析画面</option>
                </select></label
              >
            </div>
            <div class="ai-search-query-fields">
              <label class="ai-query-field"
                >{{ mode === "text" ? "物体或场景描述" : "补充描述（可选）"
                }}<textarea
                  v-model="text"
                  rows="2"
                  maxlength="500"
                  :disabled="busy"
                  :required="mode === 'text'"
                  placeholder="例如：背着黑色双肩包、穿浅色外套的人，或路边的白色纸箱"
                ></textarea>
              </label>
              <label class="ai-time-field"
                >开始时间<input
                  v-model="from"
                  type="datetime-local"
                  :disabled="busy"
              /></label>
              <label class="ai-time-field"
                >结束时间<input
                  v-model="to"
                  type="datetime-local"
                  :disabled="busy"
              /></label>
              <div class="ai-query-action">
                <button type="submit" :disabled="busy" class="ai-search-submit">
                  <AppIcon name="search" :size="16" />{{
                    busy ? "处理中…" : "开始检索"
                  }}
                </button>
              </div>
            </div>
            <div class="ai-query-options">
              <label
                v-if="
                  target === 'indexed' && mode === 'text' && can('ai.analyze')
                "
                class="checkbox-label ai-option-field"
                ><input
                  v-model="semantic"
                  type="checkbox"
                  :disabled="busy"
                />使用DeepSeek理解同义词与排除条件</label
              >
              <label
                v-if="target === 'history'"
                class="checkbox-label ai-option-field"
                ><input
                  v-model="verifyHistory"
                  type="checkbox"
                  :disabled="busy"
                />使用DeepSeek复核少量候选</label
              >
            </div>
            <div class="ai-search-form-actions">
              <button
                v-if="busy && historyJob && target === 'history'"
                type="button"
                class="secondary"
                @click="cancelHistory"
              >
                取消本次检索
              </button>
              <p v-if="error" class="error" role="alert">{{ error }}</p>
              <p v-if="stage" role="status" class="ai-search-stage">
                {{ stage }}
              </p>
            </div>
          </form>
          <div class="ai-search-results">
            <div class="ai-result-toolbar">
              <div class="panel-heading">
                <h3>检索结果</h3>
                <span v-if="searched"
                  >{{
                    target === "history" && resultView === "samples"
                      ? "已采样"
                      : "共"
                  }}
                  {{ total }}
                  {{
                    target === "history" && resultView === "samples"
                      ? "张"
                      : "条"
                  }}</span
                ><span v-else>等待检索</span>
              </div>
              <div
                v-if="target === 'history' && historyJob"
                class="ai-search-modes"
              >
                <button
                  type="button"
                  :class="{ active: resultView === 'samples' }"
                  @click="changeView('samples')"
                >
                  分析画面</button
                ><button
                  type="button"
                  :class="{ active: resultView === 'matches' }"
                  @click="changeView('matches')"
                >
                  候选片段
                </button>
              </div>
            </div>
            <p
              v-if="
                target === 'history' &&
                resultView === 'matches' &&
                results.length
              "
              class="panel-note"
            >
              候选需结合原录像核实。
            </p>
            <p
              v-if="
                target === 'history' && historyJob?.localMetrics?.coarseSampling
              "
              class="panel-note"
            >
              长时段采用粗筛，可能遗漏短暂目标；候选片段可缩小范围精查。
            </p>
            <p v-if="target === 'indexed' && searched" class="ai-search-method">
              {{ method }}
            </p>
            <div v-if="results.length" class="ai-match-grid">
              <button
                v-for="item in results"
                :key="item.id"
                type="button"
                class="ai-match-card"
                @click="details(item)"
              >
                <div class="ai-match-image">
                  <img
                    v-if="item.imageUrl"
                    :src="item.imageUrl"
                    :alt="item.sourceName + '分析画面'"
                    loading="lazy"
                    @error="imageFailed"
                  /><span class="ai-match-score">{{
                    item.historySample
                      ? "录像采样"
                      : item.score === null
                        ? "候选片段"
                        : (item.visualScore == null ? "匹配度 " : "相似度 ") +
                          item.score +
                          " 分"
                  }}</span>
                </div>
                <div class="ai-match-content">
                  <strong>{{ item.sourceName }}</strong
                  ><small>{{ aiCandidateTime(item) }}</small>
                  <p v-if="!item.historySample">{{ aiResultSummary(item) }}</p>
                  <div class="ai-match-tags">
                    <span v-if="item.recording">可定位录像</span>
                    <span v-if="item.historySample">{{
                      reasonLabels[item.historySample.reason] || "录像采样"
                    }}</span>
                    <span
                      v-for="tag in item.matchedTerms.slice(0, 4)"
                      :key="tag"
                      >{{ tag }}</span
                    >
                  </div>
                </div>
              </button>
            </div>
            <div v-else class="ai-search-empty">
              <AppIcon name="search" :size="38" /><b>{{
                busy
                  ? "正在准备检索结果"
                  : searched
                    ? target === "history"
                      ? historyJob &&
                        ["failed", "cancelled", "interrupted"].includes(
                          historyJob.status,
                        )
                        ? "检索尚未完成"
                        : "本次抽样未找到候选"
                      : "没有匹配画面"
                    : "从描述或参考图片开始"
              }}</b>
              <p>
                {{
                  searched
                    ? "可缩小通道或时间范围、补充物体颜色与场景后继续查找。"
                    : "分析过的物体、颜色和场景将用于匹配。"
                }}
              </p>
            </div>
            <div v-if="searched" class="ai-search-pagination">
              <button
                class="secondary"
                :disabled="page <= 1 || (busy && target !== 'history')"
                @click="
                  page--;
                  search(false);
                "
              >
                上一页</button
              ><span>第 {{ page }} / {{ pages }} 页</span
              ><button
                class="secondary"
                :disabled="page >= pages || (busy && target !== 'history')"
                @click="
                  page++;
                  search(false);
                "
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <AiResultDialog :job="selected" @close="selected = null" />
  </section>
</template>
<style scoped>
.ai-search-shell {
  padding: 0;
  overflow: hidden;
}
.ai-workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 54px;
  padding: 0 20px;
  border-bottom: 1px solid var(--line);
}
.ai-workspace-tabs {
  display: flex;
  gap: 24px;
  align-self: stretch;
}
.ai-workspace-tabs button {
  padding: 0 2px;
  height: auto;
  background: transparent;
  box-shadow: none;
  border: 0;
  border-radius: 0;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font-size: 14px;
}
.ai-workspace-tabs button.active,
.workspace-current {
  color: var(--blue);
  font-weight: 600;
  border-bottom-color: var(--blue);
}
.ai-workspace-tabs button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -4px;
}
.ai-workspace-header > .secondary {
  margin-left: auto;
}
.workspace-note {
  color: var(--muted);
  font-size: 12px;
}
.ai-search-layout {
  height: calc(100dvh - 260px);
  min-height: 460px;
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  background: #fff;
}
.ai-search-controls {
  padding: 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}
.ai-resource-heading {
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: none;
  border-bottom: 1px solid var(--line);
}
.ai-resource-heading h3 {
  font-size: 13px;
  margin: 0;
}
.ai-resource-heading > span {
  color: var(--muted);
  font-size: 11px;
}
.ai-search-source-scroll {
  padding: 14px;
  overflow: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ai-search-controls label {
  display: grid;
  gap: 8px;
  font-size: 12px;
  margin: 0;
  min-width: 0;
}
.ai-search-controls select {
  width: 100%;
  min-width: 0;
  height: 34px;
  font-size: 12px;
}
.ai-search-controls small {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.ai-channel-field > label {
  display: none;
}
.ai-channel-field :deep(.ai-channel-options) {
  max-height: 360px;
  margin: 10px 0;
}
.ai-channel-field :deep(.ai-channel-option) {
  padding: 9px 8px;
  gap: 8px;
  min-height: 58px;
}
.ai-channel-field :deep(.ai-channel-option .badge) {
  font-size: 11px;
}
.ai-channel-field :deep(.ai-channel-option b) {
  font-size: 12px;
}
.ai-channel-field :deep(.ai-channel-option small) {
  font-size: 11px;
}
.ai-channel-field :deep(.ai-channel-pagination) {
  gap: 5px;
  font-size: 11px;
}
.ai-channel-field :deep(.ai-channel-pagination button) {
  padding: 4px 5px;
  font-size: 11px;
}
.ai-channel-field > .panel-note {
  font-size: 12px;
  margin: 10px 0 0;
  line-height: 1.7;
  color: var(--muted);
}
.ai-channel-field :deep(.panel-note:not(:last-child)) {
  font-size: 12px;
}
.ai-ref-upload-field :deep(.ai-image-placeholder) {
  min-height: 120px;
}
.ai-ref-upload-field :deep(canvas) {
  height: 120px;
}
.ai-resource-note {
  padding: 24px 6px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--muted);
}
.ai-resource-note .app-icon {
  color: #8aa2bc;
}
.ai-resource-note b {
  font-size: 13px;
  color: #526176;
  font-weight: 500;
}
.ai-resource-note p {
  font-size: 12px;
  line-height: 1.8;
  margin: 0;
}
.ai-search-right {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ai-query-panel {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--line);
  background: #fbfcfe;
  flex: none;
}
.ai-query-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.ai-search-modes {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #f4f7fb;
  width: fit-content;
}
.ai-search-modes button {
  min-height: 28px;
  padding: 4px 14px;
  background: transparent;
  color: var(--muted);
  border: 0;
  box-shadow: none;
  font-size: 12px;
}
.ai-search-modes button.active {
  background: #fff;
  color: var(--blue);
  box-shadow: 0 1px 3px #102f5a12;
}
.ai-scope-field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.ai-scope-field select {
  width: 205px;
  height: 32px;
  font-size: 12px;
  background: #fff;
}
.ai-search-query-fields {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 176px 176px auto;
  gap: 12px;
  align-items: end;
}
.ai-search-query-fields label {
  display: grid;
  gap: 7px;
  margin: 0;
  font-size: 12px;
  min-width: 0;
}
.ai-search-query-fields textarea,
.ai-search-query-fields input {
  width: 100%;
  min-width: 0;
  height: 36px;
  font-size: 12px;
  padding: 7px 8px;
}
.ai-search-query-fields textarea {
  resize: vertical;
  min-height: 36px;
  max-height: 90px;
  line-height: 1.6;
}
.ai-search-query-fields input[type="datetime-local"] {
  text-align: center;
  padding: 6px 4px;
}
.ai-search-submit {
  justify-content: center;
  min-height: 36px;
  height: 36px;
  padding: 6px 12px;
  font-size: 13px;
  white-space: nowrap;
}
.ai-query-options {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.checkbox-label input {
  width: 14px;
  height: 14px;
  min-width: 14px;
  margin: 0;
}
.ai-search-form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ai-search-form-actions .error,
.ai-search-stage {
  font-size: 12px;
  margin: 9px 0 0;
  line-height: 1.6;
}
.ai-search-form-actions > button {
  margin-top: 8px;
  font-size: 12px;
}
.ai-search-results {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 0;
  background: #fff;
}
.ai-result-toolbar {
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.ai-result-toolbar .panel-heading {
  padding: 0;
  margin: 0;
  border: 0;
  display: flex;
  gap: 12px;
  align-items: center;
}
.ai-result-toolbar h3 {
  font-size: 13px;
  margin: 0;
}
.ai-result-toolbar .panel-heading > span {
  font-size: 12px;
  color: var(--muted);
}
.ai-search-results > .panel-note,
.ai-search-method {
  padding: 8px 20px 0;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}
.ai-match-grid {
  padding: 16px 20px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: max-content;
  gap: 16px;
  align-items: start;
  align-content: start;
  overflow: auto;
  min-height: 0;
  flex: 1;
}
.ai-match-card {
  min-width: 0;
  display: block;
  padding: 0;
  height: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: #344054;
  overflow: hidden;
  text-align: left;
  box-shadow: none;
}
.ai-match-card:hover {
  border-color: var(--accent-outline);
  box-shadow: 0 3px 12px #173b6210;
}
.ai-match-image {
  position: relative;
  aspect-ratio: 16/9;
  background: #142132;
  overflow: hidden;
}
.ai-match-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.ai-match-score {
  position: absolute;
  right: 7px;
  bottom: 7px;
  padding: 3px 7px;
  border-radius: 4px;
  color: #fff;
  background: #12263add;
  font-size: 11px;
}
.ai-match-content {
  padding: 12px;
  display: grid;
  gap: 7px;
}
.ai-match-content strong {
  font-size: 13px;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.ai-match-content small {
  font-size: 12px;
  color: var(--muted);
}
.ai-match-content p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: #697180;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ai-match-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.ai-match-tags span {
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 3px;
  background: var(--blue-soft);
  color: var(--blue);
}
.ai-search-empty {
  margin: 16px 20px;
  border: 1px dashed #dce4ef;
  border-radius: 6px;
  background: #f8fafc;
  display: flex;
  flex: 1;
  min-height: 200px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 13px;
  color: var(--muted);
  padding: 24px;
}
.ai-search-empty .app-icon {
  color: #8aa2bc;
}
.ai-search-empty b {
  color: #43546b;
  font-size: 14px;
  font-weight: 500;
}
.ai-search-empty p {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  max-width: 360px;
}
.ai-search-pagination {
  flex: none;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
@media (min-width: 1800px) {
  .ai-match-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (max-width: 1450px) {
  .ai-match-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 1200px) {
  .ai-search-query-fields {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .ai-query-field {
    grid-column: 1/-1;
  }
}
@media (max-width: 1100px) {
  .ai-search-layout {
    grid-template-columns: 230px minmax(0, 1fr);
  }
  .ai-query-heading {
    flex-wrap: wrap;
    gap: 10px;
  }
  .ai-query-heading .ai-scope-field {
    width: 100%;
    justify-content: space-between;
  }
}
@media (min-width: 761px) and (max-height: 760px) {
  .ai-search-layout {
    min-height: 0;
  }
  .ai-query-panel {
    padding-top: 12px;
    padding-bottom: 10px;
  }
  .ai-query-heading {
    margin-bottom: 10px;
  }
  .ai-result-toolbar {
    padding-top: 10px;
    padding-bottom: 10px;
  }
}
@media (max-width: 760px) {
  .ai-workspace-header {
    padding: 0 16px;
  }
  .workspace-note {
    display: none;
  }
  .ai-workspace-tabs {
    min-height: 52px;
    gap: 20px;
  }
  .ai-search-layout {
    height: auto;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
  }
  .ai-search-controls {
    border-right: 0;
    border-bottom: 1px solid var(--line);
    max-height: 300px;
  }
  .ai-search-source-scroll {
    max-height: 240px;
  }
  .ai-search-right {
    min-height: 500px;
  }
  .ai-query-panel {
    padding: 16px;
  }
  .ai-query-heading {
    gap: 12px;
  }
  .ai-scope-field select {
    width: 190px;
  }
  .ai-search-query-fields {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .ai-query-action {
    grid-column: 1/-1;
  }
  .ai-search-submit {
    width: 100%;
  }
  .ai-query-options {
    margin-top: 12px;
  }
  .ai-match-grid {
    grid-template-columns: minmax(0, 1fr);
    max-height: 65vh;
    padding: 16px;
  }
  .ai-search-empty {
    margin: 16px;
    min-height: 250px;
  }
  .ai-result-toolbar {
    padding: 12px 16px;
    flex-wrap: wrap;
  }
  .ai-history-panel {
    padding: 16px;
  }
  .ai-history-table {
    max-height: 65vh;
  }
}
</style>

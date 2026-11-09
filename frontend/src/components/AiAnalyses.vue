<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { api, can, messageOf, ApiError } from "../api";
import { rememberFilter } from "../remember-filter";
import type { AiJob } from "../ai-types";
import {
  aiLabels,
  aiDate,
  aiPending,
  aiResultSummary,
  aiResultStatus,
} from "../ai-types";
import AiImageInput from "./AiImageInput.vue";
import AiChannelPicker from "./AiChannelPicker.vue";
import AiResultDialog from "./AiResultDialog.vue";
import AppIcon from "./AppIcon.vue";
import AiHistoryRecords from "./AiHistoryRecords.vue";
import AiRecordingSource from "./AiRecordingSource.vue";
import AiRangeResults from "./AiRangeResults.vue";
const props = defineProps<{ recordsOnly?: boolean }>();
const emit = defineEmits<{ navigate: [page: string]; materials: [] }>();
const localImage = ref(true);
const imageInput = ref<{
  drawPreview: (target: HTMLCanvasElement) => boolean;
}>();
const uploadedCanvas = ref<HTMLCanvasElement>();
const recordedSearchId = rememberFilter<string>("ai.historySearch.id", "");
const savedMaterials = rememberFilter<"workbench" | "materials">(
  "ai.workspace.section",
  "workbench",
  (value) => ["workbench", "materials"].includes(value),
);
function openRecordedSearch(id: string) {
  savedMaterials.value = "workbench";
  source.value = "channel";
  recordedSearchId.value = id;
  emit("navigate", "aiSearch");
}
const activeJob = ref<AiJob | null>(null),
  previewError = ref(false);
watch(
  () => activeJob.value?.id,
  () => {
    previewError.value = false;
  },
);
const source = rememberFilter<"channel" | "upload">(
    "ai.workspace.source",
    "channel",
    (value) => ["channel", "upload"].includes(value),
  ),
  channel = ref<{
    id: string;
    name: string;
    deviceName: string;
    channelCode: string;
    status: string;
  } | null>(null),
  upload = ref<{ image: string; name: string } | null>(null),
  question = ref("");
const today = new Date().toLocaleDateString("sv-SE", {
  timeZone: "Asia/Shanghai",
});
const rangeFrom = rememberFilter<string>("ai.analysis.from", today + "T00:00");
const rangeTo = rememberFilter<string>("ai.analysis.to", today + "T23:59");
const rangeResults = ref<{
  open: (id: string) => Promise<import("../ai-types").AiHistorySearch | null>;
  start: (value: {
    channelId: string;
    from: string;
    to: string;
    question: string;
    verify: boolean;
    reference?: { image: string; name: string };
  }) => Promise<void>;
}>();
const rangeRunning = ref(false);
watch(
  [() => upload.value?.image, uploadedCanvas, source],
  () => {
    if (source.value === "upload" && upload.value && uploadedCanvas.value)
      imageInput.value?.drawPreview(uploadedCanvas.value);
  },
  { flush: "post" },
);
watch(
  () => upload.value?.image,
  () => {
    activeJob.value = null;
    selected.value = null;
    previewError.value = false;
  },
);
type RecordingFrame = {
  recordingFileId: string;
  frameOffset: number;
  capturedAt: string;
  name: string;
};
const recordingFrame = ref<RecordingFrame | null>(null);
const recordingPlayer = ref<{ pauseAndSelect: () => RecordingFrame | null }>();
const draggedChannel = ref<NonNullable<typeof channel.value> | null>(null);
function dropRecording(event: DragEvent) {
  const id = event.dataTransfer?.getData("application/x-ls-aegis-channel");
  if (busy.value || !id || draggedChannel.value?.id !== id) return;
  source.value = "channel";
  channel.value = draggedChannel.value;
  draggedChannel.value = null;
  recordingFrame.value = null;
  sourceError.value = "";
}
watch([() => channel.value?.id, source], () => {
  recordingFrame.value = null;
  activeJob.value = null;
});
const status = ref<{
    enabled: boolean;
    recordingFrames?: boolean;
    localPrompt?: boolean;
    localEnabled?: boolean;
    local?: { ready: boolean; qwenReady?: boolean };
    qwenAlarm?: { ready: boolean; enabled: boolean };
    hasKey: boolean;
    model: string;
    lastTest: { status: string } | null;
  } | null>(null),
  jobs = ref<AiJob[]>([]),
  total = ref(0),
  error = ref(""),
  sourceError = ref(""),
  message = ref(""),
  busy = ref(false),
  loading = ref(true),
  selected = ref<AiJob | null>(null);
const q = rememberFilter<string>("ai.analyses.q", ""),
  filterStatus = rememberFilter<string>("ai.analyses.status", ""),
  page = rememberFilter<number>("ai.analyses.page", 1, (n) => n >= 1),
  pages = computed(() => Math.max(1, Math.ceil(total.value / 20)));
let alive = true,
  generation = 0,
  requestKey = "",
  timer: ReturnType<typeof setTimeout> | undefined,
  searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  [
    source,
    localImage,
    question,
    () => upload.value?.image,
    () => channel.value?.id,
    () => recordingFrame.value?.recordingFileId,
    () => recordingFrame.value?.frameOffset,
    rangeFrom,
    rangeTo,
  ],
  () => {
    requestKey = "";
    sourceError.value = "";
  },
);
async function load() {
  const gen = ++generation;
  try {
    const [list, model] = await Promise.all([
      props.recordsOnly
        ? api<{ items: AiJob[]; total: number }>(
            `/ai/analyses?page=${page.value}&pageSize=20&q=${encodeURIComponent(q.value)}&status=${encodeURIComponent(filterStatus.value)}`,
          )
        : Promise.resolve({ items: [] as AiJob[], total: 0 }),
      props.recordsOnly
        ? Promise.resolve(null)
        : api<typeof status.value>("/ai/status"),
    ]);
    if (!alive || gen !== generation) return;
    jobs.value = list.items;
    if (activeJob.value)
      activeJob.value =
        list.items.find((job) => job.id === activeJob.value?.id) ||
        activeJob.value;
    total.value = list.total;
    status.value = model;
    error.value = "";
    if (page.value > pages.value) {
      page.value = pages.value;
      await load();
      return;
    }
    const detailId =
      selected.value?.id ||
      (activeJob.value &&
      aiPending(activeJob.value) &&
      !list.items.some((job) => job.id === activeJob.value?.id)
        ? activeJob.value.id
        : null);
    if (detailId) {
      try {
        const job = await api<AiJob>("/ai/analyses/" + detailId);
        if (alive && gen === generation) {
          if (selected.value?.id === job.id) selected.value = job;
          if (activeJob.value?.id === job.id) activeJob.value = job;
        }
      } catch (e) {
        if (alive && gen === generation) {
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
            if (selected.value?.id === detailId) selected.value = null;
            if (activeJob.value?.id === detailId) activeJob.value = null;
          }
          error.value = messageOf(e);
        }
      }
    }
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        jobs.value = [];
        total.value = 0;
        selected.value = null;
        activeJob.value = null;
      }
    }
  } finally {
    if (alive && gen === generation) loading.value = false;
  }
}
async function poll() {
  await load();
  if (alive)
    timer = setTimeout(
      poll,
      jobs.value.some(aiPending) ||
        (selected.value && aiPending(selected.value)) ||
        (activeJob.value && aiPending(activeJob.value))
        ? 2000
        : 10000,
    );
}
function search() {
  clearTimeout(searchTimer);
  page.value = 1;
  searchTimer = setTimeout(load, 250);
}
async function submit() {
  if (busy.value || rangeRunning.value) return;
  sourceError.value = "";
  message.value = "";
  if (source.value === "channel") {
    if (!channel.value) {
      sourceError.value = "请先选择或拖入通道";
      return;
    }
    if (!rangeResults.value) {
      sourceError.value = "正在准备时段分析，请稍后再试";
      return;
    }
    try {
      recordedSearchId.value = "";
      await rangeResults.value.start({
        channelId: channel.value.id,
        from: rangeFrom.value,
        to: rangeTo.value,
        question: question.value,
        verify: !localImage.value,
        ...(upload.value ? { reference: upload.value } : {}),
      });
    } catch (e) {
      sourceError.value = messageOf(e);
    }
    return;
  }
  if (source.value === "upload" && !upload.value) {
    sourceError.value = "请先选择图片";
    return;
  }
  if (localImage.value && status.value && !status.value.localPrompt) {
    sourceError.value = "本地自定义要求需更新后端后生效";
    return;
  }
  busy.value = true;
  try {
    const body = {
      question: question.value,
      ...(localImage.value ? { localAnalysis: true } : {}),
      image: upload.value!.image,
      name: upload.value!.name,
    };
    const result = await api<AiJob>("/ai/analyses", "POST", body, {
      "Idempotency-Key": requestKey || (requestKey = crypto.randomUUID()),
    });
    if (!alive) return;
    activeJob.value = result;
    selected.value = result;
    requestKey = "";
    message.value = localImage.value
      ? "千问分析已提交，完成后自动更新"
      : "任务已提交，完成后自动显示分析结果";
    page.value = 1;
    await load();
  } catch (e) {
    if (alive) sourceError.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
async function cancel(job: AiJob) {
  try {
    await api("/ai/analyses/" + job.id + "/cancel", "POST", {});
    await load();
  } catch (e) {
    if (alive) error.value = messageOf(e);
  }
}
async function details(job: AiJob) {
  try {
    const result = await api<AiJob>("/ai/analyses/" + job.id);
    if (alive) {
      activeJob.value = result;
      selected.value = result;
    }
  } catch (e) {
    if (alive) error.value = messageOf(e);
  }
}
onMounted(async () => {
  void poll();
  if (
    props.recordsOnly ||
    source.value !== "channel" ||
    !recordedSearchId.value
  )
    return;
  const id = recordedSearchId.value;
  // Wait for the results panel to mount before restoring a selected record.
  await nextTick();
  const result = await rangeResults.value?.open(id);
  if (!alive || !result) return;
  const local = (value: string) =>
    new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19);
  rangeFrom.value = local(result.params.from);
  rangeTo.value = local(result.params.to);
  question.value = result.params.question || "";
  localImage.value = result.params.verify !== true;
  if (result.params.channelIds.length === 1) {
    const item = result.items.find(
      (item) => item.channelId === result.params.channelIds[0],
    );
    channel.value = {
      id: result.params.channelIds[0]!,
      name: item?.sourceName || "原检索通道",
      deviceName: "",
      channelCode: "",
      status: "unknown",
    };
  }
});
onUnmounted(() => {
  alive = false;
  generation++;
  clearTimeout(timer);
  clearTimeout(searchTimer);
});
</script>
<template>
  <section class="business-page ai-analysis-page">
    <div class="title">
      <div>
        <h1>{{ recordsOnly ? "分析记录" : "录像检索" }}</h1>
        <p>
          {{
            recordsOnly
              ? "集中查看画面分析与录像检索记录。"
              : "选择通道与时间段，使用文字或参考图查找录像。"
          }}
        </p>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <p v-if="!recordsOnly && !can('ai.analyze')" class="panel-note">
      当前账号可在“分析记录”中查看已有结果，发起分析需要相应权限。
    </p>
    <div class="panel ai-analysis-shell">
      <header v-if="!recordsOnly" class="ai-workspace-header">
        <div class="ai-analysis-tabs" role="tablist" aria-label="检索操作方式">
          <button
            type="button"
            role="tab"
            :aria-selected="source === 'channel'"
            :disabled="busy || rangeRunning"
            @click="source = 'channel'"
          >
            录像检索
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="source === 'upload'"
            :disabled="busy || rangeRunning"
            @click="source = 'upload'"
          >
            图片分析
          </button>
        </div>
        <div class="ai-title-actions">
          <span
            class="badge"
            :class="
              (status?.enabled && status?.hasKey) ||
              (status?.local?.qwenReady && status?.localEnabled !== false)
                ? 'online'
                : 'unregistered'
            "
            >{{
              status?.enabled && status?.hasKey
                ? "DeepSeek 已启用"
                : status?.local?.qwenReady && status?.localEnabled !== false
                  ? "千问本地可用"
                  : status?.qwenAlarm?.ready && status?.localEnabled !== false
                    ? "千问本地可用"
                    : "大模型未接入"
            }}</span
          >
          <button
            type="button"
            class="secondary"
            :disabled="busy || rangeRunning"
            @click="emit('materials')"
          >
            检索已有画面
          </button>
          <button
            type="button"
            class="secondary"
            @click="emit('navigate', 'aiRecords')"
          >
            分析记录
          </button>
        </div>
      </header>
      <div
        v-if="can('ai.analyze') && !recordsOnly"
        class="ai-create-layout"
        :class="{ 'image-mode': source === 'upload' }"
      >
        <aside v-if="source === 'channel'" class="ai-analysis-sidebar">
          <div class="ai-source-panel">
            <div class="panel-heading">
              <h3>{{ source === "channel" ? "通道资源" : "图片分析" }}</h3>
            </div>

            <AiChannelPicker
              v-if="source === 'channel' && can('recording.view')"
              v-model="channel"
              :disabled="busy || rangeRunning"
              allow-offline
              draggable
              @drag="draggedChannel = $event"
            />
            <p v-else-if="source === 'channel'" class="empty-state">
              当前角色没有录像回放权限。
            </p>
          </div>
        </aside>
        <div class="ai-analysis-content">
          <div class="ai-preview-pair">
            <section class="ai-preview-tile">
              <header>
                <h3>
                  {{
                    source === "channel"
                      ? channel?.name || "录像预览"
                      : activeJob?.sourceName || "原始画面"
                  }}
                </h3>
                <span
                  v-if="activeJob"
                  class="badge"
                  :class="
                    activeJob.status === 'succeeded'
                      ? 'online'
                      : aiPending(activeJob)
                        ? 'unregistered'
                        : 'offline'
                  "
                  >{{ aiResultStatus(activeJob) }}</span
                >
              </header>
              <div
                v-if="source === 'channel'"
                class="ai-recording-drop"
                @dragover.prevent
                @drop.prevent="dropRecording"
              >
                <AiRecordingSource
                  v-if="channel && can('recording.view')"
                  :key="channel.id"
                  ref="recordingPlayer"
                  :channel-id="channel.id"
                  :channel-name="channel.name"
                  :disabled="busy || rangeRunning"
                  :range-from="rangeFrom"
                  hide-controls
                  @frame="recordingFrame = $event"
                />
                <div v-else class="ai-analysis-placeholder">
                  <AppIcon name="records" :size="36" /><strong
                    >拖入通道，选择分析时段</strong
                  ><span>也可以点击左侧通道</span>
                </div>
              </div>
              <div
                v-else
                class="ai-analysis-canvas"
                :class="{ 'has-image': activeJob?.imageUrl && !previewError }"
              >
                <img
                  v-if="activeJob?.imageUrl && !previewError"
                  :src="activeJob.imageUrl"
                  :alt="activeJob.sourceName + '分析画面'"
                  @error="previewError = true"
                />
                <canvas
                  v-else-if="upload"
                  ref="uploadedCanvas"
                  class="ai-uploaded-preview"
                  role="img"
                  :aria-label="upload.name + '上传预览'"
                ></canvas>
                <div v-else class="ai-analysis-placeholder">
                  <AppIcon name="ai" :size="42" /><strong>{{
                    previewError ? "图片暂不可用" : "选择画面开始分析"
                  }}</strong
                  ><span>在下方上传图片，填写要求后开始分析</span>
                </div>
              </div>
            </section>
            <section class="ai-preview-tile ai-result-tile">
              <header><h3>分析结果</h3></header>
              <AiRangeResults
                v-show="source === 'channel'"
                ref="rangeResults"
                @details="selected = $event"
                @running="rangeRunning = $event"
                @search="recordedSearchId = $event"
              />
              <div
                v-if="source === 'upload' && activeJob"
                class="ai-analysis-inline-result"
              >
                <p v-if="activeJob.error" class="error">
                  {{ activeJob.error }}
                </p>
                <p v-else>
                  {{
                    aiPending(activeJob)
                      ? "正在分析，请稍候…"
                      : aiResultSummary(activeJob)
                  }}
                </p>
                <div class="ai-inline-tags">
                  <span
                    v-for="tag in activeJob.result?.tags || []"
                    :key="tag"
                    >{{ tag }}</span
                  >
                </div>
                <button
                  v-if="activeJob.status === 'succeeded'"
                  type="button"
                  class="link"
                  @click="selected = activeJob"
                >
                  查看完整结果
                </button>
              </div>
              <div
                v-else-if="source === 'upload'"
                class="ai-analysis-placeholder"
              >
                <AppIcon name="ai" :size="36" /><strong>等待分析结果</strong
                ><span>中文描述和标签将在这里显示</span>
              </div>
            </section>
          </div>
          <form class="ai-question-panel" @submit.prevent="submit">
            <div class="panel-heading">
              <h3>分析要求</h3>
            </div>
            <div v-if="source === 'channel'" class="ai-analysis-range">
              <label
                >开始时间<input
                  v-model="rangeFrom"
                  type="datetime-local"
                  step="1"
                  :disabled="busy || rangeRunning"
                  required
              /></label>
              <label
                >结束时间<input
                  v-model="rangeTo"
                  type="datetime-local"
                  step="1"
                  :disabled="busy || rangeRunning"
                  required
              /></label>
            </div>
            <label class="ai-model-select"
              >分析方式<select
                v-model="localImage"
                :disabled="busy || rangeRunning"
              >
                <option :value="true">
                  {{
                    source === "channel"
                      ? "本地分析 · 录像检索"
                      : "本地分析 · 本机千问"
                  }}
                </option>
                <option :value="false">
                  {{
                    source === "channel"
                      ? "本地筛查 · 大模型复核"
                      : "云端分析 · 已配置的大模型"
                  }}
                </option>
              </select></label
            >
            <label class="ai-clue-text"
              >描述需要关注的物体或场景<textarea
                v-model="question"
                rows="2"
                :maxlength="source === 'channel' ? 500 : 1000"
                :disabled="busy || rangeRunning"
                placeholder="例如：红色汽车、背黑色背包的人，或需要查找的其他物品。"
              ></textarea>
            </label>
            <div class="ai-analysis-reference">
              <span>{{
                source === "channel" ? "参考图片（可选）" : "分析图片"
              }}</span>
              <AiImageInput
                ref="imageInput"
                compact
                :disabled="busy || rangeRunning"
                @change="upload = $event"
                @error="sourceError = $event"
              />
            </div>
            <p class="panel-note ai-analysis-hint">
              {{
                source === "channel"
                  ? "文字或图片至少提供一项，可组合查找；每次不超过24小时。"
                  : "本地与云端均按填写的要求分析，只描述画面中可见的内容。"
              }}
            </p>
            <p v-if="sourceError" class="error" role="alert">
              {{ sourceError }}
            </p>
            <div class="actions">
              <button
                type="submit"
                :disabled="
                  busy ||
                  rangeRunning ||
                  (source === 'channel'
                    ? !channel ||
                      !status?.local?.ready ||
                      status?.localEnabled === false ||
                      (!localImage && (!status?.enabled || !status?.hasKey))
                    : localImage
                      ? status?.localEnabled === false ||
                        !status?.local?.qwenReady
                      : !status?.enabled || !status?.hasKey)
                "
              >
                <AppIcon name="play" :size="16" />{{
                  rangeRunning
                    ? "正在检索…"
                    : busy
                      ? "正在提交…"
                      : source === "channel"
                        ? "开始检索"
                        : "开始分析"
                }}
              </button>
            </div>
            <p class="panel-note ai-mode-status" role="status">
              {{
                source === "channel" && status && !status.local?.ready
                  ? "本地录像检索模型尚未就绪。"
                  : !localImage && status && (!status.enabled || !status.hasKey)
                    ? "云端分析尚未接入，可以选择本地分析。"
                    : source === "upload" &&
                        localImage &&
                        status &&
                        !status.local?.qwenReady
                      ? "本地模型尚未就绪，请检查本地接入。"
                      : ""
              }}
            </p>
          </form>
        </div>
      </div>
      <div v-if="recordsOnly" class="ai-records-hub">
        <div class="ai-records-panel">
          <div class="panel-heading">
            <h3>画面分析记录</h3>
            <span>共 {{ total }} 条</span>
          </div>
          <div class="ai-record-filters">
            <label
              >记录检索<input
                v-model="q"
                maxlength="100"
                placeholder="来源名称或分析内容"
                @input="search" /></label
            ><label
              >任务状态<select
                v-model="filterStatus"
                @change="
                  page = 1;
                  load();
                "
              >
                <option value="">全部状态</option>
                <option
                  v-for="(label, key) in aiLabels"
                  :key="key"
                  :value="key"
                >
                  {{ label }}
                </option>
              </select></label
            ><button type="button" class="secondary" @click="load">
              <AppIcon name="refresh" :size="16" />刷新记录
            </button>
          </div>
          <div class="table-scroll data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>分析来源</th>
                  <th>采集时间</th>
                  <th>状态</th>
                  <th>分析摘要</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="job in jobs" :key="job.id">
                  <td>
                    <span class="ai-source-name"
                      ><AppIcon
                        :name="
                          job.sourceType === 'channel' ? 'devices' : 'records'
                        "
                        :size="17"
                      />{{ job.sourceName }}</span
                    ><small>{{
                      job.alarm
                        ? "告警抓图 · 本地Qwen"
                        : job.recording
                          ? "历史录像"
                          : job.sourceType === "channel"
                            ? "国标通道"
                            : job.sourceType === "image-search"
                              ? "检索参考图"
                              : "上传图片"
                    }}</small>
                  </td>
                  <td>{{ aiDate(job.capturedAt || job.createdAt) }}</td>
                  <td>
                    <span
                      class="badge"
                      :class="
                        job.status === 'succeeded'
                          ? 'online'
                          : ['failed', 'interrupted'].includes(job.status)
                            ? 'offline'
                            : 'unregistered'
                      "
                      >{{ aiResultStatus(job) }}</span
                    >
                  </td>
                  <td class="ai-record-summary">
                    <p :title="aiResultSummary(job)">
                      {{ aiResultSummary(job) }}
                    </p>
                  </td>
                  <td class="row-actions">
                    <button type="button" class="link" @click="details(job)">
                      查看详情</button
                    ><button
                      v-if="can('ai.analyze') && aiPending(job)"
                      type="button"
                      class="link danger-text"
                      @click="cancel(job)"
                    >
                      取消任务
                    </button>
                  </td>
                </tr>
                <tr v-if="!jobs.length">
                  <td colspan="5" class="empty-state">
                    {{
                      loading
                        ? "正在加载分析记录…"
                        : error
                          ? "记录加载失败，请重试"
                          : "暂无分析记录，完成一次画面分析后会显示在这里。"
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="ai-pagination">
            <button
              class="secondary"
              :disabled="page <= 1"
              @click="
                page--;
                load();
              "
            >
              上一页</button
            ><span>第 {{ page }} / {{ pages }} 页 · 每页20条</span
            ><button
              class="secondary"
              :disabled="page >= pages"
              @click="
                page++;
                load();
              "
            >
              下一页
            </button>
          </div>
        </div>
        <AiHistoryRecords
          v-if="can('recording.view')"
          @open="openRecordedSearch"
        />
      </div>
    </div>
    <AiResultDialog :job="selected" @close="selected = null" />
  </section>
</template>
<style scoped>
.ai-analysis-shell {
  padding: 0;
  overflow: hidden;
}
.ai-workspace-header {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  gap: 16px;
  border-bottom: 1px solid var(--line);
}
.ai-analysis-tabs {
  display: flex;
  gap: 24px;
  align-self: stretch;
}
.ai-analysis-tabs button {
  min-height: 54px;
  padding: 0 2px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
}
.ai-analysis-tabs button[aria-selected="true"] {
  color: var(--blue);
  font-weight: 600;
  border-bottom-color: var(--blue);
}
.ai-title-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ai-title-actions .secondary {
  min-height: 30px;
  font-size: 12px;
  padding: 5px 10px;
}
.ai-create-layout {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  height: calc(100dvh - 260px);
  min-height: 440px;
}
.ai-create-layout.image-mode {
  grid-template-columns: minmax(0, 1fr);
}
.ai-analysis-sidebar {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: #fff;
}
.ai-source-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px;
}
.ai-source-panel .panel-heading {
  display: block;
  min-height: 0;
  padding: 0;
  margin: 0 0 14px;
  border: 0;
}
.ai-source-panel h3 {
  font-size: 14px;
  margin: 0;
}
.ai-source-tabs {
  display: flex;
  gap: 3px;
  margin-top: 14px;
  background: #f2f4f8;
  border-radius: 6px;
  padding: 3px;
}
.ai-source-tabs button {
  flex: 1;
  min-height: 30px;
  height: 30px;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
}
.ai-source-tabs button.active {
  background: #fff;
  color: var(--blue);
  box-shadow: 0 1px 3px #102f5a14;
}
.ai-source-panel :deep(.ai-channel-option) {
  padding: 10px 8px;
  gap: 7px;
}
.ai-source-panel :deep(.ai-channel-option .badge),
.ai-source-panel :deep(.ai-channel-option small) {
  display: none;
}
.ai-source-panel :deep(.panel-note) {
  display: none;
}
.ai-source-panel :deep(.ai-channel-picker) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.ai-source-panel :deep(.ai-channel-search) {
  flex: none;
}
.ai-source-panel :deep(.ai-channel-options) {
  flex: 1;
  min-height: 0;
  align-content: start;
  grid-auto-rows: max-content;
  max-height: none;
}
.ai-source-panel :deep(.ai-channel-pagination) {
  margin-top: auto;
  flex: none;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  gap: 3px;
  font-size: 11px;
}
.ai-source-panel :deep(.ai-channel-pagination button) {
  padding: 3px 5px;
}
.ai-source-panel :deep(.ai-image-placeholder) {
  min-height: 140px;
  padding: 12px;
}
.ai-source-panel :deep(canvas) {
  height: 140px;
  object-fit: contain;
}
.ai-source-panel :deep(.ai-image-actions) {
  flex-wrap: wrap;
}
.ai-recording-drop {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ai-analysis-content {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 18px;
  gap: 16px;
  background: #f8fafd;
}
.ai-preview-pair {
  flex: 1;
  min-height: 180px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.ai-preview-tile {
  padding: 0;
  width: 100%;
  max-width: none;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ai-preview-tile > header {
  flex: none;
  min-height: 44px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--line);
}
.ai-preview-tile h3 {
  font-size: 13px;
  margin: 0;
}
.ai-analysis-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fafbfd;
}
.ai-analysis-canvas.has-image {
  background: #172433;
}
.ai-analysis-canvas img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.ai-analysis-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
  padding: 20px;
  font-size: 12px;
  color: #8693a5;
}
.ai-analysis-placeholder .app-icon {
  color: #98b1d2;
}
.ai-analysis-placeholder strong {
  font-weight: 500;
  font-size: 14px;
  color: #4e5e73;
}
.ai-analysis-inline-result {
  padding: 16px;
  min-height: 0;
  overflow: auto;
  font-size: 13px;
  line-height: 1.8;
}
.ai-analysis-inline-result p {
  margin: 0 0 14px;
}
.ai-inline-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}
.ai-inline-tags span {
  color: var(--blue);
  background: var(--blue-soft);
  border-radius: 3px;
  padding: 3px 7px;
  font-size: 11px;
}
.ai-question-panel {
  flex: none;
  margin: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  max-height: 48%;
  overflow: auto;
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
  gap: 12px 20px;
}
.ai-question-panel .panel-heading {
  grid-column: 1/-1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.ai-question-panel .panel-heading h3 {
  font-size: 14px;
  margin: 0;
}
.ai-question-panel .panel-heading > span {
  font-size: 11px;
  color: var(--muted);
}
.ai-question-panel label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  margin: 0;
}
.ai-question-panel select {
  width: 100%;
  height: 36px;
  font-size: 13px;
}
.ai-question-panel label:not(.ai-model-select) {
  grid-column: 1/-1;
}
.ai-question-panel textarea {
  width: 100%;
  min-height: 54px;
  height: 56px;
  max-height: 120px;
  resize: vertical;
  line-height: 1.7;
  font-size: 13px;
}
.ai-question-panel .actions {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  align-items: end;
  justify-content: flex-end;
  gap: 8px;
  margin: 0;
  padding: 0;
}
.ai-question-panel .actions button {
  min-height: 36px;
  padding: 6px 12px;
  font-size: 13px;
}
.ai-mode-status {
  min-height: 21px;
}
.ai-question-panel .panel-note,
.ai-question-panel .error {
  grid-column: 1/-1;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
.ai-records-hub {
  display: grid;
  gap: 18px;
  padding: 18px;
  background: #f6f8fb;
}
.ai-records-panel {
  padding: 18px;
  margin: 0;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.ai-record-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
  padding-bottom: 16px;
}
.ai-record-filters label {
  display: grid;
  gap: 8px;
  margin: 0;
  font-size: 13px;
}
.ai-record-filters label:first-child {
  width: 300px;
  max-width: 100%;
}
.ai-record-filters select {
  min-width: 150px;
}
.ai-records-panel .table-scroll {
  max-height: calc(100dvh - 425px);
  min-height: 220px;
}
.ai-records-panel table {
  margin: 0;
}
.ai-records-panel th,
.ai-records-panel td {
  text-align: center;
  vertical-align: middle;
  padding: 12px;
  font-size: 13px;
}
.ai-source-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ai-source-name .app-icon {
  color: var(--blue);
  flex: none;
}
.ai-records-panel td > small {
  display: block;
  color: var(--muted);
  margin-top: 5px;
  font-size: 12px;
}
.ai-record-summary {
  max-width: 420px;
  white-space: normal;
}
.ai-record-summary p {
  margin: 0;
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ai-pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  align-items: center;
  font-size: 12px;
  color: var(--muted);
}

.ai-records-panel .table-scroll {
  max-height: 300px;
  min-height: 160px;
}
@media (max-width: 1000px) {
  .ai-create-layout {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .ai-analysis-content {
    padding: 14px;
  }
  .ai-question-panel {
    grid-template-columns: minmax(0, 1fr);
  }
  .ai-question-panel .actions {
    grid-column: 1;
    grid-row: auto;
    justify-content: flex-start;
  }
}
@media (max-width: 760px) {
  .ai-workspace-header {
    flex-wrap: wrap;
    padding: 0 16px 12px;
    gap: 0;
  }
  .ai-title-actions {
    flex-wrap: wrap;
  }
  .ai-create-layout {
    height: auto;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
  }
  .ai-analysis-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--line);
    max-height: 300px;
  }
  .ai-preview-pair {
    grid-template-columns: minmax(0, 1fr);
  }
  .ai-preview-tile {
    min-height: 220px;
  }
  .ai-analysis-canvas {
    min-height: 180px;
  }
  .ai-question-panel {
    max-height: none;
  }
  .ai-question-panel .actions {
    flex-wrap: wrap;
  }
  .ai-records-hub,
  .ai-records-panel {
    padding: 14px;
  }
  .ai-record-filters {
    flex-wrap: wrap;
    gap: 12px;
  }
  .ai-record-filters label:first-child {
    width: 100%;
  }
  .ai-pagination {
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>

<style scoped>
.ai-question-panel:has(.ai-analysis-range) {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 16px;
  padding: 12px 16px;
}
.ai-question-panel .ai-analysis-range {
  display: contents;
}
.ai-question-panel .ai-analysis-range > label {
  grid-column: auto;
  grid-row: 2;
  font-size: 12px;
}
.ai-question-panel .ai-analysis-range input {
  text-align: center;
  width: 100%;
  max-width: none;
  min-width: 0;
  box-sizing: border-box;
  height: 36px;
}
.ai-question-panel:has(.ai-analysis-range) .ai-model-select {
  grid-column: 3;
  grid-row: 2;
}
.ai-question-panel:has(.ai-analysis-range) .ai-analysis-hint {
  grid-column: 1/3;
  grid-row: 4;
  align-self: center;
}
.ai-question-panel:has(.ai-analysis-range) .actions {
  grid-column: 3;
  grid-row: 4;
}
.ai-question-panel:has(.ai-analysis-range) .ai-clue-text {
  grid-column: 1/3;
  grid-row: 3;
}
.ai-analysis-reference {
  grid-column: 3;
  grid-row: 3;
  display: grid;
  gap: 7px;
  min-width: 0;
  font-size: 12px;
}
.ai-mode-status:empty {
  display: none;
}
.ai-uploaded-preview {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  background: #eef2f7;
}
@media (max-width: 850px) {
  .ai-question-panel:has(.ai-analysis-range) {
    grid-template-columns: minmax(0, 1fr);
  }
  .ai-question-panel .ai-analysis-range > label,
  .ai-question-panel:has(.ai-analysis-range) .ai-model-select,
  .ai-question-panel:has(.ai-analysis-range) .ai-analysis-hint,
  .ai-question-panel:has(.ai-analysis-range) .actions,
  .ai-question-panel:has(.ai-analysis-range) .ai-clue-text,
  .ai-analysis-reference {
    grid-column: 1;
    grid-row: auto;
  }
}
</style>

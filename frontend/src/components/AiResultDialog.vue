<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import { can } from "../api";
import type { AiJob } from "../ai-types";
import {
  aiDate,
  aiLabels,
  aiPending,
  aiResultKind,
  aiResultSummary,
  aiTargetCount,
  aiConfidence,
  aiResultStatus,
  aiModelName,
} from "../ai-types";
import DialogHeading from "./DialogHeading.vue";
const props = defineProps<{ job: AiJob | null }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>(),
  imageError = ref(false),
  recordingOpen = ref(false),
  recordingError = ref(false),
  video = ref<HTMLVideoElement>();
function stopRecording() {
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
  recordingOpen.value = false;
  recordingError.value = false;
}
function locateRecording() {
  if (video.value && props.job?.recording)
    video.value.currentTime = Math.max(
      0,
      Math.min(props.job.recording.offsetSeconds, video.value.duration || 0),
    );
}
onUnmounted(() => {
  stopRecording();
});
watch(
  () => props.job?.id,
  () => {
    stopRecording();
    imageError.value = false;
    if (props.job && !dialog.value?.open) dialog.value?.showModal();
    if (!props.job) dialog.value?.close();
  },
  { flush: "post" },
);
</script>
<template>
  <dialog
    ref="dialog"
    class="business-dialog ai-result-dialog"
    @close="
      stopRecording();
      emit('close');
    "
  >
    <DialogHeading>画面分析详情</DialogHeading
    ><template v-if="job"
      ><div class="ai-result-meta">
        <strong>{{ job.sourceName }}</strong
        ><span
          class="badge"
          :class="
            job.status === 'succeeded'
              ? 'online'
              : ['failed', 'interrupted'].includes(job.status)
                ? 'offline'
                : 'unregistered'
          "
          >{{ aiResultStatus(job) }}</span
        ><span>{{ aiDate(job.capturedAt || job.createdAt) }}</span>
      </div>
      <div v-if="job.recording" class="ai-recording-source">
        <span
          >来源录像：{{ job.recording.name }} · 文件内
          {{ Math.floor(job.recording.offsetSeconds) }} 秒</span
        ><button
          v-if="can('recording.view')"
          type="button"
          class="secondary"
          @click="
            recordingOpen = !recordingOpen;
            recordingError = false;
          "
        >
          {{ recordingOpen ? "收起录像" : "定位原录像" }}
        </button>
      </div>
      <p v-if="job.alarm" class="panel-note">
        来源：移动侦测告警 · 千问本地分析
      </p>
      <video
        v-if="recordingOpen && job.recording"
        ref="video"
        :src="job.recording.url"
        controls
        muted
        playsinline
        preload="metadata"
        class="ai-source-video"
        @loadedmetadata="locateRecording"
        @error="recordingError = true"
      ></video>
      <p v-if="recordingError" class="error">
        录像暂不可播放，可能已过期、无权限或浏览器不支持当前编码。
      </p>
      <div class="ai-result-layout">
        <div>
          <div class="ai-annotated-image">
            <img
              v-if="job.imageUrl && !imageError"
              :src="job.imageUrl"
              :alt="job.sourceName + '分析画面'"
              class="ai-result-image"
              @error="imageError = true"
            />
            <div v-else class="ai-result-placeholder">
              {{
                aiPending(job)
                  ? "正在准备画面…"
                  : imageError
                    ? "图片已不可用或无权访问"
                    : "暂无分析画面"
              }}
            </div>
          </div>
          <div class="ai-result-facts">
            <span>{{
              job.width && job.height ? job.width + " × " + job.height : "—"
            }}</span
            ><span>{{ aiModelName(job) }}</span>
          </div>
        </div>
        <div class="ai-result-summary">
          <h3>{{ aiResultKind(job) }}</h3>
          <div
            v-if="
              job.status === 'succeeded' &&
              !['检索参考图', '录像采样画面', '相似画面'].includes(
                aiResultKind(job),
              )
            "
            class="ai-result-metrics"
          >
            <span>目标数量：{{ aiTargetCount(job) }}</span>
            <span>置信度：{{ aiConfidence(undefined) }}</span>
            <span v-if="job.usage?.cached">已复用结果</span>
          </div>
          <p v-if="job.error" class="error" role="alert">{{ job.error }}</p>
          <p v-if="aiPending(job)" role="status">
            {{
              job.status === "queued"
                ? "任务排队中，完成后自动更新。"
                : "正在采集或分析画面，请稍候。"
            }}
          </p>
          <template v-if="job.result"
            ><p class="ai-summary-text">
              {{ aiResultSummary(job) }}
            </p>
            <div class="ai-result-tags">
              <span v-for="tag in job.result.tags" :key="tag">{{ tag }}</span>
            </div>
            <ul v-if="job.result.observations.length">
              <li v-for="(item, index) in job.result.observations" :key="index">
                {{ item }}
              </li>
            </ul></template
          >
        </div>
      </div>
      <div
        v-if="job.result?.objects.length"
        class="table-scroll data-table-scroll"
      >
        <table>
          <thead>
            <tr>
              <th>可见物体</th>
              <th>颜色</th>
              <th>数量</th>
              <th>画面位置</th>
              <th>置信度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(object, index) in job.result.objects" :key="index">
              <td>{{ object.label }}</td>
              <td>{{ object.color || "—" }}</td>
              <td>{{ object.count ?? "无法确定" }}</td>
              <td>{{ object.position || "—" }}</td>
              <td>{{ aiConfidence(object.confidence) }}</td>
            </tr>
            <tr v-if="!job.result.objects.length">
              <td colspan="5" class="empty-state">未识别到可明确列出的物体</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </dialog>
</template>
<style scoped>
.ai-annotated-image {
  position: relative;
}
.ai-result-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--muted);
}

.ai-recording-source {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 12px;
}
.ai-source-video {
  display: block;
  width: 100%;
  max-height: 360px;
  background: #101c2b;
  margin-bottom: 16px;
}

.ai-result-dialog {
  width: min(1080px, calc(100vw - 32px));
}
.ai-result-meta {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  margin: 18px 0;
  color: var(--muted);
  font-size: 12px;
}
.ai-result-meta strong {
  color: var(--text);
  font-size: 14px;
}
.ai-result-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 22px;
  margin-bottom: 20px;
  min-width: 0;
}
.ai-result-image {
  display: block;
  width: 100%;
  height: 270px;
  object-fit: contain;
  border-radius: 8px;
  background: #162537;
}
.ai-result-placeholder {
  height: 270px;
  display: grid;
  place-items: center;
  background: var(--surface-alt, #f5f7fb);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--muted);
  font-size: 13px;
}
.ai-result-facts {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 9px;
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.ai-result-summary {
  min-width: 0;
}
.ai-result-summary h3 {
  font-size: 14px;
  margin: 0 0 12px;
}
.ai-summary-text {
  white-space: pre-line;
  line-height: 1.9;
  margin-top: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.ai-result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.ai-result-tags span {
  background: var(--blue-soft);
  color: var(--blue);
  padding: 4px 9px;
  border-radius: 4px;
  font-size: 12px;
}
.ai-result-summary ul {
  padding-left: 18px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.ai-result-dialog .table-scroll {
  max-height: 250px;
}
.ai-result-dialog th,
.ai-result-dialog td {
  text-align: center;
}
@media (max-width: 700px) {
  .ai-result-layout {
    grid-template-columns: 1fr;
  }
  .ai-result-image,
  .ai-result-placeholder {
    height: 210px;
  }
}
</style>

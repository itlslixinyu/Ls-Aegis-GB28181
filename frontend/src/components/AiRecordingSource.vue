<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from "vue";
import { api, messageOf } from "../api";
import { archiveStart, clockTime } from "../archive-timeline";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  channelId: string;
  channelName: string;
  disabled?: boolean;
  rangeFrom?: string;
  hideControls?: boolean;
}>();
interface RecordingFrame {
  recordingFileId: string;
  frameOffset: number;
  capturedAt: string;
  name: string;
}
interface FileItem {
  id: string;
  jobId?: string;
  name: string;
  date: string;
}
interface RecordingJob {
  id: string;
  status: string;
  channelId: string;
  files: FileItem[];
}
interface SourceFile extends FileItem {
  key: string;
  start: number;
  url: string;
}
const emit = defineEmits<{ frame: [value: RecordingFrame | null] }>();
const date = ref(
  props.rangeFrom?.slice(0,10) || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
);
const time = ref("00:00:00");
const files = ref<SourceFile[]>([]);
const selected = ref<SourceFile | null>(null);
const video = ref<HTMLVideoElement>();
const loading = ref(false);
const error = ref("");
const notice = ref("");
const ready = ref(false);
const currentPosition = ref<number | null>(null);
const mediaGeneration = ref(0);
const currentLabel = computed(() =>
  currentPosition.value === null ? "" : clockTime(currentPosition.value),
);
let alive = true;
let generation = 0;
let requestedOffset = 0;

function releaseVideo() {
  const element = video.value;
  if (element) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
}
function clearFrame() {
  ready.value = false;
  currentPosition.value = null;
  emit("frame", null);
}
function resetSource() {
  releaseVideo();
  selected.value = null;
  mediaGeneration.value++;
  clearFrame();
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(value + "T00:00:00+08:00");
  return (
    Number.isFinite(instant) &&
    new Date(instant + 8 * 3600000).toISOString().slice(0, 10) === value
  );
}
function timeSeconds(value: string) {
  const parts = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return null;
  const hours = Number(parts[1]),
    minutes = Number(parts[2]),
    seconds = Number(parts[3] || 0);
  return hours < 24 && minutes < 60 && seconds < 60
    ? hours * 3600 + minutes * 60 + seconds
    : null;
}
function chooseFile(file: SourceFile, second: number) {
  resetSource();
  error.value = "";
  notice.value = "正在读取录像…";
  requestedOffset = second - file.start;
  selected.value = file;
}
async function load() {
  const gen = ++generation;
  resetSource();
  files.value = [];
  error.value = "";
  notice.value = "";
  loading.value = false;
  if (!props.channelId) return;
  if (!validDate(date.value)) {
    error.value = "请选择有效的录像日期";
    return;
  }
  const channelId = props.channelId,
    targetDate = date.value;
  loading.value = true;
  try {
    const [scheduled, downloads] = await Promise.all([
      api<{ items: RecordingJob[] }>("/recording-jobs?kind=scheduled&daily=1"),
      api<{ items: RecordingJob[] }>("/recording-jobs?kind=download"),
    ]);
    if (!alive || gen !== generation) return;
    const unique = new Map<string, SourceFile>();
    for (const job of [...scheduled.items, ...downloads.items]) {
      if (job.channelId !== channelId) continue;
      for (const file of job.files || []) {
        if (file.date !== targetDate) continue;
        const start = archiveStart(file.name, file.date);
        if (start === null) continue;
        const jobId = file.jobId || job.id,
          key = jobId + ":" + file.id;
        if (!unique.has(key))
          unique.set(key, {
            ...file,
            jobId,
            key,
            start,
            url: `/api/v1/recording-jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.id)}?play=1`,
          });
      }
    }
    files.value = [...unique.values()].sort(
      (a, b) => a.start - b.start || a.key.localeCompare(b.key),
    );
    const first = files.value[0];
    if (first) {
      const rangeSecond=props.rangeFrom ? timeSeconds(props.rangeFrom.slice(11)) : null;
      const target=rangeSecond === null ? first.start : rangeSecond;
      const chosen=[...files.value].reverse().find(f=>f.start<=target)||first;
      time.value=clockTime(Math.max(target,chosen.start));
      chooseFile(chosen,Math.max(target,chosen.start));
    } else {
      notice.value = "当前日期暂无录像";
    }
  } catch (e) {
    if (alive && gen === generation) error.value = messageOf(e);
  } finally {
    if (alive && gen === generation) loading.value = false;
  }
}
function locate() {
  if (props.disabled || loading.value || !props.channelId) return;
  const second = timeSeconds(time.value);
  if (second === null) {
    error.value = "请选择有效的定位时间";
    return;
  }
  error.value = "";
  const file = [...files.value].reverse().find((item) => item.start <= second);
  if (!file) {
    resetSource();
    notice.value = "当前时段无录像";
    return;
  }
  chooseFile(file, second);
}
function currentElement(event: Event) {
  const element = event.currentTarget as HTMLVideoElement | null;
  return alive &&
    element &&
    element === video.value &&
    selected.value &&
    element.dataset.fileKey === selected.value.key
    ? element
    : null;
}
function metadataLoaded(event: Event) {
  const element = currentElement(event);
  if (!element) return;
  if (!Number.isFinite(element.duration) || element.duration <= 0) {
    clearFrame();
    error.value = "录像时长不可用，请重新定位或选择其他时间";
    notice.value = "";
    return;
  }
  if (requestedOffset < 0 || requestedOffset >= element.duration) {
    element.pause();
    clearFrame();
    notice.value = "当前时段无录像";
    return;
  }
  error.value = "";
  notice.value = "";
  ready.value = true;
  element.currentTime = requestedOffset;
  if (requestedOffset === 0) publishFrame(event);
}
function selectedFrame(): RecordingFrame | null {
  const element = video.value,
    file = selected.value;
  if (
    !alive ||
    !element ||
    !file ||
    !ready.value ||
    element.seeking ||
    !Number.isFinite(element.duration) ||
    element.duration <= 0
  )
    return null;
  const offset = Math.max(
    0,
    Math.min(element.currentTime, element.duration - 0.001),
  );
  if (!Number.isFinite(offset)) return null;
  currentPosition.value = file.start + offset;
  return {
    recordingFileId: file.id,
    frameOffset: Number(offset.toFixed(3)),
    capturedAt: new Date(
      Date.parse(file.date + "T00:00:00+08:00") + (file.start + offset) * 1000,
    ).toISOString(),
    name: `${props.channelName} · ${file.date} ${clockTime(file.start + offset)}`,
  };
}
function publishFrame(event: Event) {
  if (!currentElement(event)) return;
  const frame = selectedFrame();
  if (frame) emit("frame", frame);
}
function pauseAndSelect() {
  video.value?.pause();
  const frame = selectedFrame();
  emit("frame", frame);
  return frame;
}
defineExpose({ pauseAndSelect });
function mediaError(event: Event) {
  if (!currentElement(event)) return;
  clearFrame();
  notice.value = "";
  error.value = "录像加载失败，请检查文件或重新定位";
}
watch(()=>props.rangeFrom,(value)=>{if(value&&validDate(value.slice(0,10))){if(date.value===value.slice(0,10))void load();else date.value=value.slice(0,10);}});
watch(
  () => [props.channelId, date.value],
  () => void load(),
  { immediate: true },
);
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) video.value?.pause();
  },
);
onUnmounted(() => {
  alive = false;
  generation++;
  releaseVideo();
  emit("frame", null);
});
</script>

<template>
  <div class="ai-recording-source">
    <form v-if="!hideControls" class="recording-source-toolbar" @submit.prevent="locate">
      <label
        >录像日期<input
          v-model="date"
          type="date"
          :disabled="disabled || loading || !channelId"
      /></label>
      <label
        >定位时间<input
          v-model="time"
          type="time"
          step="1"
          :disabled="disabled || loading || !channelId"
      /></label>
      <button
        type="submit"
        class="secondary"
        :disabled="disabled || loading || !channelId"
      >
        <AppIcon name="search" :size="15" />定位
      </button>
    </form>
    <div class="recording-source-picture" :class="{ 'has-video': ready }">
      <video
        v-if="selected"
        :key="mediaGeneration"
        ref="video"
        :src="selected.url"
        :data-file-key="selected.key"
        :class="{ 'video-hidden': !ready }"
        :controls="!disabled"
        preload="metadata"
        playsinline
        @loadedmetadata="metadataLoaded"
        @timeupdate="publishFrame"
        @seeked="publishFrame"
        @pause="publishFrame"
        @error="mediaError"
      ></video>
      <div
        v-if="!ready"
        class="recording-source-placeholder"
        :role="error ? 'alert' : 'status'"
      >
        <AppIcon name="records" :size="28" /><span>{{
          error ||
          (loading
            ? "正在查找录像…"
            : !channelId
              ? "请选择通道"
              : notice || "选择日期和时间查看录像")
        }}</span>
      </div>
    </div>
    <div class="recording-source-caption">
      <span>{{ channelName || "历史录像" }}</span
      ><span v-if="currentLabel">{{ date }} {{ currentLabel }}</span
      ><span v-else-if="files.length">共 {{ files.length }} 段录像</span>
    </div>
    <p v-if="error && ready" class="recording-source-error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.ai-recording-source {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: #fff;
}
.recording-source-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
  background: #fff;
  flex: none;
}
.recording-source-toolbar label {
  display: grid;
  gap: 6px;
  margin: 0;
  min-width: 0;
  flex: 1;
  font-size: 12px;
  color: #526176;
}
.recording-source-toolbar input {
  width: 100%;
  min-width: 0;
  height: 32px;
  font-size: 12px;
  padding: 5px;
  text-align: center;
}
.recording-source-toolbar button {
  min-height: 32px;
  height: 32px;
  padding: 5px 10px;
  justify-content: center;
  font-size: 12px;
  white-space: nowrap;
}
.recording-source-picture {
  min-height: 130px;
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: #f7f9fc;
  display: flex;
  align-items: center;
  justify-content: center;
}
.recording-source-picture.has-video {
  background: #111d2c;
}
.recording-source-picture video {
  display: block;
  width: 100%;
  height: 100%;
  max-height: 50vh;
  object-fit: contain;
}
.recording-source-picture .video-hidden {
  visibility: hidden;
}
.recording-source-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}
.recording-source-placeholder .app-icon {
  color: #8aa2bc;
}
.recording-source-caption {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--line);
  flex: none;
  font-size: 11px;
  color: var(--muted);
}
.recording-source-error {
  padding: 0 12px 10px;
  margin: 0;
  color: #d03050;
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 500px) {
  .recording-source-toolbar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px;
  }
  .recording-source-toolbar label {
    flex: 1 1 120px;
  }
  .recording-source-toolbar button {
    flex: 0 0 auto;
  }
  .recording-source-picture {
    min-height: 160px;
  }
}
</style>

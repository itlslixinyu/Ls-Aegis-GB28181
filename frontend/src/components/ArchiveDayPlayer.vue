<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import { acquireArchiveProbe } from "../archive-probe-pool";
import { can, currentUser } from "../api";
import {
  readArchiveDuration,
  cachedArchiveDuration,
} from "../archive-duration-cache";
import { rememberFilter } from "../remember-filter";
import type { PlaybackClock, PlaybackRange } from "../playback-clock";
import {
  archiveStart,
  clockTime,
  followingSegment,
  segmentAt,
  type ArchiveSegment,
} from "../archive-timeline";

const props = defineProps<{
  channelId: string;
  channelName: string;
  date: string;
  files: { id: string; name: string; date: string; url: string }[];
  clock?: PlaybackClock;
  windowEnd?: number;
}>();
const emit = defineEmits<{
  ranges: [ranges: PlaybackRange[]];
  indexing: [pending: boolean];
}>();
const video = ref<HTMLVideoElement>();
const segments = ref<ArchiveSegment[]>([]);
const current = ref<ArchiveSegment | null>(null);
const cursor = rememberFilter<number>(
  `records.platform.position:${props.channelId}:${props.date}`,
  0,
  (v) => v < 86400,
);
const seekText = ref(clockTime(cursor.value));
const editingTime = ref(false);
const skipGaps = ref(true),
  speed = ref(1),
  muted = ref(true);
const indexing = ref(false),
  completed = ref(0),
  failed = ref(0);
const playing = ref(false),
  notice = ref(""),
  playerError = ref("");
const probes = new Set<() => void>();
let generation = 0,
  alive = true,
  pendingSeek = 0,
  wantsPlay = false;
const signature = computed(() =>
  props.files.map((f) => f.id + f.url).join("|"),
);
const dayCoverage = computed(() => {
  let seconds = 0,
    end = 0;
  for (const s of segments.value) {
    seconds += Math.max(0, s.end - Math.max(end, s.start));
    end = Math.max(end, s.end);
  }
  return Math.round(seconds / 60);
});
function releasePlayer() {
  wantsPlay = false;
  video.value?.pause();
  video.value?.removeAttribute("src");
  video.value?.load();
  current.value = null;
  playing.value = false;
}
async function durationOf(url: string): Promise<number> {
  const controller = new AbortController(),
    cancel = () => controller.abort();
  probes.add(cancel);
  try {
    return await readArchiveDuration(
      currentUser.value?.id || "anonymous",
      url,
      (signal) => probeDuration(url, signal),
      controller.signal,
    );
  } finally {
    probes.delete(cancel);
  }
}
async function probeDuration(
  url: string,
  signal: AbortSignal,
): Promise<number> {
  const release = await acquireArchiveProbe(signal);
  if (!release || signal.aborted) {
    release?.();
    return 0;
  }
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    let done = false;
    const finish = (duration = 0) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      release();
      probe.onloadedmetadata = probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      resolve(Number.isFinite(duration) ? duration : 0);
    };
    const aborted = () => finish();
    const timer = setTimeout(aborted, 12000);
    signal.addEventListener("abort", aborted, { once: true });
    probe.preload = "metadata";
    probe.muted = true;
    probe.onloadedmetadata = () => finish(probe.duration);
    probe.onerror = aborted;
    probe.src = url;
  });
}
function fileStart(file: (typeof props.files)[number]) {
  const civil = archiveStart(file.name, file.date);
  const offset =
    (Date.parse(file.date + "T00:00:00+08:00") -
      Date.parse(props.date + "T00:00:00+08:00")) /
    1000;
  return civil === null || !Number.isFinite(offset) ? null : civil + offset;
}
async function indexDay() {
  const gen = ++generation;
  for (const cancel of [...probes]) cancel();
  indexing.value = true;
  failed.value = completed.value = 0;
  const ordered = [...props.files].sort(
    (a, b) => (fileStart(a) ?? Infinity) - (fileStart(b) ?? Infinity),
  );
  const position = props.clock?.position ?? cursor.value;
  const preceding = ordered.filter(
    (file) => fileStart(file) !== null && fileStart(file)! <= position,
  );
  const latest = preceding.at(-1);
  const input = [
    ...(latest ? [latest] : []),
    ...ordered.filter((file) => (fileStart(file) ?? Infinity) > position),
    ...preceding.slice(0, -1).reverse(),
  ];
  const limit = props.windowEnd || 86400;
  const known = new Map<string, ArchiveSegment>();
  const confirmed = new Map<string, ArchiveSegment>();
  // Keep already confirmed segments while a new file is being indexed. A
  // partial rebuild must not briefly turn the currently playing time into a gap.
  for (const file of input) {
    const start = fileStart(file);
    const previous = segments.value.find(
      (s) => s.id === file.id && s.url === file.url,
    );
    const duration =
      cachedArchiveDuration(currentUser.value?.id || "anonymous", file.url) ??
      (previous ? previous.end - previous.start : 0);
    if (
      start !== null &&
      duration > 0 &&
      start + duration > 0 &&
      start < limit
    ) {
      const segment = {
        ...file,
        start,
        end: Math.min(limit, start + duration),
      };
      confirmed.set(file.id, segment);
      if (previous) known.set(file.id, segment);
    }
  }
  const publish = () => {
    const value = [...known.values()].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    );
    if (
      value.length !== segments.value.length ||
      value.some((s, i) => {
        const old = segments.value[i];
        return (
          s.id !== old?.id ||
          s.url !== old.url ||
          s.start !== old.start ||
          s.end !== old.end
        );
      })
    )
      segments.value = value;
  };
  const completedSegments: (ArchiveSegment | null | undefined)[] = input.map(
    (file) => confirmed.get(file.id),
  );
  let committed = 0;
  const flush = () => {
    while (
      committed < input.length &&
      completedSegments[committed] !== undefined
    ) {
      const segment = completedSegments[committed++];
      if (segment) known.set(segment.id, segment);
    }
    publish();
  };
  flush();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, input.length) }, async () => {
      while (alive && gen === generation && next < input.length) {
        const index = next++,
          file = input[index];
        const start = fileStart(file);
        const duration = start === null ? 0 : await durationOf(file.url);
        if (!alive || gen !== generation) return;
        completed.value++;
        if (start !== null && duration > 0) {
          completedSegments[index] =
            start + duration <= 0 || start >= limit
              ? null
              : {
                  ...file,
                  start,
                  end: Math.min(limit, start + duration),
                };
        } else {
          failed.value++;
          completedSegments[index] = null;
        }
        // Publish newly probed metadata in priority order even when requests
        // finish out of order, so the very first frame uses the correct start.
        flush();
      }
    }),
  );
  if (alive && gen === generation) {
    publish();
    indexing.value = false;
    if (current.value && !input.some((f) => f.id === current.value?.id))
      releasePlayer();
  }
}
watch(signature, () => void indexDay(), { immediate: true });
watch(indexing, (pending) => emit("indexing", pending), { immediate: true });
async function resume() {
  if (!video.value || !current.value) return;
  try {
    await video.value.play();
  } catch {
    playerError.value = "未能开始播放，请重试或检查浏览器是否支持该录像编码。";
  }
}
function openSegment(segment: ArchiveSegment, second: number, play = true) {
  playerError.value = "";
  pendingSeek = Math.max(
    0,
    Math.min(second - segment.start, segment.end - segment.start - 0.05),
  );
  wantsPlay = play;
  cursor.value = Math.floor(Math.max(segment.start, second));
  if (!editingTime.value) seekText.value = clockTime(cursor.value);
  if (current.value?.id === segment.id && video.value?.readyState) {
    video.value.currentTime = pendingSeek;
    if (play) void resume();
    else video.value.pause();
    return;
  }
  current.value = segment;
  if (video.value) {
    video.value.src = segment.url;
    video.value.load();
  }
}
function seek(second: number) {
  editingTime.value = false;
  second = Math.max(0, Math.min(86399, Math.floor(second)));
  const segment = segmentAt(segments.value, second, skipGaps.value);
  if (!segment) {
    releasePlayer();
    cursor.value = second;
    seekText.value = clockTime(second);
    notice.value = "该时刻没有已确认的录像，可点击蓝色时段播放。";
    return;
  }
  notice.value =
    segment.start > second
      ? `该时刻无录像，已跳至 ${clockTime(segment.start)}。`
      : "";
  openSegment(segment, Math.max(second, segment.start));
}
function seekInput() {
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(seekText.value)) {
    notice.value = "请输入00:00:00至23:59:59之间的时间。";
    return;
  }
  const [h, m, s] = seekText.value.split(":").map(Number);
  editingTime.value = false;
  seek(h * 3600 + m * 60 + s);
}
function clickTimeline(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  seek(
    Math.max(
      0,
      Math.min(86399, ((event.clientX - rect.left) / rect.width) * 86400),
    ),
  );
}
function loaded() {
  if (!video.value || !current.value) return;
  video.value.currentTime = pendingSeek;
  video.value.playbackRate = speed.value;
  if (props.clock) syncArchive();
  if (wantsPlay) void resume();
}
function timeUpdate() {
  if (props.clock) return;
  if (!current.value || !video.value) return;
  cursor.value = Math.min(
    86399,
    Math.floor(current.value.start + video.value.currentTime),
  );
  if (!editingTime.value) seekText.value = clockTime(cursor.value);
}
function ended() {
  if (props.clock) {
    syncArchive();
    return;
  }
  if (!current.value) return;
  const next = followingSegment(segments.value, current.value);
  if (!next) {
    notice.value = indexing.value
      ? "当前分段已结束，时间轴仍在读取，请稍后继续。"
      : "当天已索引的录像播放结束。";
    return;
  }
  const gap = next.start - current.value.end;
  if (gap > 1 && !skipGaps.value) {
    notice.value = `后续存在录像空档，下一段从 ${clockTime(next.start)} 开始。`;
    return;
  }
  notice.value =
    gap > 1 ? `已跳过录像空档，继续播放 ${clockTime(next.start)} 的录像。` : "";
  openSegment(next, Math.max(next.start, current.value.end));
}
function toggle() {
  if (playing.value) video.value?.pause();
  else if (current.value && video.value && !video.value.ended) void resume();
  else seek(cursor.value);
}
watch(speed, (value) => {
  if (video.value) video.value.playbackRate = value;
});
let clockRevision = -1;
function syncArchive() {
  const clock = props.clock,
    element = video.value;
  if (!clock || !element) return;
  const reverse = clock.direction === -1;
  const shouldPlay = clock.playing && !reverse;
  muted.value = clock.muted || reverse;
  speed.value = reverse ? 1 : clock.speed;
  const segment = segmentAt(segments.value, clock.position, false);
  if (!segment) {
    if (current.value) releasePlayer();
    notice.value = indexing.value ? "正在准备录像画面" : "当前时段无录像";
    return;
  }
  notice.value = "";
  const offset = Math.max(0, clock.position - segment.start);
  if (current.value?.id !== segment.id)
    openSegment(segment, clock.position, shouldPlay);
  else if (element.readyState) {
    if (
      clockRevision !== clock.revision ||
      (!element.seeking &&
        Math.abs(element.currentTime - offset) > (reverse ? 0.04 : 0.65))
    )
      element.currentTime = offset;
    if (shouldPlay && element.paused && !element.ended) void resume();
    if (!shouldPlay && !element.paused) element.pause();
  }
  element.playbackRate = speed.value;
  wantsPlay = shouldPlay;
  clockRevision = clock.revision;
}
watch(
  segments,
  (value) => {
    emit(
      "ranges",
      value.map(({ start, end }) => ({ start, end })),
    );
    syncArchive();
  },
  { immediate: true },
);
watch(
  () =>
    props.clock && [
      props.clock.position,
      props.clock.playing,
      props.clock.speed,
      props.clock.direction,
      props.clock.muted,
      props.clock.revision,
    ],
  syncArchive,
  { flush: "post" },
);
async function fullscreen() {
  try {
    await video.value?.requestFullscreen();
  } catch {
    notice.value = "当前浏览器未允许全屏。";
  }
}
onUnmounted(() => {
  alive = false;
  generation++;
  for (const cancel of [...probes]) cancel();
  releasePlayer();
});
</script>

<template>
  <section class="archive-day" aria-label="通道24小时录像回放">
    <header class="archive-day-heading">
      <div>
        <AppIcon name="records" :size="18" /><b>{{ channelName }}</b
        ><span>{{ date }} · 北京时间</span>
      </div>
      <span>{{ segments.length }} 段 · 已确认约 {{ dayCoverage }} 分钟</span>
    </header>
    <div class="archive-day-screen">
      <video
        ref="video"
        :aria-hidden="!current"
        :muted="muted"
        playsinline
        preload="metadata"
        @loadedmetadata="loaded"
        @timeupdate="timeUpdate"
        @play="playing = true"
        @pause="playing = false"
        @ended="ended"
        @error="
          current &&
          (playerError = '录像读取或解码失败，请重试；也可展开分段文件下载。')
        "
      />
      <div v-if="!current" class="archive-day-placeholder">
        <AppIcon name="records" :size="44" /><b>{{
          clock
            ? indexing
              ? "正在准备录像画面"
              : "当前时段无录像"
            : !indexing && !segments.length
              ? "当天暂无已确认录像"
              : "通道全天录像"
        }}</b
        ><span v-if="!clock">{{
          !indexing && !segments.length
            ? "可切换日期，或在下方分段文件中检查归档情况"
            : "点击下方蓝色时段，或选择时间开始回放"
        }}</span>
      </div>
      <div
        v-if="playerError || (clock && failed && !indexing && !current)"
        class="archive-day-error"
        role="alert"
      >
        {{ playerError || `${failed} 个录像文件未能索引，请重新读取` }}
        <button
          class="secondary"
          @click="
            current
              ? openSegment(current, clock?.position ?? cursor)
              : indexDay()
          "
        >
          重试
        </button>
      </div>
    </div>
    <div v-if="!clock" class="archive-day-controls">
      <button type="button" :disabled="!segments.length" @click="toggle">
        {{ playing ? "暂停" : "播放" }}
      </button>
      <label
        >定位时间<input
          v-model="seekText"
          type="text"
          inputmode="numeric"
          aria-label="回放定位时间"
          placeholder="HH:mm:ss"
          @focus="editingTime = true"
          @keydown.esc="
            editingTime = false;
            seekText = clockTime(cursor);
          "
          @keyup.enter="seekInput"
      /></label>
      <button class="secondary" :disabled="!segments.length" @click="seekInput">
        定位
      </button>
      <label
        >倍速<select v-model="speed" aria-label="回放倍速">
          <option v-for="rate in [0.5, 1, 2, 4]" :key="rate" :value="rate">
            {{ rate }}×
          </option>
        </select></label
      >
      <button class="secondary" @click="muted = !muted">
        {{ muted ? "开启声音" : "静音" }}
      </button>
      <button class="secondary" :disabled="!current" @click="fullscreen">
        全屏
      </button>
      <a
        v-if="current && can('recording.download')"
        class="link"
        :href="current.url.replace(/\?play=1$/, '')"
        download
        >下载当前分段</a
      >
      <label class="archive-skip"
        ><input v-model="skipGaps" type="checkbox" />跳过无录像时段</label
      >
    </div>
    <div v-if="!clock" class="archive-timeline-wrap">
      <div class="archive-timeline-scale">
        <span v-for="hour in [0, 4, 8, 12, 16, 20, 24]" :key="hour"
          >{{ String(hour).padStart(2, "0") }}:00</span
        >
      </div>
      <div class="archive-timeline" @click="clickTimeline">
        <span
          v-for="segment in segments"
          :key="segment.id"
          class="archive-timeline-segment"
          :style="{
            left: segment.start / 864 + '%',
            width: (segment.end - segment.start) / 864 + '%',
          }"
          :title="clockTime(segment.start) + ' — ' + clockTime(segment.end)"
        />
        <span
          class="archive-timeline-cursor"
          :style="{ left: cursor / 864 + '%' }"
        />
      </div>
      <input
        class="archive-timeline-slider"
        type="range"
        min="0"
        max="86399"
        step="1"
        :value="cursor"
        aria-label="24小时录像时间轴"
        :aria-valuetext="clockTime(cursor)"
        @change="seek(Number(($event.target as HTMLInputElement).value))"
      />
      <div class="archive-timeline-legend">
        <span><i />蓝色为已确认录像，灰色为未索引到录像</span
        ><span>{{ clockTime(cursor) }} / 24:00:00</span>
      </div>
    </div>
    <p v-if="indexing && !clock" class="muted" role="status">
      正在读取分段实际时长 {{ completed }} /
      {{ files.length }}，已确认的蓝色时段可先播放。
    </p>
    <p v-if="failed && !clock" class="error" role="alert">
      {{ failed }}
      个文件的时间或时长未能确认，未计入时间轴；可重新读取或从下方分段文件回放。
    </p>
    <div v-if="!clock" class="archive-day-notice" role="status">
      {{ notice || "分段自动接续；录制空档不会作为有录像的时段展示。"
      }}<button v-if="failed && !indexing" class="link" @click="indexDay">
        重新读取
      </button>
    </div>
  </section>
</template>

<style scoped>
.archive-day {
  width: 100%;
  max-width: none;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  margin: 16px 0;
  background: #fff;
}
.archive-day-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  background: #f8faff;
  font-size: 12px;
  color: var(--muted);
}
.archive-day-heading > div {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.archive-day-heading b {
  color: var(--text);
}
.archive-day-screen {
  height: clamp(240px, 36vw, 510px);
  position: relative;
  background: #111d2d;
}
.archive-day-screen video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.archive-day-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 14px;
  color: #9bacc3;
  background: radial-gradient(ellipse at 50% 65%, #1b314f, #101c2c 75%);
  pointer-events: none;
}
.archive-day-placeholder b {
  font-size: 18px;
  color: #d3deee;
}
.archive-day-placeholder span {
  font-size: 13px;
}
.archive-day-error {
  position: absolute;
  bottom: 20px;
  left: 20px;
  right: 20px;
  background: #fff1f0;
  color: #a12622;
  padding: 12px;
  border-radius: 6px;
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
}
.archive-day-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.archive-day-controls label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
}
.archive-day-controls input[type="text"] {
  width: 100px;
  text-align: center;
}
.archive-day-controls select {
  width: 74px;
}
.archive-day-controls .archive-skip {
  margin-left: auto;
}
.archive-skip input {
  width: 14px;
  height: 14px;
}
.archive-timeline-wrap {
  padding: 16px 20px 10px;
  position: relative;
}
.archive-timeline-scale,
.archive-timeline-legend {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #74839b;
  gap: 8px;
}
.archive-timeline {
  height: 28px;
  background: #e9eef5;
  border-radius: 4px;
  margin-top: 8px;
  position: relative;
  cursor: pointer;
  overflow: hidden;
}
.archive-timeline-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  background: #3478ed;
  min-width: 1px;
}
.archive-timeline-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #f7a438;
  z-index: 1;
}
.archive-timeline-slider {
  position: absolute;
  left: 20px;
  top: 40px;
  width: calc(100% - 40px);
  height: 28px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.archive-timeline-wrap:has(.archive-timeline-slider:focus-visible)
  .archive-timeline {
  outline: 2px solid #3478ed;
  outline-offset: 3px;
}
.archive-timeline-legend {
  margin-top: 7px;
  flex-wrap: wrap;
}
.archive-timeline-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  background: #3478ed;
  margin-right: 5px;
  border-radius: 2px;
}
.archive-day-notice {
  padding: 10px 16px;
  background: #f8faff;
  font-size: 12px;
  color: #6a7e9c;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.archive-day > p {
  padding: 0 16px;
  font-size: 12px;
}
@media (max-width: 760px) {
  .archive-day-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .archive-day-controls {
    gap: 8px;
    padding: 12px;
  }
  .archive-day-controls .archive-skip {
    margin-left: 0;
    width: 100%;
  }
  .archive-timeline-wrap {
    padding: 14px 12px;
  }
  .archive-timeline-slider {
    left: 12px;
    width: calc(100% - 24px);
    top: 38px;
  }
  .archive-day-controls button {
    padding-left: 10px;
    padding-right: 10px;
  }
  .archive-day-placeholder span {
    font-size: 12px;
  }
}
</style>

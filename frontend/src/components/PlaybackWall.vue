<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import type { PlaybackClock, PlaybackRange } from "../playback-clock";
import AppIcon from "./AppIcon.vue";
import PlaybackLayoutPicker from "./PlaybackLayoutPicker.vue";
const props = defineProps<{
  items: { id: string; name: string; channelId?: string; slot?: number }[];
  ranges?: Record<string, PlaybackRange[]>;
  pending?: Record<string, boolean>;
  date?: string;
  rangeStart?: number;
  rangeEnd?: number;
  device?: boolean;
}>();
const boundStart = computed(() =>
  Number.isFinite(props.rangeStart) ? props.rangeStart! : 0,
);
const boundEnd = computed(() =>
  Number.isFinite(props.rangeEnd) && props.rangeEnd! > boundStart.value
    ? props.rangeEnd!
    : boundStart.value + 86400,
);
const span = computed(() => boundEnd.value - boundStart.value);
const root = ref<HTMLElement>();
let workspace: HTMLElement | null = null,
  resizeObserver: ResizeObserver | null = null;
function fitWorkspace() {
  if (!workspace) return;
  const height = Math.max(
    160,
    window.innerHeight -
      (workspace.getBoundingClientRect().top + window.scrollY) -
      32,
  );
  workspace.style.setProperty("--replay-workspace-height", `${height}px`);
}
const clock = ref<PlaybackClock>({
  position: boundStart.value,
  playing: false,
  speed: 1,
  muted: true,
  revision: 0,
  direction: 1,
});
const coverage = computed(() => {
  const ranges = props.items
    .flatMap((item) => props.ranges?.[item.id] || [])
    .filter(
      (r) =>
        Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start,
    )
    .map((r) => ({
      start: Math.max(boundStart.value, r.start),
      end: Math.min(boundEnd.value, r.end),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: PlaybackRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
});
const formatTime = (value: number) =>
  [
    Math.floor(value / 3600) % 24,
    Math.floor(value / 60) % 60,
    Math.floor(value) % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
const zoomLevels = [86400, 21600, 3600, 600, 300, 60];
const zoomSeconds = ref(86400);
const timelineStart = ref(Math.floor(boundStart.value / 86400) * 86400);
const domainStart = computed(
  () => Math.floor(boundStart.value / 86400) * 86400,
);
const domainEnd = computed(() =>
  Math.max(
    domainStart.value + 86400,
    Math.ceil(boundEnd.value / 86400) * 86400,
  ),
);
const visibleSpan = computed(() =>
  Math.min(zoomSeconds.value, domainEnd.value - domainStart.value),
);
const visibleStart = computed(() =>
  Math.max(
    domainStart.value,
    Math.min(domainEnd.value - visibleSpan.value, timelineStart.value),
  ),
);
const visibleEnd = computed(() => visibleStart.value + visibleSpan.value);
let followPlayback = true;
const isPanning = ref(false);
let timelineGesture: {
  id: number;
  x: number;
  left: number;
  width: number;
  start: number;
  span: number;
  moved: boolean;
} | null = null;
function startTimelineGesture(event: PointerEvent) {
  if (event.button !== 0) return;
  const element = event.currentTarget as HTMLElement,
    rect = element.getBoundingClientRect();
  if (!rect.width) return;
  event.preventDefault();
  timelineGesture = {
    id: event.pointerId,
    x: event.clientX,
    left: rect.left,
    width: rect.width,
    start: visibleStart.value,
    span: visibleSpan.value,
    moved: false,
  };
  element.setPointerCapture?.(event.pointerId);
  root.value
    ?.querySelector<HTMLInputElement>(".shared-time-track input")
    ?.focus({ preventScroll: true });
}
function moveTimelineGesture(event: PointerEvent) {
  const gesture = timelineGesture;
  if (!gesture || gesture.id !== event.pointerId) return;
  const distance = event.clientX - gesture.x;
  if (Math.abs(distance) > 3) gesture.moved = true;
  if (!gesture.moved) return;
  isPanning.value = true;
  followPlayback = false;
  timelineStart.value = Math.max(
    domainStart.value,
    Math.min(
      domainEnd.value - visibleSpan.value,
      Math.round(gesture.start - (distance / gesture.width) * gesture.span),
    ),
  );
}
function endTimelineGesture(event: PointerEvent) {
  const gesture = timelineGesture;
  if (!gesture || gesture.id !== event.pointerId) return;
  timelineGesture = null;
  isPanning.value = false;
  if (event.type !== "pointercancel" && !gesture.moved)
    seek(
      Math.round(
        gesture.start +
          Math.max(
            0,
            Math.min(1, (event.clientX - gesture.left) / gesture.width),
          ) *
            gesture.span,
      ),
    );
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture?.(event.pointerId))
    element.releasePointerCapture(event.pointerId);
}
function setZoom(seconds: number, focus = clock.value.position, ratio = 0.5) {
  if (!zoomLevels.includes(seconds)) return;
  zoomSeconds.value = seconds;
  timelineStart.value = Math.max(
    domainStart.value,
    Math.min(
      domainEnd.value - visibleSpan.value,
      seconds === 86400
        ? Math.floor(focus / 86400) * 86400
        : Math.floor(focus - visibleSpan.value * ratio),
    ),
  );
  followPlayback = true;
}
function zoomBy(direction: number, event?: WheelEvent) {
  const index = zoomLevels.indexOf(zoomSeconds.value),
    next = Math.max(0, Math.min(zoomLevels.length - 1, index + direction));
  if (next === index) return;
  let ratio = 0.5,
    focus = clock.value.position;
  if (event) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    focus = visibleStart.value + visibleSpan.value * ratio;
  }
  setZoom(zoomLevels[next], focus, ratio);
}
function panTimeline(direction: number) {
  timelineStart.value = Math.max(
    domainStart.value,
    Math.min(
      domainEnd.value - visibleSpan.value,
      visibleStart.value + (direction * visibleSpan.value) / 2,
    ),
  );
  followPlayback = false;
}
function ensureVisible() {
  if (
    clock.value.position < visibleStart.value ||
    clock.value.position >= visibleEnd.value
  )
    setZoom(zoomSeconds.value);
}
const ticks = computed(() =>
  Array.from({ length: 7 }, (_, index) => {
    const second = visibleStart.value + (visibleSpan.value * index) / 6;
    const full = formatTime(second),
      label = visibleSpan.value <= 600 ? full : full.slice(0, 5);
    return {
      second,
      label:
        second === 86400 && visibleStart.value === 0
          ? "24:00"
          : (second >= 86400 ? "次日 " : "") + label,
    };
  }),
);
function rangeStyle(range: PlaybackRange) {
  const start = Math.max(visibleStart.value, range.start),
    end = Math.min(visibleEnd.value, range.end);
  return {
    display: end > start ? "" : "none",
    left: ((start - visibleStart.value) / visibleSpan.value) * 100 + "%",
    width: (Math.max(0, end - start) / visibleSpan.value) * 100 + "%",
  };
}
let anchorTime = 0,
  anchorPosition = 0,
  timer: ReturnType<typeof setInterval> | undefined;
let interactionLocked = false;
const referenceId = ref<string | null>(null);
function anchor() {
  anchorTime = performance.now();
  anchorPosition = clock.value.position;
}
function seek(value: number, automatic = false) {
  if (!Number.isFinite(value)) return;
  if (!automatic) interactionLocked = true;
  clock.value.position = Math.max(
    boundStart.value,
    Math.min(boundEnd.value - 1, value),
  );
  clock.value.revision++;
  followPlayback = true;
  ensureVisible();
  anchor();
}
function seekTime(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) return;
  const [hours, minutes, seconds] = value.split(":").map(Number);
  let second = hours * 3600 + minutes * 60 + seconds;
  if (second < boundStart.value && boundEnd.value > 86400) second += 86400;
  seek(second);
}
function togglePlayback() {
  if (!props.items.length) return;
  if (referenceId.value) interactionLocked = true;
  clock.value.playing = !clock.value.playing;
  clock.value.revision++;
  anchor();
}
const rateDirection = ref<1 | -1 | null>(null);
const playbackRates = [1, 2, 4, 8, 16];
function cyclePlaybackRate(direction: 1 | -1) {
  if (
    !props.items.length ||
    (direction === -1 && clock.value.position <= boundStart.value)
  )
    return;
  if (referenceId.value) interactionLocked = true;
  const index =
    rateDirection.value === direction
      ? playbackRates.indexOf(clock.value.speed)
      : -1;
  clock.value.speed = playbackRates[(index + 1) % playbackRates.length];
  rateDirection.value = direction;
  clock.value.direction = direction;
  clock.value.playing = true;
  clock.value.revision++;
  anchor();
}
function playForward() {
  if (!props.items.length) return;
  const changed = clock.value.direction === -1 || clock.value.speed !== 1;
  rateDirection.value = null;
  clock.value.speed = 1;
  clock.value.direction = 1;
  if (!clock.value.playing) togglePlayback();
  else if (changed) {
    clock.value.revision++;
    anchor();
  }
}
function pausePlayback() {
  if (clock.value.playing) togglePlayback();
}
function rewindPlayback() {
  if (!props.items.length || clock.value.position <= boundStart.value) return;
  interactionLocked = true;
  clock.value.direction = -1;
  clock.value.playing = true;
  clock.value.revision++;
  anchor();
}
function synchronizePlayback() {
  playForward();
  if (!props.items.length) return;
  clock.value.revision++;
  anchor();
}
function tick() {
  if (!clock.value.playing) return;
  clock.value.position = Math.max(
    boundStart.value,
    Math.min(
      boundEnd.value - 1,
      anchorPosition +
        ((performance.now() - anchorTime) / 1000) *
          clock.value.speed *
          (clock.value.direction || 1),
    ),
  );
  if (followPlayback) ensureVisible();
  if (
    (clock.value.direction !== -1 &&
      (clock.value.position >= boundEnd.value - 1 ||
        (coverage.value.length &&
          clock.value.position >= coverage.value.at(-1)!.end))) ||
    (clock.value.direction === -1 &&
      clock.value.position <=
        Math.max(
          boundStart.value,
          coverage.value[0]?.start ?? boundStart.value,
        ))
  )
    clock.value.playing = false;
}
watch(
  () => clock.value.speed,
  () => {
    clock.value.revision++;
    anchor();
  },
);
watch(
  () => [props.date, boundStart.value, boundEnd.value],
  () => {
    clock.value.playing = false;
    interactionLocked = false;
    referenceId.value = null;
    seek(boundStart.value, true);
  },
);
watch(
  () => props.items.length,
  (count) => {
    if (!count) {
      clock.value.playing = false;
      interactionLocked = false;
      referenceId.value = null;
    }
  },
);
onMounted(() => {
  timer = setInterval(tick, 250);
  workspace =
    root.value?.closest<HTMLElement>(
      ".archive-review-workspace, .device-review-workspace",
    ) || null;
  fitWorkspace();
  if (typeof ResizeObserver !== "undefined" && workspace) {
    resizeObserver = new ResizeObserver(fitWorkspace);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(workspace);
  }
  window.addEventListener("resize", fitWorkspace);
  void nextTick(fitWorkspace);
});
onUnmounted(() => {
  clearInterval(timer);
  resizeObserver?.disconnect();
  if (typeof window !== "undefined")
    window.removeEventListener("resize", fitWorkspace);
  workspace?.style.removeProperty("--replay-workspace-height");
});
const emit = defineEmits<{
  close: [id: string];
  clear: [];
  "drop-channel": [drop: { channelId: string; slot: number }];
}>();
const dragTarget = ref<number | null>(null);
function dragOver(event: DragEvent, slot: number) {
  if (!event.dataTransfer?.types.includes("application/x-ls-aegis-channel"))
    return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dragTarget.value = slot;
}
function dropChannel(event: DragEvent, slot: number) {
  event.preventDefault();
  dragTarget.value = null;
  const channelId = event.dataTransfer?.getData(
    "application/x-ls-aegis-channel",
  );
  if (
    channelId &&
    channelId.length <= 200 &&
    Number.isInteger(slot) &&
    slot >= 0 &&
    slot < 9
  )
    emit("drop-channel", { channelId, slot });
}
const layouts = [1, 4, 9];
const layout = ref(4),
  maximized = ref<number | null>(null);
const columns = computed(() =>
  maximized.value === null ? Math.sqrt(layout.value) : 1,
);
watch(
  () =>
    Math.max(
      props.items.length,
      ...props.items.map((item) => (item.slot ?? -1) + 1),
    ),
  (count) => {
    if (count > layout.value)
      layout.value = layouts.find((n) => n >= count) || 9;
    if (maximized.value !== null && maximized.value >= count)
      maximized.value = null;
  },
  { immediate: true },
);
const cells = computed(() => {
  const result: ((typeof props.items)[number] | null)[] = Array(
    layout.value,
  ).fill(null);
  for (const item of props.items) {
    const slot =
      Number.isInteger(item.slot) && item.slot! >= 0
        ? item.slot!
        : result.indexOf(null);
    if (slot >= 0 && slot < result.length) result[slot] = item;
  }
  return result;
});
// Reference selection follows actual window positions, never response order or
// the globally earliest channel. An unresolved higher slot cannot be skipped.
function chooseReference() {
  if (interactionLocked) return;
  for (const item of cells.value) {
    if (!item) continue;
    const ranges = (props.ranges?.[item.id] || [])
      .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
      .map((r) => ({
        start: Math.max(boundStart.value, r.start),
        end: Math.min(boundEnd.value, r.end),
      }))
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
    if (ranges.length) {
      if (referenceId.value === item.id) return;
      referenceId.value = item.id;
      if (
        !ranges.some(
          (r) =>
            r.start <= clock.value.position && clock.value.position < r.end,
        )
      )
        seek(ranges[0].start, true);
      if (clock.value.playing) interactionLocked = true;
      return;
    }
    const pending = props.pending
      ? props.pending[item.id] !== false
      : !Object.hasOwn(props.ranges || {}, item.id);
    if (pending) return;
  }
  referenceId.value = null;
}
watch(
  () => [
    cells.value,
    props.ranges,
    props.pending,
    boundStart.value,
    boundEnd.value,
  ],
  chooseReference,
  { deep: true, immediate: true, flush: "post" },
);
function toggleMaximize(index: number, event: MouseEvent) {
  if ((event.target as Element)?.closest("button, input, select, label, a"))
    return;
  maximize(index);
}
function maximize(index: number) {
  maximized.value = maximized.value === index ? null : index;
}
function changeLayout(count: number) {
  if (!layouts.includes(count)) return;
  maximized.value = null;
  const removed = cells.value.slice(count);
  layout.value = count;
  for (const item of removed) if (item) emit("close", item.id);
}
</script>
<template>
  <section
    ref="root"
    class="playback-wall"
    aria-label="多通道录像回放"
    @keydown.esc="maximized = null"
  >
    <div
      class="playback-grid"
      :class="{ dense: layout >= 16 && maximized === null }"
      :style="{ '--playback-columns': columns }"
    >
      <div
        v-for="(entry, index) in cells"
        :key="entry?.id || 'empty:' + index"
        class="playback-cell"
        role="group"
        :aria-label="`回放窗口 ${index + 1}`"
        :data-slot="index"
        :class="{ 'is-hidden': maximized !== null && maximized !== index }"
        :data-drop-target="dragTarget === index"
        tabindex="0"
        @dblclick="toggleMaximize(index, $event)"
        @dragover="dragOver($event, index)"
        @dragleave="dragTarget = null"
        @drop="dropChannel($event, index)"
      >
        <template v-if="entry">
          <div class="playback-cell-title">
            <span>{{ entry.name }}</span
            ><button
              type="button"
              class="link"
              :aria-label="'关闭回放 ' + entry.name"
              @click.stop="emit('close', entry.id)"
              @dblclick.stop
            >
              <AppIcon name="close" :size="14" />
            </button>
          </div>
          <slot
            :item="entry"
            :clock="clock"
            :maximize="() => maximize(index)"
            :maximized="maximized === index"
          />
        </template>
        <div v-else class="playback-empty">
          <AppIcon name="devices" :size="32" /><span
            >回放窗口 {{ String(index + 1).padStart(2, "0") }}</span
          >
        </div>
      </div>
    </div>
    <div class="shared-playback-timeline" :class="{ 'is-panning': isPanning }">
      <div class="timeline-view-tools">
        <span
          >时间轴
          <small>{{
            zoomSeconds >= 3600
              ? zoomSeconds / 3600 + "小时"
              : zoomSeconds / 60 + "分钟"
          }}</small></span
        >
        <div role="group" aria-label="时间轴缩放">
          <button
            type="button"
            class="link"
            aria-label="向前查看时间轴"
            :disabled="visibleStart <= domainStart"
            @click="panTimeline(-1)"
          >
            ‹</button
          ><button
            type="button"
            class="link"
            aria-label="缩小时间轴"
            :disabled="zoomSeconds === 86400"
            @click="zoomBy(-1)"
          >
            −</button
          ><button
            v-for="preset in [
              { seconds: 86400, label: '全天' },
              { seconds: 3600, label: '小时' },
              { seconds: 60, label: '分钟' },
            ]"
            :key="preset.seconds"
            type="button"
            class="link"
            :class="{ selected: zoomSeconds === preset.seconds }"
            :aria-pressed="zoomSeconds === preset.seconds"
            @click="setZoom(preset.seconds)"
          >
            {{ preset.label }}</button
          ><button
            type="button"
            class="link"
            aria-label="放大时间轴"
            :disabled="zoomSeconds === 60"
            @click="zoomBy(1)"
          >
            +</button
          ><button
            type="button"
            class="link"
            aria-label="向后查看时间轴"
            :disabled="visibleEnd >= domainEnd"
            @click="panTimeline(1)"
          >
            ›
          </button>
        </div>
      </div>
      <div
        class="shared-time-scale"
        @pointerdown="startTimelineGesture"
        @pointermove="moveTimelineGesture"
        @pointerup="endTimelineGesture"
        @pointercancel="endTimelineGesture"
      >
        <span v-for="tick in ticks" :key="tick.second">{{ tick.label }}</span>
      </div>
      <div
        class="shared-time-track"
        @pointerdown="startTimelineGesture"
        @pointermove="moveTimelineGesture"
        @pointerup="endTimelineGesture"
        @pointercancel="endTimelineGesture"
        @wheel.prevent="zoomBy($event.deltaY < 0 ? 1 : -1, $event)"
      >
        <i
          v-for="(range, index) in coverage"
          :key="index"
          :style="rangeStyle(range)"
        /><b
          :style="{
            left: ((clock.position - visibleStart) / visibleSpan) * 100 + '%',
            display:
              clock.position >= visibleStart && clock.position < visibleEnd
                ? ''
                : 'none',
          }"
        /><input
          type="range"
          :min="visibleStart"
          :max="visibleEnd - 1"
          step="1"
          :value="
            Math.floor(
              Math.max(visibleStart, Math.min(visibleEnd - 1, clock.position)),
            )
          "
          aria-label="同步回放时间轴"
          :aria-valuetext="formatTime(clock.position)"
          @change="seek(Number(($event.target as HTMLInputElement).value))"
        />
      </div>
    </div>
    <footer>
      <div class="playback-transport" role="group" aria-label="同步回放控制">
        <button
          type="button"
          class="link"
          aria-label="快退"
          title="点击循环1、2、4、8、16倍倒放；平台采用抽帧预览，设备需支持"
          :disabled="!items.length"
          :aria-pressed="clock.playing && clock.direction === -1"
          @click="cyclePlaybackRate(-1)"
        >
          <AppIcon name="fast-rewind" :size="18" /><span
            v-if="rateDirection === -1"
            >{{ clock.speed }}×</span
          >
        </button>
        <button
          type="button"
          class="link"
          aria-label="播放"
          :disabled="!items.length"
          @click="playForward"
        >
          <AppIcon name="play" :size="18" />
        </button>
        <button
          type="button"
          class="link"
          aria-label="暂停"
          :disabled="!clock.playing"
          @click="pausePlayback"
        >
          <AppIcon name="pause" :size="18" />
        </button>

        <button
          type="button"
          class="link"
          aria-label="快进"
          title="点击循环1、2、4、8、16倍播放"
          :disabled="!items.length"
          @click="cyclePlaybackRate(1)"
        >
          <AppIcon name="fast-forward" :size="18" /><span
            v-if="rateDirection === 1"
            >{{ clock.speed }}×</span
          >
        </button>
        <button
          type="button"
          class="link"
          aria-label="同步播放"
          :disabled="!items.length"
          @click="synchronizePlayback"
        >
          <AppIcon name="refresh" :size="15" />同步
        </button>

        <small v-if="clock.direction === -1" class="reverse-label">{{
          device ? "设备倒放" : "抽帧倒放"
        }}</small>
      </div>
      <div class="playback-right">
        <div class="playback-side playback-actions">
          <PlaybackLayoutPicker
            :value="layout"
            :layouts="layouts"
            @select="changeLayout"
          />
          <button
            type="button"
            class="link"
            :disabled="!items.length"
            :aria-label="clock.muted ? '开启声音' : '静音全部'"
            @click="clock.muted = !clock.muted"
          >
            <AppIcon
              :name="clock.muted ? 'volume-off' : 'volume-on'"
              :size="16"
            />
          </button>
          <button
            type="button"
            class="link"
            aria-label="关闭全部回放"
            title="关闭全部回放"
            :disabled="!items.length"
            @click="emit('clear')"
          >
            <AppIcon name="close" :size="16" />
          </button>
        </div>
        <label class="playback-side playback-time"
          ><span>定位时间</span>
          <input
            class="shared-clock"
            type="time"
            step="1"
            aria-label="定位时间"
            :value="formatTime(clock.position)"
            @change="seekTime(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </footer>
  </section>
</template>
<style scoped>
.playback-wall {
  width: 100%;
  max-width: none;
  margin: 0;
  align-self: stretch;
  padding: 0;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid #dfe6f0;
  border-radius: 8px;
  margin-top: 0;
}
.shared-playback-timeline {
  padding: 12px 16px 4px;
  background: #f8faff;
  border-top: 1px solid #dfe6f0;
}
.timeline-view-tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 30px;
  gap: 8px;
  margin-bottom: 4px;
  color: #75859b;
  font-size: 11px;
}
.timeline-view-tools > div {
  display: flex;
  align-items: center;
  gap: 2px;
}
.timeline-view-tools button {
  min-height: 24px;
  height: 24px;
  min-width: 26px;
  padding: 0 5px;
  font-size: 11px;
}
.timeline-view-tools button.selected {
  background: #e5efff;
  color: #215ebd;
  border-radius: 4px;
}
.timeline-view-tools small {
  font-size: 10px;
  margin-left: 6px;
}
.shared-time-scale {
  cursor: grab;
  user-select: none;
  touch-action: none;
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #75859b;
  margin-bottom: 6px;
}
.shared-time-track {
  position: relative;
  height: 24px;
  background: #e7edf5;
  border-radius: 4px;
  overflow: hidden;
}
.shared-time-track i {
  position: absolute;
  height: 100%;
  top: 0;
  background: #3b83db;
  pointer-events: none;
}
.shared-time-track b {
  position: absolute;
  height: 100%;
  width: 2px;
  top: 0;
  background: #f5a623;
  pointer-events: none;
}
.shared-time-track input {
  position: absolute;
  width: 100%;
  height: 100%;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: grab;
  touch-action: none;
}
.shared-playback-timeline.is-panning .shared-time-scale,
.shared-playback-timeline.is-panning .shared-time-track input {
  cursor: grabbing;
}
.shared-time-track:focus-within {
  outline: 2px solid #276bd0;
  outline-offset: 2px;
}
.shared-clock {
  width: 112px;
  margin-right: auto;
  font-variant-numeric: tabular-nums;
  color: #34465e;
}
footer select {
  width: 70px;
  min-height: 28px;
  padding: 3px 8px;
  font-size: 12px;
}
:deep(.player-caption),
:deep(.preview-toolbar),
:deep(.preview-tools-trigger) {
  display: none;
}
.playback-grid {
  flex: 1;
  min-height: 0;
  grid-template-rows: repeat(var(--playback-columns), minmax(0, 1fr));
  display: grid;
  grid-template-columns: repeat(var(--playback-columns), minmax(0, 1fr));
  gap: 4px;
  background: #142133;
  padding: 4px;
}
.playback-cell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: #152332;
  color: #dbe6f5;
  border: 1px solid #2b3e55;
  overflow: hidden;
}
.playback-cell:focus-within {
  border-color: #4089ed;
}
.playback-cell[data-drop-target="true"] {
  border: 2px solid #4e98ff;
  background: #1b3556;
}
.playback-cell.is-hidden {
  display: none;
}
.playback-cell-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
  gap: 6px;
}
.playback-cell-title span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.playback-cell-title button {
  color: #b8cce7;
  padding: 2px;
  min-height: 22px;
}
.playback-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #73859c;
  font-size: 12px;
}
footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: #f8faff;
}
footer .segment {
  padding: 2px;
  gap: 0;
}
footer .segment button {
  width: 24px;
  min-width: 24px;
  padding: 0;
  font-size: 11px;
}
footer > span {
  margin-right: auto;
  font-size: 11px;
}
footer button {
  min-height: 28px;
  font-size: 12px;
}
:deep(.archive-day) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: #34465e;
  margin: 0;
  border: 0;
  border-radius: 0;
}
:deep(.archive-timeline-legend > span:first-child) {
  display: none;
}
:deep(.archive-day-notice) {
  font-size: 11px;
  padding: 7px 10px;
}
:deep(.archive-day-heading) {
  display: none;
}
:deep(.archive-day-screen) {
  flex: 1;
  aspect-ratio: auto;
  height: auto;
  min-height: 0;
}
:deep(.archive-day-controls) {
  flex-wrap: wrap;
  padding: 6px;
  gap: 6px;
}
:deep(.archive-day-controls label),
:deep(.archive-day-controls button) {
  font-size: 11px;
}
:deep(.archive-day-controls input) {
  width: 85px;
}
:deep(.live-player) {
  flex: 1;
  min-height: 0;
  width: 100%;
  aspect-ratio: auto;
  min-height: 0;
}
.dense .playback-cell-title {
  height: 18px;
  flex: none;
  font-size: 10px;
}
.playback-cell-title {
  flex: none;
}
.shared-playback-timeline,
footer {
  flex: none;
}
@media (max-width: 600px) {
  footer > span {
    display: none;
  }
  .playback-grid {
    overflow-x: auto;
    grid-template-columns: repeat(var(--playback-columns), minmax(180px, 1fr));
  }
}
.playback-side,
.playback-transport {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.playback-time {
  justify-content: flex-end;
  margin: 0;
  gap: 8px;
  white-space: nowrap;
  font-size: 12px;
  color: #526981;
}
.playback-time .shared-clock {
  margin: 0;
}
.playback-actions {
  justify-content: flex-end;
}
.playback-right {
  grid-column: 3;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.playback-transport {
  grid-column: 2;
}
.playback-transport button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
}
.playback-transport button[aria-pressed="true"] {
  color: #2166cd;
  background: #e5efff;
}
.reverse-label {
  font-size: 11px;
  color: #65758c;
  white-space: nowrap;
}
:deep(.player-bottom) {
  display: none;
}
@media (max-width: 1100px) {
  footer {
    grid-template-columns: 1fr 1fr;
  }
  .playback-transport {
    grid-row: 2;
    grid-column: 1 / -1;
    justify-content: center;
  }
  .playback-right {
    grid-row: 1;
    grid-column: 1 / -1;
  }
}
</style>

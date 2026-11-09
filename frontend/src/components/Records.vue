<script setup lang="ts">
import { can } from "../api";
import AppIcon from "./AppIcon.vue";
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from "vue";
import { api, messageOf, type RecordClip } from "../api";
import type { Channel } from "./Monitoring.vue";
import LivePlayer from "./LivePlayer.vue";
import PlaybackWall from "./PlaybackWall.vue";
import PlaybackResources from "./PlaybackResources.vue";
import { matchesChannelSearch } from "../channel-search";
import RecordingCenter from "./RecordingCenter.vue";
import { rememberFilter } from "../remember-filter";
import { recordSearchRange, type RecordSearchRange } from "../record-range";
const playbackClips = ref<
  (RecordClip & { windowId?: string; slot?: number })[]
>([]);
let pendingDropSlot: number | undefined;
const appliedDeviceRange = ref<RecordSearchRange | null>(null);
const windowId = (clip: RecordClip & { windowId?: string }) =>
  clip.windowId || clip.id;
function closeDeviceWindow(id: string) {
  playbackClips.value = playbackClips.value.filter(
    (clip) => windowId(clip) !== id,
  );
}
function dragDeviceChannel(event: DragEvent, id: string) {
  event.dataTransfer?.setData("application/x-ls-aegis-channel", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
async function dropDeviceChannel(drop: { channelId: string; slot: number }) {
  const channel = channels.value.find(
    (item) =>
      item.id === drop.channelId &&
      item.status === "online" &&
      item.deviceStatus === "online",
  );
  if (!channel) return;
  const clips = clipPool.value[channel.id];
  let matching = false;
  try {
    matching =
      appliedDeviceRange.value?.key ===
      recordSearchRange(start.value, end.value).key;
  } catch {}
  if (matching && clips?.length) {
    openClip(clips[0], drop.slot);
    return;
  }
  pendingDropSlot = drop.slot;
  channelId.value = channel.id;
  await nextTick();
  await search();
}
const clipPool = ref<Record<string, RecordClip[]>>({});
const clipDay = (clip: RecordClip) =>
  Number.isFinite(Date.parse(clip.start))
    ? new Date(clip.start).toLocaleDateString("sv-SE", {
        timeZone: "Asia/Shanghai",
      })
    : "";
const deviceDate = computed(
  () =>
    appliedDeviceRange.value?.date ||
    (playbackClips.value[0]
      ? clipDay(playbackClips.value[0])
      : start.value.slice(0, 10)),
);
async function selectDeviceChannel(id: string) {
  pendingDropSlot = undefined;
  channelId.value = id;
  await nextTick();
}

function openClip(clip: RecordClip, destination?: number) {
  if (
    playbackClips.value[0] &&
    clipDay(clip) &&
    clipDay(playbackClips.value[0]) !== clipDay(clip)
  )
    playbackClips.value = [];
  const current =
    destination === undefined
      ? playbackClips.value.findIndex(
          (entry) => entry.channelId === clip.channelId,
        )
      : playbackClips.value.findIndex((entry) => entry.slot === destination);
  if (current >= 0) {
    const old = playbackClips.value[current];
    playbackClips.value[current] = {
      ...clip,
      windowId: old.windowId || crypto.randomUUID(),
      slot: old.slot ?? current,
    };
    return;
  }
  const occupied = new Set(
    playbackClips.value.map((entry, index) => entry.slot ?? index),
  );
  const slot =
    destination ??
    Array.from({ length: 9 }, (_, index) => index).find(
      (index) => !occupied.has(index),
    );
  if (slot === undefined || !Number.isInteger(slot) || slot < 0 || slot >= 9) {
    message.value = "最多同时回放9路，请先关闭一个窗口";
    return;
  }
  playbackClips.value.push({ ...clip, windowId: crypto.randomUUID(), slot });
}
const emit = defineEmits<{ downloads: [] }>();
const source = rememberFilter<"platform" | "device">(
  "records.source",
  "platform",
  (value) => value === "platform" || value === "device",
);
watch(source, () => {
  playbackClips.value = [];
  selected.value = null;
});
const speed = rememberFilter<number>("records.device.speed", 1, (value) =>
    [1, 2, 4].includes(value),
  ),
  exporting = ref(false);
async function download(item: RecordClip) {
  if (!alive || exporting.value) return;
  exporting.value = true;
  message.value = "";
  try {
    await api(
      "/recording-jobs",
      "POST",
      { recordId: item.id, speed: speed.value },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    if (alive) emit("downloads");
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    exporting.value = false;
  }
}
const local = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
const now = new Date();
const midnight = new Date(now);
midnight.setHours(0, 0, 0, 0);
const channels = ref<Channel[]>([]),
  channelId = rememberFilter<string>("records.device.channel", ""),
  start = rememberFilter("records.device.start", local(midnight)),
  end = rememberFilter("records.device.end", local(now)),
  items = ref<RecordClip[]>([]),
  message = ref(""),
  busy = ref(false),
  searched = ref(false),
  selected = ref<RecordClip | null>(null);
const resourceSearch = rememberFilter<string>("records.device.search", "");
const filteredChannels = computed(() =>
  channels.value.filter((channel) =>
    matchesChannelSearch(resourceSearch.value, [
      channel.name,
      channel.channelCode,
      channel.id,
      channel.deviceName,
    ]),
  ),
);
const playbackModels = computed(
  () =>
    new Map(
      playbackClips.value.flatMap((record) => {
        const channel = channels.value.find(
          (item) => item.id === record.channelId,
        );
        return channel
          ? [[windowId(record), { record, channel }] as const]
          : [];
      }),
    ),
);
const playbackItems = computed(() =>
  [...playbackModels.value].map(([id, model]) => ({
    id,
    name: model.channel.name,
    channelId: model.channel.id,
    slot: model.record.slot,
  })),
);
const deviceRanges = computed(() =>
  Object.fromEntries(
    [...playbackModels.value].map(([id, model]) => {
      const midnight = Date.parse(deviceDate.value + "T00:00:00+08:00");
      return [
        id,
        (clipPool.value[model.channel.id] || [model.record]).map((clip) => ({
          start: (Date.parse(clip.start) - midnight) / 1000,
          end: (Date.parse(clip.end) - midnight) / 1000,
        })),
      ];
    }),
  ),
);
function recordAtClock(id: string, second: number) {
  const model = playbackModels.value.get(id);
  if (!model) return null;
  const instant =
    Date.parse(deviceDate.value + "T00:00:00+08:00") + second * 1000;
  return (
    (clipPool.value[model.channel.id] || []).find(
      (clip) =>
        Date.parse(clip.start) <= instant && instant < Date.parse(clip.end),
    ) || model.record
  );
}
let alive = true,
  generation = 0;
watch([channelId, start, end], () => {
  generation++;
  busy.value = false;
  searched.value = false;
  items.value = [];
  selected.value = null;
  message.value = "";
});
async function refreshChannels() {
  try {
    const result = await api<{ items: Channel[] }>("/channels");
    if (!alive) return;
    channels.value = result.items;
    if (!channels.value.some((channel) => channel.id === channelId.value))
      channelId.value = "";
  } catch (e) {
    message.value = messageOf(e);
  }
}
onMounted(refreshChannels);
onUnmounted(() => {
  alive = false;
  generation++;
});
async function search() {
  if (!alive || busy.value) return;
  let range: RecordSearchRange;
  try {
    if (!channelId.value) throw Error("请先选择通道");
    range = recordSearchRange(start.value, end.value);
  } catch (error) {
    message.value = messageOf(error);
    return;
  }
  const channel = channelId.value;
  const gen = ++generation;
  const destination = pendingDropSlot;
  pendingDropSlot = undefined;
  busy.value = true;
  searched.value = true;
  items.value = [];
  message.value = "正在向设备查询录像…";
  selected.value = null;
  try {
    const result = await api<{ taskId: string }>("/record-queries", "POST", {
      channelId: channel,
      start: range.start,
      end: range.end,
    });
    for (let i = 0; i < 30 && alive && generation === gen; i++) {
      const task = await api<{
        status: string;
        items: RecordClip[];
        error?: string;
      }>(`/record-queries/${result.taskId}`);
      if (!alive || generation !== gen) return;
      if (task.status === "succeeded") {
        items.value = task.items;
        if (appliedDeviceRange.value?.key !== range.key) {
          playbackClips.value = [];
          clipPool.value = {};
        }
        appliedDeviceRange.value = range;
        clipPool.value[channel] = task.items;
        if (
          task.items.length &&
          channels.value.some(
            (channel) => channel.id === task.items[0].channelId,
          )
        )
          openClip(task.items[0], destination);
        message.value = "";
        return;
      }
      if (task.status === "failed") throw Error(task.error || "录像查询失败");
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error("等待录像查询超时");
  } catch (e) {
    if (alive && gen === generation) message.value = messageOf(e);
  } finally {
    if (alive && gen === generation) busy.value = false;
  }
}
const format = (value: string) => new Date(value).toLocaleString();
</script>
<template>
  <section class="business-page" id="records-view">
    <div class="title">
      <div>
        <h1>录像回放</h1>
      </div>
      <div class="record-source-bar">
        <div class="segment record-source" role="group" aria-label="录像来源">
          <button
            type="button"
            :class="{ selected: source === 'platform' }"
            :aria-pressed="source === 'platform'"
            @click="source = 'platform'"
          >
            <AppIcon name="records" :size="16" />平台录像
          </button>
          <button
            type="button"
            :class="{ selected: source === 'device' }"
            :aria-pressed="source === 'device'"
            @click="source = 'device'"
          >
            <AppIcon name="devices" :size="16" />设备录像
          </button>
        </div>
      </div>
    </div>
    <RecordingCenter v-if="source === 'platform'" section="library" />
    <div v-else class="device-review-workspace">
      <PlaybackResources
        v-model:query="resourceSearch"
        :count="filteredChannels.length"
        :total="channels.length"
      >
        <template #tools
          ><button
            type="button"
            class="link"
            aria-label="刷新通道资源"
            @click="refreshChannels"
          >
            <AppIcon name="refresh" :size="16" />
          </button>
          <details
            v-if="items.length && can('recording.download')"
            class="device-export-list"
          >
            <summary aria-label="导出录像">···</summary>
            <div class="resource-menu">
              <label
                >导出速度<select v-model.number="speed">
                  <option v-for="rate in [1, 2, 4]" :key="rate" :value="rate">
                    {{ rate }}×
                  </option>
                </select></label
              ><button
                v-for="clip in items"
                :key="clip.id"
                type="button"
                class="link"
                :disabled="exporting"
                @click="download(clip)"
              >
                {{ new Date(clip.start).toLocaleTimeString() }} —
                {{ new Date(clip.end).toLocaleTimeString() }} · 导出
              </button>
            </div>
          </details></template
        >

        <button
          v-for="channel in filteredChannels"
          :key="channel.id"
          type="button"
          draggable="true"
          @dragstart="dragDeviceChannel($event, channel.id)"
          :disabled="
            channel.status !== 'online' || channel.deviceStatus !== 'online'
          "
          :class="{ selected: channelId === channel.id }"
          @click="selectDeviceChannel(channel.id)"
        >
          <AppIcon name="devices" :size="18" /><span>{{ channel.name }}</span>
        </button>

        <template #query>
          <form class="resource-query-form" @submit.prevent="search">
            <h4>录像查询</h4>
            <label
              >开始时间<input
                v-model="start"
                type="datetime-local"
                step="1"
                required /></label
            ><label
              >结束时间<input
                v-model="end"
                type="datetime-local"
                step="1"
                required /></label
            ><button :disabled="busy || !channelId">
              {{ busy ? "查询中…" : "查询录像" }}
            </button>
            <p v-if="message" class="inline-message" role="status">
              {{ message }}
            </p>
            <p
              v-else-if="searched && !busy && !items.length"
              class="panel-note"
            >
              所选时段暂无设备录像
            </p>
          </form></template
        >
      </PlaybackResources>
      <main class="device-replay-main">
        <PlaybackWall
          device
          :items="playbackItems"
          :ranges="deviceRanges"
          :date="deviceDate"
          :range-start="appliedDeviceRange?.from"
          :range-end="appliedDeviceRange?.to"
          @close="closeDeviceWindow"
          @drop-channel="dropDeviceChannel"
          @clear="playbackClips = []"
        >
          <template #default="{ item, clock, maximize, maximized }"
            ><LivePlayer
              v-if="playbackModels.has(item.id)"
              :key="recordAtClock(item.id, clock.position)?.id"
              :record="recordAtClock(item.id, clock.position)!"
              :playback-clock="clock"
              :playback-date="deviceDate"
              :can-maximize="true"
              :maximized="maximized"
              @toggle-maximize="maximize"
              :channel="playbackModels.get(item.id)!.channel"
              @close="closeDeviceWindow(item.id)"
          /></template>
        </PlaybackWall>
      </main>
    </div>
  </section>
</template>

<style scoped>
#records-view > .title {
  position: relative;
  justify-content: center;
  min-height: 48px;
  margin-bottom: 10px;
  padding: 0;
}
#records-view .record-source-bar {
  position: absolute;
  right: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}
@media (max-width: 760px) {
  #records-view > .title {
    flex-direction: column;
    gap: 6px;
  }
  #records-view .record-source-bar {
    position: static;
  }
}
#records-view :deep(.recording-library) {
  padding: 0;
  overflow: hidden;
}

.device-review-workspace {
  height: var(--replay-workspace-height, calc(100dvh - 260px));
  min-height: 0;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: white;
  overflow: hidden;
}
.device-export-list {
  margin: 0;
  font-size: 11px;
}
.device-export-list button {
  display: block;
}
.device-replay-main {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  padding: 0;
}
@media (max-width: 760px) {
  .device-review-workspace {
    grid-template-columns: 1fr;
    grid-template-rows: 210px minmax(0, 1fr);
  }
  .device-replay-resources {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .device-replay-channel-list {
    max-height: 180px;
  }
}

.record-source {
  align-self: flex-start;
  margin-bottom: 1rem;
  width: fit-content;
  max-width: 100%;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: white;
}
.record-source button {
  border: 0;
  border-radius: 5px;
  padding-inline: 20px;
  font-size: 13px;
}
.record-source button.selected {
  font-weight: 600;
}
.resource-heading-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.device-export-list {
  position: relative;
}
.device-export-list summary {
  cursor: pointer;
  list-style: none;
  padding: 4px;
}
.resource-menu {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 5;
  background: white;
  border: 1px solid #dce4ef;
  border-radius: 6px;
  padding: 12px;
  min-width: 230px;
  max-height: 300px;
  overflow: auto;
  box-shadow: 0 6px 18px #16345a20;
}
</style>

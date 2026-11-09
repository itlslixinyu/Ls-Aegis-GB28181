<script setup lang="ts">
import { can } from "../api";
import { rememberFilter } from "../remember-filter";
import AppIcon from "./AppIcon.vue";
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { api, messageOf } from "../api";
import PtzPanel from "./PtzPanel.vue";
import { currentUser } from "../api";
import LivePlayer from "./LivePlayer.vue";
import ChannelThumbnail from "./ChannelThumbnail.vue";
import MonitoringActions from "./MonitoringActions.vue";
import { validThumbnail, type VideoThumbnail } from "../video-thumbnail";
import {
  readThumbnails,
  saveThumbnail,
  clearAccountThumbnails,
} from "../thumbnail-cache";
export interface Channel {
  id: string;
  name: string;
  channelCode: string;
  status: string;
  deviceName: string;
  deviceStatus: string;
}
const props = defineProps<{ initialChannel?: string }>();
const footerTools = ref<HTMLElement>();
function dismissPtz(event: PointerEvent) {
  if (
    ptzExpanded.value &&
    event.target instanceof Element &&
    !event.target.closest(".monitor-ptz-popover, #monitor-ptz-toggle")
  )
    ptzExpanded.value = false;
}
onMounted(() => {
  if (typeof document !== "undefined")
    document.addEventListener("pointerdown", dismissPtz);
});
onUnmounted(() => {
  if (typeof document !== "undefined")
    document.removeEventListener("pointerdown", dismissPtz);
});
const channels = ref<Channel[]>([]),
  query = rememberFilter("monitoring.query", ""),
  message = ref(""),
  loading = ref(false),
  layout = ref(4),
  active = ref(0),
  page = rememberFilter<number>("monitoring.page", 1, (value) => value >= 1),
  total = ref(0);
const maximized = ref<number | null>(null);
const resourcePreference = rememberFilter<number>(
  "monitoring.resources-visible",
  1,
  (value) => value === 0 || value === 1,
);
const ptzPreference = rememberFilter<number>(
  "monitoring.ptz-expanded",
  0,
  (value) => value === 0 || value === 1,
);
const resourcesVisible = computed({
  get: () => resourcePreference.value === 1,
  set: (value: boolean) => (resourcePreference.value = value ? 1 : 0),
});
const ptzExpanded = computed({
  get: () => ptzPreference.value === 1,
  set: (value: boolean) => (ptzPreference.value = value ? 1 : 0),
});
const thumbnailOwner = currentUser.value?.id;
const arrangementKey = `ls-aegis:monitoring-windows:${thumbnailOwner || "anonymous"}`;
let restoringWindows = false,
  restoreGeneration = 0,
  saveWindows = false;
function interruptRestore() {
  restoreGeneration++;
  restoringWindows = false;
  saveWindows = true;
}
function persistWindows() {
  if (
    !saveWindows ||
    restoringWindows ||
    currentUser.value?.id !== thumbnailOwner
  )
    return;
  try {
    sessionStorage.setItem(
      arrangementKey,
      JSON.stringify({
        layout: layout.value,
        active: active.value,
        channels: slots.value.map((c) => c?.id || null),
        wallPage: wallPage.value,
        queue: wallQueue.value.map((c) => c?.id || null),
      }),
    );
  } catch {
    /* Storage is optional; playback must remain available. */
  }
}
async function restoreWindows() {
  if (saveWindows || props.initialChannel) {
    saveWindows = true;
    return;
  }
  let saved: {
    layout: number;
    active: number;
    channels: (string | null)[];
    wallPage?: number;
    queue?: (string | null)[];
  };
  try {
    saved = JSON.parse(sessionStorage.getItem(arrangementKey) || "null");
    if (
      !saved ||
      !layouts.includes(saved.layout) ||
      !Array.isArray(saved.channels)
    )
      return;
  } catch {
    return;
  } finally {
    saveWindows = true;
  }
  const gen = ++restoreGeneration;
  restoringWindows = true;
  const ids = saved.channels.slice(0, saved.layout);
  const restored = Array<Channel | null>(saved.layout).fill(null);
  let next = 0,
    unavailable = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (alive && gen === restoreGeneration) {
        const index = next++;
        if (index >= ids.length) break;
        const id = ids[index];
        if (typeof id !== "string" || !id || id.length > 200) continue;
        try {
          const data = await api<{ items: Channel[] }>(
            `/channels?channelId=${encodeURIComponent(id)}&page=1&pageSize=1`,
          );
          const channel = data.items.find((c) => c.id === id);
          if (
            channel &&
            channel.status === "online" &&
            channel.deviceStatus === "online"
          )
            restored[index] = channel;
          else unavailable++;
        } catch {
          unavailable++;
        }
      }
    }),
  );
  if (
    !alive ||
    gen !== restoreGeneration ||
    currentUser.value?.id !== thumbnailOwner
  )
    return;
  layout.value = saved.layout;
  active.value =
    Number.isInteger(saved.active) &&
    saved.active >= 0 &&
    saved.active < saved.layout
      ? saved.active
      : 0;
  if (
    Array.isArray(saved.queue) &&
    saved.queue.length <= maxWallChannels &&
    saved.queue.every(
      (id) =>
        id === null ||
        (typeof id === "string" && id.length > 0 && id.length <= 200),
    )
  ) {
    wallQueue.value = saved.queue.map((id) =>
      id
        ? {
            id,
            name: "",
            channelCode: "",
            deviceName: "",
            status: "unknown",
            deviceStatus: "unknown",
          }
        : null,
    );
    wallPage.value = Number.isInteger(saved.wallPage)
      ? Math.min(wallPageCount.value, Math.max(1, saved.wallPage!))
      : 1;
    const offset = (wallPage.value - 1) * layout.value;
    for (
      let i = 0;
      i < restored.length && offset + i < wallQueue.value.length;
      i++
    )
      wallQueue.value[offset + i] = restored[i];
  }
  slots.value = restored;
  restoringWindows = false;
  if (unavailable)
    batchNotice.value = `${unavailable} 路通道暂不可用，请检查在线状态或访问权限`;
  persistWindows();
}
const thumbnails = ref<Record<string, VideoThumbnail>>({});
function rememberThumbnail(channelId: string, frame: VideoThumbnail) {
  if (
    !alive ||
    !slots.value.some((c) => c?.id === channelId) ||
    !validThumbnail(frame)
  )
    return;
  thumbnails.value[channelId] = frame;
  if (thumbnailOwner && currentUser.value?.id === thumbnailOwner)
    void saveThumbnail(thumbnailOwner, channelId, frame);
  pruneThumbnails();
}
function pruneThumbnails() {
  const oldest = Object.entries(thumbnails.value).sort(
    (a, b) => a[1].capturedAt - b[1].capturedAt,
  );
  for (const [id] of oldest.slice(0, Math.max(0, oldest.length - 64)))
    delete thumbnails.value[id];
}
async function restoreThumbnails(items: Channel[], gen: number) {
  if (!thumbnailOwner) return;
  const frames = await readThumbnails(
    thumbnailOwner,
    items.map((c) => c.id),
  );
  if (!alive || gen !== generation || currentUser.value?.id !== thumbnailOwner)
    return;
  const allowed = new Set(items.map((c) => c.id));
  for (const [id, frame] of Object.entries(frames)) {
    if (!allowed.has(id) || !validThumbnail(frame)) continue;
    if (
      !thumbnails.value[id] ||
      thumbnails.value[id].capturedAt < frame.capturedAt
    )
      thumbnails.value[id] = frame;
  }
  pruneThumbnails();
}
function thumbnailTitle(channelId: string) {
  const frame = thumbnails.value[channelId];
  return frame
    ? `缩略图采集时间 · ${new Date(frame.capturedAt).toLocaleString("zh-CN", { hour12: false })}`
    : "预览通道后生成真实画面缩略图";
}
function toggleMaximize(index: number) {
  if (wallBusy.value) return;
  if (!Number.isInteger(index) || index < 0 || index >= layout.value) return;
  cancelOpenAll();
  active.value = index;
  maximized.value = maximized.value === index ? null : index;
}
const pageSize = 32;
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize)),
);
const slots = ref<(Channel | null)[]>([null, null, null, null]);
const monitorPlayers = new Map<number, { retire: () => Promise<void> }>();
function registerMonitorPlayer(index: number, instance: unknown) {
  const player = instance as { retire?: () => Promise<void> } | null;
  if (typeof player?.retire === "function")
    monitorPlayers.set(index, player as { retire: () => Promise<void> });
  else monitorPlayers.delete(index);
}
async function retireWallPlayers() {
  await Promise.all(
    [...monitorPlayers.values()].map((player) => player.retire()),
  );
}
const wallRevision = ref(0);
const maxWallChannels = 10000;
const wallQueue = ref<(Channel | null)[]>([]);
const wallPage = ref(1),
  wallBusy = ref(false);
let wallGeneration = 0,
  deferredResourcePage: number | null = null;
const wallPageCount = computed(() =>
  Math.max(1, Math.ceil(wallQueue.value.length / layout.value)),
);
function finishWallPaging() {
  wallBusy.value = false;
  if (deferredResourcePage !== null) {
    const target = deferredResourcePage;
    deferredResourcePage = null;
    void load(target);
  }
}
function cancelWallPaging() {
  wallGeneration++;
  wallBusy.value = false;
  if (deferredResourcePage !== null)
    Promise.resolve().then(() => {
      if (alive && !wallBusy.value && deferredResourcePage !== null) {
        const target = deferredResourcePage;
        deferredResourcePage = null;
        void load(target);
      }
    });
}
function syncWallQueue() {
  if (!wallQueue.value.length) return;
  const next = wallQueue.value.slice(),
    offset = (wallPage.value - 1) * layout.value;
  for (let i = 0; i < slots.value.length; i++)
    if (offset + i < next.length || slots.value[i])
      if (slots.value[i] || next[offset + i]?.status !== "unknown")
        next[offset + i] = slots.value[i];
  while (next.length && !next.at(-1)) next.pop();
  wallQueue.value = next;
}
async function changeWallPage(value: number, force = false) {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > wallPageCount.value ||
    (!force && value === wallPage.value)
  )
    return;
  interruptRestore();
  if (!force) syncWallQueue();
  cancelOpenAll();
  const gen = ++wallGeneration,
    size = layout.value,
    offset = (value - 1) * size;
  const entries = wallQueue.value.slice(offset, offset + size);
  const restored = Array<Channel | null>(size).fill(null);
  let next = 0,
    unavailable = 0,
    networkFailures = 0;
  wallBusy.value = true;
  batchNotice.value = "正在加载监控画面页…";
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (alive && gen === wallGeneration) {
        const index = next++;
        if (index >= entries.length) break;
        const entry = entries[index];
        if (!entry) continue;
        try {
          const data = await api<{ items: Channel[] }>(
            `/channels?channelId=${encodeURIComponent(entry.id)}&page=1&pageSize=1`,
          );
          if (!alive || gen !== wallGeneration) return;
          const channel = data.items.find((c) => c.id === entry.id);
          if (channel?.status === "online" && channel.deviceStatus === "online")
            restored[index] = channel;
          else unavailable++;
        } catch {
          unavailable++;
          networkFailures++;
        }
      }
    }),
  );
  if (!alive || gen !== wallGeneration) return;
  if (
    networkFailures > 0 &&
    networkFailures === entries.filter(Boolean).length
  ) {
    finishWallPaging();
    batchNotice.value = "监控画面页加载失败，原预览已保留，请重试";
    return;
  }
  await retireWallPlayers();
  if (!alive || gen !== wallGeneration) return;
  for (let i = 0; i < entries.length; i++)
    wallQueue.value[offset + i] =
      restored[i] ||
      (entries[i]
        ? { ...entries[i]!, status: "unknown", deviceStatus: "unknown" }
        : null);
  wallRevision.value++;
  wallPage.value = value;
  active.value = 0;
  maximized.value = null;
  ptzExpanded.value = false;
  slots.value = restored;
  finishWallPaging();
  batchNotice.value = unavailable
    ? `本页 ${unavailable} 路通道已离线或无权访问`
    : "";
  persistWindows();
}
const layouts = [1, 4, 9, 16, 25, 36];
const wallColumns = computed(() => Math.sqrt(layout.value));
const wallRows = computed(() => Math.sqrt(layout.value));
const openingAll = ref(false),
  batchNotice = ref("");
let batchGeneration = 0;
function cancelOpenAll() {
  cancelWallPaging();
  if (openingAll.value) batchNotice.value = "";
  batchGeneration++;
  openingAll.value = false;
}
function closeAll() {
  interruptRestore();
  cancelOpenAll();
  initialApplied = true;
  wallQueue.value = [];
  wallPage.value = 1;
  slots.value = slots.value.map(() => null);
  maximized.value = null;
  active.value = 0;
  batchNotice.value = "已关闭全部预览";
}
function closeSlot(index: number) {
  if (wallBusy.value) return;
  interruptRestore();
  cancelOpenAll();
  initialApplied = true;
  batchNotice.value = "";
  slots.value[index] = null;
  syncWallQueue();
  if (wallPage.value > wallPageCount.value)
    void changeWallPage(wallPageCount.value, true);
  persistWindows();
  if (maximized.value === index) maximized.value = null;
}
async function openAll() {
  if (wallBusy.value) return;
  interruptRestore();
  if (openingAll.value) return;
  cancelWallPaging();
  syncWallQueue();
  const gen = ++batchGeneration;
  const search = query.value.trim();
  const existing = (
    wallQueue.value.length ? wallQueue.value : slots.value
  ).filter((c): c is Channel => !!c);
  const seen = new Set(existing.map((c) => c.id));
  const additions: Channel[] = [];
  const available = maxWallChannels - existing.length;
  openingAll.value = true;
  batchNotice.value = "正在检索授权在线通道…";
  let limited = false;
  try {
    for (let nextPage = 1; ; nextPage++) {
      const data = await api<{ items: Channel[]; total: number }>(
        `/channels?page=${nextPage}&pageSize=100&q=${encodeURIComponent(search)}`,
      );
      if (!alive || gen !== batchGeneration) return;
      for (const channel of data.items) {
        if (
          channel.status !== "online" ||
          channel.deviceStatus !== "online" ||
          seen.has(channel.id)
        )
          continue;
        if (additions.length === available) {
          limited = true;
          break;
        }
        seen.add(channel.id);
        additions.push(channel);
      }
      if (limited || nextPage * 100 >= data.total || !data.items.length) break;
    }
    if (!additions.length && !existing.length) {
      batchNotice.value = search
        ? "当前搜索结果中没有可预览的在线通道"
        : "没有可预览的在线通道，请检查设备注册与通道状态";
      return;
    }
    const count = existing.length + additions.length;
    const nextLayout = layout.value;
    const queue = (
      wallQueue.value.length ? wallQueue.value : slots.value
    ).slice();
    for (const channel of additions) {
      const free = queue.indexOf(null);
      if (free >= 0) queue[free] = channel;
      else queue.push(channel);
    }
    while (queue.length && !queue.at(-1)) queue.pop();
    wallQueue.value = queue;
    wallPage.value = 1;
    slots.value = Array.from(
      { length: nextLayout },
      (_, i) => queue[i] || null,
    );
    active.value = 0;
    maximized.value = null;
    batchNotice.value = `已安排 ${count} 路预览；每页 ${nextLayout} 画面${queue.length > nextLayout ? `，共 ${Math.ceil(queue.length / nextLayout)} 页` : ""}${limited ? "；已达10000路列表上限，请缩小搜索范围" : ""}`;
    if (queue.slice(0, nextLayout).some((c) => c?.status === "unknown"))
      void changeWallPage(1, true);
    persistWindows();
  } catch (error) {
    if (alive && gen === batchGeneration)
      batchNotice.value = `批量打开失败：${messageOf(error)}，原预览已保留`;
  } finally {
    if (alive && gen === batchGeneration) openingAll.value = false;
  }
}
let alive = true,
  generation = 0,
  initialApplied = false,
  searchTimer: ReturnType<typeof setTimeout> | undefined;
onUnmounted(() => {
  cancelOpenAll();
  thumbnails.value = {};
  if (thumbnailOwner && currentUser.value?.id !== thumbnailOwner)
    void clearAccountThumbnails(thumbnailOwner);
  alive = false;
  generation++;
  clearTimeout(searchTimer);
});
async function load(targetPage = page.value) {
  if (wallBusy.value) {
    deferredResourcePage = targetPage;
    return;
  }
  cancelOpenAll();
  batchNotice.value = "";
  const gen = ++generation;
  loading.value = true;
  message.value = "";
  channels.value = [];
  try {
    const [data, initial] = await Promise.all([
      api<{ items: Channel[]; total: number }>(
        `/channels?page=${targetPage}&pageSize=${pageSize}&q=${encodeURIComponent(query.value.trim())}`,
      ),
      !initialApplied && props.initialChannel
        ? api<{ items: Channel[] }>(
            `/channels?channelId=${encodeURIComponent(props.initialChannel)}&page=1&pageSize=1`,
          )
        : Promise.resolve(null),
    ]);
    if (!alive || gen !== generation) return;
    const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
    if (targetPage > lastPage) return load(lastPage);
    channels.value = data.items;
    void restoreThumbnails(data.items, gen);
    page.value = targetPage;
    total.value = data.total;
    slots.value = slots.value.map((c) => {
      if (!c) return null;
      const next = data.items.find((item) => item.id === c.id);
      return next
        ? next.status === "online" && next.deviceStatus === "online"
          ? next
          : null
        : c;
    });
    syncWallQueue();
    if (maximized.value !== null && !slots.value[maximized.value])
      maximized.value = null;
    if (!initialApplied && props.initialChannel) {
      const channel = initial?.items[0];
      if (channel?.status === "online" && channel.deviceStatus === "online")
        slots.value[0] = channel;
    }
    initialApplied = true;
  } catch (e) {
    if (alive && gen === generation) message.value = messageOf(e);
  } finally {
    if (alive && gen === generation) loading.value = false;
  }
}
function changePage(value: number) {
  if (!loading.value && value >= 1 && value <= pageCount.value)
    void load(value);
}
watch(query, () => {
  if (wallBusy.value) {
    deferredResourcePage = 1;
    return;
  }
  cancelOpenAll();
  batchNotice.value = "";
  generation++;
  channels.value = [];
  loading.value = true;
  message.value = "";
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void load(1);
  }, 250);
});
const dropTarget = ref<number | null>(null);
function dragChannel(event: DragEvent, channel: Channel) {
  if (
    wallBusy.value ||
    channel.status !== "online" ||
    channel.deviceStatus !== "online"
  ) {
    event.preventDefault();
    return;
  }
  event.dataTransfer?.setData("application/x-ls-aegis-channel", channel.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
function dragOverSlot(event: DragEvent, index: number) {
  if (
    wallBusy.value ||
    !event.dataTransfer?.types.includes("application/x-ls-aegis-channel")
  )
    return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dropTarget.value = index;
}
async function dropOnSlot(event: DragEvent, index: number) {
  event.preventDefault();
  dropTarget.value = null;
  const id = event.dataTransfer?.getData("application/x-ls-aegis-channel");
  if (
    wallBusy.value ||
    !id ||
    id.length > 200 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= layout.value
  )
    return;
  const gen = wallGeneration;
  try {
    let channel = channels.value.find((c) => c.id === id);
    if (!channel)
      channel = (
        await api<{ items: Channel[] }>(
          `/channels?channelId=${encodeURIComponent(id)}&page=1&pageSize=1`,
        )
      ).items.find((c) => c.id === id);
    if (!alive || gen !== wallGeneration || wallBusy.value) return;
    if (channel?.status !== "online" || channel.deviceStatus !== "online") {
      batchNotice.value = "该通道已离线或无权访问，请刷新资源列表";
      return;
    }
    active.value = index;
    choose(channel);
  } catch (error) {
    if (alive && gen === wallGeneration)
      batchNotice.value = `通道拖入失败：${messageOf(error)}`;
  }
}
function choose(c: Channel) {
  if (wallBusy.value) return;
  interruptRestore();
  if (c.status !== "online" || c.deviceStatus !== "online") return;
  cancelOpenAll();
  initialApplied = true;
  batchNotice.value = "";
  if (active.value < 0 || active.value >= layout.value) active.value = 0;
  slots.value[active.value] = c;
  syncWallQueue();
  persistWindows();
}
async function changeLayout(value: number) {
  if (wallBusy.value) return;
  interruptRestore();
  if (!layouts.includes(value) || value === layout.value) return;
  cancelOpenAll();
  batchNotice.value = "";
  maximized.value = null;
  const selected = slots.value[active.value] || null;
  if (wallQueue.value.length) {
    syncWallQueue();
    const selectedIndex = (wallPage.value - 1) * layout.value + active.value;
    const gen = ++wallGeneration;
    wallBusy.value = true;
    await retireWallPlayers();
    if (!alive || gen !== wallGeneration) return;
    wallRevision.value++;
    layout.value = value;
    wallPage.value = Math.min(
      wallPageCount.value,
      Math.floor(selectedIndex / value) + 1,
    );
    const entries = wallQueue.value.slice(
      (wallPage.value - 1) * value,
      wallPage.value * value,
    );
    slots.value = Array.from({ length: value }, (_, i) =>
      entries[i]?.status === "online" && entries[i]?.deviceStatus === "online"
        ? entries[i]
        : null,
    );
    active.value = Math.min(value - 1, selectedIndex % value);
    finishWallPaging();
    if (entries.some((c) => c?.status === "unknown"))
      void changeWallPage(wallPage.value, true);
    persistWindows();
    return;
  }
  slots.value =
    value === 1
      ? [selected]
      : Array.from({ length: value }, (_, i) => slots.value[i] || null);
  if (active.value >= value && selected) slots.value[0] = selected;
  layout.value = value;
  if (active.value >= value) active.value = 0;
}
watch([slots, layout, active], persistWindows, { deep: true, flush: "sync" });
onMounted(async () => {
  await load();
  if (alive) await restoreWindows();
});
</script>
<template>
  <section
    class="business-page"
    id="monitoring-view"
    @keydown.esc="maximized = null"
  >
    <div class="title">
      <button
        v-if="!resourcesVisible"
        class="secondary monitor-restore-button"
        aria-label="展开通道栏"
        @click="resourcesVisible = true"
      >
        <AppIcon name="fold" :size="16" />通道资源
      </button>
      <div>
        <h1>实时监控</h1>
      </div>
      <div class="monitor-page-tools">
        <span class="monitor-selection"
          >已选 <strong>{{ slots.filter(Boolean).length }}</strong> 路</span
        >
      </div>
    </div>
    <div
      class="monitor-workspace"
      :class="{ 'resources-hidden': !resourcesVisible }"
    >
      <div v-show="resourcesVisible" class="monitor-side">
        <div class="channel-panel">
          <div class="panel-heading">
            <h3>通道资源</h3>
            <span class="channel-header-summary"
              >共 {{ total }} 路 · 每页 {{ pageSize }} 路</span
            >
            <div class="channel-header-actions">
              <button
                type="button"
                class="monitor-resource-refresh"
                aria-label="刷新通道资源"
                title="刷新通道资源"
                :disabled="loading || wallBusy"
                @click="load()"
              >
                <AppIcon name="refresh" :size="15" />
              </button>
              <button
                class="monitor-resource-collapse"
                aria-label="收起通道栏"
                title="收起通道栏"
                @click="resourcesVisible = false"
              >
                <AppIcon name="fold" :size="16" />
              </button>
            </div>
          </div>
          <div class="channel-search">
            <AppIcon name="search" :size="15" />
            <input
              v-model="query"
              placeholder="搜索通道名称 / 编号"
              aria-label="搜索通道"
              :disabled="wallBusy"
            />
          </div>
          <p v-if="message" class="inline-message" role="alert">
            {{ message }}
          </p>
          <div v-if="loading" class="empty-state">正在加载通道…</div>
          <div v-else-if="!channels.length" class="empty-state">
            <span class="empty-symbol"
              ><AppIcon name="devices" :size="32" /></span
            ><b>{{
              message
                ? "通道列表加载失败"
                : query
                  ? "未找到匹配通道"
                  : "暂无视频通道"
            }}</b>
            <p>
              {{ message ? "请点击刷新重试。" : "请在设备上线后同步目录。" }}
            </p>
          </div>
          <ul v-else class="channel-list">
            <li v-for="c in channels" :key="c.id">
              <button
                :disabled="
                  wallBusy ||
                  c.status !== 'online' ||
                  c.deviceStatus !== 'online'
                "
                :draggable="
                  !wallBusy &&
                  c.status === 'online' &&
                  c.deviceStatus === 'online'
                "
                @dragstart="dragChannel($event, c)"
                :class="{ 'is-selected': slots[active]?.id === c.id }"
                @click="choose(c)"
              >
                <ChannelThumbnail
                  :frame="thumbnails[c.id]"
                  :title="thumbnailTitle(c.id)"
                />
                <span class="channel-info">
                  <b :title="c.name">{{ c.name }}</b>
                  <small :title="c.deviceName">{{ c.deviceName }}</small>
                  <span class="channel-code-status">
                    <small class="mono" :title="c.channelCode">{{
                      c.channelCode
                    }}</small>
                    <span
                      class="channel-status"
                      :class="{
                        online:
                          c.status === 'online' && c.deviceStatus === 'online',
                      }"
                      >{{
                        c.status === "online" && c.deviceStatus === "online"
                          ? "在线"
                          : "离线"
                      }}</span
                    >
                  </span>
                </span>
              </button>
            </li>
          </ul>
          <div class="channel-count">
            <nav class="channel-pagination" aria-label="通道分页">
              <button
                class="secondary"
                :disabled="loading || wallBusy || page <= 1"
                @click="changePage(page - 1)"
              >
                上一页
              </button>
              <span>第 {{ page }} / {{ pageCount }} 页</span>
              <button
                class="secondary"
                :disabled="loading || wallBusy || page >= pageCount"
                @click="changePage(page + 1)"
              >
                下一页
              </button>
            </nav>
          </div>
        </div>
      </div>
      <div class="monitor-stage">
        <p v-if="batchNotice" class="monitor-batch-notice" role="status">
          {{ batchNotice }}
        </p>
        <div
          class="video-wall-scroll"
          tabindex="0"
          role="region"
          aria-label="监控画面，空间不足时可滚动"
        >
          <div
            class="video-wall"
            :class="{
              single: layout === 1 || maximized !== null,
              dense: layout >= 16 && maximized === null,
              'is-maximized': maximized !== null,
            }"
            :style="{
              '--wall-columns': maximized === null ? wallColumns : 1,
              '--wall-rows': maximized === null ? wallRows : 1,
            }"
          >
            <div
              v-for="index in layout"
              :key="index"
              class="video-tile"
              role="group"
              tabindex="0"
              :aria-label="`监控窗口 ${index}`"
              @focus="active = index - 1"
              @keydown.enter="active = index - 1"
              @keydown.space.prevent="active = index - 1"
              :class="{
                active: active === index - 1,
                'tile-hidden': maximized !== null && maximized !== index - 1,
                'is-drop-target': dropTarget === index - 1,
              }"
              @click="active = index - 1"
              @dblclick="toggleMaximize(index - 1)"
              @dragover="dragOverSlot($event, index - 1)"
              @dragleave="dropTarget = null"
              @drop="dropOnSlot($event, index - 1)"
            >
              <LivePlayer
                v-if="slots[index - 1]"
                :ref="(instance) => registerMonitorPlayer(index - 1, instance)"
                :key="
                  slots[index - 1]!.id +
                  ':' +
                  wallRevision +
                  ':' +
                  ((wallPage - 1) * layout + index - 1)
                "
                :channel="slots[index - 1]!"
                :resume-key="
                  arrangementKey + ':' + ((wallPage - 1) * layout + index - 1)
                "
                bottom-controls
                :can-maximize="layout > 1"
                :maximized="maximized === index - 1"
                @toggle-maximize="toggleMaximize(index - 1)"
                @close="closeSlot(index - 1)"
                @thumbnail="rememberThumbnail(slots[index - 1]!.id, $event)"
              />
              <div v-else class="video-placeholder">
                <span class="camera-symbol"
                  ><AppIcon name="devices" :size="38" /></span
                ><b>监控窗口 {{ String(index).padStart(2, "0") }}</b>
                <p>选择左侧在线通道开始预览</p>
              </div>
            </div>
          </div>
        </div>
        <div class="monitor-stage-foot">
          <span
            >当前窗口 {{ String(active + 1).padStart(2, "0") }} ·
            {{ slots[active]?.name || "未选择通道" }}</span
          >
          <nav class="monitor-wall-pagination" aria-label="监控画面分页">
            <button
              type="button"
              class="link"
              :disabled="wallBusy || wallPage <= 1"
              @click="changeWallPage(wallPage - 1)"
            >
              上一页
            </button>
            <span>第 {{ wallPage }} / {{ wallPageCount }} 页</span>
            <button
              type="button"
              class="link"
              :disabled="wallBusy || wallPage >= wallPageCount"
              @click="changeWallPage(wallPage + 1)"
            >
              下一页
            </button>
          </nav>
          <div
            ref="footerTools"
            class="monitor-footer-tools"
            @keydown.esc="ptzExpanded = false"
          >
            <section
              v-if="ptzExpanded && can('ptz.control')"
              id="monitor-ptz-controls"
              class="monitor-ptz-popover"
              role="region"
              aria-labelledby="monitor-ptz-toggle"
              @keydown.esc.stop="ptzExpanded = false"
            >
              <PtzPanel :channel="slots[active] || null" />
              <button
                type="button"
                class="link ptz-popover-close"
                aria-label="关闭云台面板"
                title="关闭云台面板"
                @click="ptzExpanded = false"
              >
                <AppIcon name="close" :size="14" />
              </button>
            </section>
            <MonitoringActions
              :layout="layout"
              :layouts="layouts"
              :opening-all="openingAll"
              :loading="loading || wallBusy"
              :has-slots="slots.some(Boolean)"
              :can-ptz="can('ptz.control')"
              :ptz-expanded="ptzExpanded"
              @ptz="ptzExpanded = !ptzExpanded"
              @layout="changeLayout"
              @open="openAll"
              @close="closeAll"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

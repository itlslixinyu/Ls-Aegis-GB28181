<script setup lang="ts">
import { can } from "../api";
import DialogHeading from "./DialogHeading.vue";
import AppIcon from "./AppIcon.vue";
import ArchiveDayPlayer from "./ArchiveDayPlayer.vue";
import PlaybackWall from "./PlaybackWall.vue";
import PlaybackResources from "./PlaybackResources.vue";
import RecordingTaskGroups from "./RecordingTaskGroups.vue";
import { matchesChannelSearch } from "../channel-search";
import type { PlaybackRange } from "../playback-clock";
import {
  recordSearchRange,
  defaultRecordRange,
  type RecordSearchRange,
} from "../record-range";
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { api, messageOf, currentUser } from "../api";
import type { Channel } from "./Monitoring.vue";
import { rememberFilter } from "../remember-filter";
const props = defineProps<{ section: "jobs" | "plans" | "library" }>();
interface FileItem {
  id: string;
  jobId?: string;
  name: string;
  date: string;
}
interface Job {
  id: string;
  kind: string;
  status: string;
  channelId: string;
  channelName?: string | null;
  planName?: string;
  createdAt: string;
  finishedAt?: string | null;
  error?: string;
  executionDate?: string;
  dailyKey?: string;
  attempts?: {
    id: string;
    status: string;
    createdAt: string;
    finishedAt?: string;
    error?: string;
  }[];
  files: FileItem[];
}
interface Plan {
  id: string;
  name: string;
  channelId: string;
  channelName?: string;
  deviceName?: string;
  days: number[];
  startTime: string;
  endTime: string;
  enabled: number;
  retentionDays: number;
  segmentSeconds: number;
  deviceGroupId: string | null;
  groupName: string;
  channelIds: string[];
  channelCount: number;
  version: number;
  legacy: boolean;
}
interface PlanChannel extends Channel {
  groupId: string;
}
const deviceGroups = ref<{ id: string; name: string }[]>([]);
const channelSearch = ref("");
const resourcesReady = ref(false);
const groupChannels = computed(() =>
  channels.value.filter((c) => c.groupId === form.value.deviceGroupId),
);
const matchingGroupChannels = computed(() =>
  groupChannels.value.filter((c) =>
    matchesChannelSearch(channelSearch.value, [
      c.name,
      c.channelCode,
      c.deviceName,
    ]),
  ),
);
const groupDialog = ref<HTMLDialogElement>();
const groupSelection = ref<Plan | null>(null);
const groupMembers = ref<(Plan & { latest: Job | null })[]>([]);
const groupError = ref("");
const groupLoading = ref(false);
let groupGeneration = 0;
async function showGroup(plan: Plan) {
  groupSelection.value = plan;
  groupDialog.value?.showModal();
  await loadGroup();
}
async function loadGroup() {
  if (!groupSelection.value) return;
  const gen = ++groupGeneration;
  groupLoading.value = true;
  groupError.value = "";
  try {
    const result = await api<{ items: (Plan & { latest: Job | null })[] }>(
      `/recording-plan-groups/${groupSelection.value.id}/channels`,
    );
    if (alive && gen === groupGeneration) groupMembers.value = result.items;
  } catch (e) {
    if (alive && gen === groupGeneration) {
      groupMembers.value = [];
      groupError.value = messageOf(e);
    }
  } finally {
    if (gen === groupGeneration) groupLoading.value = false;
  }
}
function changeGroup() {
  form.value.channelIds = [];
  channelSearch.value = "";
}
function selectVisibleChannels() {
  form.value.channelIds = [
    ...new Set([
      ...form.value.channelIds,
      ...matchingGroupChannels.value.map((c) => c.id),
    ]),
  ];
}
const detailDialog = ref<HTMLDialogElement>();
const detailSelection = ref<{ key: string; kind: "attempts" | "files" } | null>(
  null,
);
const detailJob = computed(
  () =>
    jobs.value.find(
      (job) => (job.dailyKey || job.id) === detailSelection.value?.key,
    ) ||
    groupMembers.value
      .map((c) => c.latest)
      .find(
        (job) => job && (job.dailyKey || job.id) === detailSelection.value?.key,
      ),
);
function showDetails(job: Job, kind: "attempts" | "files") {
  detailSelection.value = { key: job.dailyKey || job.id, kind };
  detailDialog.value?.showModal();
}
const jobs = ref<Job[]>([]),
  plans = ref<Plan[]>([]),
  channels = ref<PlanChannel[]>([]),
  message = ref(""),
  loadError = ref(""),
  busy = ref(false),
  loading = ref(true),
  editor = ref<HTMLDialogElement>(),
  confirmation = ref<HTMLDialogElement>(),
  playback = ref<HTMLDialogElement>(),
  playingFile = ref<{ name: string; url: string } | null>(null),
  playbackError = ref(false),
  selected = ref<Plan | null>(null),
  pending = ref<{ kind: "job" | "plan"; id: string } | null>(null);
function fileUrl(job: Job, file: FileItem) {
  return `/api/v1/recording-jobs/${file.jobId || job.id}/files/${file.id}`;
}
function playFile(job: Job, file: FileItem) {
  playbackError.value = false;
  playingFile.value = { name: file.name, url: fileUrl(job, file) + "?play=1" };
  playback.value?.showModal();
}
function executionSteps(job: Job) {
  return job.attempts?.length
    ? job.attempts
    : [
        {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
          error: job.error,
        },
      ];
}
const libraryChannel = rememberFilter<string>("records.platform.channel", ""),
  libraryDate = rememberFilter<string>("records.platform.date", ""),
  libraryPage = rememberFilter<number>(
    "records.platform.page",
    1,
    (page) => page >= 1,
  );
const showDeleted = rememberFilter<number>(
  "records.include-deleted",
  0,
  (value) => value === 0 || value === 1,
);
const visibleJobs = computed(() =>
  jobs.value.filter(
    (job) => showDeleted.value === 1 || job.channelName !== null,
  ),
);
function channelLabel(job: Job) {
  if (job.channelName) return job.channelName;
  const code = job.channelId.split(":").at(-1) || "";
  return /^\d{20}$/.test(code) ? `通道已删除 · ${code}` : "通道已删除";
}
const libraryChannels = computed(() => [
  ...new Map(
    visibleJobs.value
      .filter((j) => j.files.length)
      .map((j) => [j.channelId, channelLabel(j)]),
  ).entries(),
]);
const resourceSearch = rememberFilter<string>("records.platform.search", "");
const filteredLibraryChannels = computed(() =>
  libraryChannels.value.filter(([id, name]) =>
    matchesChannelSearch(resourceSearch.value, [name, id]),
  ),
);
const libraryFiles = computed(() =>
  visibleJobs.value
    .filter(
      (job) => !libraryChannel.value || job.channelId === libraryChannel.value,
    )
    .flatMap((job) =>
      job.files
        .filter(
          (file) =>
            !libraryDate.value ||
            (appliedArchiveRange.value
              ? file.date >= appliedArchiveRange.value.date &&
                file.date <=
                  new Date(
                    Date.parse(appliedArchiveRange.value.end) - 1,
                  ).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
              : file.date === libraryDate.value),
        )
        .map((file) => ({ job, file })),
    )
    .sort(
      (a, b) =>
        b.file.date.localeCompare(a.file.date) ||
        b.file.name.localeCompare(a.file.name, undefined, { numeric: true }),
    ),
);
const libraryPages = computed(() =>
  Math.max(1, Math.ceil(libraryFiles.value.length / 20)),
);
const initialSearch = defaultRecordRange(libraryDate.value || undefined);
const archiveStartInput = rememberFilter<string>(
  "records.platform.start",
  initialSearch.start,
);
const archiveEndInput = rememberFilter<string>(
  "records.platform.end",
  initialSearch.end,
);
const appliedArchiveRange = ref<RecordSearchRange | null>(null);
const archiveSearching = ref(false);
const queriedArchiveChannels = new Set<string>();
let archiveSearchGeneration = 0;
watch(
  [archiveStartInput, archiveEndInput, libraryChannel],
  () => {
    archiveSearchGeneration++;
    archiveSearching.value = false;
    message.value = "";
  },
  { flush: "sync" },
);
function archiveCacheMatches(id: string) {
  try {
    return (
      appliedArchiveRange.value?.key ===
        recordSearchRange(archiveStartInput.value, archiveEndInput.value).key &&
      queriedArchiveChannels.has(id)
    );
  } catch {
    return false;
  }
}
async function searchArchive(
  destination?: number,
  channel = libraryChannel.value,
) {
  if (!channel || archiveSearching.value) {
    if (!channel) message.value = "请先选择通道";
    return;
  }
  let range: RecordSearchRange;
  try {
    range = recordSearchRange(archiveStartInput.value, archiveEndInput.value);
  } catch (error) {
    message.value = messageOf(error);
    return;
  }
  const gen = ++archiveSearchGeneration;
  archiveSearching.value = true;
  message.value = "";
  try {
    await load();
    if (!alive || gen !== archiveSearchGeneration) return;
    if (loadError.value) throw Error(loadError.value);
    if (!libraryChannels.value.some(([id]) => id === channel))
      throw Error("该通道没有可查询的归档录像或已无访问权限");
    if (appliedArchiveRange.value?.key !== range.key) {
      archiveWindows.value = [];
      archiveRanges.value = {};
      archivePending.value = {};
      queriedArchiveChannels.clear();
    }
    appliedArchiveRange.value = range;
    libraryDate.value = range.date;
    libraryChannel.value = channel;
    queriedArchiveChannels.add(channel);
    addPlaybackChannel(destination);
  } catch (error) {
    if (alive && gen === archiveSearchGeneration)
      message.value = messageOf(error);
  } finally {
    if (alive && gen === archiveSearchGeneration)
      archiveSearching.value = false;
  }
}
const archiveWindows = ref<{ id: string; channelId: string; slot: number }[]>(
  [],
);
const playbackChannels = computed(() => [
  ...new Set(archiveWindows.value.map((window) => window.channelId)),
]);
function dragArchiveChannel(event: DragEvent, id: string) {
  event.dataTransfer?.setData("application/x-ls-aegis-channel", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
async function dropArchiveChannel(drop: { channelId: string; slot: number }) {
  if (!libraryChannels.value.some(([id]) => id === drop.channelId)) return;
  libraryChannel.value = drop.channelId;
  if (archiveCacheMatches(drop.channelId)) addPlaybackChannel(drop.slot);
  else await searchArchive(drop.slot, drop.channelId);
}
function closeArchiveWindow(id: string) {
  archiveWindows.value = archiveWindows.value.filter(
    (window) => window.id !== id,
  );
  delete archiveRanges.value[id];
  delete archivePending.value[id];
}

const archiveRanges = ref<Record<string, PlaybackRange[]>>({});
const archivePending = ref<Record<string, boolean>>({});
watch(libraryDate, () => {
  archiveRanges.value = {};
  archivePending.value = {};
});
function selectArchiveChannel(id: string) {
  libraryChannel.value = id;
  message.value = "";
}
const playbackItems = computed(() =>
  archiveWindows.value
    .filter((window) =>
      libraryChannels.value.some(([id]) => id === window.channelId),
    )
    .map((window) => ({
      ...window,
      name:
        libraryChannels.value.find(([id]) => id === window.channelId)?.[1] ||
        window.channelId,
    })),
);
function addPlaybackChannel(destination?: number) {
  if (
    !libraryChannel.value ||
    !libraryDate.value ||
    (destination === undefined &&
      playbackChannels.value.includes(libraryChannel.value))
  )
    return;
  const occupied = new Set(archiveWindows.value.map((window) => window.slot));
  const slot =
    destination ??
    Array.from({ length: 9 }, (_, index) => index).find(
      (index) => !occupied.has(index),
    );
  if (slot === undefined || !Number.isInteger(slot) || slot < 0 || slot >= 9) {
    message.value = "最多同时回放9路，请先关闭一个窗口";
    return;
  }
  archiveWindows.value = archiveWindows.value.filter(
    (window) => window.slot !== slot,
  );
  archiveWindows.value.push({
    id: crypto.randomUUID(),
    channelId: libraryChannel.value,
    slot,
  });
}
const dayFiles = computed(() => filesForDay(libraryChannel.value));
function filesForDay(channelId: string) {
  const previous = libraryDate.value
    ? new Date(
        Date.parse(libraryDate.value + "T00:00:00+08:00") - 86400000,
      ).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    : "";
  const lastDate = appliedArchiveRange.value
    ? new Date(
        Date.parse(appliedArchiveRange.value.end) - 1,
      ).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    : libraryDate.value;
  return visibleJobs.value
    .filter((job) => job.kind === "scheduled" && job.channelId === channelId)
    .flatMap((job) =>
      job.files
        .filter(
          (file) =>
            (file.date >= libraryDate.value && file.date <= lastDate) ||
            file.date === previous,
        )
        .map((file) => ({
          id: file.id,
          name: file.name,
          date: file.date,
          url: fileUrl(job, file) + "?play=1",
        })),
    )
    .sort(
      (a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name),
    );
}
watch([libraryChannel, libraryDate], () => {
  libraryPage.value = 1;
});
watch(showDeleted, () => {
  libraryPage.value = 1;
  if (
    libraryChannel.value &&
    !libraryChannels.value.some(([id]) => id === libraryChannel.value)
  )
    libraryChannel.value = libraryChannels.value[0]?.[0] || "";
});
const blank = () => ({
  name: "",
  deviceGroupId: "",
  channelIds: [] as string[],
  version: 0,
  days: [1, 2, 3, 4, 5],
  startTime: "00:00",
  endTime: "00:00",
  enabled: false,
  retentionDays: 7,
  segmentSeconds: 900,
});
const allDay = ref(true);
const segmentMinutes = [1, 3, 5, 10, 15, 20];
const form = ref(blank()),
  labels: Record<string, string> = {
    starting: "准备中",
    recording: "录制中",
    finalizing: "生成文件",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const activeCount = computed(
  () =>
    visibleJobs.value.filter((j) =>
      ["starting", "recording", "finalizing"].includes(j.status),
    ).length,
);
const archivedFileCount = computed(() =>
  visibleJobs.value.reduce((total, job) => total + job.files.length, 0),
);
let alive = true,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const gen = ++generation;
  try {
    const [jobResult, planResult] = await Promise.all([
      props.section === "jobs" || props.section === "library"
        ? Promise.all([
            api<{ items: Job[] }>("/recording-jobs?kind=scheduled&daily=1"),
            api<{ items: Job[] }>("/recording-jobs?kind=download"),
          ]).then(([scheduled, downloads]) => ({
            items: [...scheduled.items, ...downloads.items].sort(
              (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
            ),
          }))
        : Promise.resolve({ items: [] as Job[] }),
      props.section === "plans"
        ? api<{ items: Plan[] }>("/recording-plan-groups")
        : Promise.resolve(null),
    ]);
    if (!alive || gen !== generation) return;
    jobs.value = jobResult.items;
    if (props.section === "library") {
      if (
        libraryChannel.value &&
        !libraryChannels.value.some(([id]) => id === libraryChannel.value)
      )
        libraryChannel.value = "";
      if (!libraryChannel.value)
        libraryChannel.value = libraryChannels.value[0]?.[0] || "";
      if (!libraryDate.value)
        libraryDate.value = libraryFiles.value[0]?.file.date || "";
      libraryPage.value = Math.min(libraryPage.value, libraryPages.value);
    }
    if (planResult) plans.value = planResult.items;
    if (groupDialog.value?.open) await loadGroup();
    loadError.value = "";
  } catch (e) {
    if (alive && gen === generation) loadError.value = messageOf(e);
  } finally {
    if (alive && gen === generation) loading.value = false;
  }
}
async function poll() {
  await load();
  if (alive) timer = setTimeout(poll, 3000);
}
onMounted(async () => {
  if (props.section === "jobs") return;
  await poll();
  if (!alive || props.section !== "plans") return;
  try {
    deviceGroups.value = (
      await api<{ items: { id: string; name: string }[] }>("/groups")
    ).items;
    const all: PlanChannel[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await api<{ items: PlanChannel[]; total: number }>(
        `/channels?page=${page}&pageSize=100`,
      );
      if (!alive) return;
      all.push(...result.items);
      if (all.length >= result.total || !result.items.length) break;
      if (page === 100) throw Error("可选通道超过10000路，请先缩小设备范围");
    }
    channels.value = all;
    resourcesReady.value = true;
  } catch (e) {
    message.value = messageOf(e);
  }
});
onUnmounted(() => {
  alive = false;
  generation++;
  archiveSearchGeneration++;
  groupGeneration++;
  clearTimeout(timer);
});
function edit(plan: Plan | null = null) {
  selected.value = plan;
  form.value = plan
    ? {
        name: plan.name,
        deviceGroupId: plan.deviceGroupId || "",
        channelIds: [...plan.channelIds],
        version: plan.version,
        days: [...plan.days],
        startTime: plan.startTime,
        endTime: plan.endTime,
        enabled: !!plan.enabled,
        retentionDays: plan.retentionDays,
        segmentSeconds: plan.segmentSeconds,
      }
    : blank();
  channelSearch.value = "";
  saveRequestKey = crypto.randomUUID();
  allDay.value =
    form.value.startTime === "00:00" && form.value.endTime === "00:00";
  message.value = "";
  editor.value?.showModal();
}
let saveRequestKey = "";
async function save() {
  if (busy.value) return;
  if (!form.value.deviceGroupId || !form.value.channelIds.length) {
    message.value = "请选择分组并勾选至少一个通道";
    return;
  }
  busy.value = true;
  message.value = "";
  try {
    await api(
      "/recording-plan-groups" +
        (selected.value ? "/" + selected.value.id : ""),
      selected.value ? "PUT" : "POST",
      {
        ...form.value,
        ...(allDay.value ? { startTime: "00:00", endTime: "00:00" } : {}),
      },
      selected.value
        ? {}
        : {
            "Idempotency-Key":
              saveRequestKey || (saveRequestKey = crypto.randomUUID()),
          },
    );
    editor.value?.close();
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function toggle(p: Plan) {
  busy.value = true;
  message.value = "";
  try {
    await api(`/recording-plan-groups/${p.id}/enabled`, "PUT", {
      enabled: !p.enabled,
      version: p.version,
    });
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
function confirm(kind: "job" | "plan", id: string) {
  message.value = "";
  pending.value = { kind, id };
  confirmation.value?.showModal();
}
async function remove() {
  if (!pending.value) return;
  busy.value = true;
  message.value = "";
  try {
    const p = pending.value;
    await api(
      p.kind === "job"
        ? `/recording-jobs/${p.id}/cancel`
        : `/recording-plan-groups/${p.id}?version=${plans.value.find((plan) => plan.id === p.id)?.version ?? -1}`,
      p.kind === "job" ? "POST" : "DELETE",
      p.kind === "job" ? {} : undefined,
    );
    confirmation.value?.close();
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
const date = (v: string) => new Date(v).toLocaleString();
</script>
<template>
  <RecordingTaskGroups v-if="section === 'jobs'" />
  <div v-else-if="section === 'library'" class="panel recording-library">
    <div class="archive-review-workspace">
      <PlaybackResources
        v-model:query="resourceSearch"
        :count="filteredLibraryChannels.length"
        :total="libraryChannels.length"
      >
        <template #tools
          ><button
            type="button"
            class="link"
            aria-label="刷新通道资源"
            @click="load"
          >
            <AppIcon name="refresh" :size="16" />
          </button>
        </template>

        <button
          v-for="[id, name] in filteredLibraryChannels"
          :key="id"
          type="button"
          draggable="true"
          @dragstart="dragArchiveChannel($event, id)"
          :class="{ selected: libraryChannel === id }"
          @click="selectArchiveChannel(id)"
        >
          <AppIcon name="devices" :size="18" /><span>{{ name }}</span>
        </button>

        <template #query>
          <form class="resource-query-form" @submit.prevent="searchArchive()">
            <h4>录像查询</h4>
            <label
              >开始时间<input
                v-model="archiveStartInput"
                type="datetime-local"
                step="1"
                required /></label
            ><label
              >结束时间<input
                v-model="archiveEndInput"
                type="datetime-local"
                step="1"
                required
            /></label>
            <p v-if="message" class="error" role="alert">{{ message }}</p>
            <button
              type="submit"
              :disabled="archiveSearching || !libraryChannel"
            >
              {{ archiveSearching ? "查询中…" : "查询录像" }}
            </button>
          </form></template
        >
      </PlaybackResources>
      <main class="replay-main">
        <p v-if="loading" class="inline-message" role="status">
          正在读取录像分段…
        </p>
        <p v-if="loadError" class="inline-message error" role="alert">
          {{ loadError }}
        </p>
        <PlaybackWall
          :items="playbackItems"
          :ranges="archiveRanges"
          :pending="archivePending"
          :date="libraryDate"
          :range-start="appliedArchiveRange?.from"
          :range-end="appliedArchiveRange?.to"
          @close="closeArchiveWindow"
          @clear="
            archiveWindows = [];
            archiveRanges = {};
            archivePending = {};
          "
          @drop-channel="dropArchiveChannel"
        >
          <template #default="{ item, clock }"
            ><ArchiveDayPlayer
              v-if="libraryDate && !loadError && !loading"
              :key="item.id + ':' + libraryDate"
              :channel-id="item.channelId!"
              :channel-name="item.name"
              :date="libraryDate"
              :window-end="appliedArchiveRange?.to"
              :files="filesForDay(item.channelId!)"
              :clock="clock"
              @ranges="archiveRanges[item.id] = $event"
              @indexing="archivePending[item.id] = $event"
          /></template>
        </PlaybackWall>
      </main>
    </div>
  </div>
  <section
    v-else
    class="business-page"
    id="recording-center"
    :data-section="section"
  >
    <div class="title">
      <div>
        <h1>{{ section === "plans" ? "录像计划管理" : "录像任务中心" }}</h1>
        <p>
          {{
            section === "plans"
              ? "按设备分组安排录制，统一配置周期与存储规则，按通道查看执行结果。"
              : "集中查看设备录像导出与计划录制，文件生成后可下载。"
          }}
        </p>
      </div>
      <button
        v-if="section === 'plans'"
        :disabled="!resourcesReady || busy"
        @click="edit()"
      >
        <AppIcon name="plus" :size="16" />新增录像计划</button
      ><button v-else class="secondary" @click="load">刷新任务</button>
    </div>
    <div class="record-stats">
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon
            :name="section === 'plans' ? 'plans' : 'monitoring'"
            :size="21"
        /></span>
        <span>{{ section === "plans" ? "计划总数" : "执行中的任务" }}</span
        ><strong
          >{{ section === "plans" ? plans.length : activeCount
          }}<small> 项</small></strong
        >
      </div>
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon :name="section === 'plans' ? 'plans' : 'jobs'" :size="21"
        /></span>
        <span>{{ section === "plans" ? "已启用的计划" : "已完成的任务" }}</span
        ><strong
          >{{
            section === "plans"
              ? plans.filter((p) => p.enabled).length
              : visibleJobs.filter((j) => j.status === "succeeded").length
          }}<small> 项</small></strong
        >
      </div>
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon
            :name="section === 'plans' ? 'plans' : 'records'"
            :size="21"
        /></span>
        <span>{{ section === "plans" ? "已停用的计划" : "归档文件" }}</span>
        <strong
          >{{
            section === "plans"
              ? plans.filter((p) => !p.enabled).length
              : archivedFileCount
          }}<small> {{ section === "plans" ? "项" : "个" }}</small></strong
        >
      </div>
    </div>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <p v-if="loading" role="status">正在读取录像数据…</p>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <div v-if="section === 'plans'" class="panel recording-table">
      <div class="panel-heading">
        <h3>录像计划</h3>
        <span>时区：Asia/Shanghai（UTC+08）</span>
      </div>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table class="has-actions">
          <thead>
            <tr>
              <th scope="col" class="plan-name-column">计划名称</th>
              <th scope="col">设备分组</th>
              <th scope="col" class="plan-channel-details">通道明细</th>
              <th scope="col">执行周期</th>
              <th scope="col">录制时段</th>
              <th scope="col">保留时间</th>
              <th scope="col">文件分段</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in plans" :key="p.id">
              <td class="plan-name-column">
                <span class="video-name-cell plan-name-content"
                  ><AppIcon name="plans" :size="17" /><b>{{ p.name }}</b></span
                >
              </td>
              <td>
                <span>{{ p.groupName }}</span
                >
              </td>
              <td class="plan-channel-details">
                <button class="link" @click="showGroup(p)">
                  通道明细 · {{ p.channelCount }} 路
                </button>
              </td>
              <td>{{ p.days.map((d) => weekdays[d - 1]).join("、") }}</td>
              <td class="mono">
                <template
                  v-if="p.startTime === '00:00' && p.endTime === '00:00'"
                  >全天 00:00—24:00</template
                >
                <template v-else
                  >{{ p.startTime }}—{{ p.endTime
                  }}<small v-if="p.endTime <= p.startTime">
                    次日</small
                  ></template
                >
              </td>
              <td>{{ p.retentionDays }} 天</td>
              <td>{{ p.segmentSeconds / 60 }} 分钟</td>
              <td>
                <span
                  class="badge"
                  :class="p.enabled ? 'online' : 'unregistered'"
                  >{{ p.enabled ? "已启用" : "已停用" }}</span
                >
              </td>
              <td class="row-actions">
                <button class="link" :disabled="busy" @click="toggle(p)">
                  {{ p.enabled ? "停用" : "启用" }}</button
                ><button
                  class="link"
                  :disabled="!resourcesReady || busy"
                  @click="edit(p)"
                >
                  编辑</button
                ><button
                  class="link danger-text"
                  @click="confirm('plan', p.id)"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!plans.length && !loading && !loadError" class="empty-state">
        <span class="empty-symbol"><AppIcon name="plans" :size="32" /></span
        ><b>尚未配置录像计划</b>
        <p>选择设备分组和通道，设置录制周期后启用。</p>
      </div>
      <p class="panel-note">
        分组新增设备不会自动加入录制。通道明细可查看各路最近的执行过程与录像文件，完整历史保留在录像任务。
      </p>
    </div>
  </section>
  <dialog
    ref="detailDialog"
    class="business-dialog recording-detail-dialog"
    @close="detailSelection = null"
  >
    <DialogHeading>{{
      detailSelection?.kind === "attempts" ? "执行过程" : "录像文件"
    }}</DialogHeading>
    <template v-if="detailJob">
      <p class="muted">
        {{ channelLabel(detailJob) }} ·
        {{ detailJob.executionDate || date(detailJob.createdAt) }}
      </p>
      <div class="table-scroll data-table-scroll">
        <table v-if="detailSelection?.kind === 'attempts'">
          <thead>
            <tr>
              <th>序号</th>
              <th>开始时间</th>
              <th>结束时间</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(attempt, index) in executionSteps(detailJob)"
              :key="attempt.id"
            >
              <td>{{ index + 1 }}</td>
              <td>{{ date(attempt.createdAt) }}</td>
              <td>{{ attempt.finishedAt ? date(attempt.finishedAt) : "—" }}</td>
              <td>{{ labels[attempt.status] || attempt.status }}</td>
              <td>{{ attempt.error || "—" }}</td>
            </tr>
          </tbody>
        </table>
        <table v-else>
          <thead>
            <tr>
              <th>日期</th>
              <th>文件名称</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in detailJob.files" :key="file.id">
              <td>{{ file.date }}</td>
              <td>{{ file.name }}</td>
              <td class="row-actions">
                <button
                  type="button"
                  class="link"
                  @click="playFile(detailJob, file)"
                >
                  回放</button
                ><a
                  v-if="can('recording.download')"
                  class="link"
                  :href="fileUrl(detailJob, file)"
                  download
                  >下载</a
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="empty-state">此任务已不在当前列表中，请刷新后查看。</p>
    <div class="actions">
      <button type="button" class="secondary" @click="detailDialog?.close()">
        关闭
      </button>
    </div>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    ref="editor"
    class="plan-dialog business-dialog plan-editor-dialog"
  >
    <form @submit.prevent="save">
      <DialogHeading :disabled="busy"
        ><span class="plan-editor-title-icon"
          ><AppIcon name="plans" :size="18" /></span
        >{{ selected ? "编辑录像计划" : "新增录像计划" }}</DialogHeading
      >
      <p class="plan-editor-intro">
        选择设备分组与录制通道，统一安排执行周期、保留时间和文件分段。
      </p>
      <div class="plan-form">
        <section class="plan-editor-section">
          <h3>基本信息</h3>
          <div class="plan-editor-fields plan-basic-fields">
            <label
              ><span class="field-label">计划名称</span
              ><input
                autofocus
                v-model="form.name"
                required
                maxlength="100"
                placeholder="例如：办公区域工作日录像" /></label
            ><label
              ><span class="field-label">设备分组</span
              ><select
                v-model="form.deviceGroupId"
                aria-label="设备分组"
                required
                @change="changeGroup"
              >
                <option disabled value="">请选择设备分组</option>
                <option v-for="g in deviceGroups" :key="g.id" :value="g.id">
                  {{ g.name }}
                </option>
              </select></label
            >
          </div>
          <div class="group-channel-picker">
            <div class="group-channel-tools">
              <b
                >录制通道
                <small
                  >已选 {{ form.channelIds.length }} /
                  {{ groupChannels.length }} 路</small
                ></b
              >
              <div>
                <button
                  type="button"
                  class="link"
                  :disabled="!matchingGroupChannels.length"
                  @click="selectVisibleChannels"
                >
                  全选当前结果</button
                ><button
                  type="button"
                  class="link"
                  :disabled="!form.channelIds.length"
                  @click="form.channelIds = []"
                >
                  清空选择
                </button>
              </div>
            </div>
            <input
              v-model="channelSearch"
              type="search"
              aria-label="搜索计划通道"
              placeholder="搜索通道名称、编号或设备"
              :disabled="!form.deviceGroupId"
            />
            <div class="group-channel-list">
              <label v-for="c in matchingGroupChannels" :key="c.id"
                ><input
                  v-model="form.channelIds"
                  type="checkbox"
                  :value="c.id"
                /><span
                  ><b>{{ c.name }}</b
                  ><small>{{ c.deviceName }} · {{ c.channelCode }}</small></span
                ></label
              >
              <p v-if="!matchingGroupChannels.length">
                {{
                  !form.deviceGroupId ? "请先选择设备分组" : "没有匹配的通道"
                }}
              </p>
            </div>
            <p
              v-if="
                form.channelIds.some(
                  (id) => !groupChannels.some((c) => c.id === id),
                )
              "
              class="error"
            >
              已选通道中有已移除或移出分组的通道，请清空后重新选择。
            </p>
          </div>
        </section>
        <div class="plan-editor-columns">
          <section class="plan-editor-section">
            <h3>录制安排</h3>
            <fieldset class="plan-days">
              <legend>执行星期</legend>
              <div class="plan-week-options">
                <label
                  v-for="(day, i) in weekdays"
                  :key="day"
                  :class="{ 'is-selected': form.days.includes(i + 1) }"
                  ><input
                    v-model="form.days"
                    type="checkbox"
                    :value="i + 1"
                  />{{ day }}</label
                >
              </div>
            </fieldset>
            <div
              class="plan-mode-options"
              role="radiogroup"
              aria-label="录制时段模式"
            >
              <label :class="{ 'is-selected': allDay }"
                ><input
                  v-model="allDay"
                  type="radio"
                  :value="true"
                  name="recording-time-mode"
                /><span><b>全天录制</b><small>00:00—24:00</small></span></label
              >
              <label :class="{ 'is-selected': !allDay }"
                ><input
                  v-model="allDay"
                  type="radio"
                  :value="false"
                  name="recording-time-mode"
                /><span
                  ><b>自定义时段</b><small>设置开始与结束时间</small></span
                ></label
              >
            </div>
            <div v-if="!allDay" class="plan-editor-fields plan-custom-fields">
              <label v-if="!allDay"
                ><span class="field-label">开始时间</span
                ><input v-model="form.startTime" type="time" required /></label
              ><label v-if="!allDay"
                ><span class="field-label">结束时间</span
                ><input v-model="form.endTime" type="time" required
              /></label>
            </div>
          </section>
          <section class="plan-editor-section">
            <h3>存储策略</h3>
            <div class="plan-editor-fields plan-storage-fields">
              <label
                ><span class="field-label">保留天数</span
                ><input
                  v-model.number="form.retentionDays"
                  type="number"
                  min="1"
                  max="365"
                  step="1"
                  required
                /><small class="plan-field-help"
                  >1—365天，到期自动清理</small
                ></label
              ><label
                ><span class="field-label">文件分段</span
                ><select v-model.number="form.segmentSeconds">
                  <option
                    v-for="minutes in segmentMinutes"
                    :key="minutes"
                    :value="minutes * 60"
                  >
                    {{ minutes }}分钟
                  </option>
                  <option
                    v-if="!segmentMinutes.includes(form.segmentSeconds / 60)"
                    :value="form.segmentSeconds"
                  >
                    {{ form.segmentSeconds / 60 }}分钟（现有值）
                  </option></select
                ><small class="plan-field-help"
                  >分段保存，按天连续回放</small
                ></label
              >
            </div>
            <div class="plan-enable-row">
              <label class="plan-enable"
                ><input
                  v-model="form.enabled"
                  type="checkbox"
                />保存后启用计划</label
              ><span :class="{ 'is-enabled': form.enabled }">{{
                form.enabled ? "将自动执行" : "暂不启用"
              }}</span>
            </div>
          </section>
        </div>
      </div>
      <p class="panel-note plan-editor-note">
        按北京时间执行；自定义结束时间不晚于开始时间时，录制至次日。启用前请确认设备在线且存储可用。
      </p>
      <p v-if="message" class="error" role="alert">{{ message }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="editor?.close()"
        >
          取消</button
        ><button
          :disabled="
            busy ||
            !form.channelIds.length ||
            form.channelIds.some(
              (id) => !groupChannels.some((c) => c.id === id),
            )
          "
        >
          保存计划
        </button>
      </div>
    </form>
  </dialog>
  <dialog
    ref="groupDialog"
    class="business-dialog group-plan-dialog"
    @close="
      groupGeneration++;
      groupSelection = null;
      groupMembers = [];
    "
  >
    <DialogHeading>{{ groupSelection?.name }} · 通道明细</DialogHeading>
    <p class="panel-note">
      {{ groupSelection?.groupName }} · 每路独立录制，以下为最近执行记录
    </p>
    <p v-if="groupLoading && !groupMembers.length" role="status">
      正在读取通道状态…
    </p>
    <p v-if="groupError" class="error" role="alert">{{ groupError }}</p>
    <div class="table-scroll data-table-scroll">
      <table class="has-actions">
        <thead>
          <tr>
            <th>通道名称</th>
            <th>所属设备</th>
            <th>录制状态</th>
            <th>执行过程</th>
            <th>录像文件</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in groupMembers" :key="c.id">
            <td>{{ c.channelName || "通道已移除" }}</td>
            <td>
              {{ (c as Plan & { deviceName?: string }).deviceName || "—" }}
            </td>
            <td>
              <span
                class="badge"
                :class="
                  c.latest?.status === 'recording' ? 'online' : 'unregistered'
                "
                >{{
                  c.latest
                    ? labels[c.latest.status] || c.latest.status
                    : "待执行"
                }}</span
              ><small v-if="c.latest?.error" class="group-channel-error">{{
                c.latest.error
              }}</small>
            </td>
            <td>
              <button
                v-if="c.latest"
                type="button"
                class="link"
                @click="showDetails(c.latest, 'attempts')"
              >
                查看过程 · {{ executionSteps(c.latest).length }} 次</button
              ><span v-else>—</span>
            </td>
            <td>
              <button
                v-if="c.latest?.files.length"
                type="button"
                class="link"
                @click="showDetails(c.latest!, 'files')"
              >
                {{ c.latest.files.length }} 个文件</button
              ><span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button type="button" class="secondary" @click="groupDialog?.close()">
        关闭
      </button>
    </div>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="confirmation"
  >
    <DialogHeading :disabled="busy">{{
      pending?.kind === "job" ? "结束录像任务" : "删除录像计划"
    }}</DialogHeading>
    <p>
      {{
        pending?.kind === "job"
          ? "结束后将停止本任务拉流，并保留已经生成的部分文件。"
          : "删除后不再调度，已生成的录像仍按原保留周期管理。"
      }}
    </p>
    <p v-if="message" class="error">{{ message }}</p>
    <div class="actions">
      <button :disabled="busy" class="secondary" @click="confirmation?.close()">
        取消</button
      ><button class="danger" :disabled="busy" @click="remove">确认</button>
    </div>
  </dialog>
  <dialog
    ref="playback"
    class="business-dialog recording-playback-dialog"
    @close="playingFile = null"
  >
    <DialogHeading>录像回放</DialogHeading>
    <div v-if="playingFile">
      <p>{{ playingFile.name }}</p>
      <video
        :src="playingFile.url"
        controls
        autoplay
        playsinline
        aria-label="录像回放"
        class="recording-file-video"
        @error="playbackError = true"
      ></video>
      <p v-if="playbackError" role="alert">
        无法播放该录像，请检查浏览器编码支持，或下载后使用本地播放器。
      </p>
    </div>
  </dialog>
</template>

<style scoped>
.plan-name-column {
  width: 180px;
  min-width: 150px;
}
#recording-center .plan-name-content {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
}
.plan-name-content .app-icon {
  justify-self: center;
}
.plan-name-content b {
  min-width: 0;
  overflow-wrap: anywhere;
}
.plan-channel-details {
  width: 160px;
  text-align: center;
  white-space: nowrap;
}
.plan-channel-details .link {
  white-space: nowrap;
}
.archive-review-workspace {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: 0;
  height: var(--replay-workspace-height, calc(100dvh - 280px));
  min-height: 0;
  overflow: hidden;
}
.replay-main {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  padding: 0;
}
@media (max-width: 760px) {
  .archive-review-workspace {
    grid-template-columns: 1fr;
    grid-template-rows: 210px minmax(0, 1fr);
  }
  .replay-resource-panel {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .replay-resource-list {
    max-height: 180px;
  }
}
.recording-detail-dialog {
  width: min(960px, calc(100vw - 32px));
}
.recording-detail-dialog .table-scroll {
  max-height: 55vh;
}
.recording-file-video {
  display: block;
  width: min(760px, 100%);
  max-height: 65vh;
  background: #101720;
}
.file-link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  max-width: none;
}
.file-link > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.library-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
}
.resource-heading-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.group-channel-picker {
  margin-top: 14px;
  display: grid;
  gap: 8px;
}
.group-channel-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.group-channel-tools small {
  margin-left: 6px;
  color: var(--muted);
  font-weight: 400;
}
.group-channel-tools > div {
  display: flex;
  gap: 12px;
}
.group-channel-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 150px;
  overflow-y: auto;
  padding: 2px;
}
.group-channel-list > label {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel, white);
  min-width: 0;
  text-align: left;
}
.group-channel-list > label:has(input:checked) {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.group-channel-list input[type="checkbox"] {
  width: 15px;
  height: 15px;
  margin: 0;
  flex: 0 0 auto;
}
.group-channel-list label > span {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.group-channel-list b {
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.group-channel-list small {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.group-channel-list > p {
  color: var(--muted);
  font-size: 12px;
  padding: 10px;
}
.business-dialog.group-plan-dialog {
  width: min(980px, calc(100vw - 32px));
}
.group-channel-error {
  display: block;
  max-width: 240px;
  margin: 4px auto 0;
  color: var(--danger, #d43838);
  white-space: normal;
}
@media (max-width: 600px) {
  .group-channel-list {
    grid-template-columns: minmax(0, 1fr);
  }
  .group-channel-tools {
    flex-wrap: wrap;
  }
}
</style>

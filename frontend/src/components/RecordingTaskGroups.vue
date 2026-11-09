<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, can, messageOf, ApiError } from "../api";
import DialogHeading from "./DialogHeading.vue";
import AppIcon from "./AppIcon.vue";
import { rememberFilter } from "../remember-filter";
interface FileItem {
  id: string;
  jobId?: string;
  name: string;
  date: string;
}
interface Attempt {
  id: string;
  status: string;
  createdAt: string;
  finishedAt?: string | null;
  error?: string;
}
interface Job extends Attempt {
  kind: string;
  channelId: string;
  channelName?: string | null;
  dailyKey?: string;
  executionDate?: string;
  files: FileItem[];
  attempts?: Attempt[];
}
interface Group {
  id: string;
  name: string;
  channels: number;
  recording: number;
  processing: number;
  errors: number;
  waiting: number;
  files: number;
}
interface Member {
  channelId: string;
  channelName: string | null;
  channelCode: string | null;
  deviceName: string | null;
  job: Job | null;
}
const groups = ref<Group[]>([]),
  members = ref<Member[]>([]),
  downloads = ref<Job[]>([]);
const stats = ref({
  groups: 0,
  channels: 0,
  recording: 0,
  errors: 0,
  files: 0,
});
const page = rememberFilter<number>(
    "recording.tasks.groupPage",
    1,
    (value) => value >= 1,
  ),
  total = ref(0),
  memberPage = ref(1),
  memberTotal = ref(0);
const day = ref(
    new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
  ),
  query = ref("");
const appliedDay = ref(day.value),
  appliedQuery = ref("");
const showDeleted = ref(false),
  selection = ref<Group | null>(null),
  error = ref(""),
  memberError = ref(""),
  downloadError = ref("");
const loading = ref(true),
  memberLoading = ref(false),
  busy = ref(false);
const groupDialog = ref<HTMLDialogElement>(),
  detailDialog = ref<HTMLDialogElement>(),
  videoDialog = ref<HTMLDialogElement>(),
  confirmDialog = ref<HTMLDialogElement>();
const detail = ref<{ job: Job; kind: "attempts" | "files" } | null>(null),
  pending = ref<Job | null>(null),
  video = ref<{ name: string; url: string } | null>(null),
  videoError = ref(false);
const detailJob = computed(
  () =>
    members.value
      .map((m) => m.job)
      .find(
        (j) =>
          j &&
          (j.dailyKey || j.id) ===
            (detail.value?.job.dailyKey || detail.value?.job.id),
      ) ||
    downloads.value.find((j) => j.id === detail.value?.job.id) ||
    detail.value?.job,
);
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20))),
  memberPages = computed(() => Math.max(1, Math.ceil(memberTotal.value / 20)));
const labels: Record<string, string> = {
  starting: "准备中",
  recording: "录制中",
  finalizing: "生成文件",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
let alive = true,
  generation = 0,
  memberGeneration = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const fileUrl = (job: Job, file: FileItem) =>
  `/api/v1/recording-jobs/${encodeURIComponent(file.jobId || job.id)}/files/${encodeURIComponent(file.id)}`;
const active = (job: Job) => ["starting", "recording"].includes(job.status);
function options() {
  return showDeleted.value ? "&includeDeleted=1" : "";
}
function clearDeniedDetails(reason: unknown) {
  if (!(reason instanceof ApiError) || ![401, 403, 404].includes(reason.status))
    return;
  detailDialog.value?.close();
  videoDialog.value?.close();
  detail.value = null;
  video.value = null;
}
async function loadMembers() {
  if (!selection.value || !groupDialog.value?.open) return;
  const gen = ++memberGeneration;
  memberLoading.value = true;
  memberError.value = "";
  try {
    const result = await api<{ items: Member[]; total: number }>(
      `/recording-task-groups/${encodeURIComponent(selection.value.id)}/channels?date=${encodeURIComponent(appliedDay.value)}&page=${memberPage.value}&pageSize=20&q=${encodeURIComponent(appliedQuery.value)}${options()}`,
    );
    if (!alive || gen !== memberGeneration) return;
    memberTotal.value = result.total;
    if (memberPage.value > memberPages.value) {
      memberPage.value = memberPages.value;
      await loadMembers();
      return;
    }
    members.value = result.items;
  } catch (e) {
    if (alive && gen === memberGeneration) {
      members.value = [];
      memberTotal.value = 0;
      clearDeniedDetails(e);
      memberError.value = messageOf(e);
    }
  } finally {
    if (gen === memberGeneration) memberLoading.value = false;
  }
}
async function load() {
  const gen = ++generation;
  const [summary, exports] = await Promise.allSettled([
    api<{ items: Group[]; total: number; stats: typeof stats.value }>(
      `/recording-task-groups?page=${page.value}&pageSize=20${options()}`,
    ),
    api<{ items: Job[] }>("/recording-jobs?kind=download"),
  ]);
  if (!alive || gen !== generation) return;
  loading.value = false;
  if (summary.status === "fulfilled") {
    groups.value = summary.value.items;
    total.value = summary.value.total;
    stats.value = summary.value.stats;
    error.value = "";
    if (page.value > pages.value) {
      page.value = pages.value;
      await load();
      return;
    }
  } else {
    groups.value = [];
    total.value = 0;
    stats.value = { groups: 0, channels: 0, recording: 0, errors: 0, files: 0 };
    error.value = messageOf(summary.reason);
    clearDeniedDetails(summary.reason);
  }
  if (exports.status === "fulfilled") {
    downloads.value = exports.value.items;
    downloadError.value = "";
  } else {
    downloads.value = [];
    downloadError.value = messageOf(exports.reason);
    if (detail.value?.job.kind === "download")
      clearDeniedDetails(exports.reason);
  }
  if (groupDialog.value?.open) await loadMembers();
}
async function poll() {
  await load();
  if (alive) timer = setTimeout(poll, 10000);
}
async function openGroup(group: Group) {
  selection.value = group;
  members.value = [];
  memberTotal.value = 0;
  memberPage.value = 1;
  query.value = "";
  day.value = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  groupDialog.value?.showModal();
  appliedDay.value = day.value;
  appliedQuery.value = "";
  await loadMembers();
}
async function filterMembers() {
  appliedDay.value = day.value;
  appliedQuery.value = query.value;
  memberPage.value = 1;
  members.value = [];
  detailDialog.value?.close();
  await loadMembers();
}
function openDetail(job: Job, kind: "attempts" | "files") {
  detail.value = { job, kind };
  detailDialog.value?.showModal();
}
function play(job: Job, file: FileItem) {
  video.value = { name: file.name, url: fileUrl(job, file) + "?play=1" };
  videoError.value = false;
  videoDialog.value?.showModal();
}
function requestStop(job: Job) {
  pending.value = job;
  confirmDialog.value?.showModal();
}
async function stop() {
  if (!pending.value || busy.value) return;
  busy.value = true;
  try {
    await api(
      `/recording-jobs/${encodeURIComponent(pending.value.id)}/cancel`,
      "POST",
      {},
    );
    confirmDialog.value?.close();
    await load();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
onMounted(poll);
onUnmounted(() => {
  alive = false;
  generation++;
  memberGeneration++;
  clearTimeout(timer);
});
</script>

<template>
  <section
    class="business-page task-groups-page"
    id="recording-center"
    data-section="jobs"
  >
    <header class="title">
      <div>
        <h1>录像任务管理</h1>
        <p>按设备分组查看录制状态，按通道追溯执行过程与录像文件。</p>
      </div>
      <button class="secondary" @click="load">
        <AppIcon name="refresh" :size="16" />刷新任务
      </button>
    </header>
    <div class="record-stats task-summary">
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon name="groups" :size="21"
        /></span>
        <span>任务分组</span
        ><strong>{{ stats.groups }}<small> 组</small></strong>
      </div>
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon name="monitoring" :size="21"
        /></span>
        <span>录制中</span
        ><strong class="success"
          >{{ stats.recording }}<small> 路</small></strong
        >
      </div>
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon name="alarms" :size="21"
        /></span>
        <span>异常通道</span
        ><strong>{{ stats.errors }}<small> 路</small></strong>
      </div>
      <div class="panel">
        <span class="record-metric-icon"
          ><AppIcon name="records" :size="21"
        /></span>
        <span>录像文件</span
        ><strong>{{ stats.files }}<small> 个</small></strong>
      </div>
    </div>
    <div class="panel recording-table">
      <div class="panel-heading task-panel-heading">
        <h3>分组任务</h3>
        <label v-if="can('plans.manage')" class="task-checkbox"
          ><input
            v-model="showDeleted"
            type="checkbox"
            @change="
              page = 1;
              load();
            "
          />显示已删除通道历史</label
        >
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div class="table-scroll data-table-scroll">
        <table class="has-actions">
          <thead>
            <tr>
              <th>设备分组</th>
              <th>通道数量</th>
              <th>录制中</th>
              <th>处理中</th>
              <th>异常</th>
              <th>录像文件</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="group in groups" :key="group.id">
              <td>
                <button
                  class="link task-group-name video-name-cell"
                  @click="openGroup(group)"
                >
                  <AppIcon name="folder" :size="17" /><b>{{ group.name }}</b>
                </button>
              </td>
              <td>{{ group.channels }} 路</td>
              <td>
                <span
                  class="task-count"
                  :class="{ 'task-count-active': group.recording > 0 }"
                  >{{ group.recording }}</span
                >
              </td>
              <td>{{ group.processing }}</td>
              <td>
                <span
                  class="task-count"
                  :class="{ 'task-count-error': group.errors > 0 }"
                  >{{ group.errors }}</span
                >
              </td>
              <td>{{ group.files }} 个</td>
              <td>
                <button class="link task-detail-link" @click="openGroup(group)">
                  通道明细<AppIcon name="arrow" :size="14" />
                </button>
              </td>
            </tr>
            <tr v-if="!groups.length">
              <td colspan="7" class="empty-state">
                {{
                  loading
                    ? "正在加载任务…"
                    : error
                      ? "任务加载失败，请重试"
                      : "暂无录像任务"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="task-pagination">
        <button
          class="secondary"
          :disabled="page <= 1"
          @click="
            page--;
            load();
          "
        >
          上一页</button
        ><span>第 {{ page }} / {{ pages }} 页 · 共 {{ total }} 组</span
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
    <div v-if="downloads.length || downloadError" class="panel recording-table">
      <div class="panel-heading task-panel-heading">
        <h3>设备录像导出</h3>
        <span class="muted">最近 {{ downloads.length }} 项</span>
      </div>
      <p v-if="downloadError" class="error" role="alert">{{ downloadError }}</p>
      <div class="table-scroll data-table-scroll">
        <table>
          <thead>
            <tr>
              <th>通道名称</th>
              <th>创建时间</th>
              <th>状态</th>
              <th>录像文件</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in downloads" :key="job.id">
              <td>{{ job.channelName || "已删除通道" }}</td>
              <td>{{ date(job.createdAt) }}</td>
              <td>{{ labels[job.status] || job.status }}</td>
              <td>
                <button
                  class="link"
                  :disabled="!job.files.length"
                  @click="openDetail(job, 'files')"
                >
                  {{ job.files.length }} 个文件
                </button>
              </td>
              <td>
                <button class="link" @click="openDetail(job, 'attempts')">
                  执行过程</button
                ><button
                  v-if="active(job) && can('recording.download')"
                  class="link danger"
                  @click="requestStop(job)"
                >
                  结束任务
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
  <dialog
    ref="groupDialog"
    class="business-dialog task-group-dialog"
    @close="
      memberGeneration++;
      selection = null;
      members = [];
      memberLoading = false;
    "
  >
    <DialogHeading>{{ selection?.name }} · 录像任务</DialogHeading>
    <form class="task-member-filters" @submit.prevent="filterMembers">
      <label>执行日期<input v-model="day" type="date" required /></label
      ><label
        >通道检索<input
          v-model="query"
          maxlength="100"
          placeholder="通道名称、编号或设备名称" /></label
      ><button type="submit" :disabled="memberLoading">查询</button>
    </form>
    <p v-if="memberError" class="error" role="alert">{{ memberError }}</p>
    <div
      class="table-scroll data-table-scroll task-member-table"
      :aria-busy="memberLoading"
    >
      <table>
        <thead>
          <tr>
            <th>通道名称</th>
            <th>所属设备</th>
            <th>状态</th>
            <th>执行过程</th>
            <th>录像文件</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in members" :key="member.channelId">
            <td>
              <strong>{{ member.channelName || "已删除通道" }}</strong
              ><small class="task-channel-code">{{
                member.channelCode || "历史通道"
              }}</small>
            </td>
            <td>{{ member.deviceName || "—" }}</td>
            <td>
              <span
                class="badge"
                :class="
                  member.job?.status === 'recording'
                    ? 'online'
                    : member.job &&
                        ['failed', 'interrupted'].includes(member.job.status)
                      ? 'offline'
                      : 'unregistered'
                "
                >{{
                  member.job
                    ? labels[member.job.status] || member.job.status
                    : "当日无任务"
                }}</span
              >
            </td>
            <td>
              <button
                v-if="member.job"
                class="link"
                @click="openDetail(member.job, 'attempts')"
              >
                查看过程（{{ member.job.attempts?.length || 1 }} 次）</button
              ><span v-else>—</span>
            </td>
            <td>
              <button
                v-if="member.job?.files.length"
                class="link"
                @click="openDetail(member.job, 'files')"
              >
                {{ member.job.files.length }} 个文件</button
              ><span v-else>—</span>
            </td>
            <td>
              <button
                v-if="member.job && active(member.job) && can('plans.manage')"
                class="link danger"
                @click="requestStop(member.job)"
              >
                结束任务</button
              ><span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!members.length">
            <td colspan="6" class="empty-state">
              {{
                memberLoading
                  ? "正在加载通道任务…"
                  : memberError
                    ? "加载失败，请重试"
                    : "没有符合条件的通道"
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="task-pagination">
      <button
        class="secondary"
        :disabled="memberPage <= 1 || memberLoading"
        @click="
          memberPage--;
          loadMembers();
        "
      >
        上一页</button
      ><span
        >第 {{ memberPage }} / {{ memberPages }} 页 · 共
        {{ memberTotal }} 路</span
      ><button
        class="secondary"
        :disabled="memberPage >= memberPages || memberLoading"
        @click="
          memberPage++;
          loadMembers();
        "
      >
        下一页
      </button>
    </div>
  </dialog>
  <dialog
    ref="detailDialog"
    class="business-dialog task-detail-dialog"
    @close="detail = null"
  >
    <DialogHeading>{{
      detail?.kind === "attempts" ? "执行过程" : "录像文件"
    }}</DialogHeading
    ><template v-if="detailJob"
      ><p class="muted">
        {{ detailJob.channelName || "已删除通道" }} ·
        {{ detailJob.executionDate || date(detailJob.createdAt) }}
      </p>
      <div class="table-scroll data-table-scroll">
        <table v-if="detail?.kind === 'attempts'">
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
              v-for="(attempt, i) in detailJob.attempts?.length
                ? detailJob.attempts
                : [detailJob]"
              :key="attempt.id"
            >
              <td>{{ i + 1 }}</td>
              <td>{{ date(attempt.createdAt) }}</td>
              <td>{{ date(attempt.finishedAt) }}</td>
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
                <button class="link" @click="play(detailJob!, file)">
                  回放</button
                ><a
                  v-if="can('recording.download')"
                  class="link"
                  :href="fileUrl(detailJob!, file)"
                  download
                  >下载</a
                >
              </td>
            </tr>
            <tr v-if="!detailJob.files.length">
              <td colspan="3" class="empty-state">暂无录像文件</td>
            </tr>
          </tbody>
        </table>
      </div></template
    >
  </dialog>
  <dialog
    ref="videoDialog"
    class="business-dialog task-video-dialog"
    @close="video = null"
  >
    <DialogHeading>录像回放</DialogHeading
    ><template v-if="video"
      ><p class="muted">{{ video.name }}</p>
      <video
        :src="video.url"
        controls
        autoplay
        @error="videoError = true"
      ></video>
      <p v-if="videoError" class="error" role="alert">
        录像加载失败，请检查文件是否仍在保留期内，或下载后查看。
      </p></template
    >
  </dialog>
  <dialog
    ref="confirmDialog"
    class="business-dialog"
    @cancel="busy && $event.preventDefault()"
    @close="pending = null"
  >
    <DialogHeading :disabled="busy">结束录像任务</DialogHeading>
    <p>
      确认结束此通道的当前任务？已生成的录像文件会保留，启用的计划仍按规则执行。
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="actions">
      <button
        class="secondary"
        :disabled="busy"
        @click="confirmDialog?.close()"
      >
        取消</button
      ><button class="danger" :disabled="busy" @click="stop">
        {{ busy ? "正在结束…" : "确认结束" }}
      </button>
    </div>
  </dialog>
</template>

<style scoped>
#recording-center.task-groups-page .task-summary {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
#recording-center.task-groups-page
  .record-stats
  > .panel:nth-child(3)
  .record-metric-icon {
  background: #fff4e9;
  color: #c47e29;
}
.task-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.task-count {
  display: inline-flex;
  min-width: 32px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: var(--surface-alt, #f3f5f8);
  color: var(--muted, #86909f);
  font-variant-numeric: tabular-nums;
}
.task-count-active {
  background: #edf7f2;
  color: #25866b;
}
.task-count-error {
  background: #fff1f0;
  color: #cb4545;
}
.task-detail-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.task-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted, #6b7c95);
}
.task-checkbox input {
  width: auto;
}
.task-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  font-size: 12px;
  color: var(--muted, #6b7c95);
}
.task-group-name {
  font-weight: 600;
}
.task-group-dialog {
  width: min(980px, calc(100vw - 32px));
}
.task-detail-dialog {
  width: min(1000px, calc(100vw - 40px));
}
.task-member-filters {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  margin: 16px 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-alt, #f8fafd);
}
.task-member-filters label {
  margin: 0;
  display: grid;
  gap: 8px;
  font-size: 13px;
}
.task-member-filters label:nth-child(2) {
  width: 300px;
  max-width: 100%;
}
.task-member-filters input[type="date"] {
  text-align: center;
}
.task-member-filters > button {
  height: 36px;
  margin: 0;
}
.task-member-table {
  max-height: 50vh;
}
.task-channel-code {
  display: block;
  font-weight: 400;
  font-size: 11px;
  color: var(--muted, #6b7c95);
  margin-top: 5px;
}
.task-groups-page th,
.task-groups-page td,
.task-group-dialog th,
.task-group-dialog td,
.task-detail-dialog th,
.task-detail-dialog td {
  text-align: center;
  vertical-align: middle;
}
.task-group-dialog td,
.task-groups-page td {
  height: auto;
  padding: 14px 12px;
}
.task-detail-dialog .table-scroll {
  max-height: 60vh;
}
.task-video-dialog {
  width: min(960px, calc(100vw - 32px));
}
.task-video-dialog video {
  display: block;
  width: 100%;
  max-height: 65vh;
  background: #101923;
}
.success {
  color: #189451;
}
.danger {
  color: #d43838;
}
.task-groups-page .panel {
  min-width: 0;
}
@media (max-width: 700px) {
  #recording-center.task-groups-page .task-summary {
    grid-template-columns: 1fr;
  }
  .task-member-filters {
    flex-wrap: wrap;
    gap: 12px;
  }
  .task-member-filters label:nth-child(2) {
    width: 100%;
  }
  .task-pagination {
    gap: 8px;
  }
  .task-group-dialog,
  .task-detail-dialog {
    width: calc(100vw - 24px);
  }
}
</style>

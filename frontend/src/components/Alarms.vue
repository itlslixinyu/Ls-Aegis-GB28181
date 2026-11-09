<script setup lang="ts">
import { can } from "../api";
import { rememberFilter } from "../remember-filter";
import DialogHeading from "./DialogHeading.vue";
import AppIcon from "./AppIcon.vue";
import AiResultDialog from "./AiResultDialog.vue";
import type { AiJob } from "../ai-types";
import { ref, onMounted, onUnmounted } from "vue";
import { api, messageOf } from "../api";
interface Alarm {
  analysis?: AiJob | null;
  snapshot?: { status: string; error: string | null; capturedAt: string | null; requestedAt: string; url: string | null } | null;
  id: string;
  deviceId: string;
  deviceName: string;
  targetCode: string;
  priority: number;
  method: string;
  type: string;
  description: string;
  occurredAt: string;
  receivedAt: string;
  lastReceivedAt: string;
  repeatCount: number;
  status: string;
  version: number;
  groupName?: string;
  longitude: number | null;
  latitude: number | null;
  actions?: {
    id: string;
    username: string;
    action: string;
    note: string;
    createdAt: string;
  }[];
}
const items = ref<Alarm[]>([]),
  groups = ref<{ id: string; name: string }[]>([]),
  stats = ref({ total: 0, pending: 0, acknowledged: 0, resolved: 0 }),
  total = ref(0),
  page = rememberFilter<number>("alarms.page", 1, (value) => value >= 1),
  busy = ref(false),
  message = ref(""),
  detail = ref<Alarm | null>(null),
  dialog = ref<HTMLDialogElement>(),
  note = ref(""),
  actionBusy = ref(false),
  detailError = ref("");
const selectedAnalysis = ref<AiJob | null>(null), submittingAnalysis = ref(false);
async function analyzeAlarm(reanalyze = false) {
  if (!detail.value || submittingAnalysis.value) return;
  detailError.value = "";
  submittingAnalysis.value = true; const id = detail.value.id, gen = detailGeneration;
  try {
    const job = await api<AiJob>("/ai/alarm-analyses", "POST", { alarmId: id, ...(reanalyze ? { reanalyze: true } : {}) });
    if (alive && gen === detailGeneration && detail.value?.id === id) detail.value.analysis = job;
  } catch (e) { if (alive && gen === detailGeneration) detailError.value = messageOf(e); }
  finally { if (alive) submittingAnalysis.value = false; }
}
const filters = ref({
  q: rememberFilter("alarms.q", ""),
  status: rememberFilter("alarms.status", ""),
  priority: rememberFilter("alarms.priority", ""),
  groupId: rememberFilter("alarms.groupId", ""),
  from: rememberFilter("alarms.from", ""),
  to: rememberFilter("alarms.to", ""),
});
const labels: Record<string, string> = {
  new: "待确认",
  acknowledged: "待处置",
  resolved: "已处置",
};
let alive = true,
  generation = 0,
  detailGeneration = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const gen = ++generation;
  busy.value = true;
  try {
    const values = {
      ...filters.value,
      page: String(page.value),
      pageSize: "20",
      from: filters.value.from
        ? new Date(filters.value.from).toISOString()
        : "",
      to: filters.value.to ? new Date(filters.value.to).toISOString() : "",
    };
    const data = await api<{
      items: Alarm[];
      total: number;
      stats: typeof stats.value;
    }>("/alarms?" + new URLSearchParams(values));
    if (alive && gen === generation) {
      const lastPage = Math.max(1, Math.ceil(data.total / 20));
      if (page.value > lastPage) {
        page.value = lastPage;
        return load();
      }
      items.value = data.items;
      total.value = data.total;
      stats.value = data.stats;
      message.value = "";
    }
  } catch (e) {
    if (alive && gen === generation) message.value = messageOf(e);
  } finally {
    if (gen === generation) busy.value = false;
  }
}
async function poll() {
  await load();
  if (dialog.value?.open && detail.value && !actionBusy.value) {
    const id = detail.value.id, gen = detailGeneration;
    try {
      const value = await api<Alarm>("/alarms/" + id);
      if (alive && gen === detailGeneration && detail.value?.id === id) {
        detail.value = value;
        if (selectedAnalysis.value?.id === value.analysis?.id) selectedAnalysis.value = value.analysis || null;
      }
    } catch (e) {
      if (alive && gen === detailGeneration) { detail.value = null; selectedAnalysis.value = null; dialog.value?.close(); message.value = messageOf(e); }
    }
  }
  if (alive) timer = setTimeout(poll, 10000);
}
onMounted(async () => {
  await poll();
  try {
    groups.value = (
      await api<{ items: { id: string; name: string }[] }>("/groups")
    ).items;
    if (!alive) return;
    if (
      filters.value.groupId &&
      !groups.value.some((g) => g.id === filters.value.groupId)
    ) {
      filters.value.groupId = "";
      page.value = 1;
      await load();
    }
  } catch (e) {
    message.value = messageOf(e);
  }
});
onUnmounted(() => {
  alive = false;
  generation++;
  detailGeneration++;
  clearTimeout(timer);
});
async function open(id: string) {
  if (actionBusy.value) return;
  const gen = ++detailGeneration;
  detailError.value = "";
  note.value = "";
  try {
    const data = await api<Alarm>("/alarms/" + id);
    if (!alive || gen !== detailGeneration) return;
    detail.value = data;
    if (!dialog.value?.open) dialog.value?.showModal();
  } catch (e) {
    if (alive && gen === detailGeneration) message.value = messageOf(e);
  }
}
async function act(action: string) {
  if (!detail.value) return;
  actionBusy.value = true;
  detailError.value = "";
  try {
    detail.value = await api<Alarm>(
      `/alarms/${detail.value.id}/actions`,
      "POST",
      { action, note: note.value, version: detail.value.version },
    );
    note.value = "";
    await load();
  } catch (e) {
    detailError.value = messageOf(e);
  } finally {
    actionBusy.value = false;
  }
}
const format = (v: string) => new Date(v).toLocaleString();
</script>
<template>
  <section class="business-page" id="alarms-view">
    <div class="title">
      <div>
        <h1>告警管理中心</h1>
        <p>统一接收国标设备告警，按确认、处置流程形成完整记录。</p>
      </div>
      <button class="secondary" :disabled="busy" @click="load">刷新告警</button>
    </div>
    <div class="alarm-stats">
      <div class="panel">
        <span>告警总数</span><strong>{{ stats.total }}</strong>
      </div>
      <div class="panel">
        <span>待确认</span
        ><strong class="danger-text">{{ stats.pending }}</strong>
      </div>
      <div class="panel">
        <span>待处置</span><strong>{{ stats.acknowledged }}</strong>
      </div>
      <div class="panel">
        <span>已处置</span><strong>{{ stats.resolved }}</strong>
      </div>
    </div>
    <div class="panel alarm-list">
      <div class="panel-heading">
        <h3>告警事件列表</h3>
        <span>授权范围内统计 · 每10秒更新</span>
      </div>
      <form
        class="toolbar alarm-filters business-filters"
        @submit.prevent="
          page = 1;
          load();
        "
      >
        <label
          >关键词<input
            v-model="filters.q"
            placeholder="设备、通道编号或告警内容"
            maxlength="100" /></label
        ><label
          >处理状态<select v-model="filters.status">
            <option value="">全部状态</option>
            <option value="new">待确认</option>
            <option value="acknowledged">待处置</option>
            <option value="resolved">已处置</option>
          </select></label
        ><label
          >告警级别<select v-model="filters.priority">
            <option value="">全部级别</option>
            <option value="1">一级</option>
            <option value="2">二级</option>
            <option value="3">三级</option>
            <option value="4">四级</option>
          </select></label
        ><label
          >设备分组<select v-model="filters.groupId">
            <option value="">全部授权分组</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select></label
        ><label
          >开始时间<input v-model="filters.from" type="datetime-local" /></label
        ><label
          >结束时间<input v-model="filters.to" type="datetime-local" /></label
        ><button :disabled="busy">查询</button>
      </form>
      <p v-if="message" role="status" class="inline-message">{{ message }}</p>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table class="has-actions">
          <thead>
            <tr>
              <th scope="col">告警时间</th>
              <th scope="col">设备 / 通道</th>
              <th scope="col">级别</th>
              <th scope="col" class="cell-description">告警内容</th>
              <th scope="col">重复次数</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in items" :key="a.id">
              <td class="cell-date">{{ format(a.occurredAt) }}</td>
              <td>
                {{ a.deviceName
                }}<small class="muted block mono">{{ a.targetCode }}</small>
              </td>
              <td>
                <span
                  class="badge"
                  :class="a.priority === 1 ? 'offline' : 'unregistered'"
                  >{{ ["", "一级", "二级", "三级", "四级"][a.priority] }}</span
                >
              </td>
              <td class="cell-description">
                <span class="alarm-text" :title="a.description">{{
                  a.description || (a.method === "5" && a.type === "2" ? "移动侦测告警（运动目标检测）" : "设备未提供描述")
                }}</span>
              </td>
              <td>{{ a.repeatCount }}</td>
              <td>
                <span
                  class="badge"
                  :class="
                    a.status === 'resolved'
                      ? 'online'
                      : a.status === 'new'
                        ? 'offline'
                        : 'unregistered'
                  "
                  >{{ labels[a.status] }}</span
                >
              </td>
              <td>
                <button class="link" @click="open(a.id)">
                  {{
                    can("alarms.handle") && a.status !== "resolved"
                      ? "查看 / 处理"
                      : "查看详情"
                  }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!items.length && !busy && !message" class="empty-state">
        <span class="empty-symbol"><AppIcon name="alarms" :size="32" /></span
        ><b>暂无符合条件的告警</b>
        <p>仅展示有权访问的设备事件，不生成模拟告警。</p>
      </div>
      <div class="pager">
        <button
          class="secondary"
          :disabled="busy || page <= 1"
          @click="
            page--;
            load();
          "
        >
          上一页</button
        ><span>第 {{ page }} 页 · 共 {{ total }} 条</span
        ><button
          class="secondary"
          :disabled="busy || page * 20 >= total"
          @click="
            page++;
            load();
          "
        >
          下一页
        </button>
      </div>
    </div>
  </section>
  <dialog
    @cancel="actionBusy && $event.preventDefault()"
    ref="dialog"
    class="alarm-dialog business-dialog"
    @close="detailGeneration++"
  >
    <template v-if="detail"
      ><DialogHeading :disabled="actionBusy">告警详情与处置</DialogHeading>
      <dl class="event-details">
        <dt>设备名称</dt>
        <dd>{{ detail.deviceName }}</dd>
        <dt>通道编号</dt>
        <dd class="mono">{{ detail.targetCode }}</dd>
        <dt>告警时间</dt>
        <dd>{{ format(detail.occurredAt) }}</dd>
        <dt>接收时间</dt>
        <dd>{{ format(detail.receivedAt) }}</dd>
        <dt>告警级别</dt>
        <dd>{{ detail.priority }} 级</dd>
        <dt>上报方式 / 类型</dt>
        <dd>{{ detail.method }} / {{ detail.type || "未提供" }}<template v-if="detail.method === '5' && detail.type === '2'"> · 移动侦测告警（运动目标检测）</template></dd>
        <dt>处理状态</dt>
        <dd>{{ labels[detail.status] }}</dd>
        <dt>重复接收</dt>
        <dd>{{ detail.repeatCount }} 次</dd>
        <dt>告警描述</dt>
        <dd>{{ detail.description || (detail.method === "5" && detail.type === "2" ? "移动侦测告警（运动目标检测）" : "设备未提供描述") }}</dd>
        <dt v-if="detail.longitude !== null">上报坐标</dt>
        <dd v-if="detail.longitude !== null">
          {{ detail.longitude }}, {{ detail.latitude }}（WGS84）
        </dd>
      </dl>
      <div class="event-history">
        <section class="alarm-snapshot">
          <h3>告警抓图</h3>
          <template v-if="detail.snapshot?.status === 'ready' && detail.snapshot.url">
            <img :src="detail.snapshot.url" alt="移动侦测告警关联画面" style="display:block;max-width:100%;height:auto;border-radius:6px" @error="detailError = '图片加载失败或访问权限已变化，请刷新详情'" />
            <p>抓图时间：{{ detail.snapshot.capturedAt ? format(detail.snapshot.capturedAt) : '—' }}。图片为平台抓图，30秒内连续告警共用一张，不是摄像机事件原图。</p>
          </template>
          <p v-else-if="detail.snapshot?.status === 'capturing'">正在异步抓图，详情每10秒更新。</p>
          <p v-else-if="detail.snapshot">{{ detail.snapshot.error || '图片已过期清理' }}</p>
          <p v-else>此告警无关联图片；历史告警不会补拍。</p>
        </section>
        <section v-if="can('ai.view')">
          <h3>AI画面分析 · 本地Qwen</h3>
          <template v-if="detail.analysis">
            <p>{{ detail.analysis.status === 'succeeded' ? detail.analysis.result?.summary : detail.analysis.error || (detail.analysis.status === 'running' ? '正在本地分析…' : detail.analysis.status === 'queued' ? '等待低频队列调度…' : '分析未完成') }}</p>
            <button type="button" class="secondary" @click="selectedAnalysis = detail.analysis">查看分析记录</button>
          </template>
          <p v-else>尚无分析记录。开启自动分析后处理新抓图；同通道按配置间隔采样。</p>
          <button v-if="can('ai.analyze') && detail.snapshot?.status === 'ready' && !['queued', 'running'].includes(detail.analysis?.status || '')" type="button" class="secondary" :disabled="submittingAnalysis" @click="analyzeAlarm(!!detail.analysis)">{{ submittingAnalysis ? '提交中…' : detail.analysis ? '重新分析原图' : '提交Qwen分析' }}</button>
        </section>
        <h3>处置记录</h3>
        <p v-if="!detail.actions?.length" class="muted">尚无处置记录</p>
        <div v-for="a in detail.actions" :key="a.id">
          <b
            >{{ a.username }} ·
            {{ a.action === "acknowledge" ? "确认告警" : "完成处置" }}</b
          ><small>{{ format(a.createdAt) }}</small>
          <p>{{ a.note || "无备注" }}</p>
        </div>
      </div>
      <label v-if="can('alarms.handle') && detail.status !== 'resolved'"
        ><span class="field-label">{{
          detail.status === "new" ? "确认备注（选填）" : "处置意见（必填）"
        }}</span
        ><textarea
          autofocus
          v-model="note"
          maxlength="1000"
          rows="3"
          placeholder="记录核查情况与处置结果"
        />
      </label>
      <p v-if="detailError" role="alert" class="error">{{ detailError }}</p>
      <div class="actions">
        <button
          class="secondary"
          :disabled="actionBusy"
          @click="dialog?.close()"
        >
          关闭</button
        ><button
          class="secondary"
          :disabled="actionBusy"
          @click="open(detail.id)"
        >
          刷新详情</button
        ><button
          v-if="can('alarms.handle') && detail.status !== 'resolved'"
          :disabled="
            actionBusy || (detail.status === 'acknowledged' && !note.trim())
          "
          @click="act(detail.status === 'new' ? 'acknowledge' : 'resolve')"
        >
          {{ detail.status === "new" ? "确认告警" : "完成处置" }}
        </button>
      </div></template
    >
  </dialog>
  <AiResultDialog :job="selectedAnalysis" @close="selectedAnalysis = null" />
</template>

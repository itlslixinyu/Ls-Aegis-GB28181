<script setup lang="ts">
import { can } from "../api";
import { rememberFilter } from "../remember-filter";
import DialogHeading from "./DialogHeading.vue";
import { ref, nextTick, onMounted, onUnmounted } from "vue";
import { api, currentUser, messageOf } from "../api";
interface Subscription {
  guard?: { status: string; phase: string; error: string | null } | null;
  id: string;
  deviceId: string;
  kind: string;
  enabled: number;
  expires: number;
  interval: number;
  status: string;
  error: string | null;
  acceptedAt: string | null;
  lastNotifyAt: string | null;
  expiresAt: number | null;
  deviceName: string;
  deviceCode: string;
  deviceStatus: string;
  groupName: string;
}
interface Device {
  id: string;
  name: string;
  deviceId: string;
  status: string;
}
const items = ref<Subscription[]>([]),
  groups = ref<{ id: string; name: string }[]>([]),
  devices = ref<Device[]>([]),
  q = rememberFilter("subscriptions.query", ""),
  kind = rememberFilter("subscriptions.kind", ""),
  groupId = rememberFilter("subscriptions.group", ""),
  page = rememberFilter<number>("subscriptions.page", 1, (value) => value >= 1),
  total = ref(0),
  message = ref(""),
  loadError = ref(""),
  busy = ref(false),
  loading = ref(false),
  editor = ref<HTMLDialogElement>(),
  deviceId = ref(""),
  deviceQuery = ref(""),
  editKind = ref("Alarm"),
  expires = ref(3600),
  interval = ref(5),
  enabled = ref(true),
  editing = ref(false);
const labels: Record<string, string> = {
  disabled: "已停用",
  waiting: "等待接入",
  subscribing: "请求中",
  awaiting_notify: "设备已接受 · 待通知",
  active: "通知正常",
  pending: "设备待授权",
  failed: "订阅异常",
  stopping: "取消中",
};
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  deviceGeneration = 0;
const time = (v: string | number | null) =>
  v ? new Date(v).toLocaleString() : "—";
async function load() {
  const gen = ++generation;
  loading.value = true;
  try {
    const data = await api<{ items: Subscription[]; total: number }>(
      "/subscriptions?" +
        new URLSearchParams({
          q: q.value,
          kind: kind.value,
          groupId: groupId.value,
          page: String(page.value),
        }),
    );
    if (!alive || gen !== generation) return;
    const lastPage = Math.max(1, Math.ceil(data.total / 20));
    if (page.value > lastPage) {
      page.value = lastPage;
      return load();
    }
    items.value = data.items;
    total.value = data.total;
    loadError.value = "";
  } catch (e) {
    if (alive && gen === generation) loadError.value = messageOf(e);
  } finally {
    if (gen === generation) loading.value = false;
  }
}
async function loadDevices() {
  const gen = ++deviceGeneration;
  try {
    const data = await api<{ items: Device[] }>(
      "/devices?" +
        new URLSearchParams({ q: deviceQuery.value, pageSize: "100" }),
    );
    if (alive && gen === deviceGeneration) devices.value = data.items;
  } catch (e) {
    message.value = messageOf(e);
  }
}
async function open(row?: Subscription) {
  message.value = "";
  editing.value = !!row;
  deviceQuery.value = row?.deviceCode || "";
  deviceId.value = row?.deviceId || "";
  editKind.value = row?.kind || "Alarm";
  expires.value = row?.expires || 3600;
  interval.value = row?.interval || 5;
  enabled.value = row ? !!row.enabled : true;
  await nextTick();
  editor.value?.showModal();
  await loadDevices();
}
async function save() {
  busy.value = true;
  message.value = "";
  try {
    await api(
      "/devices/" + deviceId.value + "/subscriptions/" + editKind.value,
      "PUT",
      {
        enabled: enabled.value,
        expires: expires.value,
        interval: editKind.value === "Alarm" ? 5 : interval.value,
      },
    );
    editor.value?.close();
    message.value = "设置已提交，请以设备应答和通知状态为准。";
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function stop(row: Subscription) {
  busy.value = true;
  message.value = "";
  try {
    await api(
      "/devices/" + row.deviceId + "/subscriptions/" + row.kind,
      "PUT",
      { enabled: false, expires: row.expires, interval: row.interval },
    );
    message.value = "取消请求已提交，正在核实对端状态。";
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function poll() {
  await load();
  if (alive) timer = setTimeout(poll, 5000);
}
async function arm(row: Subscription) {
  busy.value = true;
  try {
    await api(`/devices/${row.deviceId}/subscriptions/Alarm/guard`, "POST", {});
    message.value = "国标布防请求已受理，等待设备业务应答；布防完成后仍需实际触发告警验证。";
    await load();
  } catch (e) { message.value = messageOf(e); }
  finally { busy.value = false; }
}
onMounted(async () => {
  void poll();
  try {
    groups.value = (
      await api<{ items: { id: string; name: string }[] }>("/groups")
    ).items;
    if (!alive) return;
    if (groupId.value && !groups.value.some((g) => g.id === groupId.value)) {
      groupId.value = "";
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
  deviceGeneration++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="subscriptions-view business-page">
    <div class="title">
      <div>
        <h1>设备订阅管理</h1>
        <p>统一管理告警与位置坐标订阅。移动侦测属于告警；移动位置是坐标上报，需要设备提供定位数据。</p>
      </div>
      <button v-if="can('subscriptions.manage')" @click="open()">
        配置订阅
      </button>
    </div>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <p v-if="message && !editor?.open" class="inline-message" role="status">
      {{ message }}
    </p>
    <p class="scope-banner">
      订阅配置不代表设备已经生效。设备接受请求后，仍需收到对应
      NOTIFY；离线设备上线后自动重试。
    </p>
    <div class="panel">
      <div class="panel-heading">
        <h3>订阅任务</h3>
        <span>共 {{ total }} 条 · 每5秒更新</span>
      </div>
      <form
        class="filters business-filters"
        @submit.prevent="
          page = 1;
          load();
        "
      >
        <label
          >设备检索<input
            v-model="q"
            maxlength="100"
            placeholder="设备名称或编号" /></label
        ><label
          >订阅类型<select v-model="kind">
            <option value="">全部类型</option>
            <option value="Alarm">告警订阅</option>
            <option value="MobilePosition">移动位置订阅</option>
          </select></label
        ><label
          >设备分组<select v-model="groupId">
            <option value="">全部授权分组</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select></label
        ><button class="secondary">查询</button>
      </form>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table class="has-actions">
          <thead>
            <tr>
              <th scope="col">设备 / 分组</th>
              <th scope="col">订阅类型</th>
              <th scope="col">状态</th>
              <th scope="col">有效期 / 间隔</th>
              <th scope="col">最近接受 / 到期</th>
              <th scope="col">最近通知</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in items" :key="row.id">
              <td>
                <strong>{{ row.deviceName }}</strong
                ><small>{{ row.deviceCode }} · {{ row.groupName }}</small>
              </td>
              <td>{{ row.kind === "Alarm" ? "告警" : "移动位置" }}</td>
              <td>
                <span
                  class="badge"
                  :class="
                    row.status === 'active'
                      ? 'online'
                      : row.status === 'failed'
                        ? 'offline'
                        : 'pending'
                  "
                  >{{ labels[row.status] || row.status }}</span
                ><small v-if="row.error" class="error-text">{{
                  row.error
                }}</small>
                <small v-if="row.guard">国标布防：{{ row.guard.status === 'succeeded' ? '设备业务应答成功' : row.guard.status === 'failed' ? row.guard.error : row.guard.phase === 'protocol_accepted' ? 'SIP已接受，等待业务应答' : '请求中' }}</small>
              </td>
              <td>
                {{ row.expires }}秒<small>{{
                  row.kind === "MobilePosition"
                    ? row.interval + "秒上报一次"
                    : "事件触发"
                }}</small>
              </td>
              <td class="cell-date">
                {{ time(row.acceptedAt)
                }}<small>{{ time(row.expiresAt) }}</small>
              </td>
              <td class="cell-date">{{ time(row.lastNotifyAt) }}</td>
              <td>
                <div v-if="can('subscriptions.manage')" class="row-actions">
                  <button v-if="row.kind === 'Alarm'" class="link" :disabled="busy || row.guard?.status === 'running'" @click="arm(row)">国标布防</button>
                  <button class="link" :disabled="busy" @click="open(row)">
                    设置</button
                  ><button
                    v-if="row.enabled"
                    class="link danger"
                    :disabled="busy"
                    @click="stop(row)"
                  >
                    停用
                  </button>
                </div>
                <span v-else>只读</span>
              </td>
            </tr>
            <tr v-if="!items.length">
              <td colspan="7" class="empty-state">
                {{
                  loading
                    ? "正在读取订阅…"
                    : loadError
                      ? "订阅读取失败，请稍后重试。"
                      : "暂无订阅配置，可为已建档设备配置告警或移动位置订阅。"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button
          class="secondary"
          :disabled="page === 1 || loading"
          @click="
            page--;
            load();
          "
        >
          上一页</button
        ><span>第 {{ page }} 页 · 共 {{ total }} 条</span
        ><button
          class="secondary"
          :disabled="page * 20 >= total || loading"
          @click="
            page++;
            load();
          "
        >
          下一页
        </button>
      </div>
    </div>
    <dialog
      ref="editor"
      class="subscription-dialog business-dialog"
      @cancel="busy && $event.preventDefault()"
    >
      <form @submit.prevent="save">
        <DialogHeading :disabled="busy">订阅设置</DialogHeading>
        <p v-if="message" class="inline-message" role="status">{{ message }}</p>
        <label
          ><span class="field-label">查找设备</span
          ><input
            :autofocus="!editing"
            v-model="deviceQuery"
            :disabled="editing || busy"
            maxlength="100"
            placeholder="输入名称或编号，最多显示100台"
            @input="loadDevices" /></label
        ><label
          ><span class="field-label">目标设备</span
          ><select v-model="deviceId" required :disabled="editing || busy">
            <option value="" disabled>请选择设备</option>
            <option v-for="d in devices" :key="d.id" :value="d.id">
              {{ d.name }} ·
              {{ d.status === "online" ? "在线" : "离线 / 待注册" }}
            </option>
          </select></label
        ><label
          ><span class="field-label">订阅类型</span
          ><select v-model="editKind" :disabled="editing || busy">
            <option value="Alarm">告警订阅</option>
            <option value="MobilePosition">移动位置订阅</option>
          </select></label
        >
        <div class="form-grid">
          <label
            ><span class="field-label">有效期（秒）</span
            ><input
              :autofocus="editing"
              v-model.number="expires"
              type="number"
              min="30"
              max="86400"
              required
              :disabled="busy" /></label
          ><label v-if="editKind === 'MobilePosition'"
            ><span class="field-label">上报间隔（秒）</span
            ><input
              v-model.number="interval"
              type="number"
              min="1"
              :max="Math.min(3600, expires)"
              required
              :disabled="busy"
          /></label>
        </div>
        <label class="check-label"
          ><input
            v-model="enabled"
            type="checkbox"
            :disabled="busy"
          />启用并自动续订</label
        >
        <p class="panel-note">
          有效期30～86400秒。移动位置指坐标上报，不是移动侦测，间隔不超过有效期。移动侦测需在摄像机配置检测区域、布防时间及上报联动，并通过告警链路送达。设备接受订阅不代表已有事件通知。
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            @click="editor?.close()"
          >
            取消
          </button>
          <button :disabled="busy || !deviceId">
            {{ busy ? "正在提交…" : "保存设置" }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>

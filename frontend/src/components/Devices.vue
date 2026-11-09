<script setup lang="ts">
import { can } from "../api";
import { rememberFilter } from "../remember-filter";
import DialogHeading from "./DialogHeading.vue";
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import AppIcon from "./AppIcon.vue";
import { api, currentUser, messageOf, type Device } from "../api";
const transportDialog = ref<HTMLDialogElement>(),
  transportDevice = ref<Device | null>(null),
  mediaTransport = ref("UDP");
function editTransport(d: Device) {
  transportDevice.value = d;
  mediaTransport.value = d.mediaTransport || "UDP";
  error.value = "";
  transportDialog.value?.showModal();
}
async function saveTransport() {
  if (!transportDevice.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/devices/${transportDevice.value.id}/media-transport`, "PUT", {
      transport: mediaTransport.value,
    });
    transportDialog.value?.close();
    await load();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
const emit = defineEmits<{ preview: [channelId: string] }>();
const deviceActionMenu = ref<HTMLElement>(),
  actionMenuOpen = ref(false),
  actionDevice = ref<Device | null>(null),
  actionMenuPosition = ref({ left: "0px", top: "0px" });
async function openDeviceActions(device: Device, event: MouseEvent) {
  if (currentUser.value?.role !== "admin") return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  actionDevice.value = device;
  actionMenuPosition.value = {
    left: Math.max(12, Math.min(innerWidth - 212, bounds.right - 200)) + "px",
    top:
      Math.max(
        12,
        bounds.bottom + 238 > innerHeight
          ? bounds.top - 230
          : bounds.bottom + 6,
      ) + "px",
  };
  await nextTick();
  if (currentUser.value?.role === "admin") {
    deviceActionMenu.value?.showPopover();
    deviceActionMenu.value
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
  }
}
function onDeviceMenuKey(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(
    deviceActionMenu.value?.querySelectorAll<HTMLButtonElement>("button") || [],
  );
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next]?.focus();
}
function runDeviceAction(
  action: "edit" | "transport" | "credential" | "delete",
) {
  const device = actionDevice.value;
  deviceActionMenu.value?.hidePopover();
  if (!device || currentUser.value?.role !== "admin") return;
  if (action === "edit") edit(device);
  else if (action === "transport") editTransport(device);
  else if (action === "credential") openCredential(device);
  else remove(device);
}
const closeDeviceActions = () => deviceActionMenu.value?.hidePopover();
onMounted(() => {
  window.addEventListener("resize", closeDeviceActions);
  window.addEventListener("wheel", closeDeviceActions, {
    capture: true,
    passive: true,
  });
  window.addEventListener("touchmove", closeDeviceActions, {
    capture: true,
    passive: true,
  });
});
onUnmounted(() => {
  if (typeof window === "undefined") return;
  window.removeEventListener("resize", closeDeviceActions);
  window.removeEventListener("wheel", closeDeviceActions, true);
  window.removeEventListener("touchmove", closeDeviceActions, true);
});
const pageSize = 32;
const groupId = rememberFilter("devices.group", ""),
  groups = ref<{ id: string; name: string }[]>([]);
const summary = ref({
    devices: 0,
    onlineDevices: 0,
    channels: 0,
    liveSessions: 0,
  }),
  filterStatus = rememberFilter("devices.status", "");
const devices = ref<Device[]>([]),
  query = rememberFilter("devices.query", ""),
  page = rememberFilter<number>("devices.page", 1, (value) => value >= 1),
  total = ref(0),
  loading = ref(false),
  message = ref(""),
  error = ref(""),
  busy = ref(false),
  sip = ref("检查中"),
  mediaState = ref("检查中");
const editor = ref<HTMLDialogElement>(),
  credential = ref<HTMLDialogElement>(),
  deletion = ref<HTMLDialogElement>(),
  channelsDialog = ref<HTMLDialogElement>();
const selected = ref<Device | null>(null),
  name = ref(""),
  deviceId = ref(""),
  password = ref("");
const channels = ref<
    { id: string; name: string; channelCode: string; status: string }[]
  >([]),
  channelMessage = ref(""),
  channelDevice = ref<Device | null>(null),
  channelPage = ref(1),
  channelTotal = ref(0),
  channelLoading = ref(false);
const channelPageCount = computed(() =>
  Math.max(1, Math.ceil(channelTotal.value / pageSize)),
);
let generation = 0,
  channelGeneration = 0,
  alive = true,
  timer: ReturnType<typeof setTimeout> | undefined;
const status = (s: string) =>
  ({ online: "在线", offline: "离线", unregistered: "待注册" })[s] || s;
async function load() {
  const n = ++generation;
  loading.value = true;
  message.value = "";
  try {
    const data = await api<{ items: Device[]; total: number }>(
      `/devices?page=${page.value}&pageSize=${pageSize}&q=${encodeURIComponent(query.value.trim())}&status=${filterStatus.value}&groupId=${encodeURIComponent(groupId.value)}`,
    );
    if (n !== generation || !alive) return;
    const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
    if (page.value > lastPage) {
      page.value = lastPage;
      return;
    }
    devices.value = data.items;
    total.value = data.total;
    const snapshot = await api<typeof summary.value>("/overview");
    if (alive && n === generation) summary.value = snapshot;
  } catch (e) {
    if (n === generation) {
      devices.value = [];
      message.value = messageOf(e);
    }
  } finally {
    if (n === generation) loading.value = false;
  }
}
watch(query, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (page.value !== 1) page.value = 1;
    else load();
  }, 250);
});
watch(page, load);
watch(groupId, () => {
  if (page.value !== 1) page.value = 1;
  else load();
});
watch(filterStatus, () => {
  if (page.value !== 1) page.value = 1;
  else load();
});
onMounted(() => {
  api<{ items: { id: string; name: string }[] }>("/groups")
    .then((data) => {
      if (!alive) return;
      groups.value = data.items;
      if (groupId.value && !data.items.some((g) => g.id === groupId.value))
        groupId.value = "";
    })
    .catch((e) => (message.value = messageOf(e)));
  load();
  fetch("/api/health")
    .then((r) => r.json())
    .then(({ data }) => {
      mediaState.value =
        {
          not_configured: "未配置",
          unchecked: "待检查",
          online: "管理接口在线",
          offline: "离线",
        }[data.media as string] || data.media;
      sip.value =
        { disabled: "未启用", listening: "监听中", error: "异常" }[
          data.sip as string
        ] || data.sip;
    })
    .catch(() => (sip.value = "不可用"));
});
onUnmounted(() => {
  alive = false;
  generation++;
  channelGeneration++;
  clearTimeout(timer);
});
function edit(d: Device | null = null) {
  selected.value = d;
  name.value = d?.name || "";
  deviceId.value = d?.deviceId || "";
  error.value = "";
  editor.value?.showModal();
}
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await api(
      selected.value ? "/devices/" + selected.value.id : "/devices",
      selected.value ? "PATCH" : "POST",
      { name: name.value, deviceId: deviceId.value },
    );
    editor.value?.close();
    await load();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
function openCredential(d: Device) {
  selected.value = d;
  password.value = "";
  error.value = "";
  credential.value?.showModal();
}
async function saveCredential() {
  busy.value = true;
  error.value = "";
  try {
    await api("/devices/" + selected.value!.id + "/credential", "PUT", {
      password: password.value,
    });
    password.value = "";
    credential.value?.close();
    message.value = "设备接入密码已更新";
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
function remove(d: Device) {
  selected.value = d;
  error.value = "";
  deletion.value?.showModal();
}
async function confirmRemove() {
  busy.value = true;
  error.value = "";
  try {
    await api("/devices/" + selected.value!.id, "DELETE");
    deletion.value?.close();
    await load();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function showChannels(d: Device) {
  channelDevice.value = d;
  channelPage.value = 1;
  channelTotal.value = 0;
  channelsDialog.value?.showModal();
  await loadChannels(1);
}
async function loadChannels(targetPage = channelPage.value) {
  const d = channelDevice.value;
  if (!d) return;
  const gen = ++channelGeneration;
  channels.value = [];
  channelLoading.value = true;
  channelMessage.value = "正在加载…";
  try {
    const data = await api<{ items: typeof channels.value; total: number }>(
      `/devices/${d.id}/channels?page=${targetPage}&pageSize=${pageSize}`,
    );
    if (!alive || gen !== channelGeneration) return;
    const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
    if (targetPage > lastPage) return loadChannels(lastPage);
    channels.value = data.items;
    channelPage.value = targetPage;
    channelTotal.value = data.total;
    channelMessage.value = data.total
      ? `共 ${data.total} 路通道 · 每页 ${pageSize} 路`
      : "暂无通道，请上线后同步目录";
  } catch (e) {
    if (alive && gen === channelGeneration) channelMessage.value = messageOf(e);
  } finally {
    if (alive && gen === channelGeneration) channelLoading.value = false;
  }
}
function changeChannelPage(value: number) {
  if (!channelLoading.value && value >= 1 && value <= channelPageCount.value)
    void loadChannels(value);
}
function closeChannels() {
  if (!channelsDialog.value?.open) {
    channelGeneration++;
    channelLoading.value = false;
  }
}
const syncing = ref(new Set<string>());
async function sync(d: Device) {
  syncing.value.add(d.id);
  try {
    const { taskId } = await api<{ taskId: string }>(
      "/devices/" + d.id + "/catalog-sync",
      "POST",
      {},
    );
    message.value = "已提交同步任务，等待设备响应…";
    for (let i = 0; i < 25 && alive; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!alive) return;
      const task = await api<{ status: string; error?: string }>(
        "/tasks/" + taskId,
      );
      if (task.status === "succeeded") {
        await load();
        message.value = "目录同步成功";
        return;
      }
      if (task.status === "failed") throw Error(task.error || "同步失败");
    }
    if (alive) message.value = "等待超时，请稍后刷新查看";
  } catch (e) {
    if (alive) message.value = messageOf(e);
  } finally {
    syncing.value.delete(d.id);
  }
}
</script>
<template>
  <section class="business-page" id="devices-view">
    <div class="title device-page-heading">
      <div>
        <h1>国标设备管理</h1>
        <p>集中管理设备档案、接入状态与视频通道资源。</p>
      </div>
      <button v-if="currentUser?.role === 'admin'" @click="edit()">
        <AppIcon name="plus" :size="16" />添加设备
      </button>
    </div>
    <div class="stats device-overview" aria-label="设备资源概览">
      <article>
        <span class="stat-icon"><AppIcon name="devices" :size="22" /></span>
        <label>设备总数</label
        ><strong>{{ summary.devices }}<small>台</small></strong
        ><span class="stat-foot">已纳入管理的国标设备</span>
      </article>
      <article>
        <span class="stat-icon"><AppIcon name="monitoring" :size="22" /></span>
        <label>在线设备</label
        ><strong class="success-text"
          >{{ summary.onlineDevices }}<small>台</small></strong
        ><span class="stat-foot">SIP 服务：{{ sip }}</span>
      </article>
      <article>
        <span class="stat-icon"><AppIcon name="cascade" :size="22" /></span>
        <label>视频通道</label
        ><strong>{{ summary.channels }}<small>路</small></strong
        ><span class="stat-foot">通过设备目录同步获取</span>
      </article>
      <article>
        <span class="stat-icon"><AppIcon name="records" :size="22" /></span>
        <label>点播会话</label
        ><strong>{{ summary.liveSessions }}<small>路</small></strong
        ><span class="stat-foot">媒体节点：{{ mediaState }}</span>
      </article>
    </div>
    <div class="panel device-resource-panel">
      <div class="panel-heading">
        <h3>设备资源列表</h3>
        <span>共 {{ total }} 条记录</span>
      </div>
      <div class="toolbar business-filters device-filters">
        <label class="inline-field device-search-field"
          >设备检索<input
            v-model="query"
            placeholder="请输入设备名称或国标编号"
            aria-label="搜索设备"
            maxlength="100" /></label
        ><label class="inline-field device-status-field"
          >设备状态<select v-model="filterStatus">
            <option value="">全部状态</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
            <option value="unregistered">待注册</option>
          </select></label
        ><label class="inline-field device-group-field"
          >设备分组<select v-model="groupId">
            <option value="">全部授权分组</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select></label
        ><button class="secondary" :disabled="loading" @click="load">
          <AppIcon name="refresh" :size="15" />刷新列表
        </button>
        <button
          class="link device-reset-filter"
          :disabled="!query && !filterStatus && !groupId"
          @click="
            query = '';
            filterStatus = '';
            groupId = '';
            page = 1;
          "
        >
          重置
        </button>
      </div>
      <p role="status">{{ loading ? "正在加载设备…" : message }}</p>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table class="has-actions device-resource-table">
          <thead>
            <tr>
              <th scope="col">设备信息</th>
              <th scope="col">接入状态</th>
              <th scope="col">所属分组</th>
              <th scope="col">通道数量</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in devices" :key="d.id">
              <td>
                <span class="device-identity"
                  ><span class="device-list-icon"
                    ><AppIcon name="devices" :size="17" /></span
                  ><span class="device-identity-copy"
                    ><b :title="d.name">{{ d.name }}</b
                    ><small class="mono">{{ d.deviceId }}</small></span
                  ></span
                >
              </td>
              <td>
                <span class="badge" :class="d.status">{{
                  status(d.status)
                }}</span>
              </td>
              <td>
                <span class="device-group-label">{{ d.groupName }}</span>
              </td>
              <td>
                <span class="device-channel-count">{{ d.channels }}</span
                ><small class="device-channel-unit">路</small>
              </td>
              <td>
                <div class="device-actions">
                  <button
                    class="link device-channels-action"
                    @click="showChannels(d)"
                  >
                    通道
                  </button>
                  <template v-if="currentUser?.role === 'admin'">
                    <button
                      class="link"
                      :disabled="d.status !== 'online' || syncing.has(d.id)"
                      @click="sync(d)"
                    >
                      {{ syncing.has(d.id) ? "同步中…" : "同步目录" }}
                    </button>
                    <button
                      class="link device-more-action"
                      :aria-label="d.name + '更多操作'"
                      aria-haspopup="menu"
                      aria-controls="device-maintenance-menu"
                      :aria-expanded="
                        actionDevice?.id === d.id && actionMenuOpen
                      "
                      @click="openDeviceActions(d, $event)"
                    >
                      更多<AppIcon name="chevron" :size="13" />
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!loading && !message && !devices.length" id="empty">
        {{ query ? "没有匹配的设备" : "暂无设备，请添加设备档案。" }}
      </div>
      <div class="pagination">
        <button
          class="secondary"
          :disabled="page === 1 || loading"
          @click="page--"
        >
          上一页</button
        ><span
          >第 {{ page }} 页 · 共 {{ total }} 条 · 每页 {{ pageSize }} 条</span
        ><button
          class="secondary"
          :disabled="page * pageSize >= total || loading"
          @click="page++"
        >
          下一页
        </button>
      </div>
    </div>
    <p class="note">
      接入说明：新增档案后，请配置设备接入密码；设备完成注册后可同步目录并发起预览。
    </p>
  </section>
  <Teleport to="body">
    <div
      ref="deviceActionMenu"
      id="device-maintenance-menu"
      popover="auto"
      class="device-maintenance-menu"
      :style="actionMenuPosition"
      role="menu"
      aria-label="设备维护操作"
      @toggle="actionMenuOpen = ($event as ToggleEvent).newState === 'open'"
      @keydown="onDeviceMenuKey"
    >
      <template v-if="actionDevice && currentUser?.role === 'admin'">
        <p class="device-maintenance-heading" :title="actionDevice.name">
          {{ actionDevice.name }}
        </p>
        <button type="button" role="menuitem" @click="runDeviceAction('edit')">
          <AppIcon name="devices" :size="15" />编辑设备
        </button>
        <button
          type="button"
          role="menuitem"
          @click="runDeviceAction('transport')"
        >
          <AppIcon name="config" :size="15" />传输设置
        </button>
        <button
          type="button"
          role="menuitem"
          @click="runDeviceAction('credential')"
        >
          <AppIcon name="lock" :size="15" />接入密码
        </button>
        <div class="device-menu-divider"></div>
        <button
          type="button"
          class="device-menu-danger"
          role="menuitem"
          @click="runDeviceAction('delete')"
        >
          <AppIcon name="close" :size="15" />删除设备
        </button>
      </template>
    </div>
  </Teleport>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="editor"
  >
    <form @submit.prevent="save">
      <DialogHeading :disabled="busy">{{
        selected ? "编辑设备档案" : "添加设备档案"
      }}</DialogHeading>
      <label
        ><span class="field-label">设备名称</span
        ><input autofocus v-model="name" required maxlength="100" /></label
      ><label
        ><span class="field-label">国标设备编号</span
        ><input
          v-model="deviceId"
          :disabled="!!selected"
          required
          pattern="[0-9]{20}"
          maxlength="20"
      /></label>
      <p class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="editor?.close()"
        >
          取消</button
        ><button :disabled="busy">保存设备</button>
      </div>
    </form>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="credential"
  >
    <form @submit.prevent="saveCredential">
      <DialogHeading :disabled="busy">设置设备接入密码</DialogHeading>
      <p>请在摄像机或 NVR 中配置相同密码，保存后不能回读明文。</p>
      <label
        ><span class="field-label">接入密码</span
        ><input
          autofocus
          v-model="password"
          type="password"
          required
          minlength="8"
          maxlength="128"
          autocomplete="new-password"
      /></label>
      <p class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="credential?.close()"
        >
          取消</button
        ><button :disabled="busy">保存密码</button>
      </div>
    </form>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="deletion"
  >
    <DialogHeading :disabled="busy">删除设备档案</DialogHeading>
    <p>{{ selected?.name }}（{{ selected?.deviceId }}）</p>
    <p>将删除本地档案，操作记入审计日志。</p>
    <p class="error" role="alert">{{ error }}</p>
    <div class="actions">
      <button :disabled="busy" class="secondary" @click="deletion?.close()">
        取消</button
      ><button class="danger" :disabled="busy" @click="confirmRemove">
        确认删除
      </button>
    </div>
  </dialog>
  <dialog
    class="business-dialog"
    ref="channelsDialog"
    id="channels-dialog"
    @close="closeChannels"
  >
    <DialogHeading :disabled="busy"
      >设备通道 · {{ channelDevice?.name }}</DialogHeading
    >
    <p class="muted mono">{{ channelDevice?.deviceId }}</p>
    <p role="status">{{ channelMessage }}</p>
    <div
      class="table-scroll data-table-scroll"
      tabindex="0"
      role="region"
      aria-label="表格内容，可横向滚动"
    >
      <table class="has-actions" v-if="channels.length">
        <thead>
          <tr>
            <th scope="col">通道名称</th>
            <th scope="col">国标编号</th>
            <th scope="col">状态</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in channels" :key="c.id">
            <td>{{ c.name }}</td>
            <td class="mono">{{ c.channelCode }}</td>
            <td>
              <span class="badge" :class="c.status">{{
                status(c.status)
              }}</span>
            </td>
            <td>
              <button
                class="link"
                :disabled="
                  c.status !== 'online' ||
                  channelDevice?.status !== 'online' ||
                  !can('live.preview')
                "
                @click="
                  channelsDialog?.close();
                  emit('preview', c.id);
                "
              >
                实时预览
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav class="channel-dialog-pagination" aria-label="设备通道分页">
      <button
        class="secondary"
        :disabled="channelLoading || channelPage <= 1"
        @click="changeChannelPage(channelPage - 1)"
      >
        上一页
      </button>
      <span>第 {{ channelPage }} / {{ channelPageCount }} 页</span>
      <button
        class="secondary"
        :disabled="channelLoading || channelPage >= channelPageCount"
        @click="changeChannelPage(channelPage + 1)"
      >
        下一页
      </button>
      <button class="link" :disabled="channelLoading" @click="loadChannels()">
        刷新通道
      </button>
    </nav>
    <div class="actions">
      <button class="secondary" @click="channelsDialog?.close()">关闭</button>
    </div>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="transportDialog"
  >
    <form @submit.prevent="saveTransport">
      <DialogHeading :disabled="busy">设备传输设置</DialogHeading>
      <p>
        {{ transportDevice?.name }} · 信令
        {{ transportDevice?.sipTransport || "UDP" }}（由注册连接确定）
      </p>
      <label
        ><span class="field-label">媒体传输</span
        ><select autofocus v-model="mediaTransport">
          <option value="UDP">UDP</option>
          <option value="TCP-PASSIVE">TCP 被动接收（设备主动连接）</option>
          <option value="TCP-ACTIVE">TCP 主动接收（连接设备）</option>
        </select></label
      >
      <p class="panel-note">
        需先结束此设备的点播和录像任务。TCP主动模式限定连接到设备注册IP。
      </p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="transportDialog?.close()"
        >
          取消</button
        ><button :disabled="busy">保存设置</button>
      </div>
    </form>
  </dialog>
</template>

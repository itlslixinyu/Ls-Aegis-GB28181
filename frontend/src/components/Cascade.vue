<script setup lang="ts">
import { rememberFilter } from "../remember-filter";
import DialogHeading from "./DialogHeading.vue";
import AppIcon from "./AppIcon.vue";
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, messageOf } from "../api";
import type { Channel } from "./Monitoring.vue";
interface Platform {
  sipTransport: string;
  id: string;
  name: string;
  serverId: string;
  localId: string;
  domain: string;
  host: string;
  port: number;
  mediaHost: string;
  expires: number;
  heartbeat: number;
  status: string;
  enabled: number;
  registeredUntil: number;
  lastError?: string;
}
interface Share {
  channelId: string;
  alias: string;
  name?: string;
  channelCode?: string;
  deviceName?: string;
}
const items = ref<Platform[]>([]),
  message = ref(""),
  busy = ref(false),
  error = ref(""),
  editor = ref<HTMLDialogElement>(),
  sharesDialog = ref<HTMLDialogElement>(),
  deleteDialog = ref<HTMLDialogElement>(),
  selected = ref<Platform | null>(null),
  query = rememberFilter("cascade.query", "");
const form = ref({
  name: "",
  serverId: "",
  domain: "",
  localId: "",
  host: "",
  port: 5060,
  mediaHost: "",
  expires: 3600,
  heartbeat: 60,
  password: "",
  sipTransport: "UDP",
});
const shareReady = ref(false);
let alive = true,
  shareGeneration = 0;
onUnmounted(() => {
  alive = false;
  shareGeneration++;
});
const channels = ref<Share[]>([]),
  sharing = ref<Record<string, string>>({});
const filtered = computed(() =>
  channels.value.filter((c) =>
    ((c.name || "") + (c.channelCode || "") + (c.deviceName || ""))
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
async function load() {
  try {
    items.value = (
      await api<{ items: Platform[] }>("/cascade/platforms")
    ).items;
    message.value = "";
  } catch (e) {
    message.value = messageOf(e);
  }
}
onMounted(load);
function edit(item: Platform | null = null) {
  selected.value = item;
  error.value = "";
  form.value = item
    ? {
        name: item.name,
        serverId: item.serverId,
        domain: item.domain,
        localId: item.localId,
        host: item.host,
        port: item.port,
        mediaHost: item.mediaHost,
        expires: item.expires,
        heartbeat: item.heartbeat,
        password: "",
        sipTransport: item.sipTransport || "UDP",
      }
    : {
        name: "",
        serverId: "",
        domain: "",
        localId: "",
        host: "",
        port: 5060,
        mediaHost: "",
        expires: 3600,
        heartbeat: 60,
        password: "",
        sipTransport: "UDP",
      };
  editor.value?.showModal();
}
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await api(
      "/cascade/platforms" + (selected.value ? "/" + selected.value.id : ""),
      selected.value ? "PUT" : "POST",
      form.value,
    );
    form.value.password = "";
    editor.value?.close();
    await load();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function register(item: Platform, stop = false) {
  busy.value = true;
  message.value = stop ? "正在注销上级平台…" : "正在注册上级平台…";
  try {
    await api(
      `/cascade/platforms/${item.id}/${stop ? "unregister" : "register"}`,
      "POST",
      {},
    );
    await load();
    message.value = stop ? "平台已注销，相关转发已停止" : "平台注册成功";
  } catch (e) {
    await load();
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function openShares(item: Platform) {
  const gen = ++shareGeneration;
  shareReady.value = false;
  selected.value = item;
  error.value = "";
  query.value = "";
  sharing.value = {};
  channels.value = [];
  sharesDialog.value?.showModal();
  busy.value = true;
  try {
    const [available, assigned] = await Promise.all([
      api<{ items: Channel[] }>("/channels"),
      api<{ items: Share[] }>(`/cascade/platforms/${item.id}/channels`),
    ]);
    if (!alive || gen !== shareGeneration) return;
    channels.value = available.items.map((c) => ({
      channelId: c.id,
      name: c.name,
      channelCode: c.channelCode,
      deviceName: c.deviceName,
      alias: c.channelCode,
    }));
    for (const c of assigned.items) {
      sharing.value[c.channelId] = c.alias;
      if (!channels.value.some((x) => x.channelId === c.channelId))
        channels.value.push(c);
    }
    shareReady.value = true;
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
function toggleShare(channel: Share, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const next = { ...sharing.value };
  if (checked) next[channel.channelId] = channel.alias;
  else delete next[channel.channelId];
  sharing.value = next;
}
async function saveShares() {
  if (!selected.value || !shareReady.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/cascade/platforms/${selected.value.id}/channels`, "PUT", {
      items: Object.entries(sharing.value).map(([channelId, alias]) => ({
        channelId,
        alias,
      })),
    });
    sharesDialog.value?.close();
    message.value = "共享通道已保存，未选通道不会向该平台开放";
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
function remove(item: Platform) {
  selected.value = item;
  error.value = "";
  deleteDialog.value?.showModal();
}
async function confirmRemove() {
  busy.value = true;
  error.value = "";
  try {
    await api(`/cascade/platforms/${selected.value!.id}`, "DELETE");
    deleteDialog.value?.close();
    await load();
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="business-page" id="cascade-view">
    <div class="title">
      <div>
        <h1>国标级联管理</h1>
        <p>向上级平台注册，仅共享指定通道；支持 UDP / TCP 国标信令。</p>
      </div>
      <button @click="edit()">
        <AppIcon name="plus" :size="16" />添加上级平台
      </button>
    </div>
    <div class="panel">
      <div class="panel-heading">
        <h3>上级平台列表</h3>
        <button class="link" :disabled="busy" @click="load">刷新</button>
      </div>
      <p v-if="message" class="inline-message" role="status">{{ message }}</p>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table class="has-actions">
          <thead>
            <tr>
              <th scope="col">平台名称</th>
              <th scope="col">上级国标编号</th>
              <th scope="col">服务器地址</th>
              <th scope="col">注册状态</th>
              <th scope="col">最近异常</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in items" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="mono">{{ p.serverId }}</td>
              <td class="mono">{{ p.host }}:{{ p.port }}</td>
              <td>
                <span
                  class="badge"
                  :class="
                    p.status === 'online'
                      ? 'online'
                      : p.enabled
                        ? 'offline'
                        : 'unregistered'
                  "
                  >{{ p.status === "online" ? "已注册" : "未注册" }}</span
                >
              </td>
              <td class="error-cell">{{ p.lastError || "—" }}</td>
              <td>
                <button
                  class="link"
                  :disabled="busy || p.status === 'online'"
                  @click="register(p)"
                >
                  注册</button
                ><button
                  class="link"
                  :disabled="busy || !p.enabled"
                  @click="register(p, true)"
                >
                  注销</button
                ><button class="link" :disabled="busy" @click="openShares(p)">
                  共享通道</button
                ><button
                  class="link"
                  :disabled="busy || p.status === 'online'"
                  @click="edit(p)"
                >
                  编辑</button
                ><button
                  class="link danger-text"
                  :disabled="busy || p.status === 'online'"
                  @click="remove(p)"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!items.length" class="empty-state">
        <span class="empty-symbol"><AppIcon name="cascade" :size="32" /></span
        ><b>尚未添加上级平台</b>
        <p>添加后配置共享通道，再执行注册。</p>
      </div>
    </div>
  </section>
  <dialog
    @cancel="busy && $event.preventDefault()"
    ref="editor"
    class="wide-dialog business-dialog"
  >
    <form @submit.prevent="save">
      <DialogHeading :disabled="busy">{{
        selected ? "编辑上级平台" : "添加上级平台"
      }}</DialogHeading>
      <div class="form-grid">
        <label
          ><span class="field-label">平台名称</span
          ><input
            autofocus
            v-model="form.name"
            required
            maxlength="100" /></label
        ><label
          ><span class="field-label">上级国标编号</span
          ><input
            v-model="form.serverId"
            required
            pattern="[0-9]{20}"
            maxlength="20" /></label
        ><label
          ><span class="field-label">本平台接入编号</span
          ><input
            v-model="form.localId"
            required
            pattern="[0-9]{20}"
            maxlength="20" /></label
        ><label
          ><span class="field-label">认证域</span
          ><input
            v-model="form.domain"
            required
            pattern="[0-9]{10}"
            maxlength="10" /></label
        ><label
          ><span class="field-label">信令传输</span
          ><select v-model="form.sipTransport">
            <option value="UDP">UDP</option>
            <option value="TCP">TCP</option>
          </select></label
        ><label
          ><span class="field-label">上级服务器 IPv4</span
          ><input
            v-model="form.host"
            required
            placeholder="例如：192.168.1.20" /></label
        ><label
          ><span class="field-label">SIP端口</span
          ><input
            v-model.number="form.port"
            type="number"
            min="1"
            max="65535"
            required /></label
        ><label
          ><span class="field-label">上级媒体接收 IPv4</span
          ><input
            v-model="form.mediaHost"
            placeholder="留空时使用上级服务器地址" /></label
        ><label
          ><span class="field-label">注册密码</span
          ><input
            v-model="form.password"
            type="password"
            :required="!selected"
            minlength="8"
            maxlength="128"
            autocomplete="new-password"
            :placeholder="selected ? '留空保持原密码' : ''" /></label
        ><label
          ><span class="field-label">注册周期（秒）</span
          ><input
            v-model.number="form.expires"
            type="number"
            min="60"
            max="86400"
            required /></label
        ><label
          ><span class="field-label">心跳周期（秒）</span
          ><input
            v-model.number="form.heartbeat"
            type="number"
            min="10"
            max="300"
            required
        /></label>
      </div>
      <p class="note">
        认证域须与上级 Digest realm
        一致；上级媒体地址限定转发目的地。保存后需点击“注册”。
      </p>
      <p class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="editor?.close()"
        >
          取消</button
        ><button :disabled="busy">保存</button>
      </div>
    </form>
  </dialog>
  <dialog ref="sharesDialog" class="wide-dialog business-dialog">
    <form @submit.prevent="saveShares">
      <DialogHeading :disabled="busy"
        >共享通道 · {{ selected?.name }}</DialogHeading
      >
      <p>勾选通道并设置上级可见的20位国标编号；默认沿用原通道编号。</p>
      <input
        autofocus
        v-model="query"
        placeholder="筛选设备或通道"
        aria-label="筛选共享通道"
      />
      <div class="share-table">
        <div
          class="table-scroll data-table-scroll"
          tabindex="0"
          role="region"
          aria-label="表格内容，可横向滚动"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">共享</th>
                <th scope="col">设备 / 通道</th>
                <th scope="col">上级可见编号</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in filtered" :key="c.channelId">
                <td>
                  <input
                    type="checkbox"
                    :aria-label="`共享 ${c.name || c.channelId}`"
                    :checked="Object.hasOwn(sharing, c.channelId)"
                    @change="toggleShare(c, $event)"
                  />
                </td>
                <td>{{ c.deviceName }} / {{ c.name || c.channelId }}</td>
                <td>
                  <input
                    v-if="Object.hasOwn(sharing, c.channelId)"
                    v-model="sharing[c.channelId]"
                    required
                    pattern="[0-9]{20}"
                    maxlength="20"
                    aria-label="上级通道编号"
                  /><span v-else class="mono">{{
                    c.channelCode || c.alias
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!channels.length" class="empty-state">
          {{
            busy
              ? "正在读取共享配置…"
              : !shareReady
                ? "共享配置未能读取，已禁止保存，请关闭后重试。"
                : "暂无可共享通道，请先同步设备目录。"
          }}
        </div>
      </div>
      <p class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="button" class="secondary" @click="sharesDialog?.close()">
          取消</button
        ><button :disabled="busy || !shareReady">保存共享配置</button>
      </div>
    </form>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="deleteDialog"
  >
    <DialogHeading :disabled="busy">删除上级平台</DialogHeading>
    <p>确认删除“{{ selected?.name }}”？平台须先注销并完成资源回收。</p>
    <p class="error" role="alert">{{ error }}</p>
    <div class="actions">
      <button :disabled="busy" class="secondary" @click="deleteDialog?.close()">
        取消</button
      ><button class="danger" :disabled="busy" @click="confirmRemove">
        确认删除
      </button>
    </div>
  </dialog>
</template>

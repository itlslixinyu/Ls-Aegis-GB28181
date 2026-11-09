<script setup lang="ts">
import DialogHeading from "./DialogHeading.vue";
import AppIcon from "./AppIcon.vue";
import { ref, onMounted, onUnmounted } from "vue";
import {
  api,
  ApiError,
  messageOf,
  type Device,
  roleLabel,
  type User,
} from "../api";
interface Group {
  id: string;
  name: string;
  description: string;
  devices: number;
}
const groups = ref<Group[]>([]),
  users = ref<User[]>([]),
  message = ref(""),
  busy = ref(false),
  selected = ref<Group | null>(null),
  editor = ref<HTMLDialogElement>(),
  assignment = ref<HTMLDialogElement>(),
  permission = ref<HTMLDialogElement>(),
  deletion = ref<HTMLDialogElement>(),
  name = ref(""),
  description = ref(""),
  devices = ref<Device[]>([]),
  deviceTotal = ref(0),
  page = ref(1),
  query = ref(""),
  selectedIds = ref<string[]>([]),
  userId = ref(""),
  grantIds = ref<string[]>([]),
  grantLoading = ref(false),
  grantReady = ref(false),
  grantVersion = ref(0);
const grantAll = ref(false);
const deviceLoading = ref(false),
  deviceReady = ref(false),
  deviceError = ref("");
let grantGeneration = 0,
  deviceGeneration = 0,
  loadGeneration = 0,
  alive = true;
onUnmounted(() => {
  alive = false;
  grantGeneration++;
  deviceGeneration++;
  loadGeneration++;
});
async function load() {
  const gen = ++loadGeneration;
  try {
    const [groupResult, userResult] = await Promise.all([
      api<{ items: Group[] }>("/groups"),
      api<{ items: User[] }>("/users"),
    ]);
    if (!alive || gen !== loadGeneration) return;
    groups.value = groupResult.items;
    users.value = userResult.items;
  } catch (e) {
    if (alive && gen === loadGeneration) message.value = messageOf(e);
  }
}
onMounted(load);
function edit(g: Group | null = null) {
  selected.value = g;
  name.value = g?.name || "";
  description.value = g?.description || "";
  message.value = "";
  editor.value?.showModal();
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await api(
      "/groups" + (selected.value ? "/" + selected.value.id : ""),
      selected.value ? "PUT" : "POST",
      { name: name.value, description: description.value },
    );
    editor.value?.close();
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function loadDevices() {
  const gen = ++deviceGeneration;
  deviceLoading.value = true;
  deviceReady.value = false;
  deviceError.value = "";
  try {
    const data = await api<{ items: Device[]; total: number }>(
      `/devices?page=${page.value}&pageSize=20&q=${encodeURIComponent(query.value)}`,
    );
    if (!alive || gen !== deviceGeneration) return;
    devices.value = data.items;
    deviceTotal.value = data.total;
    deviceReady.value = true;
  } catch (e) {
    if (alive && gen === deviceGeneration) {
      devices.value = [];
      deviceTotal.value = 0;
      deviceError.value = messageOf(e);
    }
  } finally {
    if (alive && gen === deviceGeneration) deviceLoading.value = false;
  }
}
async function assign(g: Group) {
  selected.value = g;
  selectedIds.value = [];
  page.value = 1;
  query.value = "";
  message.value = "";
  devices.value = [];
  deviceTotal.value = 0;
  assignment.value?.showModal();
  await loadDevices();
}
function closeAssignment() {
  if (assignment.value?.open) return;
  deviceGeneration++;
  deviceLoading.value = false;
  deviceReady.value = false;
}
async function move() {
  if (
    !selected.value ||
    busy.value ||
    deviceLoading.value ||
    !deviceReady.value ||
    !selectedIds.value.length
  )
    return;
  busy.value = true;
  message.value = "";
  try {
    await api(`/groups/${selected.value.id}/devices`, "PUT", {
      deviceIds: selectedIds.value,
    });
    assignment.value?.close();
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
function permissions() {
  grantGeneration++;
  grantLoading.value = false;
  grantReady.value = false;
  message.value = "";
  userId.value = "";
  grantIds.value = [];
  permission.value?.showModal();
}
async function readGrants() {
  const gen = ++grantGeneration;
  grantIds.value = [];
  grantReady.value = false;
  grantLoading.value = true;
  message.value = "";
  try {
    const data = await api<{
      groupIds: string[];
      scopeMode?: string;
      version?: number;
    }>(`/users/${userId.value}/groups`);
    if (alive && gen === grantGeneration) {
      grantIds.value = data.groupIds;
      grantAll.value = data.scopeMode === "all";
      grantVersion.value = data.version ?? 0;
      grantReady.value = true;
    }
  } catch (e) {
    if (alive && gen === grantGeneration) message.value = messageOf(e);
  } finally {
    if (alive && gen === grantGeneration) grantLoading.value = false;
  }
}
async function saveGrants() {
  if (busy.value || grantLoading.value || !grantReady.value || !userId.value)
    return;
  busy.value = true;
  message.value = "";
  try {
    await api(`/users/${userId.value}/groups`, "PUT", {
      groupIds: grantIds.value,
      version: grantVersion.value,
    });
    permission.value?.close();
    await load();
  } catch (e) {
    message.value = messageOf(e);
    if (e instanceof ApiError && e.code === "AUTHORIZATION_CONFLICT")
      grantReady.value = false;
  } finally {
    busy.value = false;
  }
}
function remove(g: Group) {
  selected.value = g;
  message.value = "";
  deletion.value?.showModal();
}
async function confirmRemove() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  try {
    await api("/groups/" + selected.value.id, "DELETE");
    deletion.value?.close();
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="business-page" id="groups-view">
    <div class="title">
      <div>
        <h1>设备分组与授权</h1>
        <p>设备按分组归属，只读用户仅可访问被授权分组中的资源。</p>
      </div>
      <div class="row-actions">
        <button class="secondary" @click="permissions">用户分组授权</button
        ><button @click="edit()">
          <AppIcon name="plus" :size="16" />新建设备分组
        </button>
      </div>
    </div>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <div class="scope-banner">
      <b>权限规则</b
      ><span
        >管理员全局管理；新建只读用户默认无设备访问权限。撤销授权会终止相关播放和文件下载。</span
      >
    </div>
    <div class="panel group-table">
      <div class="panel-heading">
        <h3>设备分组</h3>
        <span>{{ groups.length }} 个分组</span>
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
              <th scope="col">分组名称</th>
              <th scope="col" class="group-description">分组说明</th>
              <th scope="col">设备数量</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.id">
              <td>
                <span class="group-name-content">
                  <b>{{ g.name }}</b>
                  <span v-if="g.id === 'default'" class="badge unregistered">默认</span>
                </span>
              </td>
              <td class="group-description">{{ g.description || "—" }}</td>
              <td>{{ g.devices }} 台</td>
              <td class="row-actions">
                <button class="link" @click="assign(g)">移入设备</button
                ><button class="link" :disabled="busy" @click="edit(g)">
                  编辑</button
                ><button
                  class="link danger-text"
                  :disabled="g.id === 'default' || g.devices > 0"
                  @click="remove(g)"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="panel-note">
        默认分组可编辑名称和说明，但不可删除。其他分组删除前需移出设备并清空授权；分组调整会即时影响资源访问范围。
      </p>
    </div>
  </section>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="editor"
  >
    <form @submit.prevent="save">
      <DialogHeading :disabled="busy">{{
        selected ? "编辑设备分组" : "新建设备分组"
      }}</DialogHeading>
      <p v-if="selected?.id === 'default'" class="profile-help">
        默认分组的名称和说明可以修改；设备归属和已有分组授权保持不变。
      </p>
      <label
        ><span class="field-label">分组名称</span
        ><input autofocus v-model="name" required maxlength="80" /></label
      ><label
        ><span class="field-label">分组说明</span
        ><textarea v-model="description" rows="3" maxlength="300" />
      </label>
      <p v-if="message" class="error">{{ message }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="editor?.close()"
        >
          取消</button
        ><button :disabled="busy">保存分组</button>
      </div>
    </form>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    ref="assignment"
    @close="closeAssignment"
    class="group-dialog business-dialog"
  >
    <DialogHeading :disabled="busy"
      >移入设备 · {{ selected?.name }}</DialogHeading
    >
    <p>选中设备移入本组，未选设备保持原归属。每次最多200台。</p>
    <form
      class="toolbar"
      @submit.prevent="
        page = 1;
        loadDevices();
      "
    >
      <input
        autofocus
        v-model="query"
        aria-label="查找设备"
        placeholder="设备名称或国标编号"
        maxlength="100"
        :disabled="busy"
      /><button :disabled="busy" class="secondary">查询</button
      ><span>已选择 {{ selectedIds.length }} 台</span>
    </form>
    <p v-if="deviceLoading" role="status">正在读取设备…</p>
    <p v-if="deviceError" class="error" role="alert">
      {{ deviceError }}，请重新查询后再移入。
    </p>
    <div
      class="table-scroll data-table-scroll"
      tabindex="0"
      role="region"
      aria-label="表格内容，可横向滚动"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">选择</th>
            <th scope="col">设备名称</th>
            <th scope="col">当前分组</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in devices" :key="d.id">
            <td>
              <input
                v-model="selectedIds"
                type="checkbox"
                :value="d.id"
                :aria-label="`选择${d.name}`"
                :disabled="
                  busy ||
                  deviceLoading ||
                  !deviceReady ||
                  (!selectedIds.includes(d.id) && selectedIds.length >= 200)
                "
              />
            </td>
            <td>
              {{ d.name
              }}<small class="muted block mono">{{ d.deviceId }}</small>
            </td>
            <td>{{ d.groupName }}</td>
          </tr>
          <tr v-if="!deviceLoading && !deviceError && !devices.length">
            <td colspan="3" class="empty">未找到设备</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="pager">
      <button
        class="secondary"
        :disabled="busy || deviceLoading || !deviceReady || page <= 1"
        @click="
          page--;
          loadDevices();
        "
      >
        上一页</button
      ><span
        >第 {{ page }} 页 ·
        {{
          deviceLoading
            ? "读取中"
            : deviceError
              ? "数量未获取"
              : deviceTotal + " 台"
        }}</span
      ><button
        class="secondary"
        :disabled="
          busy || deviceLoading || !deviceReady || page * 20 >= deviceTotal
        "
        @click="
          page++;
          loadDevices();
        "
      >
        下一页
      </button>
    </div>
    <p v-if="message" class="error">{{ message }}</p>
    <div class="actions">
      <button :disabled="busy" class="secondary" @click="assignment?.close()">
        取消</button
      ><button
        :disabled="busy || deviceLoading || !deviceReady || !selectedIds.length"
        @click="move"
      >
        确认移入
      </button>
    </div>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    ref="permission"
    class="group-dialog business-dialog"
  >
    <DialogHeading :disabled="busy">用户分组授权</DialogHeading>
    <label
      ><span class="field-label">业务账号</span
      ><select autofocus v-model="userId" :disabled="busy" @change="readGrants">
        <option disabled value="">请选择用户</option>
        <option
          v-for="u in users.filter((u) => u.role === 'viewer')"
          :key="u.id"
          :value="u.id"
        >
          {{ u.username }} · {{ roleLabel(u) }}
        </option>
      </select></label
    >
    <p class="panel-note">
      保存将替换所选用户的全部分组授权；清空表示无设备访问权限。管理员始终具有全局权限。
    </p>
    <p v-if="grantAll && grantReady" class="panel-note">
      该账号当前具有全部设备范围；在此保存后将改为指定设备分组。功能角色请在用户管理的“授权”中维护。
    </p>
    <fieldset
      class="grant-options"
      :disabled="!userId || grantLoading || busy || !grantReady"
    >
      <legend>允许访问的设备分组</legend>
      <label v-for="g in groups" :key="g.id"
        ><input v-model="grantIds" type="checkbox" :value="g.id" />{{ g.name
        }}<small>{{ g.devices }} 台设备</small></label
      >
    </fieldset>
    <p v-if="grantLoading" role="status">正在读取授权…</p>
    <p v-if="message" class="error">{{ message }}</p>
    <div class="actions">
      <button :disabled="busy" class="secondary" @click="permission?.close()">
        取消</button
      ><button
        type="button"
        class="secondary"
        :disabled="busy || grantLoading || !userId"
        @click="readGrants"
      >
        重新读取</button
      ><button
        :disabled="busy || grantLoading || !grantReady || !userId"
        @click="saveGrants"
      >
        保存授权
      </button>
    </div>
  </dialog>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="deletion"
  >
    <DialogHeading :disabled="busy">删除设备分组</DialogHeading>
    <p>确认删除“{{ selected?.name }}”？包含设备或仍有授权的分组不能删除。</p>
    <p v-if="message" class="error">{{ message }}</p>
    <div class="actions">
      <button :disabled="busy" class="secondary" @click="deletion?.close()">
        取消</button
      ><button class="danger" :disabled="busy" @click="confirmRemove">
        确认删除
      </button>
    </div>
  </dialog>
</template>

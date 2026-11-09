<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { api, ApiError, messageOf } from "../api";
import DialogHeading from "./DialogHeading.vue";
interface Permission {
  key: string;
  label: string;
  group: string;
  dependencies: string[];
  adminOnly: boolean;
}
interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  builtin: number;
  users: number;
  version: number;
}
const emit = defineEmits<{ changed: [] }>();
const roles = ref<Role[]>([]),
  catalog = ref<Permission[]>([]),
  error = ref(""),
  message = ref(""),
  loading = ref(false),
  busy = ref(false),
  editor = ref<HTMLDialogElement>(),
  confirmation = ref<HTMLDialogElement>(),
  selected = ref<Role | null>(null),
  removeTarget = ref<Role | null>(null),
  name = ref(""),
  description = ref(""),
  permissions = ref<string[]>([]),
  formError = ref(""),
  reloading = ref(false),
  editorReady = ref(true);
let alive = true,
  loadGeneration = 0,
  editorGeneration = 0;
onUnmounted(() => {
  alive = false;
  loadGeneration++;
  editorGeneration++;
});
const groups = computed(() => [
  ...new Set(catalog.value.filter((p) => !p.adminOnly).map((p) => p.group)),
]);
async function load() {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = "";
  try {
    const value = await api<{ items: Role[]; catalog: Permission[] }>("/roles");
    if (alive && generation === loadGeneration) {
      roles.value = value.items;
      catalog.value = value.catalog;
    }
  } catch (e) {
    if (alive && generation === loadGeneration) error.value = messageOf(e);
  } finally {
    if (alive && generation === loadGeneration) loading.value = false;
  }
}
onMounted(load);
function open(role: Role | null = null) {
  if (busy.value) return;
  editorGeneration++;
  reloading.value = false;
  editorReady.value = true;
  selected.value = role;
  name.value = role?.name || "";
  description.value = role?.description || "";
  permissions.value = [...(role?.permissions || [])];
  formError.value = "";
  editor.value?.showModal();
}
function editorClosed() {
  editorGeneration++;
}
async function reloadRole() {
  if (!selected.value || reloading.value || busy.value) return;
  const id = selected.value.id,
    generation = ++editorGeneration;
  reloading.value = true;
  editorReady.value = false;
  formError.value = "";
  try {
    const value = await api<{ items: Role[]; catalog: Permission[] }>("/roles");
    if (!alive || generation !== editorGeneration || !editor.value?.open)
      return;
    const role = value.items.find((r) => r.id === id);
    if (!role) throw Error("角色已删除，请关闭弹窗后刷新角色列表");
    selected.value = role;
    name.value = role.name;
    description.value = role.description;
    permissions.value = [...role.permissions];
    catalog.value = value.catalog;
    roles.value = value.items;
    editorReady.value = true;
  } catch (e) {
    if (alive && generation === editorGeneration)
      formError.value = messageOf(e);
  } finally {
    if (alive && generation === editorGeneration) reloading.value = false;
  }
}
function toggle(key: string, checked: boolean) {
  const values = new Set(permissions.value);
  const add = (id: string) => {
    values.add(id);
    catalog.value.find((p) => p.key === id)?.dependencies.forEach(add);
  };
  if (checked) add(key);
  else {
    values.delete(key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of catalog.value)
        if (values.has(p.key) && p.dependencies.some((d) => !values.has(d))) {
          values.delete(p.key);
          changed = true;
        }
    }
  }
  permissions.value = [...values];
}
function preset() {
  permissions.value = [];
  [
    "live.preview",
    "ptz.control",
    "recording.view",
    "alarms.handle",
    "map.view",
    "tracks.view",
    "subscriptions.view",
  ].forEach((k) => toggle(k, true));
}
async function save() {
  if (
    busy.value ||
    reloading.value ||
    !editorReady.value ||
    selected.value?.builtin
  )
    return;
  busy.value = true;
  formError.value = "";
  try {
    await api(
      "/roles" + (selected.value ? "/" + selected.value.id : ""),
      selected.value ? "PUT" : "POST",
      {
        name: name.value,
        description: description.value,
        permissions: permissions.value,
        ...(selected.value ? { version: selected.value.version } : {}),
      },
    );
    if (!alive) return;
    editor.value?.close();
    await load();
    message.value = "角色权限已保存，关联账号权限立即生效";
    emit("changed");
  } catch (e) {
    if (alive) {
      formError.value = messageOf(e);
      if (e instanceof ApiError && e.code === "ROLE_CONFLICT")
        editorReady.value = false;
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function remove() {
  if (!removeTarget.value || busy.value) return;
  busy.value = true;
  formError.value = "";
  try {
    await api("/roles/" + removeTarget.value.id, "DELETE");
    if (!alive) return;
    confirmation.value?.close();
    await load();
    emit("changed");
  } catch (e) {
    if (alive) formError.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
</script>
<template>
  <div class="roles-panel">
    <div class="role-toolbar">
      <p>
        角色控制功能权限，账号授权控制设备范围。平台管理权限保留给系统管理员。
      </p>
      <div class="row-actions">
        <button class="secondary" :disabled="loading || busy" @click="load">
          刷新角色</button
        ><button :disabled="loading" @click="open()">创建角色</button>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div class="panel">
      <div class="panel-heading">
        <h3>平台角色</h3>
        <span>{{ roles.length }} 个角色</span>
      </div>
      <div class="table-scroll data-table-scroll">
        <table class="has-actions">
          <thead>
            <tr>
              <th>角色名称</th>
              <th>说明</th>
              <th>功能权限</th>
              <th>关联账号</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="role in roles" :key="role.id">
              <td>
                {{ role.name }}
                <span v-if="role.builtin" class="badge">内置</span>
              </td>
              <td class="cell-description">{{ role.description || "—" }}</td>
              <td>
                {{
                  role.id === "admin"
                    ? "全部权限"
                    : `${role.permissions.length} 项`
                }}
              </td>
              <td>{{ role.users }}</td>
              <td>
                <button class="link" @click="open(role)">
                  {{ role.builtin ? "查看权限" : "编辑权限" }}</button
                ><button
                  v-if="!role.builtin"
                  class="link danger"
                  :disabled="busy || role.users > 0"
                  :title="role.users ? '角色仍被账号使用' : ''"
                  @click="
                    removeTarget = role;
                    formError = '';
                    confirmation?.showModal();
                  "
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!roles.length">
              <td colspan="5">{{ loading ? "正在读取角色…" : "暂无角色" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <dialog
      ref="editor"
      class="business-dialog role-editor-dialog"
      @cancel="busy && $event.preventDefault()"
      @close="editorClosed"
    >
      <form @submit.prevent="save">
        <DialogHeading :disabled="busy">{{
          selected?.builtin
            ? "查看内置角色"
            : selected
              ? "编辑角色"
              : "创建角色"
        }}</DialogHeading>
        <div class="user-account-fields">
          <label
            ><span class="field-label">角色名称</span
            ><input
              v-model="name"
              name="roleName"
              required
              maxlength="60"
              :disabled="busy || reloading || !!selected?.builtin" /></label
          ><label
            ><span class="field-label">角色说明</span
            ><input
              v-model="description"
              name="roleDescription"
              maxlength="300"
              :disabled="busy || reloading || !!selected?.builtin"
          /></label>
        </div>
        <div class="role-permission-intro">
          <h3>功能权限</h3>
          <button
            v-if="!selected?.builtin"
            type="button"
            class="link"
            @click="preset"
            :disabled="busy || reloading || !editorReady"
          >
            使用值班员参考权限
          </button>
        </div>
        <fieldset
          v-for="group in groups"
          :key="group"
          class="permission-group"
          :disabled="busy || reloading || !!selected?.builtin"
        >
          <legend>{{ group }}</legend>
          <label
            v-for="p in catalog.filter(
              (p) => p.group === group && !p.adminOnly,
            )"
            :key="p.key"
            ><input
              type="checkbox"
              :value="p.key"
              :checked="permissions.includes(p.key)"
              @change="
                toggle(p.key, ($event.target as HTMLInputElement).checked)
              "
            />{{ p.label }}</label
          >
        </fieldset>
        <p class="profile-help">
          选择操作权限会同时勾选必要的查看权限。平台配置、设备接入、录像计划、用户授权、级联和审计仅系统管理员可管理。
        </p>
        <p v-if="selected?.id === 'admin'" class="role-admin-note">
          系统管理员具有全部功能和设备权限。
        </p>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <div class="actions">
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            @click="editor?.close()"
          >
            关闭</button
          ><button
            v-if="selected && !selected.builtin"
            type="button"
            class="secondary"
            :disabled="busy || reloading"
            @click="reloadRole"
          >
            {{ reloading ? "正在读取…" : "重新读取" }}</button
          ><button
            v-if="!selected?.builtin"
            :disabled="busy || reloading || !editorReady"
          >
            {{ busy ? "正在保存…" : "保存角色" }}
          </button>
        </div>
      </form>
    </dialog>
    <dialog
      ref="confirmation"
      class="business-dialog"
      @cancel="busy && $event.preventDefault()"
    >
      <DialogHeading :disabled="busy">删除角色</DialogHeading>
      <p>
        确认删除“{{
          removeTarget?.name
        }}”？内置角色及仍有账号使用的角色不可删除。
      </p>
      <p v-if="formError" class="error" role="alert">{{ formError }}</p>
      <div class="actions">
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="confirmation?.close()"
        >
          取消</button
        ><button class="danger" :disabled="busy" @click="remove">
          确认删除
        </button>
      </div>
    </dialog>
  </div>
</template>

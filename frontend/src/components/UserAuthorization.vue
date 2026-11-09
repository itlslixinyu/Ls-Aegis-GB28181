<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { api, messageOf, type User } from "../api";
import DialogHeading from "./DialogHeading.vue";
const props = defineProps<{ user: User }>(),
  emit = defineEmits<{ close: []; saved: [] }>();
const dialog = ref<HTMLDialogElement>(),
  roles = ref<
    { id: string; name: string; description?: string; permissions?: string[] }[]
  >([]),
  catalog = ref<{ key: string; label: string }[]>([]),
  groups = ref<{ id: string; name: string; devices: number }[]>([]),
  roleId = ref("viewer"),
  scope = ref("groups"),
  selected = ref<string[]>([]),
  version = ref(0),
  loading = ref(true),
  ready = ref(false),
  busy = ref(false),
  error = ref("");
let alive = true;
onUnmounted(() => {
  alive = false;
});
const global = computed(
  () => roleId.value === "admin" || scope.value === "all",
);
const selectedRole = computed(() =>
  roles.value.find((r) => r.id === roleId.value),
);
const permissionSummary = computed(() =>
  (selectedRole.value?.permissions || [])
    .map((key) => catalog.value.find((p) => p.key === key)?.label || key)
    .join("、"),
);
async function load() {
  loading.value = true;
  ready.value = false;
  error.value = "";
  try {
    const [r, g, a] = await Promise.all([
      api<{ items: typeof roles.value; catalog: typeof catalog.value }>(
        "/roles",
      ),
      api<{ items: { id: string; name: string; devices: number }[] }>(
        "/groups",
      ),
      api<{
        roleId: string;
        scopeMode: string;
        groupIds: string[];
        version: number;
      }>("/users/" + props.user.id + "/authorization"),
    ]);
    if (!alive) return;
    roles.value = r.items;
    catalog.value = r.catalog || [];
    groups.value = g.items;
    roleId.value = a.roleId;
    scope.value = a.scopeMode;
    selected.value = a.groupIds;
    version.value = a.version;
    ready.value = true;
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) loading.value = false;
  }
}
watch(
  roleId,
  (id, previous) => {
    if (loading.value) return;
    if (id === "admin") scope.value = "all";
    else if (previous === "admin") scope.value = "groups";
  },
  { flush: "sync" },
);
onMounted(() => {
  dialog.value?.showModal();
  void load();
});
async function save() {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/users/" + props.user.id + "/authorization", "PUT", {
      roleId: roleId.value,
      scopeMode: global.value ? "all" : "groups",
      groupIds: global.value ? [] : selected.value,
      version: version.value,
    });
    if (alive) {
      emit("saved");
      dialog.value?.close();
    }
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
</script>
<template>
  <dialog
    ref="dialog"
    class="business-dialog user-authorization-dialog"
    @close="emit('close')"
    @cancel="busy && $event.preventDefault()"
  >
    <form @submit.prevent="save">
      <DialogHeading :disabled="busy"
        >账号授权 · {{ user.username }}</DialogHeading
      >
      <p v-if="loading" role="status">正在读取角色与设备范围…</p>
      <fieldset
        class="user-account-fields"
        :disabled="loading || busy || !ready"
      >
        <label
          ><span class="field-label">功能角色</span
          ><select v-model="roleId" name="authorizationRole">
            <option v-for="role in roles" :key="role.id" :value="role.id">
              {{ role.name }}
            </option>
          </select></label
        ><label
          ><span class="field-label">设备范围</span
          ><select
            v-model="scope"
            name="authorizationScope"
            :disabled="roleId === 'admin'"
          >
            <option value="groups">指定设备分组</option>
            <option value="all">全部设备（含以后新增）</option>
          </select></label
        >
      </fieldset>
      <div
        v-if="ready && selectedRole"
        class="profile-help authorization-summary"
        role="note"
      >
        <strong>{{ selectedRole.name }}</strong>
        <p v-if="selectedRole.description">{{ selectedRole.description }}</p>
        <p>
          {{
            permissionSummary ||
            "该角色尚未开放任何业务功能，仍可使用个人中心。"
          }}
        </p>
      </div>
      <p v-if="global" class="profile-help">
        当前授权允许访问全部设备，功能操作仍由所选角色决定。
      </p>
      <fieldset
        v-else
        class="permission-group scope-group"
        :disabled="loading || busy || !ready"
      >
        <legend>可访问设备分组</legend>
        <label v-for="group in groups" :key="group.id"
          ><input v-model="selected" type="checkbox" :value="group.id" />{{
            group.name
          }}（{{ group.devices }} 台）</label
        >
        <p v-if="!groups.length">暂无设备分组</p>
      </fieldset>
      <p class="profile-help">
        不选择设备分组时无法访问设备。授权修改立即在服务端生效，失权预览会被回收；登录页面会同步更新菜单。
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="dialog?.close()"
        >
          取消</button
        ><button
          type="button"
          class="secondary"
          :disabled="busy || loading"
          @click="load"
        >
          重新读取</button
        ><button :disabled="busy || loading || !ready">
          {{ busy ? "正在保存…" : "保存授权" }}
        </button>
      </div>
    </form>
  </dialog>
</template>

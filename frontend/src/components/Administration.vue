<script setup lang="ts">
import DialogHeading from "./DialogHeading.vue";
import AppIcon from "./AppIcon.vue";
import AccessConfiguration from "./AccessConfiguration.vue";
import UserProfileFields from "./UserProfileFields.vue";
import RolesPanel from "./RolesPanel.vue";
import UserAuthorization from "./UserAuthorization.vue";
import { profileFields, profileDate, syncOwnProfile } from "../user-profile";
import { rememberFilter } from "../remember-filter";
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import {
  api,
  ApiError,
  messageOf,
  currentUser,
  roleLabel,
  type User,
} from "../api";
const props = defineProps<{ view: string }>();
interface Audit {
  id: string;
  username: string;
  action: string;
  resourceId: string;
  createdAt: string;
}
const users = ref<User[]>([]),
  audit = ref<Audit[]>([]),
  message = ref(""),
  error = ref(""),
  busy = ref(false),
  dialog = ref<HTMLDialogElement>();
const loading = ref(false),
  loadError = ref(""),
  search = rememberFilter("users.query", ""),
  roleFilter = rememberFilter("users.role", "", (value) => value.length <= 100);
const managementTab = ref("users"),
  rolesAvailable = ref(true),
  authorizationUser = ref<User | null>(null),
  roleOptions = ref([
    { id: "viewer", name: "只读用户" },
    { id: "admin", name: "系统管理员" },
  ]);
const fields = ref(profileFields()),
  editing = ref<User | null>(null),
  editorReady = ref(true),
  profileLoading = ref(false);
const details = ref<HTMLDialogElement>(),
  detailUser = ref<User | null>(null),
  detailError = ref(""),
  detailLoading = ref(false);
let alive = true,
  loadGeneration = 0,
  editorGeneration = 0,
  detailGeneration = 0;
onUnmounted(() => {
  alive = false;
  loadGeneration++;
  editorGeneration++;
  detailGeneration++;
});
const filteredUsers = computed(() =>
  users.value.filter((user) => {
    const q = search.value.trim().toLowerCase();
    return (
      (!roleFilter.value || (user.roleId || user.role) === roleFilter.value) &&
      (!q ||
        [
          user.username,
          user.displayName,
          user.department,
          user.phone,
          user.email,
        ].some((v) => v?.toLowerCase().includes(q)))
    );
  }),
);
watch(currentUser, (user) => {
  if (!user || props.view !== "users") return;
  const index = users.value.findIndex((row) => row.id === user.id);
  if (index >= 0) users.value[index] = { ...users.value[index], ...user };
});
const username = ref(""),
  password = ref(""),
  role = ref("viewer");
const actionLabels: Record<string, string> = {
  "group.create": "创建设备分组",
  "group.update": "修改设备分组",
  "group.delete": "删除设备分组",
  "group.devices": "调整设备归属",
  "user.groups": "配置用户分组授权",
  "device.location": "设置设备坐标",
  "device.location.clear": "清除设备坐标",
  "subscription.enable": "启用设备订阅",
  "subscription.disable": "停用设备订阅",
  "alarm.acknowledge": "确认告警",
  "alarm.resolve": "处置告警",
  "device.transport": "设置设备传输方式",
  "record.download": "导出设备录像",
  "record.cancel": "结束录像任务",
  "plan.create": "创建录像计划",
  "plan.update": "修改录像计划",
  "plan.enabled": "启停录像计划",
  "plan.delete": "删除录像计划",
  "live.create": "发起实时预览",
  "record.query": "查询设备录像",
  "playback.create": "发起录像回放",
  "ptz.command": "云台控制",
  "cascade.create": "添加级联平台",
  "cascade.update": "修改级联平台",
  "cascade.delete": "删除级联平台",
  "cascade.channels": "配置级联共享通道",
  "cascade.register": "注册上级平台",
  "cascade.unregister": "注销上级平台",
  "system.setup": "初始化管理员",
  "system.config.update": "保存接入配置",
  "system.restart": "重启平台",
  "auth.login": "登录",
  "auth.password.reset": "重置账号密码",
  "device.create": "添加设备",
  "device.update": "编辑设备",
  "device.delete": "删除设备",
  "device.credential.update": "更新设备接入凭据",
  "device.catalog.sync": "发起目录同步",
  "user.create": "创建用户",
  "user.delete": "删除用户",
  "user.profile.update": "编辑用户资料",
  "user.profile.self": "更新个人资料",
  "auth.password_change": "修改本人密码",
  "role.create": "创建角色",
  "role.update": "修改角色权限",
  "role.delete": "删除角色",
  "user.authorization": "调整账号角色和设备范围",
};
async function load() {
  const generation = ++loadGeneration;
  loading.value = true;
  loadError.value = "";
  try {
    if (props.view === "users") {
      const [value, roles] = await Promise.all([
        api<{ items: User[] }>("/users"),
        api<{ items: { id: string; name: string }[]; unavailable?: boolean }>(
          "/roles",
        ).catch((e) => {
          if (e instanceof ApiError && e.status === 404)
            return {
              items: [
                { id: "admin", name: "系统管理员" },
                { id: "viewer", name: "只读用户" },
              ],
              unavailable: true,
            };
          throw e;
        }),
      ]);
      if (alive && generation === loadGeneration) {
        users.value = value.items;
        roleOptions.value = roles.items;
        rolesAvailable.value = !roles.unavailable;
        if (
          roleFilter.value &&
          !roles.items.some((r) => r.id === roleFilter.value)
        )
          roleFilter.value = "";
      }
    } else if (props.view === "audit") {
      const value = await api<{ items: Audit[] }>("/audit");
      if (alive && generation === loadGeneration) audit.value = value.items;
    }
  } catch (e) {
    if (alive && generation === loadGeneration) loadError.value = messageOf(e);
  } finally {
    if (alive && generation === loadGeneration) loading.value = false;
  }
}
onMounted(load);
function open() {
  editorGeneration++;
  editing.value = null;
  editorReady.value = true;
  profileLoading.value = false;
  fields.value = profileFields();
  username.value = "";
  password.value = "";
  role.value = "viewer";
  error.value = "";
  dialog.value?.showModal();
}
function editorClosed() {
  editorGeneration++;
  password.value = "";
}
async function openEdit(user: User) {
  const generation = ++editorGeneration;
  editing.value = user;
  fields.value = profileFields();
  editorReady.value = false;
  profileLoading.value = true;
  error.value = "";
  dialog.value?.showModal();
  try {
    const value = await api<User>("/users/" + encodeURIComponent(user.id));
    if (!alive || generation !== editorGeneration || !dialog.value?.open)
      return;
    editing.value = value;
    fields.value = profileFields(value);
    editorReady.value = true;
  } catch (e) {
    if (alive && generation === editorGeneration) error.value = messageOf(e);
  } finally {
    if (alive && generation === editorGeneration) profileLoading.value = false;
  }
}
async function showDetails(user: User) {
  const generation = ++detailGeneration;
  detailUser.value = null;
  detailLoading.value = true;
  detailError.value = "";
  details.value?.showModal();
  try {
    const value = await api<User>("/users/" + encodeURIComponent(user.id));
    if (alive && generation === detailGeneration && details.value?.open)
      detailUser.value = value;
  } catch (e) {
    if (alive && generation === detailGeneration)
      detailError.value = messageOf(e);
  } finally {
    if (alive && generation === detailGeneration) detailLoading.value = false;
  }
}
async function create() {
  if (busy.value || profileLoading.value || !editorReady.value) return;
  busy.value = true;
  error.value = "";
  try {
    const isEdit = !!editing.value;
    const value = isEdit
      ? await api<User>(
          "/users/" + encodeURIComponent(editing.value!.id) + "/profile",
          "PUT",
          { ...fields.value, version: editing.value!.version },
        )
      : await api<User>("/users", "POST", {
          username: username.value,
          password: password.value,
          role: role.value,
          profile: fields.value,
        });
    if (!alive) return;
    syncOwnProfile(value, currentUser);
    password.value = "";
    dialog.value?.close();
    await load();
    if (alive) message.value = isEdit ? "用户资料已保存" : "用户已创建";
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
const removal = ref<HTMLDialogElement>(),
  removeTarget = ref<User | null>(null),
  removeError = ref("");
function confirmUserRemoval(user: User) {
  removeTarget.value = user;
  removeError.value = "";
  removal.value?.showModal();
}
async function removeUser() {
  if (!removeTarget.value || busy.value) return;
  busy.value = true;
  removeError.value = "";
  try {
    await api("/users/" + removeTarget.value.id, "DELETE");
    removal.value?.close();
    await load();
    message.value = "用户已删除，其登录会话和授权已失效。";
  } catch (e) {
    removeError.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="business-page" v-if="view === 'users'" id="users-view">
    <div class="title">
      <div>
        <h1>用户管理</h1>
        <p>
          在“角色配置”设置功能权限，通过账号“授权”选择角色和设备范围。账号资料与业务权限分别维护。
        </p>
      </div>
      <div v-if="managementTab === 'users'" class="row-actions">
        <button class="secondary" :disabled="loading || busy" @click="load">
          <AppIcon name="refresh" :size="16" />刷新</button
        ><button :disabled="loading || busy" @click="open">
          <AppIcon name="plus" :size="16" />创建用户
        </button>
      </div>
    </div>
    <div
      class="profile-tabs user-management-tabs"
      role="group"
      aria-label="用户管理栏目"
    >
      <button
        :aria-pressed="managementTab === 'users'"
        @click="managementTab = 'users'"
      >
        用户列表</button
      ><button
        :aria-pressed="managementTab === 'roles'"
        :disabled="!rolesAvailable"
        :title="rolesAvailable ? '配置角色功能权限' : '服务更新后可配置角色'"
        @click="managementTab = 'roles'"
      >
        角色配置
      </button>
    </div>
    <RolesPanel v-if="managementTab === 'roles'" @changed="load" />
    <p v-if="message && managementTab === 'users'" role="status">
      {{ message }}
    </p>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <div v-if="managementTab === 'users'" class="business-filters user-filters">
      <label
        >查找用户<input
          v-model="search"
          type="search"
          placeholder="账号、姓名、部门、电话或邮箱"
          aria-label="查找用户"
      /></label>
      <label
        >账号角色<select v-model="roleFilter" aria-label="筛选账号角色">
          <option value="">全部角色</option>
          <option v-for="role in roleOptions" :key="role.id" :value="role.id">
            {{ role.name }}
          </option>
        </select></label
      >
      <button
        class="secondary"
        @click="
          search = '';
          roleFilter = '';
        "
      >
        重置筛选
      </button>
    </div>
    <div v-if="managementTab === 'users'" class="panel">
      <div class="panel-heading">
        <h3>平台用户</h3>
        <span>{{
          loading
            ? "正在读取…"
            : `共 ${users.length} 个账号 · 显示 ${filteredUsers.length} 个`
        }}</span>
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
              <th scope="col">账号</th>
              <th scope="col">姓名</th>
              <th scope="col">所属部门</th>
              <th scope="col">角色</th>
              <th scope="col">联系电话</th>
              <th scope="col">最近登录</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in filteredUsers" :key="u.id">
              <td class="mono">{{ u.username }}</td>
              <td>{{ u.displayName || "未填写" }}</td>
              <td>{{ u.department || "未填写" }}</td>
              <td>
                <span
                  class="badge"
                  :class="u.role === 'admin' ? 'role-admin' : 'role-viewer'"
                  >{{ roleLabel(u) }}</span
                >
              </td>
              <td>{{ u.phone || "未填写" }}</td>
              <td class="cell-date">{{ profileDate(u.lastLoginAt) }}</td>
              <td>
                <button class="link" @click="showDetails(u)">详情</button>
                <button class="link" :disabled="busy" @click="openEdit(u)">
                  编辑
                </button>
                <button
                  class="link"
                  :disabled="
                    busy || !rolesAvailable || u.id === currentUser?.id
                  "
                  :title="
                    u.id === currentUser?.id ? '不能修改当前登录账号的授权' : ''
                  "
                  @click="authorizationUser = u"
                >
                  授权
                </button>
                <button
                  class="link danger"
                  :disabled="busy || u.id === currentUser?.id"
                  :title="
                    u.id === currentUser?.id
                      ? '不能删除当前登录用户'
                      : '删除用户'
                  "
                  @click="confirmUserRemoval(u)"
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!filteredUsers.length">
              <td colspan="7">
                {{
                  loading
                    ? "正在加载用户…"
                    : loadError
                      ? "用户列表读取失败，请点击刷新重试"
                      : "暂无匹配的用户"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
  <section class="business-page" v-else-if="view === 'audit'" id="audit-view">
    <div class="title">
      <div>
        <h1>操作审计</h1>
        <p>查看平台操作记录，追溯操作人、时间与关联资源。</p>
      </div>
    </div>
    <p role="status">{{ loading ? "正在加载…" : message }}</p>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <div class="panel">
      <div class="panel-heading">
        <h3>最近操作记录</h3>
        <span>最多100条 · 时间倒序</span>
      </div>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">操作者</th>
              <th scope="col">操作</th>
              <th scope="col">资源</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in audit" :key="row.id">
              <td class="cell-date">
                {{ new Date(row.createdAt).toLocaleString() }}
              </td>
              <td>{{ row.username || "系统" }}</td>
              <td>{{ actionLabels[row.action] || row.action }}</td>
              <td>{{ row.resourceId || "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!message && !audit.length">暂无操作记录</p>
    </div>
  </section>
  <AccessConfiguration v-else />
  <dialog
    @cancel="busy && $event.preventDefault()"
    @close="editorClosed"
    class="business-dialog user-editor-dialog"
    ref="dialog"
  >
    <form @submit.prevent="create">
      <DialogHeading :disabled="busy">{{
        editing ? "编辑用户资料" : "创建用户"
      }}</DialogHeading>
      <dl v-if="editing" class="profile-summary">
        <dt>当前账号</dt>
        <dd>{{ editing.username }}</dd>
        <dt>账号角色</dt>
        <dd>{{ roleLabel(editing) }}</dd>
      </dl>
      <fieldset v-else class="user-account-fields" :disabled="busy">
        <label
          ><span class="field-label">账号</span
          ><input
            autofocus
            v-model="username"
            required
            pattern="[a-zA-Z0-9_\-]{3,32}"
            minlength="3"
            maxlength="32"
            title="3～32位字母、数字、下划线或连字符"
            autocomplete="off" /></label
        ><label
          ><span class="field-label">密码</span
          ><input
            v-model="password"
            type="password"
            required
            minlength="12"
            maxlength="128"
            autocomplete="new-password" /></label
        ><label
          ><span class="field-label">角色</span
          ><select v-model="role">
            <option
              v-for="option in roleOptions"
              :key="option.id"
              :value="option.id"
            >
              {{ option.name }}
            </option>
          </select></label
        >
      </fieldset>
      <h3 class="user-form-heading">个人信息</h3>
      <p v-if="profileLoading" role="status">正在读取用户资料…</p>
      <UserProfileFields
        v-model="fields"
        :disabled="busy || profileLoading || !editorReady"
      />
      <p class="profile-help">
        个人信息均为选填，创建后也可由用户在个人中心补充。
      </p>
      <p class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="dialog?.close()"
        >
          取消</button
        ><button
          v-if="editing"
          type="button"
          class="secondary"
          :disabled="busy || profileLoading"
          @click="openEdit(editing)"
        >
          重新读取</button
        ><button :disabled="busy || profileLoading || !editorReady">
          {{ busy ? "正在保存…" : editing ? "保存资料" : "创建用户" }}
        </button>
      </div>
    </form>
  </dialog>
  <dialog
    ref="details"
    class="business-dialog user-details-dialog"
    @close="detailGeneration++"
  >
    <DialogHeading>用户详情</DialogHeading>
    <p v-if="detailLoading" role="status">正在读取用户详情…</p>
    <p v-if="detailError" class="error" role="alert">{{ detailError }}</p>
    <dl v-if="detailUser" class="user-info-grid">
      <div>
        <dt>登录账号</dt>
        <dd>{{ detailUser.username }}</dd>
      </div>
      <div>
        <dt>姓名</dt>
        <dd>{{ detailUser.displayName || "未填写" }}</dd>
      </div>
      <div>
        <dt>账号角色</dt>
        <dd>{{ roleLabel(detailUser) }}</dd>
      </div>
      <div>
        <dt>设备权限范围</dt>
        <dd>
          {{
            detailUser.scopeMode === "all"
              ? "全部设备（含以后新增）"
              : "指定设备分组"
          }}
        </dd>
      </div>
      <div>
        <dt>所属部门</dt>
        <dd>{{ detailUser.department || "未填写" }}</dd>
      </div>
      <div>
        <dt>职务</dt>
        <dd>{{ detailUser.jobTitle || "未填写" }}</dd>
      </div>
      <div>
        <dt>联系电话</dt>
        <dd>{{ detailUser.phone || "未填写" }}</dd>
      </div>
      <div class="profile-full">
        <dt>电子邮箱</dt>
        <dd>{{ detailUser.email || "未填写" }}</dd>
      </div>
      <div>
        <dt>创建时间</dt>
        <dd>{{ profileDate(detailUser.createdAt) }}</dd>
      </div>
      <div>
        <dt>最近登录</dt>
        <dd>{{ profileDate(detailUser.lastLoginAt) }}</dd>
      </div>
      <div class="profile-full">
        <dt>资料更新时间</dt>
        <dd>{{ profileDate(detailUser.updatedAt) }}</dd>
      </div>
      <div class="profile-full">
        <dt>备注</dt>
        <dd class="profile-note">{{ detailUser.remark || "未填写" }}</dd>
      </div>
    </dl>
    <div class="actions">
      <button type="button" class="secondary" @click="details?.close()">
        关闭
      </button>
    </div>
  </dialog>
  <UserAuthorization
    v-if="authorizationUser"
    :user="authorizationUser"
    @close="authorizationUser = null"
    @saved="
      load();
      message = '账号授权已保存';
    "
  />
  <dialog
    class="business-dialog"
    ref="removal"
    @cancel="busy && $event.preventDefault()"
  >
    <DialogHeading :disabled="busy">删除用户</DialogHeading>
    <p>
      确认删除账号“{{ removeTarget?.username }}”？该账号的登录和分组授权将失效。
    </p>
    <p>关联级联平台、录像计划或活动任务会阻止删除，请先处理相关资源。</p>
    <p v-if="removeError" class="error" role="alert">{{ removeError }}</p>
    <div class="actions">
      <button class="secondary" :disabled="busy" @click="removal?.close()">
        取消</button
      ><button class="danger" :disabled="busy" @click="removeUser">
        确认删除
      </button>
    </div>
  </dialog>
</template>

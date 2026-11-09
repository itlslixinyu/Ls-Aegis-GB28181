<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api, currentUser, messageOf, type User } from "../api";
import { profileFields, profileDate, syncOwnProfile } from "../user-profile";
import UserProfileFields from "./UserProfileFields.vue";
const emit = defineEmits<{ busy: [value: boolean] }>();
const fields = ref(profileFields()),
  user = ref<User>(),
  loading = ref(true),
  saving = ref(false),
  error = ref(""),
  message = ref("");
let alive = true;
onUnmounted(() => {
  alive = false;
});
async function load() {
  if (saving.value) return;
  loading.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = (await api<{ user: User }>("/me")).user;
    if (!alive) return;
    user.value = value;
    fields.value = profileFields(value);
    syncOwnProfile(value, currentUser);
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) loading.value = false;
  }
}
onMounted(load);
async function save() {
  if (!user.value || saving.value || loading.value) return;
  saving.value = true;
  emit("busy", true);
  error.value = "";
  message.value = "";
  try {
    const value = await api<User>("/me/profile", "PUT", {
      ...fields.value,
      version: user.value.version,
    });
    if (!alive) return;
    user.value = value;
    fields.value = profileFields(value);
    syncOwnProfile(value, currentUser);
    message.value = "个人资料已保存";
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) {
      saving.value = false;
      emit("busy", false);
    }
  }
}
</script>
<template>
  <form class="personal-details" @submit.prevent="save">
    <p class="profile-help">以下资料用于账号信息展示，均可选填。</p>
    <p v-if="loading" role="status">正在读取个人资料…</p>
    <UserProfileFields
      v-model="fields"
      :disabled="loading || saving || !user"
    />
    <dl v-if="user" class="user-info-grid profile-metadata">
      <div>
        <dt>创建时间</dt>
        <dd>{{ profileDate(user.createdAt) }}</dd>
      </div>
      <div>
        <dt>最近登录</dt>
        <dd>{{ profileDate(user.lastLoginAt) }}</dd>
      </div>
    </dl>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="message" class="success-message" role="status">{{ message }}</p>
    <div class="dialog-actions">
      <button
        class="secondary"
        type="button"
        :disabled="saving || loading"
        @click="load"
      >
        重新读取
      </button>
      <button :disabled="saving || loading || !user">
        {{ saving ? "正在保存…" : "保存个人资料" }}
      </button>
    </div>
  </form>
</template>

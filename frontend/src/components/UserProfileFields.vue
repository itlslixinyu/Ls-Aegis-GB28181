<script setup lang="ts">
import type { UserProfileFields } from "../api";
const fields = defineModel<UserProfileFields>({ required: true });
defineProps<{ disabled?: boolean }>();
</script>
<template>
  <fieldset class="user-profile-fields" :disabled="disabled">
    <label
      ><span class="field-label">姓名</span
      ><input
        v-model="fields.displayName"
        name="displayName"
        maxlength="50"
        autocomplete="name"
        placeholder="请输入姓名"
    /></label>
    <label
      ><span class="field-label">所属部门</span
      ><input
        v-model="fields.department"
        name="department"
        maxlength="80"
        autocomplete="organization"
        placeholder="请输入所属部门"
    /></label>
    <label
      ><span class="field-label">职务</span
      ><input
        v-model="fields.jobTitle"
        name="jobTitle"
        maxlength="50"
        autocomplete="organization-title"
        placeholder="请输入职务"
    /></label>
    <label
      ><span class="field-label">联系电话</span
      ><input
        v-model="fields.phone"
        name="phone"
        type="tel"
        maxlength="32"
        pattern="\+?[0-9\s\(\)\-]+"
        title="可填写数字、国家区号、空格、括号或短横线，至少3位数字"
        autocomplete="tel"
        placeholder="手机或固定电话"
    /></label>
    <label class="profile-email"
      ><span class="field-label">电子邮箱</span
      ><input
        v-model="fields.email"
        name="email"
        type="email"
        maxlength="254"
        autocomplete="email"
        placeholder="例如：name@example.cn"
    /></label>
    <label class="profile-remark"
      ><span class="field-label">备注</span
      ><textarea
        v-model="fields.remark"
        name="remark"
        maxlength="500"
        rows="3"
        placeholder="补充说明（选填，最多500字）"
      ></textarea>
    </label>
  </fieldset>
</template>

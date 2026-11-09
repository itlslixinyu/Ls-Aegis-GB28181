<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
const props = withDefaults(defineProps<{ disabled?: boolean }>(), {
  disabled: false,
});
function close(event: MouseEvent) {
  if (props.disabled) return;
  (event.currentTarget as HTMLElement)
    .closest<HTMLDialogElement>("dialog")
    ?.close();
}
</script>
<template>
  <div class="business-dialog-heading">
    <h2><slot /></h2>
    <button
      type="button"
      class="icon-button"
      aria-label="关闭弹窗"
      title="关闭"
      :disabled="disabled"
      @click="close"
    >
      <AppIcon name="close" :size="18" />
    </button>
  </div>
</template>

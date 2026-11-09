<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import PlaybackLayoutPicker from "./PlaybackLayoutPicker.vue";
defineProps<{
  layout: number;
  layouts: readonly number[];
  openingAll: boolean;
  loading: boolean;
  hasSlots: boolean;
  canPtz: boolean;
  ptzExpanded: boolean;
}>();
const emit = defineEmits<{
  layout: [count: number];
  open: [];
  close: [];
  ptz: [];
}>();
</script>
<template>
  <div class="monitor-quick-actions" role="group" aria-label="监控操作">
    <button
      v-if="canPtz"
      id="monitor-ptz-toggle"
      type="button"
      class="link"
      :class="{ selected: ptzExpanded }"
      :aria-label="ptzExpanded ? '收起云台控制' : '展开云台控制'"
      :aria-expanded="ptzExpanded"
      aria-controls="monitor-ptz-controls"
      :title="
        ptzExpanded ? '收起云台控制' : '云台控制：打开方向、变焦和速度面板'
      "
      @click="emit('ptz')"
    >
      <AppIcon name="ptz" :size="18" />
    </button>
    <PlaybackLayoutPicker
      :value="layout"
      :disabled="loading"
      :layouts="layouts"
      label="选择监控画面布局"
      group-label="预览画面布局"
      option-suffix="画面"
      align="end"
      @select="emit('layout', $event)"
    />
    <button
      type="button"
      class="link"
      :disabled="openingAll || loading"
      :aria-label="openingAll ? '正在打开全部通道' : '打开全部通道'"
      :aria-busy="openingAll"
      :title="`打开全部通道：保留当前${layout}画面布局，按授权在线通道分页`"
      @click="emit('open')"
    >
      <AppIcon name="play-all" :size="18" />
    </button>
    <button
      type="button"
      class="link"
      :disabled="!openingAll && !hasSlots"
      aria-label="关闭全部通道"
      title="关闭全部通道：仅关闭本页预览，不停止录像计划"
      @click="emit('close')"
    >
      <AppIcon name="close-all" :size="18" />
    </button>
  </div>
</template>
<style scoped>
.monitor-quick-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.monitor-quick-actions > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  min-height: 30px;
  padding: 5px;
  border: 0;
  border-radius: 5px;
  color: #5e7692;
  background: transparent;
}
.monitor-quick-actions > button:hover:not(:disabled),
.monitor-quick-actions > button.selected {
  color: var(--blue);
  background: var(--blue-soft);
}
.monitor-quick-actions > button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.monitor-quick-actions > button:disabled {
  color: #a6b2c2;
}
</style>

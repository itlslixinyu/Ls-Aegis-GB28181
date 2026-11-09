<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import AppIcon from "./AppIcon.vue";
defineProps<{
  value: number;
  disabled?: boolean;
  layouts: readonly number[];
  label?: string;
  groupLabel?: string;
  optionSuffix?: string;
  align?: "start" | "end";
}>();
const emit = defineEmits<{ select: [count: number] }>();
const picker = ref<HTMLDetailsElement>();
function select(count: number) {
  emit("select", count);
  if (picker.value) picker.value.open = false;
  picker.value?.querySelector("summary")?.focus();
}
function dismiss(event: PointerEvent) {
  if (
    event.target instanceof Node &&
    !picker.value?.contains(event.target) &&
    picker.value
  )
    picker.value.open = false;
}
function escape(event: KeyboardEvent) {
  if (event.key === "Escape" && picker.value?.open) {
    picker.value.open = false;
    picker.value.querySelector("summary")?.focus();
  }
}
onMounted(() => {
  document.addEventListener("pointerdown", dismiss);
  document.addEventListener("keydown", escape);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", dismiss);
  document.removeEventListener("keydown", escape);
});
</script>

<template>
  <details
    ref="picker"
    class="layout-picker"
    :class="{ 'align-end': align === 'end' }"
  >
    <summary
      :aria-label="label || '选择回放画面布局'"
      :aria-disabled="disabled || undefined"
      @click="disabled && $event.preventDefault()"
      :title="`画面布局：当前${value}画面`"
    >
      <AppIcon name="groups" :size="18" />
    </summary>
    <div
      class="layout-options"
      role="group"
      :aria-label="groupLabel || '回放画面布局'"
    >
      <button
        v-for="count in layouts"
        :key="count"
        type="button"
        :aria-label="count + (optionSuffix || '画面回放')"
        :aria-pressed="value === count"
        :class="{ selected: value === count }"
        @click="select(count)"
      >
        {{ count }}画面
      </button>
    </div>
  </details>
</template>

<style scoped>
.layout-picker {
  position: relative;
}
summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 28px;
  padding: 4px 6px;
  cursor: pointer;
  border-radius: 4px;
  color: #526981;
}
summary::-webkit-details-marker {
  display: none;
}
summary:hover,
details[open] summary {
  color: #2166cd;
  background: #e5efff;
}
summary:focus-visible {
  outline: 2px solid #276bd0;
  outline-offset: 2px;
}
summary span {
  font-size: 11px;
  min-width: 14px;
  text-align: center;
}
.layout-options {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 10;
  width: 210px;
  padding: 8px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  background: white;
  border: 1px solid #dce4ef;
  border-radius: 8px;
  box-shadow: 0 6px 24px #16345a25;
}
.layout-options button {
  min-height: 34px;
  padding: 4px;
  font-size: 12px;
  color: #50657f;
  background: #f5f7fb;
  border: 1px solid transparent;
  border-radius: 4px;
}
.layout-options button.selected {
  color: #2166cd;
  background: #e5efff;
  border-color: #a9c9f5;
}
@media (max-width: 600px) {
  .layout-options {
    left: 0;
    right: auto;
  }
}
.align-end .layout-options {
  left: auto;
  right: 0;
}
</style>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { api, messageOf } from "../api";
import AppIcon from "./AppIcon.vue";
interface Source {
  id: string;
  name: string;
  deviceName: string;
  channelCode: string;
  status: string;
}
defineProps<{
  modelValue: Source | null;
  disabled?: boolean;
  allowOffline?: boolean;
  draggable?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: Source | null];
  drag: [value: Source];
}>();
function dragSource(event: DragEvent, row: Source) {
  event.dataTransfer?.setData("application/x-ls-aegis-channel", row.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  emit("drag", row);
}
const rows = ref<Source[]>([]),
  q = ref(""),
  page = ref(1),
  total = ref(0),
  loading = ref(false),
  error = ref("");
let alive = true,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const gen = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ items: Source[]; total: number }>(
      `/channels?page=${page.value}&pageSize=16&q=${encodeURIComponent(q.value)}`,
    );
    if (alive && gen === generation) {
      rows.value = result.items;
      total.value = result.total;
    }
  } catch (e) {
    if (alive && gen === generation) {
      rows.value = [];
      error.value = messageOf(e);
    }
  } finally {
    if (alive && gen === generation) loading.value = false;
  }
}
watch(q, () => {
  page.value = 1;
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});
onMounted(load);
onUnmounted(() => {
  alive = false;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <div class="ai-channel-picker">
    <div class="ai-channel-search">
      <input
        v-model="q"
        placeholder="搜索通道名称、编号或设备"
        aria-label="AI通道检索"
        maxlength="100"
        :disabled="disabled"
      /><button
        type="button"
        class="icon-button"
        title="刷新通道"
        aria-label="刷新AI通道"
        :disabled="disabled || loading"
        @click="load"
      >
        <AppIcon name="refresh" :size="17" />
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="ai-channel-options" role="list" aria-label="可选择的通道">
      <button
        v-for="row in rows"
        :key="row.id"
        type="button"
        class="ai-channel-option"
        :class="{ selected: modelValue?.id === row.id }"
        :disabled="disabled || (!allowOffline && row.status !== 'online')"
        :draggable="
          draggable && !disabled && (allowOffline || row.status === 'online')
        "
        @dragstart="dragSource($event, row)"
        @click="emit('update:modelValue', row)"
      >
        <AppIcon name="devices" :size="19" /><span
          ><b>{{ row.name }}</b
          ><small>{{ row.deviceName }}</small></span
        ><span
          class="badge"
          :class="row.status === 'online' ? 'online' : 'offline'"
          >{{ row.status === "online" ? "在线" : "离线" }}</span
        >
      </button>
      <p v-if="!rows.length" class="empty-state">
        {{ loading ? "正在加载通道…" : "没有匹配通道" }}
      </p>
    </div>
    <div class="ai-channel-pagination">
      <button
        type="button"
        class="secondary"
        :disabled="disabled || loading || page <= 1"
        @click="
          page--;
          load();
        "
      >
        上一页</button
      ><span
        >{{ page }} / {{ Math.max(1, Math.ceil(total / 16)) }} ·
        {{ total }} 路</span
      ><button
        type="button"
        class="secondary"
        :disabled="disabled || loading || page * 16 >= total"
        @click="
          page++;
          load();
        "
      >
        下一页
      </button>
    </div>
    <p class="panel-note">
      {{
        modelValue
          ? "已选择：" + modelValue.name
          : allowOffline
            ? "选择通道只缩小录像范围，不会点播摄像机。"
            : "选择通道后点击“开始分析”，才会采集一张画面。"
      }}
    </p>
  </div>
</template>
<style scoped>
.ai-channel-search {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ai-channel-search input {
  min-width: 0;
  flex: 1;
}
.ai-channel-options {
  display: grid;
  gap: 6px;
  max-height: 246px;
  overflow: auto;
  margin: 12px 0;
}
.ai-channel-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--panel, #fff);
  border: 1px solid var(--line);
  text-align: left;
  min-height: 60px;
  height: auto;
  color: var(--text);
}
.ai-channel-option.selected {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.ai-channel-option > .app-icon {
  flex: none;
  color: var(--blue);
}
.ai-channel-option > span:nth-child(2) {
  display: grid;
  gap: 5px;
  min-width: 0;
  flex: 1;
}
.ai-channel-option b {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.ai-channel-option small {
  font-size: 11px;
  color: var(--muted);
}
.ai-channel-option .badge {
  flex: none;
}
.ai-channel-pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
.ai-channel-picker .panel-note {
  margin-bottom: 0;
}
</style>

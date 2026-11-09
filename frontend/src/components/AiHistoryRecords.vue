<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { api, ApiError, messageOf } from "../api";
import { aiDate, aiLabels } from "../ai-types";
import AppIcon from "./AppIcon.vue";

interface HistoryRecord {
  id: string;
  params: { question?: string };
  createdAt: string;
  status: string;
}
const emit = defineEmits<{ open: [id: string] }>();
const records = ref<HistoryRecord[]>([]);
const loading = ref(true);
const error = ref("");
let alive = true;
let generation = 0;

async function load() {
  const gen = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ items: HistoryRecord[] }>(
      "/ai/history-searches",
    );
    if (alive && gen === generation)
      records.value = Array.isArray(result.items) ? result.items : [];
  } catch (e) {
    if (alive && gen === generation) {
      error.value = messageOf(e);
      if (e instanceof ApiError && [401, 403].includes(e.status))
        records.value = [];
    }
  } finally {
    if (alive && gen === generation) loading.value = false;
  }
}
function statusLabel(status: string) {
  return status === "partial" ? "部分完成" : aiLabels[status] || status;
}
onMounted(load);
onUnmounted(() => {
  alive = false;
  generation++;
});
</script>

<template>
  <section class="panel ai-history-records" aria-label="录像检索记录">
    <header class="panel-heading history-records-heading">
      <div>
        <h3>录像检索记录</h3>
        <span>共 {{ records.length }} 条</span>
      </div>
      <button type="button" class="secondary" :disabled="loading" @click="load">
        <AppIcon name="refresh" :size="16" />{{
          loading ? "读取中…" : "刷新记录"
        }}
      </button>
    </header>
    <p v-if="error" class="error history-records-error" role="alert">
      {{ error }}，请点击刷新记录重试。
    </p>
    <div
      class="table-scroll data-table-scroll history-records-table"
      :aria-busy="loading"
    >
      <table>
        <thead>
          <tr>
            <th>查询时间</th>
            <th>检索线索</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.id">
            <td class="history-record-date">{{ aiDate(record.createdAt) }}</td>
            <td class="history-record-description">
              {{ record.params?.question || "以图检索" }}
            </td>
            <td>
              <span
                class="badge"
                :class="
                  record.status === 'succeeded'
                    ? 'online'
                    : ['failed', 'interrupted'].includes(record.status)
                      ? 'offline'
                      : 'unregistered'
                "
                >{{ statusLabel(record.status) }}</span
              >
            </td>
            <td>
              <button
                type="button"
                class="link"
                @click="emit('open', record.id)"
              >
                查看结果
              </button>
            </td>
          </tr>
          <tr v-if="!records.length">
            <td colspan="4" class="empty-state">
              {{
                loading
                  ? "正在加载录像检索记录…"
                  : error
                    ? "记录加载失败"
                    : "暂无录像检索记录"
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.ai-history-records {
  width: 100%;
  max-width: none;
  min-width: 0;
  margin: 0;
  padding: 20px;
  overflow: hidden;
}
.history-records-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 0 16px;
  margin: 0 0 16px;
}
.history-records-heading > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}
.history-records-heading h3 {
  margin: 0;
  font-size: 14px;
}
.history-records-heading span {
  font-size: 12px;
  color: var(--muted);
}
.history-records-heading button {
  min-height: 34px;
  padding: 6px 12px;
  font-size: 12px;
  white-space: nowrap;
}
.history-records-error {
  font-size: 13px;
  margin: 0 0 14px;
  line-height: 1.7;
}
.history-records-table {
  width: 100%;
  min-width: 0;
  max-height: 360px;
  overflow: auto;
}
.history-records-table table {
  width: 100%;
  min-width: 640px;
  margin: 0;
}
.history-records-table th,
.history-records-table td {
  text-align: center;
  vertical-align: middle;
  font-size: 13px;
  padding: 12px;
}
.history-record-date {
  width: 210px;
  white-space: nowrap;
}
.history-record-description {
  min-width: 220px;
  max-width: 600px;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.history-records-table th:nth-child(3),
.history-records-table td:nth-child(3) {
  width: 130px;
}
.history-records-table th:last-child,
.history-records-table td:last-child {
  width: 120px;
}
.history-records-table .empty-state {
  padding: 32px 16px;
}
@media (max-width: 760px) {
  .ai-history-records {
    padding: 16px;
  }
  .history-records-heading {
    gap: 10px;
  }
  .history-records-heading > div {
    gap: 7px;
  }
  .history-records-heading h3 {
    font-size: 14px;
  }
  .history-records-table {
    max-height: 55vh;
  }
}
</style>

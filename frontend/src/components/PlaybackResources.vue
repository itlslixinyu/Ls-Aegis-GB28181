<script setup lang="ts">
defineProps<{ count: number; total?: number; query?: string }>();
const emit = defineEmits<{ "update:query": [value: string] }>();
</script>

<template>
  <aside class="playback-resources">
    <header class="resource-heading">
      <h3>通道资源</h3>
      <div class="resource-tools">
        <span
          >{{ query?.trim() ? `${count} / ${total ?? count}` : count }} 路</span
        ><slot name="tools" />
      </div>
    </header>
    <div class="resource-search">
      <input
        type="search"
        aria-label="搜索回放通道"
        placeholder="搜索通道名称或编号"
        maxlength="100"
        :value="query || ''"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="playback-resource-list">
      <slot />
      <p v-if="count === 0 && query?.trim()" class="search-empty" role="status">
        未找到匹配通道
      </p>
    </div>
    <div class="playback-resource-query"><slot name="query" /></div>
  </aside>
</template>

<style scoped>
.playback-resources {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--surface, white);
}
.resource-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  gap: 8px;
  padding: 12px;
  min-height: 52px;
  border-bottom: 1px solid var(--line);
}
.resource-heading h3 {
  margin: 0;
  font-size: 14px;
  white-space: nowrap;
}
.resource-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
}
.resource-tools :deep(button) {
  min-height: 26px;
  padding: 4px;
}
.playback-resource-list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}
.resource-search {
  flex: none;
  padding: 8px 12px 4px;
}
.resource-search input {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 6px 8px;
  font-size: 12px;
  text-align: left;
}
.search-empty {
  margin: 8px 0;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
.playback-resource-list :deep(button) {
  width: 100%;
  min-height: 44px;
  background: transparent;
  border: 1px solid transparent;
  justify-content: flex-start;
  gap: 8px;
  color: var(--text);
  margin-bottom: 4px;
  padding: 8px;
}
.playback-resource-list :deep(button.selected) {
  background: var(--blue-soft);
  border-color: #bed5f7;
  color: var(--blue);
}
.playback-resource-list :deep(button span) {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playback-resource-list :deep(button small) {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}
.playback-resource-query {
  flex: none;
  border-top: 1px solid var(--line);
  max-height: 70%;
  overflow-y: auto;
}
.playback-resource-query :deep(form) {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  margin: 0;
}
.playback-resource-query :deep(h4) {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
}
.playback-resource-query :deep(h4 small) {
  color: var(--muted);
  font-weight: normal;
  font-size: 10px;
}
.playback-resource-query :deep(label) {
  display: grid;
  gap: 5px;
  font-size: 12px;
  margin: 0;
  text-align: left;
}
.playback-resource-query :deep(input) {
  width: 100%;
  min-width: 0;
  padding: 6px;
  font-size: 12px;
  text-align: center;
}
.playback-resource-query :deep(input::-webkit-datetime-edit) {
  text-align: center;
  padding: 0;
}
.playback-resource-query :deep(p) {
  text-align: left;
  margin: 0;
  font-size: 11px;
}
.playback-resource-query :deep(button) {
  min-height: 32px;
  justify-content: center;
}
@media (max-width: 760px) {
  .playback-resources {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 210px;
    grid-template-rows: 44px 42px minmax(0, 1fr);
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .resource-heading {
    min-height: 0;
    padding: 8px;
  }
  .playback-resource-list {
    grid-column: 1;
    grid-row: 3;
  }
  .resource-search {
    grid-column: 1;
    grid-row: 2;
    padding: 4px 8px;
  }
  .playback-resource-query {
    grid-column: 2;
    grid-row: 1 / -1;
    max-height: none;
    border-top: 0;
    border-left: 1px solid var(--line);
  }
}
</style>

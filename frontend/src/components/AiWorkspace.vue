<script setup lang="ts">
import { rememberFilter } from "../remember-filter";
import AiAnalyses from "./AiAnalyses.vue";
import AiSearch from "./AiSearch.vue";
const emit = defineEmits<{ navigate: [page: string] }>();
const section = rememberFilter<"workbench" | "materials">(
  "ai.workspace.section",
  "workbench",
  (value) => ["workbench", "materials"].includes(value),
);
function navigate(page: string) {
  if (page === "aiSearch") section.value = "workbench";
  else emit("navigate", page);
}
</script>
<template>
  <AiSearch v-if="section === 'materials'" materials @navigate="navigate" />
  <AiAnalyses v-else @materials="section = 'materials'" @navigate="navigate" />
</template>

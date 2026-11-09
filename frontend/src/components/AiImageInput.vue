<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import AppIcon from "./AppIcon.vue";
defineProps<{ disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{
  change: [value: { image: string; name: string } | null];
  error: [message: string];
}>();
const input = ref<HTMLInputElement>(),
  canvas = ref<HTMLCanvasElement>(),
  name = ref(""),
  loading = ref(false);
let generation = 0;
async function selected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const gen = ++generation;
  loading.value = true;
  emit("error", "");
  emit("change", null);
  name.value = "";
  let bitmap: ImageBitmap | undefined;
  try {
    if (
      file.size > 3 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
        file.type,
      )
    )
      throw Error("请选择不超过3MB的JPEG、PNG、WebP或GIF图片");
    bitmap = await createImageBitmap(file);
    if (gen !== generation) return;
    if (bitmap.width * bitmap.height > 16_000_000)
      throw Error("图片像素不能超过1600万");
    const target = canvas.value;
    if (!target) throw Error("图片预览不可用");
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    target.width = Math.max(1, Math.round(bitmap.width * scale));
    target.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = target.getContext("2d");
    if (!context) throw Error("图片预览不可用");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    name.value = file.name;
    emit("change", {
      image: target.toDataURL("image/jpeg", 0.82),
      name: file.name,
    });
  } catch (e) {
    if (gen === generation)
      emit("error", e instanceof Error ? e.message : "图片读取失败");
  } finally {
    bitmap?.close();
    if (gen === generation) loading.value = false;
    if (input.value) input.value.value = "";
  }
}
function clear() {
  generation++;
  name.value = "";
  emit("change", null);
  emit("error", "");
}
function drawPreview(target:HTMLCanvasElement){
 const original=canvas.value;if(!original||!name.value)return false;
 target.width=original.width;target.height=original.height;
 const context=target.getContext('2d');if(!context)return false;
 context.drawImage(original,0,0);return true;
}
defineExpose({drawPreview});
onUnmounted(() => generation++);
</script>
<template>
  <div class="ai-image-input" :class="{compact}">
    <input
      ref="input"
      type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      class="ai-file-input"
      aria-label="选择分析图片"
      :disabled="disabled || loading"
      @change="selected"
    /><canvas
      ref="canvas"
      v-show="name"
      role="img"
      :aria-label="name || '图片预览'"
    ></canvas>
    <div v-if="!name" class="ai-image-placeholder">
      <AppIcon name="records" :size="32" /><b>选择图片进行分析</b
      ><span>JPEG / PNG / WebP / GIF，最大3MB</span>
    </div>
    <div class="ai-image-actions">
      <span :title="name">{{
        loading ? "正在读取图片…" : name || "尚未选择图片"
      }}</span
      ><button
        type="button"
        class="secondary"
        :disabled="disabled || loading"
        @click="input?.click()"
      >
        {{ name ? "更换图片" : "选择图片" }}</button
      ><button
        v-if="name"
        type="button"
        class="link"
        :disabled="disabled || loading"
        @click="clear"
      >
        清除
      </button>
    </div>
  </div>
</template>
<style scoped>
.ai-image-input {
  border: 1px dashed var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-alt, #f8fafd);
}
.ai-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.ai-image-input canvas {
  display: block;
  width: 100%;
  height: 210px;
  object-fit: contain;
  background: #eef2f7;
}
.ai-image-placeholder {
  min-height: 210px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}
.ai-image-placeholder b {
  font-size: 14px;
  color: var(--text);
}
.ai-image-placeholder .app-icon {
  color: var(--blue);
}
.ai-image-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: var(--panel, #fff);
  border-top: 1px solid var(--line);
}
.ai-image-actions > span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
}
.compact{display:flex;align-items:center;min-height:64px}
.compact canvas{width:74px;height:64px;flex:none}
.compact .ai-image-placeholder{display:none}
.compact .ai-image-actions{border:0;min-width:0;padding:8px;flex:1;flex-wrap:wrap;gap:6px}
.compact .ai-image-actions>span{flex-basis:100%;font-size:11px}
.compact .ai-image-actions button{font-size:12px;padding:4px 8px;min-height:28px;height:auto}
</style>

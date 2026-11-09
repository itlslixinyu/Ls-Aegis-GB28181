<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import AppIcon from "./AppIcon.vue";
import type { VideoThumbnail } from "../video-thumbnail";
const props = defineProps<{ frame?: VideoThumbnail }>();
const canvas = ref<HTMLCanvasElement>();
function paint() {
  const element = canvas.value,
    pixels = props.frame?.pixels;
  if (!element || !pixels) return;
  element.width = pixels.width;
  element.height = pixels.height;
  element.getContext("2d")?.putImageData(pixels, 0, 0);
}
onMounted(paint);
watch(() => props.frame, paint, { flush: "post" });
</script>
<template>
  <span class="channel-thumbnail">
    <canvas
      v-if="frame"
      ref="canvas"
      role="img"
      aria-label="通道预览缩略图"
    ></canvas>
    <template v-else
      ><AppIcon name="devices" :size="22" /><span>暂无预览</span></template
    >
  </span>
</template>

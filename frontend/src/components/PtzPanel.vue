<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { api, messageOf } from "../api";
import AppIcon from "./AppIcon.vue";
import type { Channel } from "./Monitoring.vue";
const props = defineProps<{ channel: Channel | null }>();
const speed = ref(96),
  held = ref(""),
  message = ref(""),
  error = ref(false);
const enabled = computed(
  () =>
    props.channel?.status === "online" &&
    props.channel?.deviceStatus === "online",
);
const directions = [
  ["upLeft", "↖", "左上"],
  ["up", "↑", "向上"],
  ["upRight", "↗", "右上"],
  ["left", "←", "向左"],
  ["stop", "■", "停止"],
  ["right", "→", "向右"],
  ["downLeft", "↙", "左下"],
  ["down", "↓", "向下"],
  ["downRight", "↘", "右下"],
];
const lensControls = [
  ["zoomIn", "放大＋", "按住放大，松开停止"],
  ["zoomOut", "缩小−", "按住缩小，松开停止"],
  ["focusNear", "聚焦近＋", "按住向近处聚焦，松开停止；需设备支持"],
  ["focusFar", "聚焦远−", "按住向远处聚焦，松开停止；需设备支持"],
];
let current: { channelId: string; token: string } | null = null,
  alive = true;
async function start(action: string, event?: PointerEvent) {
  if (action === "stop") {
    await stop(true);
    return;
  }
  if (!enabled.value || current) return;
  if (event && event.button !== 0) return;
  event?.preventDefault();
  if (event)
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const command = { channelId: props.channel!.id, token: crypto.randomUUID() };
  current = command;
  held.value = action;
  error.value = false;
  message.value = "正在发送控制指令";
  try {
    const result = await api<{ commandId: string }>(
      `/channels/${encodeURIComponent(command.channelId)}/ptz`,
      "POST",
      { action, speed: speed.value, duration: 2000, token: command.token },
    );
    if (current !== command || !alive) return;
    const status = await api<{ status: string; error?: string }>(
      `/commands/${result.commandId}`,
    );
    if (current !== command || !alive) return;
    message.value =
      status.status === "acknowledged"
        ? "设备已受理；单次动作最长2秒"
        : "指令已提交，等待设备响应";
    if (status.status === "failed") throw Error(status.error || "云台控制失败");
  } catch (e) {
    if (current === command && alive) {
      error.value = true;
      const reason = messageOf(e);
      message.value =
        action.startsWith("focus") && /云台方向或速度无效/.test(reason)
          ? "当前后端尚未启用聚焦控制，请更新重启平台后重试"
          : reason;
      void stop();
    }
  }
}
async function stop(emergency = false) {
  const command = current;
  current = null;
  held.value = "";
  const channelId =
    command?.channelId || (emergency ? props.channel?.id : null);
  if (!channelId) return;
  try {
    await api(`/channels/${encodeURIComponent(channelId)}/ptz`, "POST", {
      action: "stop",
      ...(command ? { token: command.token } : {}),
    });
    if (alive && !error.value) message.value = "停止指令已提交";
  } catch (e) {
    if (alive) {
      error.value = true;
      message.value = messageOf(e);
    }
  }
}
function hidden() {
  if (document.hidden) void stop();
}
function blur() {
  void stop();
}
watch(
  () => props.channel?.id,
  () => {
    void stop();
    message.value = "";
  },
);
onMounted(() => {
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", hidden);
});
onUnmounted(() => {
  alive = false;
  window.removeEventListener("blur", blur);
  document.removeEventListener("visibilitychange", hidden);
  void stop();
});
</script>
<template>
  <div class="ptz-panel">
    <div class="panel-heading">
      <h3>云台控制</h3>
      <span>{{ channel?.name || "未选择通道" }}</span>
    </div>
    <div class="ptz-body">
      <div class="ptz-pad">
        <button
          v-for="[action, symbol, label] in directions"
          :key="action"
          :aria-label="label"
          :title="label"
          :disabled="
            !enabled || (!!held && held !== action && action !== 'stop')
          "
          :class="{ pressed: held === action }"
          @pointerdown="start(action, $event)"
          @pointerup="stop()"
          @pointercancel="stop()"
          @lostpointercapture="stop()"
          @contextmenu.prevent
          @keydown.enter.prevent="start(action)"
          @keyup.enter.prevent="stop()"
          @keydown.space.prevent="start(action)"
          @keyup.space.prevent="stop()"
        >
          <AppIcon
            :name="action === 'stop' ? 'stop' : 'arrow'"
            :size="action === 'stop' ? 14 : 16"
            class="ptz-direction"
            :class="action"
          />
        </button>
      </div>
      <div class="ptz-options">
        <label
          ><span class="ptz-speed-label">移动速度</span
          ><select v-model.number="speed">
            <option :value="48">低速</option>
            <option :value="96">中速</option>
            <option :value="192">高速</option>
          </select></label
        >
        <div class="zoom-buttons">
          <button
            v-for="[action, label, title] in lensControls"
            :key="action"
            :aria-label="label"
            :title="title"
            :disabled="!enabled || (!!held && held !== action)"
            :class="{ pressed: held === action }"
            @pointerdown="start(action, $event)"
            @pointerup="stop()"
            @pointercancel="stop()"
            @lostpointercapture="stop()"
            @keydown.enter.prevent="start(action)"
            @keyup.enter.prevent="stop()"
            @keydown.space.prevent="start(action)"
            @keyup.space.prevent="stop()"
          >
            {{ label }}
          </button>
        </div>
      </div>
    </div>
    <p v-if="message" class="ptz-message" :class="{ error }" role="status">
      {{ message }}
    </p>
  </div>
</template>

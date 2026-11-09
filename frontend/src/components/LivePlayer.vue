<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { PlaybackClock } from "../playback-clock";
import AppIcon from "./AppIcon.vue";
import type { VideoThumbnail } from "../video-thumbnail";
import DialogHeading from "./DialogHeading.vue";
import mpegts from "mpegts.js";
import { openFragmentedPreview } from "../fragmented-preview";
import { api, ApiError, messageOf, type RecordClip } from "../api";
import { probePlatform, waitForPlatformRestart } from "../platform-recovery";
import type { Channel } from "./Monitoring.vue";
interface Viewing {
  sessionId: string;
  viewerId: string;
  state: string;
  playUrl?: string;
  error?: string;
}
const props = defineProps<{
  channel: Channel;
  record?: RecordClip;
  canMaximize?: boolean;
  maximized?: boolean;
  bottomControls?: boolean;
  resumeKey?: string;
  playbackClock?: PlaybackClock;
  playbackDate?: string;
}>();
const emit = defineEmits<{
  close: [];
  "toggle-maximize": [];
  thumbnail: [frame: VideoThumbnail];
}>();
const playerRoot = ref<HTMLDivElement>(),
  settingsDialog = ref<HTMLDialogElement>();
const streamNumber = ref(0),
  toolsOpen = ref(false),
  muted = ref(true),
  volume = ref(70),
  fit = ref("contain");
const viewerStorageKey = props.resumeKey ? props.resumeKey + ":viewer" : "";
function savedViewer(): {
  sessionId: string;
  viewerId: string;
  streamNumber: number;
  channelId: string;
} | null {
  try {
    const value =
      viewerStorageKey &&
      JSON.parse(sessionStorage.getItem(viewerStorageKey) || "null");
    return value &&
      typeof value.sessionId === "string" &&
      typeof value.viewerId === "string" &&
      value.channelId === props.channel.id &&
      [0, 1].includes(value.streamNumber)
      ? value
      : null;
  } catch {
    return null;
  }
}
const resumeViewer = savedViewer();
if (resumeViewer) streamNumber.value = resumeViewer.streamNumber;
function storeViewer(value: Viewing | null) {
  if (!viewerStorageKey) return;
  try {
    if (value)
      sessionStorage.setItem(
        viewerStorageKey,
        JSON.stringify({
          sessionId: value.sessionId,
          viewerId: value.viewerId,
          channelId: props.channel.id,
          streamNumber: streamNumber.value,
        }),
      );
    else sessionStorage.removeItem(viewerStorageKey);
  } catch {
    /* Playback also works when browser storage is unavailable. */
  }
}
let resumeAttempted = false;
async function acquireViewer(): Promise<Viewing> {
  if (!resumeAttempted && resumeViewer && !props.record) {
    resumeAttempted = true;
    try {
      const state = await api<Viewing>(
        `/live-sessions/${resumeViewer.sessionId}?viewerId=${resumeViewer.viewerId}`,
      );
      if (
        !["failed", "stopped", "stopping", "completed"].includes(state.state)
      ) {
        await api(
          `/live-sessions/${resumeViewer.sessionId}/viewers/${resumeViewer.viewerId}/renew`,
          "POST",
          {},
        );
        return {
          ...state,
          sessionId: resumeViewer.sessionId,
          viewerId: resumeViewer.viewerId,
        };
      }
    } catch {
      /* Expired leases and changed permissions are checked again on creation. */
    }
    await api(
      `/live-sessions/${resumeViewer.sessionId}/viewers/${resumeViewer.viewerId}`,
      "DELETE",
    ).catch(() => {});
  }
  resumeAttempted = true;
  return api<Viewing>(
    props.record ? "/playback-sessions" : "/live-sessions",
    "POST",
    props.record
      ? { recordId: props.record.id }
      : { channelId: props.channel.id, streamNumber: streamNumber.value },
    { "Idempotency-Key": crypto.randomUUID() },
  );
}
const hasAudio = ref<boolean | null>(null),
  audioUnsupported = ref(false),
  notice = ref(""),
  connecting = ref(false),
  fullScreen = ref(false);
const resolution = ref(""),
  videoCodec = ref(""),
  audioCodec = ref("");
const soundLabel = computed(() =>
  audioUnsupported.value
    ? "音频编码不支持"
    : hasAudio.value === false
      ? "当前码流无音轨"
      : muted.value
        ? "开启声音"
        : "关闭声音",
);
let playGeneration = 0,
  ownerDocument: Document | undefined;
function syncFullscreen() {
  fullScreen.value = ownerDocument?.fullscreenElement === playerRoot.value;
}
async function toggleFullscreen() {
  const element = playerRoot.value;
  if (!element) return;
  notice.value = "";
  try {
    if (element.ownerDocument.fullscreenElement === element)
      await element.ownerDocument.exitFullscreen();
    else if (element.requestFullscreen) await element.requestFullscreen();
    else notice.value = "当前浏览器不支持全屏，请使用放大画面";
  } catch {
    notice.value = "无法进入全屏，请检查浏览器权限";
  }
}
function enlarge() {
  if (fullScreen.value) void toggleFullscreen();
  else if (props.canMaximize) emit("toggle-maximize");
  else void toggleFullscreen();
}
function setVolume() {
  volume.value = Math.min(100, Math.max(0, volume.value));
  muted.value = volume.value === 0;
  if (video.value) {
    video.value.volume = volume.value / 100;
    video.value.muted = muted.value;
  }
}
async function toggleAudio() {
  if (!ready.value || hasAudio.value === false || audioUnsupported.value)
    return;
  muted.value = !muted.value;
  if (!muted.value && volume.value === 0) volume.value = 70;
  if (video.value) {
    video.value.muted = muted.value;
    video.value.volume = volume.value / 100;
  }
  if (!muted.value) await startPlayback();
}
function updateVideoInfo() {
  if (video.value?.videoWidth && video.value.videoHeight) {
    resolution.value = `${video.value.videoWidth} × ${video.value.videoHeight}`;
  }
}
let lastThumbnailAt = 0;
function captureThumbnail() {
  const element = video.value;
  if (
    props.record ||
    !alive ||
    !playing.value ||
    !element ||
    element.readyState < 2 ||
    !element.videoWidth ||
    !element.videoHeight
  )
    return;
  const now = Date.now();
  if (now - lastThumbnailAt < 15000) return;
  lastThumbnailAt = now;
  try {
    const canvas = element.ownerDocument.createElement("canvas");
    const ratio = Math.min(
      192 / element.videoWidth,
      108 / element.videoHeight,
      1,
    );
    canvas.width = Math.max(1, Math.round(element.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(element.videoHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    emit("thumbnail", {
      pixels: context.getImageData(0, 0, canvas.width, canvas.height),
      capturedAt: now,
    });
  } catch {
    // Thumbnail failure must not interrupt the real-time media session.
  }
}
function onPlaying() {
  playing.value = true;
  clearTimeout(stablePlaybackTimer);
  stablePlaybackTimer = setTimeout(() => {
    if (alive && playing.value) mediaRetries = 0;
  }, 60000);
  captureThumbnail();
}
function snapshot() {
  const element = video.value;
  if (!element || element.readyState < 2 || !element.videoWidth) {
    notice.value = "画面尚未就绪，暂不能截图";
    return;
  }
  try {
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw Error();
    context.drawImage(element, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob || !alive) {
        if (alive) notice.value = "截图失败，请重试";
        return;
      }
      const url = URL.createObjectURL(blob),
        link = element.ownerDocument.createElement("a");
      link.href = url;
      link.download = `${props.channel.channelCode}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  } catch {
    notice.value = "截图失败，请检查浏览器权限";
  }
}
const video = ref<HTMLVideoElement>(),
  message = ref("准备点播…"),
  failed = ref(false),
  playing = ref(false),
  paused = ref(false),
  controlBusy = ref(false),
  controlError = ref(""),
  position = ref(0),
  target = ref(0),
  scale = ref(1),
  ready = ref(false),
  ended = ref(false);
const duration = props.record
  ? Math.floor(
      (Date.parse(props.record.end) - Date.parse(props.record.start)) / 1000,
    )
  : 0;
let pendingPause = false;
let basePosition = 0,
  baseMediaTime: number | null = null,
  playUrl = "";
let alive = true,
  viewing: Viewing | null = null,
  player: Pick<
    ReturnType<typeof mpegts.createPlayer>,
    "play" | "pause" | "destroy"
  > | null = null,
  renewal: ReturnType<typeof setInterval> | undefined,
  renewing = false;
let platformInstance = "",
  failureGeneration = -1;
let recovery: AbortController | null = null;
function destroyPlayer() {
  const p = player;
  player = null;
  if (p)
    try {
      p.destroy();
    } catch {}
  if (p && video.value) {
    video.value.removeAttribute("src");
    video.value.load();
  }
}
async function release() {
  clearInterval(renewal);
  const current = viewing;
  viewing = null;
  if (current) {
    const saved = savedViewer();
    if (
      saved &&
      saved.viewerId === current.viewerId &&
      saved.sessionId === current.sessionId
    )
      storeViewer(null);
  }
  if (current)
    await api(
      `/live-sessions/${current.sessionId}/viewers/${current.viewerId}`,
      "DELETE",
    ).catch(() => {});
}
async function failure(error: unknown) {
  if (!alive || ended.value || failureGeneration === playGeneration) return;
  const generation = playGeneration;
  failureGeneration = generation;
  failed.value = true;
  ready.value = false;
  playing.value = false;
  paused.value = false;
  message.value = messageOf(error);
  destroyPlayer();
  autoplayBlocked.value = false;
  await release();
  if (
    !alive ||
    generation !== playGeneration ||
    props.record ||
    !platformInstance ||
    (error instanceof ApiError && [401, 403].includes(error.status))
  )
    return;
  const controller = new AbortController();
  recovery = controller;
  failed.value = false;
  connecting.value = true;
  message.value = "连接中断，正在确认平台是否重启…";
  const instance = await waitForPlatformRestart(platformInstance, {
    signal: controller.signal,
  });
  if (!alive || generation !== playGeneration || controller.signal.aborted)
    return;
  recovery = null;
  if (instance) {
    message.value = "平台已恢复，正在重新点播…";
    await connect();
  } else {
    connecting.value = false;
    failed.value = true;
    message.value = messageOf(error);
  }
}
const autoplayBlocked = ref(false);
const synchronizedGap = ref(false);
const mediaDiagnostic = ref("");
let mediaRetries = 0,
  mediaErrorBusy = false,
  mediaRetryTimer: ReturnType<typeof setTimeout> | undefined,
  stablePlaybackTimer: ReturnType<typeof setTimeout> | undefined;
async function mediaFailure(type: string, detail: string, description: string) {
  if (!alive || ended.value) return;
  const label = /network|ioerror|eof/i.test(type + detail)
    ? "媒体连接中断"
    : /codec|format|unsupported/i.test(detail + description)
      ? "浏览器无法解码当前视频"
      : "视频解码或缓冲异常";
  mediaDiagnostic.value = `${label}（${type || "播放器"} / ${detail || "未知错误"}）`;
  try {
    if (viewerStorageKey)
      sessionStorage.setItem(
        viewerStorageKey + ":last-error",
        JSON.stringify({
          type,
          detail,
          description: description.slice(0, 300),
          at: Date.now(),
        }),
      );
  } catch {}
  const current = viewing,
    gen = playGeneration;
  if (current) {
    try {
      const state = await api<Viewing>(
        `/live-sessions/${current.sessionId}?viewerId=${current.viewerId}`,
      );
      if (!alive || playerGenerationMismatch(gen, current)) return;
      if (props.record && state.state === "completed") {
        await finishPlayback();
        return;
      }
      if (["failed", "stopped", "stopping"].includes(state.state)) {
        await failure(Error(state.error || "设备媒体会话已结束，请重新连接"));
        return;
      }
      if (
        !props.record &&
        state.state === "ready" &&
        mediaRetries < 2 &&
        !/unsupported|codec/i.test(detail + description)
      ) {
        mediaRetries++;
        destroyPlayer();
        playing.value = false;
        connecting.value = true;
        message.value = `${label}，正在重新连接（${mediaRetries}/2）…`;
        mediaRetryTimer = setTimeout(() => {
          if (alive && !playerGenerationMismatch(gen, current)) {
            connecting.value = false;
            attach();
          }
        }, mediaRetries * 1000);
        return;
      }
    } catch (error) {
      if (!alive || gen !== playGeneration) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        await failure(error);
        return;
      }
    }
  }
  if (alive && gen === playGeneration)
    await failure(
      Error(mediaDiagnostic.value + "，请重新连接；可在画面设置查看诊断信息"),
    );
}
function playerGenerationMismatch(gen: number, current: Viewing) {
  return gen !== playGeneration || viewing !== current;
}
let committedScale = 1;
async function startPlayback() {
  const p = player;
  if (!p) return;
  try {
    await p.play();
    if (alive && player === p) autoplayBlocked.value = false;
  } catch {
    if (alive && player === p) {
      autoplayBlocked.value = true;
      message.value = "浏览器尚未允许播放，请再次点击播放视频";
    }
  }
}
const stages: Record<string, string> = {
  allocating: "正在分配媒体资源",
  inviting: "正在请求设备点播",
  waiting_media: "等待设备发送视频流",
  ready: "媒体已就绪，正在加载画面",
};
async function connect() {
  clearTimeout(mediaRetryTimer);
  clearTimeout(stablePlaybackTimer);
  mediaRetries = 0;
  const gen = ++playGeneration;
  recovery?.abort();
  recovery = null;
  failureGeneration = -1;
  destroyPlayer();
  await release();
  if (!alive || gen !== playGeneration) return;
  failed.value = false;
  ready.value = false;
  playing.value = false;
  paused.value = false;
  ended.value = false;
  connecting.value = true;
  renewing = false;
  hasAudio.value = null;
  audioUnsupported.value = false;
  resolution.value = "";
  videoCodec.value = "";
  audioCodec.value = "";
  notice.value = "";
  message.value = "准备点播…";
  if (!mpegts.getFeatureList().mseLivePlayback) {
    connecting.value = false;
    failed.value = true;
    message.value = "当前浏览器不支持实时视频播放，请更换现代桌面浏览器";
    return;
  }
  try {
    if (!props.record) {
      platformInstance = (await probePlatform())?.instanceId || "";
      if (!alive || gen !== playGeneration) return;
    }
    const result = await acquireViewer();
    if (!alive || gen !== playGeneration) {
      await api(
        `/live-sessions/${result.sessionId}/viewers/${result.viewerId}`,
        "DELETE",
      ).catch(() => {});
      return;
    }
    viewing = result;
    storeViewer(result);
    renewal = setInterval(async () => {
      if (!viewing || renewing || !alive || gen !== playGeneration) return;
      renewing = true;
      try {
        await api(
          `/live-sessions/${result.sessionId}/viewers/${result.viewerId}/renew`,
          "POST",
          {},
        );
      } catch (e) {
        if (!alive || gen !== playGeneration) return;
        if (props.record && viewing) {
          try {
            const state = await api<Viewing>(
              `/live-sessions/${viewing.sessionId}?viewerId=${viewing.viewerId}`,
            );
            if (state.state === "completed") {
              await finishPlayback();
              return;
            }
          } catch {}
        }
        await failure(e);
      } finally {
        if (gen === playGeneration) renewing = false;
      }
    }, 15000);
    while (alive && viewing && gen === playGeneration) {
      const current = await api<Viewing>(
        `/live-sessions/${result.sessionId}?viewerId=${result.viewerId}`,
      );
      if (!alive || !viewing || gen !== playGeneration) break;
      message.value = stages[current.state] || current.state;
      if (current.state === "completed" && props.record) {
        await finishPlayback();
        break;
      }
      if (["failed", "stopped", "stopping"].includes(current.state))
        throw Error(current.error || "设备点播已结束");
      if (current.state === "ready" && !player) {
        if (!current.playUrl) throw Error("未获得播放地址");
        ready.value = true;
        connecting.value = false;
        const url = new URL(current.playUrl, window.location.href);
        if (!url.pathname.endsWith("/stream.mp4"))
          url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        playUrl = url.toString();
        attach();
      }
      await new Promise((r) =>
        setTimeout(r, current.state === "ready" ? 5000 : 1000),
      );
    }
  } catch (e) {
    if (alive && gen === playGeneration) {
      connecting.value = false;
      await failure(e);
    }
  }
}
onMounted(() => {
  ownerDocument = playerRoot.value?.ownerDocument;
  ownerDocument?.addEventListener("fullscreenchange", syncFullscreen);
  void connect();
});
async function finishPlayback() {
  if (!alive) return;
  ended.value = true;
  ready.value = false;
  playing.value = false;
  paused.value = false;
  message.value = "录像回放已结束";
  player?.pause();
  await release();
}
function attach() {
  autoplayBlocked.value = false;
  destroyPlayer();
  if (playUrl.endsWith("/stream.mp4")) {
    const element = video.value!;
    const generation = playGeneration;
    const sourceUrl = playUrl;
    const isCurrent = () =>
      alive && generation === playGeneration && playUrl === sourceUrl;
    player = openFragmentedPreview(
      element,
      playUrl,
      (codec) => {
        if (!isCurrent()) return;
        videoCodec.value = codec;
        audioCodec.value = "mp4a.40.2";
        hasAudio.value = true;
      },
      (error) => {
        if (!isCurrent() || !viewing) return;
        if (!mpegts.getFeatureList().mseLivePlayback) {
          void failure(error);
          return;
        }
        const fallback = new URL(playUrl);
        fallback.pathname = fallback.pathname.replace(/\.mp4$/, ".flv");
        fallback.protocol = fallback.protocol === "https:" ? "wss:" : "ws:";
        playUrl = fallback.toString();
        playing.value = false;
        videoCodec.value = "";
        audioCodec.value = "";
        notice.value = "正在使用兼容模式加载画面";
        attach();
      },
    );
    element.muted = muted.value;
    element.volume = volume.value / 100;
    void startPlayback();
    return;
  }
  const p = mpegts.createPlayer(
    {
      type: "flv",
      isLive: true,
      url: playUrl,
      ...(audioUnsupported.value ? { hasAudio: false } : {}),
    },
    {
      enableWorker: false,
      enableStashBuffer: false,
      liveBufferLatencyChasing: !props.record,
    },
  );
  player = p;
  p.on(
    mpegts.Events.MEDIA_INFO,
    (info: {
      hasAudio?: boolean;
      videoCodec?: string;
      audioCodec?: string;
    }) => {
      if (!alive || player !== p) return;
      hasAudio.value = audioUnsupported.value ? false : (info.hasAudio ?? null);
      videoCodec.value = info.videoCodec || "";
      audioCodec.value = info.audioCodec || "";
      updateVideoInfo();
    },
  );
  p.on(
    mpegts.Events.ERROR,
    (_type: string, _detail: string, info: { msg?: string } | string) => {
      // mpegts still uses its emitter after dispatching ERROR, including in
      // queued microtasks. Destroying it in that stack causes null.emit errors.
      setTimeout(() => {
        if (!alive || player !== p) return;
        if (ended.value || (props.record && (paused.value || pendingPause)))
          return;
        const detail = typeof info === "string" ? info : info?.msg || "";
        if (
          player === p &&
          !audioUnsupported.value &&
          /unsupported audio codec/i.test(detail)
        ) {
          audioUnsupported.value = true;
          hasAudio.value = false;
          muted.value = true;
          notice.value = "设备音频编码暂不支持网页播放，正在尝试仅播放视频";
          attach();
          return;
        }
        if (player === p && !mediaErrorBusy) {
          mediaErrorBusy = true;
          void mediaFailure(_type, _detail, detail).finally(() => {
            mediaErrorBusy = false;
          });
        }
      }, 0);
    },
  );
  p.attachMediaElement(video.value!);
  p.load();
  if (video.value) video.value.playbackRate = Math.abs(scale.value);
  if (video.value) {
    video.value.muted = muted.value;
    video.value.volume = volume.value / 100;
  }
  Promise.resolve(p.play()).catch(() => {
    if (alive && player === p) {
      autoplayBlocked.value = true;
      message.value = "浏览器已暂停自动播放，请点击播放视频";
    }
  });
}
function updatePosition() {
  captureThumbnail();
  if (!props.record || !video.value) return;
  if (baseMediaTime === null) baseMediaTime = video.value.currentTime;
  position.value = Math.min(
    duration,
    Math.max(
      0,
      basePosition +
        Math.max(0, video.value.currentTime - baseMediaTime) *
          Math.sign(committedScale),
    ),
  );
}
async function control(action: string) {
  if (!viewing || controlBusy.value) return;
  controlBusy.value = true;
  controlError.value = "";
  const wasPaused = paused.value;
  pendingPause = action === "pause";
  try {
    await api(`/playback-sessions/${viewing.sessionId}/control`, "POST", {
      viewerId: viewing.viewerId,
      action,
      scale: scale.value,
      position: target.value,
    });
    if (!alive || !viewing) return;
    if (action === "pause") {
      paused.value = true;
      player?.pause();
    }
    if (action === "resume") {
      paused.value = false;
      basePosition = position.value;
      baseMediaTime = null;
      attach();
    }
    if (action === "speed" && video.value) {
      basePosition = position.value;
      baseMediaTime = video.value.currentTime;
      committedScale = scale.value;
      paused.value = false;
      video.value.playbackRate = Math.abs(scale.value);
      if (wasPaused) {
        basePosition = position.value;
        baseMediaTime = null;
        attach();
      } else await player?.play();
    }
    if (action === "seek") {
      basePosition = target.value;
      baseMediaTime = null;
      position.value = target.value;
      playing.value = false;
      attach();
      paused.value = false;
    }
  } catch (e) {
    if (action === "speed") scale.value = committedScale;
    const reason = messageOf(e);
    controlError.value =
      action === "speed" && /回放倍速无效/.test(reason)
        ? "当前运行后端尚未启用该倍速，请更新平台后重试"
        : reason;
  } finally {
    pendingPause = false;
    controlBusy.value = false;
  }
}
let synchronizing = false,
  synchronizedRevision = -1,
  lastCorrection = 0,
  blockedRevision = -1;
async function synchronizeDevice() {
  const clock = props.playbackClock,
    record = props.record;
  if (
    clock &&
    record &&
    ended.value &&
    !connecting.value &&
    clock.revision !== synchronizedRevision
  ) {
    const offset =
      (Date.parse(
        (props.playbackDate || record.start.slice(0, 10)) + "T00:00:00+08:00",
      ) +
        clock.position * 1000 -
        Date.parse(record.start)) /
      1000;
    if (offset >= 0 && offset < duration) {
      synchronizedRevision = clock.revision;
      void connect();
      return;
    }
  }
  if (
    !clock ||
    !record ||
    !ready.value ||
    !viewing ||
    synchronizing ||
    controlBusy.value ||
    blockedRevision === clock.revision
  )
    return;
  synchronizing = true;
  const revision = clock.revision;
  try {
    muted.value = clock.muted || clock.direction === -1;
    const midnight = Date.parse(
      (props.playbackDate || record.start.slice(0, 10)) + "T00:00:00+08:00",
    );
    const offset =
      (midnight + clock.position * 1000 - Date.parse(record.start)) / 1000;
    if (offset < 0 || offset >= duration) {
      synchronizedGap.value = true;
      if (!paused.value) await control("pause");
      notice.value = "当前时段无录像";
      return;
    }
    notice.value = "";
    synchronizedGap.value = false;
    if (
      synchronizedRevision !== revision ||
      (clock.playing &&
        Math.abs(position.value - offset) > 2 &&
        performance.now() - lastCorrection > 5000)
    ) {
      target.value = Math.min(duration - 0.1, Math.max(0, offset));
      await control("seek");
      lastCorrection = performance.now();
      if (controlError.value) {
        blockedRevision = revision;
        return;
      }
      synchronizedRevision = revision;
    }
    if (!alive || !viewing) return;
    const desiredScale = clock.speed * (clock.direction || 1);
    if (scale.value !== desiredScale) {
      scale.value = desiredScale;
      await control("speed");
    }
    if (controlError.value) {
      blockedRevision = revision;
      return;
    }
    if (clock.playing && paused.value) await control("resume");
    if (!clock.playing && !paused.value) await control("pause");
    if (controlError.value) blockedRevision = revision;
  } finally {
    synchronizing = false;
  }
}
watch(
  () => [
    ready.value,
    props.playbackClock?.position,
    props.playbackClock?.playing,
    props.playbackClock?.speed,
    props.playbackClock?.direction,
    props.playbackClock?.revision,
    props.playbackClock?.muted,
  ],
  () => void synchronizeDevice(),
  { flush: "post" },
);
let retiring: Promise<void> | null = null;
function retire() {
  if (retiring) return retiring;
  alive = false;
  recovery?.abort();
  playGeneration++;
  clearTimeout(mediaRetryTimer);
  clearTimeout(stablePlaybackTimer);
  destroyPlayer();
  return (retiring = release());
}
defineExpose({ retire });
onUnmounted(() => {
  clearTimeout(mediaRetryTimer);
  clearTimeout(stablePlaybackTimer);
  alive = false;
  recovery?.abort();
  playGeneration++;
  ownerDocument?.removeEventListener("fullscreenchange", syncFullscreen);
  destroyPlayer();
  void release();
});
</script>
<template>
  <div
    class="live-player"
    ref="playerRoot"
    :class="{ 'player-fullscreen': fullScreen, 'is-tools-open': toolsOpen }"
    @pointerleave="toolsOpen = false"
    @keydown.esc="toolsOpen = false"
  >
    <div class="player-caption">
      <span>{{ record ? "录像回放 · " : "" }}{{ channel.name }}</span
      ><button
        v-if="!bottomControls"
        aria-label="关闭预览"
        title="关闭预览"
        @click.stop="emit('close')"
      >
        ×
      </button>
    </div>
    <video
      ref="video"
      :muted="muted"
      autoplay
      playsinline
      :style="{
        objectFit: fit as 'contain' | 'fill' | 'cover',
        visibility: synchronizedGap ? 'hidden' : 'visible',
      }"
      @dblclick.stop="enlarge"
      @loadedmetadata="updateVideoInfo"
      @resize="updateVideoInfo"
      @playing="onPlaying"
      @waiting="playing = false"
      @timeupdate="updatePosition"
    ></video>
    <button
      v-if="bottomControls"
      class="preview-close preview-close-standalone"
      aria-label="关闭预览"
      title="关闭预览"
      @click="emit('close')"
    >
      <AppIcon name="close" :size="16" />
    </button>
    <button
      v-if="bottomControls"
      class="preview-tools-trigger"
      aria-label="画面工具"
      title="画面工具：码流、声音、放大、全屏和设置"
      :aria-expanded="toolsOpen"
      @click.stop="toolsOpen = !toolsOpen"
      @dblclick.stop
    >
      <AppIcon :name="toolsOpen ? 'chevron' : 'config'" :size="15" />
    </button>
    <div class="preview-toolbar" @click.stop @dblclick.stop>
      <select
        v-if="!record"
        v-model.number="streamNumber"
        class="live-stream-select"
        aria-label="码流选择"
        :disabled="connecting"
        @change="connect()"
      >
        <option :value="0">主码流</option>
        <option :value="1">子码流</option>
      </select>
      <button
        :aria-label="soundLabel"
        :title="soundLabel"
        :aria-pressed="!muted"
        :disabled="!ready || hasAudio === false || audioUnsupported"
        @click="toggleAudio"
      >
        <AppIcon :name="muted ? 'volume-off' : 'volume-on'" :size="16" />
      </button>
      <button
        v-if="canMaximize"
        class="preview-enlarge"
        :aria-label="maximized ? '还原画面' : '放大画面'"
        :title="maximized ? '还原画面' : '放大画面'"
        @click="enlarge"
      >
        <AppIcon :name="maximized ? 'restore' : 'expand'" :size="16" />
      </button>
      <button
        :aria-label="fullScreen ? '退出全屏' : '进入全屏'"
        :title="fullScreen ? '退出全屏' : '进入全屏'"
        @click="toggleFullscreen"
      >
        <AppIcon name="fullscreen" :size="16" />
      </button>
      <button
        aria-label="预览设置"
        title="预览设置：音量、截图、重连与画面比例"
        @click="settingsDialog?.showModal()"
      >
        <AppIcon name="config" :size="16" />
      </button>
    </div>
    <div v-if="notice" class="preview-notice" role="status">{{ notice }}</div>
    <div
      v-if="playbackClock && controlError"
      class="preview-notice error"
      role="alert"
    >
      {{ controlError }}
    </div>
    <dialog
      ref="settingsDialog"
      class="business-dialog player-options-dialog"
      @click.stop
      @dblclick.stop
    >
      <DialogHeading
        >{{ record ? "回放设置" : "预览设置" }} ·
        {{ channel.name }}</DialogHeading
      >
      <div class="player-options-fields">
        <label v-if="!record"
          ><span class="field-label">码流选择</span
          ><select
            v-model.number="streamNumber"
            :disabled="connecting"
            @change="connect()"
          >
            <option :value="0">主码流</option>
            <option :value="1">子码流</option></select
          ><small
            >设备需支持对应码流，实际画质以接收到的视频为准。</small
          ></label
        >
        <label
          ><span class="field-label">声音音量 · {{ volume }}%</span
          ><input
            aria-label="声音音量"
            v-model.number="volume"
            type="range"
            min="0"
            max="100"
            :disabled="hasAudio === false || audioUnsupported"
            @input="setVolume"
          /><small>{{
            hasAudio === false || audioUnsupported
              ? soundLabel
              : muted
                ? "当前已静音"
                : "声音已开启"
          }}</small></label
        >
        <label
          ><span class="field-label">画面比例</span
          ><select v-model="fit">
            <option value="contain">保持比例</option>
            <option value="fill">铺满窗口</option>
            <option value="cover">等比裁剪</option>
          </select></label
        >
        <p v-if="mediaDiagnostic" class="error" role="status">
          最近媒体诊断：{{ mediaDiagnostic }}
        </p>
        <p class="muted">
          实际画面：{{ resolution || "等待视频"
          }}{{ videoCodec ? " · " + videoCodec : "" }}
        </p>
        <p class="muted">
          音频：{{
            audioUnsupported
              ? "编码暂不支持"
              : hasAudio === false
                ? "当前码流无音轨"
                : audioCodec || "等待音轨信息"
          }}
        </p>
        <div class="player-option-actions">
          <button class="secondary" :disabled="!playing" @click="snapshot">
            截图保存</button
          ><button
            v-if="!record"
            class="secondary"
            :disabled="connecting"
            @click="connect()"
          >
            重新连接</button
          ><button
            class="secondary"
            :disabled="!ready || hasAudio === false || audioUnsupported"
            @click="toggleAudio"
          >
            {{ soundLabel }}
          </button>
        </div>
      </div>
      <div class="actions">
        <button class="secondary" @click="settingsDialog?.close()">关闭</button>
      </div>
    </dialog>
    <div
      v-if="(!playing && !paused) || failed"
      class="player-status"
      :class="{ failed }"
    >
      <span
        v-if="!failed && !ended && !autoplayBlocked"
        class="loader-ring"
      ></span
      ><span>{{ message }}</span
      ><button
        v-if="autoplayBlocked && !failed && !ended"
        @click="startPlayback"
      >
        播放视频
      </button>
    </div>
    <div v-if="record && !playbackClock" class="playback-controls">
      <button
        :disabled="!ready || failed || controlBusy"
        @click="control(paused ? 'resume' : 'pause')"
      >
        {{ paused ? "继续播放" : "暂停" }}</button
      ><label
        >倍速<select
          v-model.number="scale"
          :disabled="!ready || failed || controlBusy"
          @change="control('speed')"
        >
          <option
            v-for="rate in [0.25, 0.5, 1, 2, 4]"
            :key="rate"
            :value="rate"
          >
            {{ rate }}×
          </option>
        </select></label
      ><label class="seek-control"
        >跳转<input
          v-model.number="target"
          type="range"
          min="0"
          :max="Math.max(0, duration - 1)"
          step="1"
          :disabled="!ready || failed || controlBusy"
          @change="control('seek')" /></label
      ><span>{{ Math.floor(position) }} / {{ duration }} 秒</span>
      <p v-if="controlError" class="error" role="alert">{{ controlError }}</p>
    </div>
    <div class="player-bottom">
      <span class="channel-dot" :class="{ online: playing }"></span
      >{{
        ended
          ? "回放结束"
          : paused
            ? "已暂停"
            : playing
              ? record
                ? "录像回放"
                : "实时预览"
              : failed
                ? "播放失败"
                : "连接中"
      }}<span class="mono">{{ channel.channelCode }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from "vue";
import AppIcon from "./AppIcon.vue";
import { api, messageOf, currentUser } from "../api";
interface SipConfig {
  enabled: boolean;
  host: string;
  advertisedHost: string;
  port: number;
  domain: string;
  serverId: string;
  heartbeatTimeout: number;
}
interface MediaConfig {
  url: string;
  rtpHost: string;
  playUrl: string;
  recordPath: string;
  secretConfigured: boolean;
  hookConfigured: boolean;
}
interface Settings {
  revision: string;
  editable: boolean;
  restartRequired: boolean;
  values: { sip: SipConfig; media: MediaConfig };
}
interface Snapshot {
  runtime?: {
    instanceId: string;
    restartAvailable: boolean;
    restartState: string;
  };
  sipState: string;
  sip: SipConfig;
  media: { configured: boolean; hookConfigured: boolean };
  settings: Settings;
}
const snapshot = ref<Snapshot>(),
  settings = ref<Settings>(),
  sip = ref<SipConfig>({
    enabled: false,
    host: "",
    advertisedHost: "",
    port: 8116,
    domain: "",
    serverId: "",
    heartbeatTimeout: 180000,
  }),
  media = ref<MediaConfig>({
    url: "",
    rtpHost: "",
    playUrl: "",
    recordPath: "",
    secretConfigured: false,
    hookConfigured: false,
  });
const heartbeat = ref(180),
  feedback = ref<HTMLElement>(),
  secret = ref(""),
  hookToken = ref(""),
  clearSecret = ref(false),
  clearHookToken = ref(false),
  busy = ref(false),
  loading = ref(true),
  checking = ref(false),
  error = ref(""),
  message = ref(""),
  checkMessage = ref("");
const restartDialog = ref<HTMLDialogElement>(),
  restarting = ref(false);
const restartAbort = new AbortController();
onBeforeUnmount(() => restartAbort.abort());
async function restart() {
  if (restarting.value) return;
  restartDialog.value?.close();
  restarting.value = true;
  error.value = "";
  message.value = "";
  checkMessage.value = "";
  try {
    const accepted = await api<{ status: string; instanceId: string }>(
      "/system/restart",
      "POST",
      { confirm: true },
    );
    message.value = "重启请求已受理，正在等待平台重新连接…";
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !restartAbort.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (restartAbort.signal.aborted) return;
      let health;
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          signal: AbortSignal.any([
            restartAbort.signal,
            AbortSignal.timeout(3000),
          ]),
        });
        if (!response.ok) continue;
        health = (await response.json()).data;
      } catch {
        continue;
      }
      if (
        health?.instanceId === accepted.instanceId &&
        health.restartState === "failed"
      )
        throw Error("平台重启未完成，请检查服务日志后重试。");
      if (health?.instanceId && health.instanceId !== accepted.instanceId) {
        await load();
        if (restartAbort.signal.aborted) return;
        if (error.value) return;
        if (health.status !== "ok") {
          message.value = "";
          error.value =
            "平台已重新启动，但接入服务启动异常，请检查配置和端口占用后重试。";
        } else {
          message.value = "平台重启完成，已重新读取当前生效配置。";
        }
        return;
      }
    }
    if (!restartAbort.signal.aborted) {
      message.value = "";
      error.value =
        "等待重启超过 90 秒，尚未确认完成。请稍后重新读取，必要时检查平台服务日志；不要连续重复重启。";
    }
  } catch (e) {
    if (!restartAbort.signal.aborted) {
      message.value = "";
      error.value = messageOf(e);
    }
  } finally {
    if (!restartAbort.signal.aborted) {
      restarting.value = false;
      await nextTick();
      feedback.value?.scrollIntoView({ block: "nearest" });
    }
  }
}
function apply(value: Settings) {
  settings.value = value;
  sip.value = { ...value.values.sip };
  media.value = { ...value.values.media };
  heartbeat.value = sip.value.heartbeatTimeout / 1000;
  secret.value = "";
  hookToken.value = "";
  clearSecret.value = false;
  clearHookToken.value = false;
}
async function load() {
  loading.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await api<Snapshot>("/system/config");
    snapshot.value = value;
    apply(value.settings);
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!settings.value || busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await api<Settings>("/system/config", "PUT", {
      revision: settings.value.revision,
      sip: { ...sip.value, heartbeatTimeout: heartbeat.value * 1000 },
      media: {
        url: media.value.url,
        rtpHost: media.value.rtpHost,
        playUrl: media.value.playUrl,
        recordPath: media.value.recordPath,
        secret: secret.value,
        hookToken: hookToken.value,
        clearSecret: clearSecret.value,
        clearHookToken: clearHookToken.value,
      },
    });
    apply(value);
    message.value = value.restartRequired
      ? "配置已保存，需重启平台服务后生效。"
      : "配置已保存，与当前生效配置一致。";
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
    await nextTick();
    feedback.value?.scrollIntoView({ block: "nearest" });
  }
}
async function check() {
  checking.value = true;
  checkMessage.value = "";
  try {
    const result = await api<{ state: string }>(
      "/media-nodes/local/check",
      "POST",
      {},
    );
    checkMessage.value =
      (
        {
          online: "当前媒体管理接口连接正常",
          offline: "当前媒体管理接口不可用，请检查地址、密钥及网络",
          not_configured: "当前运行服务尚未配置媒体地址与密钥",
        } as Record<string, string>
      )[result.state] || result.state;
  } catch (e) {
    checkMessage.value = messageOf(e);
  } finally {
    checking.value = false;
  }
}
const stateLabels: Record<string, string> = {
  disabled: "未启用",
  listening: "监听中",
  error: "异常",
};
onMounted(load);
</script>

<template>
  <section class="business-page access-config" id="config-view">
    <div class="title">
      <div>
        <h1>国标接入配置</h1>
        <p>配置国标信令与媒体节点，管理设备接入和视频服务参数。</p>
      </div>
    </div>
    <p v-if="loading" role="status">正在读取接入配置…</p>

    <div ref="feedback">
      <p v-if="error" class="error config-feedback" role="alert">{{ error }}</p>
      <p v-if="message" class="config-feedback success-message" role="status">
        {{ message }}
      </p>
      <p v-if="checkMessage" class="config-feedback" role="status">
        {{ checkMessage }}
      </p>
    </div>

    <form class="config-editor" @submit.prevent="save">
      <div class="panel">
        <div class="panel-heading">
          <h3 id="sip-config-title">SIP / 国标信令</h3>
          <span>UDP / TCP 同端口接入</span>
        </div>
        <fieldset
          class="config-grid"
          aria-labelledby="sip-config-title"
          :disabled="loading || busy || restarting || !settings?.editable"
        >
          <div class="config-layer">
            <div class="config-layer-heading">
              <span>01</span>
              <div>
                <h4>服务设置</h4>
                <p>启用服务并设置心跳超时</p>
              </div>
            </div>
            <div class="config-layer-fields">
              <label class="config-toggle">
                <span class="config-field-title">服务状态</span>
                <span class="config-toggle-control"
                  ><input v-model="sip.enabled" type="checkbox" />启用 SIP
                  服务</span
                >
                <small title="重启后开始监听设备注册与信令。"
                  >重启后开始监听设备注册与信令。</small
                >
              </label>
              <label
                ><span class="config-field-title">心跳超时（秒）</span
                ><input
                  v-model.number="heartbeat"
                  type="number"
                  min="30"
                  max="3600"
                  step="1"
                  required
                /><small title="范围 30～3600 秒；超时未收到心跳则判定离线。"
                  >范围 30～3600 秒；超时未收到心跳则判定离线。</small
                ></label
              >
            </div>
          </div>
          <div class="config-layer">
            <div class="config-layer-heading">
              <span>02</span>
              <div>
                <h4>平台标识</h4>
                <p>设备注册使用的平台身份</p>
              </div>
            </div>
            <div class="config-layer-fields">
              <label
                ><span class="config-field-title">国标域</span
                ><input
                  v-model="sip.domain"
                  required
                  pattern="[0-9]{10}"
                  maxlength="10"
                  title="10位数字"
                  inputmode="numeric"
                /><small title="10 位数字；修改并重启后需重设设备接入密码。"
                  >10 位数字；修改并重启后需重设设备接入密码。</small
                ></label
              >
              <label
                ><span class="config-field-title">平台国标编号</span
                ><input
                  v-model="sip.serverId"
                  required
                  pattern="[0-9]{20}"
                  maxlength="20"
                  title="20位数字"
                  inputmode="numeric"
                /><small title="20 位数字，与设备填写的平台编号一致。"
                  >20 位数字，与设备填写的平台编号一致。</small
                ></label
              >
            </div>
          </div>
          <div class="config-layer">
            <div class="config-layer-heading">
              <span>03</span>
              <div>
                <h4>网络与会话</h4>
                <p>监听、通告地址与接入端口</p>
              </div>
            </div>
            <div class="config-layer-fields">
              <label
                ><span class="config-field-title">SIP 监听地址</span
                ><input
                  v-model="sip.host"
                  required
                  maxlength="15"
                  placeholder="例如：0.0.0.0"
                /><small title="本机网卡 IPv4；0.0.0.0 表示监听全部网卡"
                  >本机网卡 IPv4；0.0.0.0 表示监听全部网卡</small
                ></label
              >
              <label
                ><span class="config-field-title">SIP 通告地址</span
                ><input
                  v-model="sip.advertisedHost"
                  required
                  maxlength="15"
                  placeholder="设备可访问的平台 IPv4"
                /><small title="写入国标信令；跨互联网时填写设备可达地址"
                  >写入国标信令；跨互联网时填写设备可达地址</small
                ></label
              >
              <label
                ><span class="config-field-title">SIP 端口</span
                ><input
                  v-model.number="sip.port"
                  type="number"
                  min="1"
                  max="65535"
                  required
                /><small title="范围 1～65535，与设备填写的 SIP 端口一致。"
                  >范围 1～65535，与设备填写的 SIP 端口一致。</small
                ></label
              >
            </div>
          </div>
        </fieldset>
      </div>
      <div class="panel">
        <div class="panel-heading">
          <h3 id="media-config-title">媒体节点 / ZLMediaKit</h3>
          <span>管理接口、RTP 与录像回调</span>
        </div>
        <fieldset
          class="config-grid"
          aria-labelledby="media-config-title"
          :disabled="loading || busy || restarting || !settings?.editable"
        >
          <div class="config-layer">
            <div class="config-layer-heading">
              <span>01</span>
              <div>
                <h4>连接与接收</h4>
                <p>媒体接口与设备推流地址</p>
              </div>
            </div>
            <div class="config-layer-fields">
              <label
                ><span class="config-field-title">媒体管理地址</span
                ><input
                  v-model="media.url"
                  type="url"
                  maxlength="256"
                  placeholder="例如：http://127.0.0.1:8080"
                /><small title="填写 HTTP(S) 地址及端口，不附带密钥或接口路径"
                  >填写 HTTP(S) 地址及端口，不附带密钥或接口路径</small
                ></label
              >
              <label
                ><span class="config-field-title">RTP 接收地址</span
                ><input
                  v-model="media.rtpHost"
                  required
                  maxlength="15"
                  placeholder="设备可达的媒体节点 IPv4"
                /><small title="设备向此地址发送视频，须可从设备网络访问"
                  >设备向此地址发送视频，须可从设备网络访问</small
                ></label
              >
            </div>
          </div>
          <div class="config-layer">
            <div class="config-layer-heading">
              <span>02</span>
              <div>
                <h4>播放与录像</h4>
                <p>视频访问与录像文件位置</p>
              </div>
            </div>
            <div class="config-layer-fields">
              <label
                ><span class="config-field-title">媒体访问地址</span
                ><input
                  v-model="media.playUrl"
                  type="url"
                  maxlength="256"
                  placeholder="留空沿用媒体管理地址"
                /><small title="平台访问媒体文件和视频流所用地址"
                  >平台访问媒体文件和视频流所用地址</small
                ></label
              >
              <label
                ><span class="config-field-title">录像文件路径模板</span
                ><input
                  v-model="media.recordPath"
                  required
                  maxlength="512"
                  placeholder="/record/rtp/{stream}/{date}/{file}"
                /><small
                  title="须包含 {stream}、{date}、{file}，与媒体节点保持一致"
                  >须包含 {stream}、{date}、{file}，与媒体节点保持一致</small
                ></label
              >
            </div>
          </div>
          <div class="config-layer">
            <div class="config-layer-heading">
              <span>03</span>
              <div>
                <h4>安全凭据</h4>
                <p>管理密钥与录像回调凭据</p>
              </div>
            </div>
            <div class="config-layer-fields">
              <label
                ><span class="config-field-title">媒体管理密钥</span
                ><input
                  v-model="secret"
                  type="password"
                  maxlength="256"
                  autocomplete="new-password"
                  :placeholder="
                    media.secretConfigured
                      ? '已设置，留空保留原密钥'
                      : '尚未设置，填写后保存'
                  "
                  @input="clearSecret = false"
                /><small title="填写媒体节点管理密钥，留空保留原值。"
                  >填写媒体节点管理密钥，留空保留原值。</small
                ></label
              >
              <label
                ><span class="config-field-title">录像回调凭据</span
                ><input
                  v-model="hookToken"
                  type="password"
                  maxlength="256"
                  autocomplete="new-password"
                  :placeholder="
                    media.hookConfigured
                      ? '已设置，留空保留原凭据'
                      : '尚未设置，须与媒体发布回调一致'
                  "
                  @input="clearHookToken = false"
                /><small title="与媒体节点录像回调一致，留空保留原值。"
                  >与媒体节点录像回调一致，留空保留原值。</small
                ></label
              >
              <div class="config-secret-actions">
                <label class="config-check"
                  ><input
                    v-model="clearSecret"
                    type="checkbox"
                    :disabled="!media.secretConfigured || !!secret"
                  />清除已有媒体密钥<small title="保存后移除已有管理密钥。"
                    >保存后移除已有管理密钥。</small
                  ></label
                >
                <label class="config-check"
                  ><input
                    v-model="clearHookToken"
                    type="checkbox"
                    :disabled="!media.hookConfigured || !!hookToken"
                  />清除已有回调凭据<small title="保存后移除已有录像回调凭据。"
                    >保存后移除已有录像回调凭据。</small
                  ></label
                >
              </div>
            </div>
          </div>
        </fieldset>
        <p class="panel-note">
          密钥和回调凭据只用于保存与替换，不回显。设备接入密码请在“国标设备”中逐台设置。
        </p>
      </div>
      <div class="config-actions">
        <span>所有修改保存后需重启平台服务生效</span>
        <div>
          <button
            class="secondary"
            type="button"
            :disabled="busy || loading || checking || restarting"
            @click="check"
          >
            <AppIcon name="refresh" :size="16" />{{
              checking ? "检查中…" : "检查当前媒体连接"
            }}
          </button>
          <button
            class="secondary"
            type="button"
            :disabled="busy || loading || restarting"
            @click="load"
          >
            重新读取</button
          ><button
            :disabled="busy || loading || restarting || !settings?.editable"
          >
            {{ busy ? "正在保存…" : "保存接入配置" }}
          </button>
          <button
            v-if="currentUser?.role === 'admin'"
            class="danger"
            type="button"
            :disabled="
              busy ||
              loading ||
              checking ||
              restarting ||
              !snapshot?.runtime?.restartAvailable
            "
            :title="
              snapshot?.runtime?.restartAvailable
                ? '重启平台并应用已保存配置'
                : '当前服务需更新并以 npm start 启动后支持在线重启'
            "
            @click="restartDialog?.showModal()"
          >
            <AppIcon name="refresh" :size="16" />{{
              restarting ? "正在重启…" : "重启平台"
            }}
          </button>
        </div>
      </div>
    </form>
    <dialog
      ref="restartDialog"
      class="business-dialog config-restart-dialog"
      aria-labelledby="restart-platform-title"
    >
      <h2 id="restart-platform-title">重启平台</h2>
      <p>
        重启将短暂中断所有设备的实时预览、回放和正在执行的录像任务，录像期间会留下空档。已启用的录像计划将在服务恢复后按计划接续。
      </p>
      <p>
        仅应用已保存的配置；当前未保存的修改不会生效。媒体节点不会随平台重启。
      </p>
      <div class="row-actions">
        <button class="secondary" type="button" @click="restartDialog?.close()">
          取消
        </button>
        <button class="danger" type="button" @click="restart">确认重启</button>
      </div>
    </dialog>
    <details v-if="snapshot" class="panel config-running">
      <summary>查看当前生效配置</summary>
      <dl>
        <dt>SIP 状态</dt>
        <dd>{{ stateLabels[snapshot.sipState] || snapshot.sipState }}</dd>
        <dt>监听地址 / 端口</dt>
        <dd>{{ snapshot.sip.host }} : {{ snapshot.sip.port }}</dd>
        <dt>国标域 / 平台编号</dt>
        <dd>{{ snapshot.sip.domain }} / {{ snapshot.sip.serverId }}</dd>
        <dt>媒体节点</dt>
        <dd>
          {{ snapshot.media.configured ? "已配置，请检查连接" : "未配置" }}
        </dd>
        <dt>录像回调</dt>
        <dd>{{ snapshot.media.hookConfigured ? "已配置" : "未配置" }}</dd>
      </dl>
    </details>
    <div v-if="settings" class="scope-banner">
      <strong>{{
        settings.restartRequired ? "已保存 · 待重启生效" : "当前配置"
      }}</strong
      ><span
        >保存不会自动启用或重启服务。重启平台后，新配置才用于设备接入与媒体连接。</span
      >
    </div>
  </section>
</template>

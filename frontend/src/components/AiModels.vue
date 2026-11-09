<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { api, messageOf } from "../api";
import type { AiSettings, LocalAiModel } from "../ai-types";
import { aiDate } from "../ai-types";
import AppIcon from "./AppIcon.vue";
const settings = ref<AiSettings | null>(null),
  apiKey = ref(""),
  clearKey = ref(false),
  error = ref(""),
  message = ref(""),
  busy = ref(false),
  testing = ref(false);
const localModels = ref<LocalAiModel[]>([]);
const localModelsLoaded = ref(false);
const localError = ref("");
const accessMode = ref<"local" | "cloud">("local");
const localEnabled = ref(true);
const indexEnabled = ref(false),
  indexCapacity = ref(1024),
  indexRetention = ref(7);
const indexError = ref("");
const indexStatus = ref<{
  state: string;
  bytes: number;
  files: number;
  frames: number;
  pending: number;
} | null>(null);
let indexTimer: ReturnType<typeof setTimeout> | undefined;
async function loadIndex() {
  try {
    const value = await api<NonNullable<typeof indexStatus.value>>(
      "/ai/settings/local-index",
    );
    if (alive) {
      indexStatus.value = value;
      indexError.value = "";
    }
  } catch {
    if (alive) indexError.value = "索引状态读取失败，请刷新页面重试";
  } finally {
    if (alive) indexTimer = setTimeout(loadIndex, 5000);
  }
}
onMounted(() => void loadIndex());
onUnmounted(() => {
  if (indexTimer) clearTimeout(indexTimer);
});
const qwenAlarmEnabled = ref(false),
  qwenInterval = ref(120);
async function saveLocal() {
  if (!settings.value || busy.value || testing.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await api<AiSettings>("/ai/settings", "PUT", {
      ...settings.value,
      indexEnabled: indexEnabled.value,
      indexCapacityMiB: indexCapacity.value,
      indexRetentionDays: indexRetention.value,
      localEnabled: localEnabled.value,
      qwenAlarmEnabled: localEnabled.value && qwenAlarmEnabled.value,
      qwenAlarmIntervalSeconds: qwenInterval.value,
      retentionDays: form.value.retentionDays,
    });
    if (alive) {
      settings.value = value;
      qwenAlarmEnabled.value = value.qwenAlarmEnabled === true;
      message.value = "本地接入配置已保存，即时生效";
    }
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
async function loadLocalModels() {
  try {
    const result = await api<{ items: LocalAiModel[] }>(
      "/ai/settings/local-models",
    );
    if (alive) {
      localModels.value = result.items.filter((model) => model.installed);
      localModelsLoaded.value = true;
    }
  } catch (e) {
    if (alive) localError.value = messageOf(e);
  }
}
const form = ref({
  enabled: false,
  model: "deepseek-flash",
  timeoutSeconds: 60,
  retentionDays: 7,
});
let alive = true,
  testDeadline = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  try {
    const value = await api<AiSettings>("/ai/settings");
    if (!alive) return;
    settings.value = value;
    indexEnabled.value = value.indexEnabled === true;
    indexCapacity.value = value.indexCapacityMiB || 1024;
    indexRetention.value = value.indexRetentionDays || 7;
    localEnabled.value = value.localEnabled !== false;
    qwenAlarmEnabled.value = value.qwenAlarmEnabled === true;
    qwenInterval.value = value.qwenAlarmIntervalSeconds || 120;
    form.value = {
      enabled: value.enabled,
      model: value.model,
      timeoutSeconds: value.timeoutSeconds,
      retentionDays: value.retentionDays,
    };
    testing.value = value.lastTest?.status === "testing";
    if (testing.value) {
      testDeadline = Date.now() + 130000;
      timer = setTimeout(pollTest, 1000);
    }
  } catch (e) {
    if (alive) error.value = messageOf(e);
  }
}
async function pollTest() {
  try {
    if (testDeadline && Date.now() > testDeadline)
      throw Error("模型测试等待超时，请刷新配置查看最终结果");
    const value = await api<AiSettings>("/ai/settings");
    if (!alive) return;
    settings.value = value;
    testing.value = value.lastTest?.status === "testing";
    if (testing.value) timer = setTimeout(pollTest, 1000);
    else message.value = value.lastTest?.message || "";
  } catch (e) {
    if (alive) {
      testing.value = false;
      error.value = messageOf(e);
    }
  }
}
async function save() {
  if (busy.value || testing.value || !settings.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await api<AiSettings>("/ai/settings", "PUT", {
      ...form.value,
      localEnabled: settings.value.localEnabled !== false,
      version: settings.value.version,
      apiKey: apiKey.value,
      clearKey: clearKey.value,
    });
    if (!alive) return;
    settings.value = value;
    apiKey.value = "";
    clearKey.value = false;
    message.value = "模型配置已保存，即时生效";
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
async function test() {
  if (!settings.value || busy.value || testing.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await api<AiSettings>("/ai/settings/test", "POST", {
      version: settings.value.version,
    });
    if (!alive) return;
    settings.value = value;
    testing.value = true;
    testDeadline = Date.now() + 130000;
    timer = setTimeout(pollTest, 1000);
  } catch (e) {
    if (alive) error.value = messageOf(e);
  } finally {
    if (alive) busy.value = false;
  }
}
onMounted(load);
onMounted(loadLocalModels);
onUnmounted(() => {
  alive = false;
  clearTimeout(timer);
  apiKey.value = "";
});
</script>
<template>
  <section class="business-page ai-models">
    <div class="title">
      <div>
        <h1>模型配置</h1>
        <p>管理本地分析能力与大模型接入。</p>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <div class="panel ai-settings-panel">
      <header class="ai-settings-header">
        <div class="access-tabs" role="tablist" aria-label="AI 接入方式">
          <button
            type="button"
            role="tab"
            :aria-selected="accessMode === 'local'"
            @click="accessMode = 'local'"
          >
            本地接入
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="accessMode === 'cloud'"
            @click="accessMode = 'cloud'"
          >
            大模型接入
          </button>
        </div>
        <span class="settings-header-note">保存后即时生效</span>
      </header>
      <div v-show="accessMode === 'local'" class="local-models">
        <section class="model-section">
          <div class="model-section-heading">
            <h3>本地分析</h3>
            <p>图片留在本机，无需云端密钥。</p>
          </div>
          <div class="model-section-content">
            <label class="checkbox-label local-master-switch"
              ><input
                v-model="localEnabled"
                type="checkbox"
                :disabled="busy || testing || !settings"
              />启用本地接入</label
            >
            <p class="field-help">
              支持画面分析、以文搜物和以图搜图；预览与录像优先。
            </p>
          </div>
        </section>
        <section class="model-section">
          <div class="model-section-heading">
            <h3>告警自动分析</h3>
            <p>千问生成中文描述与检索标签。</p>
          </div>
          <div class="model-section-content local-alarm-fields">
            <label class="checkbox-label alarm-enable"
              ><input
                v-model="qwenAlarmEnabled"
                type="checkbox"
                :disabled="busy || !settings || !localEnabled"
              />自动分析新告警图片</label
            >
            <label class="setting-field"
              >同通道采样间隔（秒）<input
                v-model.number="qwenInterval"
                type="number"
                min="120"
                max="3600"
                :disabled="busy || !settings"
              /><small>同一通道两次自动分析的最短间隔。</small></label
            >
            <label class="setting-field"
              >分析记录保留（天）<input
                v-model.number="form.retentionDays"
                type="number"
                min="1"
                max="90"
                :disabled="busy || !settings"
              /><small>画面分析与告警分析共用保留时间。</small></label
            >
            <p class="field-help alarm-help">
              已有告警图片可在告警详情中手动分析，资源繁忙时自动等待。
            </p>
          </div>
        </section>
        <section class="model-section">
          <div class="model-section-heading">
            <h3>空闲本地索引</h3>
            <p>提前准备录像索引，加快文字与图片查找。</p>
          </div>
          <div class="model-section-content local-alarm-fields">
            <label class="checkbox-label alarm-enable"
              ><input
                v-model="indexEnabled"
                type="checkbox"
                :disabled="busy || !settings || !localEnabled"
              />空闲时自动建立索引</label
            >
            <label class="setting-field"
              >索引容量（MiB）<input
                v-model.number="indexCapacity"
                type="number"
                min="64"
                max="32768"
                :disabled="busy || !settings"
              /><small>仅限制索引图片与特征，不删除原录像。</small></label
            >
            <label class="setting-field"
              >索引保留（天）<input
                v-model.number="indexRetention"
                type="number"
                min="1"
                max="90"
                :disabled="busy || !settings"
              /><small>自动处理最近录像，过期索引自动清理。</small></label
            >
            <p v-if="indexError" class="error" role="alert">{{ indexError }}</p>
            <p class="field-help alarm-help" role="status">
              {{ indexStatus?.state || "读取索引状态…"
              }}<template v-if="indexStatus">
                · {{ indexStatus.files }} 个文件 · {{ indexStatus.frames }} 张 ·
                {{ (indexStatus.bytes / 1048576).toFixed(1) }} MiB</template
              >。暂停或重启后自动续建；预览、回放和前台分析优先。
            </p>
          </div>
        </section>
        <section class="model-section model-inventory-section">
          <div class="model-section-heading">
            <h3>本地模型</h3>
            <p>已安装模型与当前用途。</p>
          </div>
          <div class="model-section-content">
            <p v-if="localError" class="error" role="alert">{{ localError }}</p>
            <p v-else-if="!localModels.length" class="field-help">
              {{
                localModelsLoaded ? "尚未安装本地模型" : "正在读取本地模型清单…"
              }}
            </p>
            <div class="local-model-grid">
              <article
                v-for="model in localModels"
                :key="model.id"
                class="local-model-row"
              >
                <div class="local-model-heading">
                  <span class="model-icon"
                    ><AppIcon name="ai" :size="20" /></span
                  ><b>{{ model.name }}</b>
                </div>
                <p>{{ model.purpose }}</p>
                <span
                  class="badge"
                  :class="model.installed ? 'online' : 'unregistered'"
                  >{{
                    !model.installed
                      ? "未安装"
                      : model.selected
                        ? model.ready
                          ? "检索默认使用"
                          : "文件待检查"
                        : model.id === "qwen"
                          ? "已安装 · 中文分析"
                          : "已安装 · 未选用"
                  }}</span
                >
                <details class="model-technical">
                  <summary>模型信息</summary>
                  <small
                    >{{ model.license
                    }}<template v-if="model.installed">
                      · {{ (model.bytes / 1000000).toFixed(1) }} MB</template
                    ></small
                  >
                  <p v-if="model.benchmark">
                    离线实测：CPU 单线程，平均
                    {{ model.benchmark.warmAverageMs.toFixed(0) }} ms/帧，峰值
                    {{ model.benchmark.peakRssMiB.toFixed(0) }} MiB；{{
                      aiDate(model.benchmark.checkedAt)
                    }}。单张样本不代表检测准确率。
                  </p>
                </details>
              </article>
            </div>
          </div>
        </section>
        <footer class="settings-actions">
          <span>仅更新分析配置，不更改预览与录像计划。</span
          ><button
            type="button"
            :disabled="busy || testing || !settings"
            @click="saveLocal"
          >
            {{ busy ? "保存中…" : "保存本地配置" }}
          </button>
        </footer>
      </div>
      <div v-show="accessMode === 'cloud'" class="ai-cloud-settings">
        <div class="cloud-status-strip" aria-label="大模型连接状态">
          <div>
            <span>接入状态</span
            ><b
              class="status-value"
              :class="{ available: settings?.enabled }"
              >{{ settings?.enabled ? "已启用" : "未启用" }}</b
            >
          </div>
          <div>
            <span>密钥状态</span
            ><b>{{ settings?.hasKey ? "已安全保存" : "尚未配置" }}</b>
          </div>
          <div>
            <span>最近测试</span
            ><b>{{ aiDate(settings?.lastTest?.checkedAt) }}</b>
          </div>
        </div>
        <p
          v-if="settings?.lastTest"
          class="cloud-test-message"
          :class="{ error: settings.lastTest.status === 'failed' }"
          role="status"
        >
          {{ settings.lastTest.message }}
        </p>
        <form v-if="settings" @submit.prevent="save">
          <section class="model-section">
            <div class="model-section-heading">
              <h3>接入参数</h3>
              <p>配置服务、模型和访问凭据。</p>
            </div>
            <div class="model-section-content ai-model-fields">
              <label class="setting-field"
                >模型服务<input value="DeepSeek 官方服务" readonly
              /></label>
              <label class="setting-field"
                >接口地址<input :value="settings.baseUrl" readonly
              /></label>
              <label class="setting-field"
                >分析模型<input
                  v-model="form.model"
                  required
                  maxlength="80"
                  pattern="[A-Za-z0-9_.-]+"
                /><small>图片输入能力以连接测试结果为准。</small></label
              >
              <label class="setting-field"
                >API 密钥<input
                  v-model="apiKey"
                  type="password"
                  autocomplete="new-password"
                  maxlength="256"
                  :placeholder="
                    settings.hasKey
                      ? '已保存密钥，留空保持原值'
                      : '请输入 DeepSeek API 密钥'
                  "
                  :disabled="busy || testing"
                /><small>后端加密保存，不在页面回显。</small></label
              >
              <label class="setting-field"
                >请求超时（秒）<input
                  v-model.number="form.timeoutSeconds"
                  type="number"
                  min="15"
                  max="120"
                  required
              /></label>
              <label class="setting-field"
                >分析记录保留（天）<input
                  v-model.number="form.retentionDays"
                  type="number"
                  min="1"
                  max="90"
                  required
              /></label>
              <div class="ai-setting-switches">
                <label class="checkbox-label"
                  ><input
                    v-model="form.enabled"
                    type="checkbox"
                  />启用大模型接入</label
                ><label v-if="settings.hasKey" class="checkbox-label"
                  ><input
                    v-model="clearKey"
                    type="checkbox"
                    :disabled="!!apiKey"
                  />清除已保存密钥</label
                >
              </div>
            </div>
          </section>
          <div v-if="settings?.lastTest?.sampleSummary" class="ai-test-result">
            <b>测试图识别结果</b>
            <p>{{ settings.lastTest.sampleSummary }}</p>
          </div>
          <footer class="settings-actions">
            <span>连接测试使用合成图片，不发送摄像机画面。</span>
            <div>
              <button
                class="secondary"
                type="button"
                :disabled="
                  busy || testing || !settings.hasKey || !!apiKey || clearKey
                "
                @click="test"
              >
                <AppIcon name="refresh" :size="16" />{{
                  testing ? "测试中…" : "测试模型连接"
                }}</button
              ><button type="submit" :disabled="busy || testing">
                {{ busy ? "保存中…" : "保存配置" }}
              </button>
            </div>
          </footer>
        </form>
        <p v-else class="model-loading">
          {{ error ? "配置加载失败，请刷新页面重试。" : "正在读取模型配置…" }}
        </p>
      </div>
    </div>
  </section>
</template>
<style scoped>
.ai-settings-panel {
  padding: 0;
  overflow: hidden;
}
.ai-settings-header {
  min-height: 54px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--line);
}
.access-tabs {
  display: flex;
  align-self: stretch;
  gap: 24px;
}
.access-tabs button {
  height: auto;
  padding: 0 2px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  box-shadow: none;
}
.access-tabs button[aria-selected="true"] {
  color: var(--blue);
  border-bottom-color: var(--blue);
  font-weight: 600;
}
.access-tabs button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -4px;
}
.settings-header-note {
  font-size: 12px;
  color: var(--muted);
}
.model-section {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 24px;
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 24px;
  border-bottom: 1px solid var(--line);
}
.model-section-heading h3 {
  font-size: 14px;
  margin: 0 0 7px;
  line-height: 1.5;
}
.model-section-heading p,
.field-help {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}
.model-section-content {
  min-width: 0;
}
.checkbox-label {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.checkbox-label input {
  width: 14px;
  min-width: 14px;
  height: 14px;
  margin: 0;
  flex: none;
}
.local-master-switch {
  min-height: 24px;
  margin-bottom: 8px;
  font-weight: 500;
}
.local-alarm-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 320px));
  gap: 16px 24px;
}
.alarm-enable,
.alarm-help {
  grid-column: 1/-1;
}
.setting-field {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  color: #344054;
}
.setting-field input {
  width: 100%;
  min-width: 0;
  height: 36px;
  font-size: 13px;
}
.setting-field small {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.setting-field input[readonly] {
  color: #697180;
  background: #f7f8fa;
}
.local-model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.local-model-row {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fbfcfe;
}
.local-model-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 30px;
}
.model-icon {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: var(--blue-soft);
  color: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.local-model-heading b {
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.local-model-row > p {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
  margin: 10px 0 12px;
}
.model-technical {
  margin-top: 14px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
  font-size: 12px;
  color: var(--muted);
}
.model-technical summary {
  cursor: pointer;
  color: #52647b;
  width: fit-content;
}
.model-technical small {
  display: block;
  margin-top: 8px;
  line-height: 1.7;
}
.model-technical p {
  font-size: 12px;
  line-height: 1.7;
  margin-bottom: 0;
}
.settings-actions {
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: #fbfcfe;
}
.settings-actions > span {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.settings-actions > div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.settings-actions button {
  min-height: 36px;
  justify-content: center;
  white-space: nowrap;
  font-size: 13px;
}
.cloud-status-strip {
  display: grid;
  grid-template-columns: 1fr 1fr 1.4fr;
  margin: 20px 24px 0;
  background: #f7f9fc;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.cloud-status-strip > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 20px;
}
.cloud-status-strip > div + div {
  border-left: 1px solid var(--line);
}
.cloud-status-strip span {
  color: var(--muted);
  font-size: 12px;
}
.cloud-status-strip b {
  font-size: 13px;
  color: #344054;
  font-weight: 500;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.cloud-status-strip .available {
  color: #17834b;
}
.cloud-test-message {
  margin: 12px 24px 0;
  font-size: 13px;
  line-height: 1.7;
}
.ai-model-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 360px));
  gap: 20px 24px;
}
.ai-setting-switches {
  grid-column: 1/-1;
  display: flex;
  flex-wrap: wrap;
  gap: 14px 24px;
  padding-top: 4px;
}
.ai-test-result {
  margin: 16px 24px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--blue-soft);
  font-size: 13px;
  line-height: 1.8;
}
.ai-test-result p {
  margin: 8px 0 0;
}
.model-loading {
  padding: 36px 24px;
  color: var(--muted);
  font-size: 13px;
}
@media (max-width: 1100px) {
  .model-section {
    grid-template-columns: 140px minmax(0, 1fr);
    gap: 20px;
  }
  .local-model-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .ai-settings-header {
    padding: 0 16px;
  }
  .settings-header-note {
    display: none;
  }
  .model-section {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    padding: 20px 16px;
  }
  .model-section-heading p {
    margin: 0;
  }
  .local-alarm-fields,
  .ai-model-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .settings-actions {
    padding: 16px;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  .settings-actions > div {
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .settings-actions > button {
    align-self: flex-end;
  }
  .cloud-status-strip {
    margin: 16px 16px 0;
    grid-template-columns: 1fr;
  }
  .cloud-status-strip > div {
    flex-direction: row;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 14px;
  }
  .cloud-status-strip > div + div {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
  .cloud-test-message,
  .ai-test-result {
    margin-left: 16px;
    margin-right: 16px;
  }
}
</style>

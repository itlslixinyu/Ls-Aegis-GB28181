import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
export const aiProblem = (status, code, message) =>
  Object.assign(Error(message), { status, code });
export class AiSettings {
  constructor({
    file = null,
    envKey = process.env.DEEPSEEK_API_KEY || "",
  } = {}) {
    this.file = file;
    this.envKey = envKey;
    this.masterFile = file ? join(dirname(file), "ai-master.key") : null;
    this.state = {
      version: 0,
      enabled: false,
      localEnabled: true,
      indexEnabled: false,
      indexCapacityMiB: 1024,
      indexRetentionDays: 7,
      indexOwnerId: null,
      qwenAlarmEnabled: false,
      qwenAlarmIntervalSeconds: 120,
      qwenAlarmOwnerId: null,
      qwenAlarmEnabledAt: null,
      model: "deepseek-flash",
      timeoutSeconds: 60,
      retentionDays: 7,
      keyCipher: null,
      keyDisabled: false,
      lastTest: null,
    };
    if (file && existsSync(file)) {
      try {
        this.state = {
          ...this.state,
          ...JSON.parse(readFileSync(file, "utf8")),
        };
      } catch {
        throw Error("AI配置文件无法读取");
      }
    }
  }
  master() {
    if (this.masterKey) return this.masterKey;
    if (this.masterFile && existsSync(this.masterFile)) {
      const value = readFileSync(this.masterFile);
      if (value.length !== 32) throw Error("AI密钥保护文件无效");
      this.masterKey = value;
    } else {
      this.masterKey = randomBytes(32);
      if (this.masterFile) {
        mkdirSync(dirname(this.masterFile), { recursive: true });
        writeFileSync(this.masterFile, this.masterKey, {
          mode: 0o600,
          flag: "wx",
        });
      }
    }
    return this.masterKey;
  }
  encrypt(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.master(), iv),
      data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }
  key() {
    if (this.state.keyCipher) {
      if (this.masterFile && !existsSync(this.masterFile))
        throw aiProblem(
          503,
          "AI_KEY_UNREADABLE",
          "AI密钥保护文件丢失，请重新保存密钥",
        );
      try {
        const c = this.state.keyCipher,
          decipher = createDecipheriv(
            "aes-256-gcm",
            this.master(),
            Buffer.from(c.iv, "base64"),
          );
        decipher.setAuthTag(Buffer.from(c.tag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(c.data, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw aiProblem(
          503,
          "AI_KEY_UNREADABLE",
          "AI密钥无法解密，请在模型配置中重新保存",
        );
      }
    }
    return this.state.keyDisabled ? "" : this.envKey;
  }
  public() {
    const { version, enabled, model, timeoutSeconds, retentionDays, lastTest } =
      this.state;
    return {
      indexEnabled: this.state.indexEnabled === true,
      indexCapacityMiB: this.state.indexCapacityMiB,
      indexRetentionDays: this.state.indexRetentionDays,
      provider: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      version,
      enabled,
      localEnabled: this.state.localEnabled !== false,
      qwenAlarmEnabled: this.state.qwenAlarmEnabled === true,
      qwenAlarmIntervalSeconds: this.state.qwenAlarmIntervalSeconds || 120,
      model,
      timeoutSeconds,
      retentionDays,
      hasKey: !!(
        this.state.keyCipher ||
        (!this.state.keyDisabled && this.envKey)
      ),
      lastTest,
    };
  }
  persist(next) {
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary =
        this.file + "." + randomBytes(6).toString("hex") + ".tmp";
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2), {
          mode: 0o600,
          flag: "wx",
        });
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    this.state = next;
    return this.public();
  }
  save(value, { userId } = {}) {
    if (!value || value.version !== this.state.version)
      throw aiProblem(
        409,
        "AI_CONFIG_CONFLICT",
        "模型配置已更新，请刷新后重试",
      );
    const {
      enabled,
      model,
      timeoutSeconds,
      retentionDays,
      localEnabled = this.state.localEnabled !== false,
      qwenAlarmEnabled = this.state.qwenAlarmEnabled === true,
      qwenAlarmIntervalSeconds = this.state.qwenAlarmIntervalSeconds || 120,
      indexEnabled = this.state.indexEnabled === true,
      indexCapacityMiB = this.state.indexCapacityMiB,
      indexRetentionDays = this.state.indexRetentionDays,
      apiKey = "",
      clearKey = false,
    } = value;
    if (
      typeof indexEnabled !== "boolean" ||
      !Number.isInteger(indexCapacityMiB) ||
      indexCapacityMiB < 64 ||
      indexCapacityMiB > 32768 ||
      !Number.isInteger(indexRetentionDays) ||
      indexRetentionDays < 1 ||
      indexRetentionDays > 90 ||
      typeof enabled !== "boolean" ||
      typeof localEnabled !== "boolean" ||
      typeof qwenAlarmEnabled !== "boolean" ||
      !Number.isInteger(qwenAlarmIntervalSeconds) ||
      qwenAlarmIntervalSeconds < 120 ||
      qwenAlarmIntervalSeconds > 3600 ||
      (qwenAlarmEnabled && !localEnabled) ||
      typeof model !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,80}$/.test(model) ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 15 ||
      timeoutSeconds > 120 ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 90 ||
      typeof apiKey !== "string" ||
      typeof clearKey !== "boolean" ||
      (apiKey && !/^[a-zA-Z0-9_.-]{16,256}$/.test(apiKey)) ||
      (clearKey && apiKey)
    )
      throw aiProblem(
        400,
        "INVALID_AI_CONFIG",
        "索引容量（64～32768 MiB）、保留天数（1～90）、模型或密钥配置无效（采样间隔120～3600秒，需启用本地接入）",
      );
    if (indexEnabled && !this.state.indexEnabled && !userId)
      throw aiProblem(
        400,
        "AI_INDEX_OWNER_REQUIRED",
        "自动索引需由登录管理员启用",
      );
    const next = {
      ...this.state,
      indexEnabled,
      indexCapacityMiB,
      indexRetentionDays,
      indexOwnerId: indexEnabled && userId ? userId : this.state.indexOwnerId,
      enabled,
      localEnabled,
      qwenAlarmEnabled,
      qwenAlarmIntervalSeconds,
      model,
      timeoutSeconds,
      retentionDays,
      version: this.state.version + 1,
    };
    if (qwenAlarmEnabled && !this.state.qwenAlarmEnabled) {
      if (!userId)
        throw aiProblem(
          400,
          "QWEN_OWNER_REQUIRED",
          "自动分析需由登录管理员启用",
        );
      next.qwenAlarmOwnerId = userId;
      next.qwenAlarmEnabledAt = new Date().toISOString();
    }
    if (clearKey) {
      next.keyCipher = null;
      next.keyDisabled = true;
    }
    if (apiKey) {
      next.keyCipher = this.encrypt(apiKey);
      next.keyDisabled = false;
    }
    // Local retrieval can run without a cloud key. Cloud-only operations enforce
    // their own key checks before accepting work.
    if (clearKey || apiKey || model !== this.state.model) next.lastTest = null;
    return this.persist(next);
  }
  tested(result, version) {
    if (version === this.state.version)
      this.persist({
        ...this.state,
        lastTest: { ...result, checkedAt: new Date().toISOString() },
      });
    return this.public();
  }
}

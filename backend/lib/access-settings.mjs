import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { isIPv4 } from "node:net";
import { randomUUID } from "node:crypto";

const error = (message, status = 400, code = "CONFIG_INVALID") =>
  Object.assign(new Error(message), { status, code });
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
function shape(v, keys) {
  if (!plain(v) || Object.keys(v).some((k) => !keys.includes(k)))
    throw error("配置字段不正确，请刷新后重试");
}
function address(v, label, wildcard = false) {
  if (typeof v !== "string" || !isIPv4(v) || (!wildcard && v === "0.0.0.0"))
    throw error(label + "须为有效IPv4地址");
  return v;
}
function url(v, label) {
  if (v === "") return "";
  try {
    const u = new URL(v);
    if (
      typeof v !== "string" ||
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["", "/"].includes(u.pathname)
    )
      throw Error();
    return u.origin;
  } catch {
    throw error(label + "须为不含账号、密码或路径参数的HTTP(S)地址");
  }
}
function extract(c) {
  return {
    sip: {
      enabled: c.sip.enabled,
      host: c.sip.host,
      advertisedHost: c.sip.advertisedHost || c.sip.host,
      port: c.sip.port,
      domain: c.sip.domain,
      serverId: c.sip.serverId,
      heartbeatTimeout: c.sip.heartbeatTimeout,
    },
    media: {
      url: c.media.url || "",
      rtpHost: c.media.rtpHost || "127.0.0.1",
      playUrl: c.media.playUrl || "",
      recordPath: c.media.recordPath || "/record/rtp/{stream}/{date}/{file}",
      secret: c.media.secret || "",
      hookToken: c.media.hookToken || "",
    },
  };
}
function validate(v) {
  shape(v, ["sip", "media"]);
  shape(v.sip, [
    "enabled",
    "host",
    "advertisedHost",
    "port",
    "domain",
    "serverId",
    "heartbeatTimeout",
  ]);
  shape(v.media, [
    "url",
    "rtpHost",
    "playUrl",
    "recordPath",
    "secret",
    "hookToken",
  ]);
  const { sip: s, media: m } = v;
  if (
    typeof s.enabled !== "boolean" ||
    !Number.isInteger(s.port) ||
    s.port < 1 ||
    s.port > 65535
  )
    throw error("SIP启用状态或端口无效");
  if (
    typeof s.domain !== "string" ||
    !/^\d{10}$/.test(s.domain) ||
    typeof s.serverId !== "string" ||
    !/^\d{20}$/.test(s.serverId)
  )
    throw error("国标域须为10位数字，平台编号须为20位数字");
  if (
    !Number.isInteger(s.heartbeatTimeout) ||
    s.heartbeatTimeout < 30000 ||
    s.heartbeatTimeout > 3600000 ||
    s.heartbeatTimeout % 1000
  )
    throw error("心跳超时须为30至3600秒的整数");
  if (
    typeof m.recordPath !== "string" ||
    m.recordPath.length > 512 ||
    !m.recordPath.startsWith("/") ||
    m.recordPath.startsWith("//") ||
    /[\\?#\x00-\x1f]/.test(m.recordPath) ||
    m.recordPath.includes("..") ||
    !["{stream}", "{date}", "{file}"].every((t) => m.recordPath.includes(t))
  )
    throw error(
      "录像路径须以单个/开头，包含stream/date/file占位符且不能包含上级路径",
    );
  for (const field of ["secret", "hookToken"])
    if (
      typeof m[field] !== "string" ||
      m[field].length > 256 ||
      /[\x00-\x1f\x7f]/.test(m[field])
    )
      throw error("媒体密钥或回调凭据格式无效");
  return {
    sip: {
      ...s,
      host: address(s.host, "SIP监听地址", true),
      advertisedHost: address(s.advertisedHost, "SIP通告地址"),
    },
    media: {
      ...m,
      url: url(m.url, "媒体管理地址"),
      playUrl: url(m.playUrl, "媒体访问地址"),
      rtpHost: address(m.rtpHost, "RTP接收地址"),
    },
  };
}
export class AccessSettings {
  constructor(base, path) {
    this.path = path;
    this.initial = extract(base);
    this.revision = randomUUID();
    const saved = this.read();
    if (saved) {
      this.revision = saved.revision;
      this.initial = validate(saved.values);
    }
    this.active = saved
      ? {
          ...base,
          sip: { ...base.sip, ...this.initial.sip },
          media: {
            ...base.media,
            ...this.initial.media,
            configured: !!this.initial.media.url && !!this.initial.media.secret,
          },
        }
      : base;
  }
  read() {
    if (!this.path || !existsSync(this.path)) return null;
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8"));
      if (saved.version !== 1 || typeof saved.revision !== "string")
        throw Error();
      validate(saved.values);
      return saved;
    } catch {
      throw error(
        "接入配置文件无法读取，请从备份恢复后重启",
        500,
        "CONFIG_STORAGE_ERROR",
      );
    }
  }
  view() {
    const saved = this.read(),
      values = saved?.values || this.initial;
    const { secret, hookToken, ...media } = values.media;
    return {
      revision: saved?.revision || this.revision,
      editable: !!this.path,
      restartRequired: JSON.stringify(values) !== JSON.stringify(this.initial),
      values: {
        sip: values.sip,
        media: {
          ...media,
          secretConfigured: !!secret,
          hookConfigured: !!hookToken,
        },
      },
    };
  }
  save(value) {
    if (!this.path)
      throw error(
        "当前运行模式不支持持久保存配置",
        503,
        "CONFIG_STORAGE_UNAVAILABLE",
      );
    shape(value, ["revision", "sip", "media"]);
    shape(value.media, [
      "url",
      "rtpHost",
      "playUrl",
      "recordPath",
      "secret",
      "hookToken",
      "clearSecret",
      "clearHookToken",
    ]);
    const current = this.read(),
      revision = current?.revision || this.revision;
    if (value.revision !== revision)
      throw error(
        "配置已被其他操作修改，请重新读取后再保存",
        409,
        "CONFIG_CONFLICT",
      );
    const old = current?.values || this.initial,
      media = { ...value.media };
    for (const [field, clear] of [
      ["secret", "clearSecret"],
      ["hookToken", "clearHookToken"],
    ]) {
      if (media[clear] !== undefined && typeof media[clear] !== "boolean")
        throw error("清除凭据选项无效");
      if (media[field] !== undefined && typeof media[field] !== "string")
        throw error("媒体凭据须为文本");
      if (media[clear] && media[field])
        throw error("不能同时替换和清除同一凭据");
      media[field] = media[clear] ? "" : media[field] || old.media[field];
      delete media[clear];
    }
    const values = validate({ sip: value.sip, media }),
      next = { version: 1, revision: randomUUID(), values };
    const temporary = this.path + "." + randomUUID() + ".tmp";
    let fd;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
    } catch {
      throw error(
        "配置保存失败，请检查服务端存储权限",
        500,
        "CONFIG_STORAGE_ERROR",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
    }
    this.revision = next.revision;
    return this.view();
  }
}

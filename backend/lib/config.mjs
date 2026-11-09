import { isIP } from "node:net";

// Defaults reference WVP application-dev.yml; secrets and host addresses are installation-specific.
export function loadConfig(env = process.env) {
  const rtpBindIp = env.MEDIA_RTP_BIND_IP?.trim();
  if (rtpBindIp && !isIP(rtpBindIp))
    throw Error("MEDIA_RTP_BIND_IP 须为有效的媒体节点本地 IP 地址");
  const port = (key, fallback) => {
    const v = Number(env[key] || fallback);
    if (!Number.isInteger(v) || v < 1 || v > 65535)
      throw Error(`${key}须为有效端口`);
    return v;
  };
  const domain = env.SIP_DOMAIN || "4101050000",
    serverId = env.SIP_ID || "41010500002000000001";
  if (!/^\d{10}$/.test(domain) || !/^\d{20}$/.test(serverId))
    throw Error("SIP域须为10位数字，平台编号须为20位数字");
  const tileUrl = env.MAP_TILE_URL || "";
  if (tileUrl) {
    const url = new URL(tileUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !["{z}", "{x}", "{y}"].every((p) => tileUrl.includes(p))
    )
      throw Error("MAP_TILE_URL须为包含z/x/y的HTTP(S)模板");
  }
  const positionRetentionDays = Number(env.POSITION_RETENTION_DAYS || 30);
  if (
    !Number.isInteger(positionRetentionDays) ||
    positionRetentionDays < 1 ||
    positionRetentionDays > 365
  )
    throw Error("POSITION_RETENTION_DAYS须为1～365天");
  return {
    positionRetentionDays,
    map: { tileUrl, attribution: env.MAP_ATTRIBUTION || "" },
    sip: {
      enabled: env.SIP_ENABLED === "1",
      host: env.SIP_HOST || "127.0.0.1",
      advertisedHost: env.SIP_PUBLIC_IP || env.SIP_HOST || "127.0.0.1",
      port: port("SIP_PORT", 8116),
      domain,
      serverId,
      heartbeatTimeout: 180000,
      transport: "UDP/TCP",
    },
    media: {
      configured: !!env.MEDIA_URL && !!env.MEDIA_SECRET,
      url: env.MEDIA_URL || "",
      secret: env.MEDIA_SECRET || "",
      rtpHost: env.MEDIA_RTP_HOST || "127.0.0.1",
      rtpBindIp,
      hookToken: env.MEDIA_HOOK_TOKEN || "",
      recordPath: env.MEDIA_RECORD_PATH || "/record/rtp/{stream}/{date}/{file}",
      playUrl: env.MEDIA_PLAY_URL || env.MEDIA_URL || "",
      aacPreviewAuto: !!(
        env.MEDIA_AAC_PREVIEW_CONTAINER || env.MEDIA_AAC_PREVIEW_EXECUTABLE
      ),
      aacPreviewDevices: (env.MEDIA_AAC_PREVIEW_DEVICES || "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^\d{20}$/.test(id)),
      aacPreviewContainer: env.MEDIA_AAC_PREVIEW_CONTAINER || undefined,
      aacPreviewExecutable: env.MEDIA_AAC_PREVIEW_EXECUTABLE || "ffmpeg",
      rtpRange: [40000, 45000],
      sendRange: [50000, 55000],
    },
    playTimeout: 180000,
  };
}
export function publicConfig(config) {
  return {
    sip: config.sip,
    media: {
      configured: config.media.configured,
      hookConfigured: !!config.media.hookToken,
      rtpRange: config.media.rtpRange,
      sendRange: config.media.sendRange,
    },
    playTimeout: config.playTimeout,
  };
}

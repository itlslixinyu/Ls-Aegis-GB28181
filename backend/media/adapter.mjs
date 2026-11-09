import { AacPreview } from "./aac-preview.mjs";

export class MediaAdapter {
  constructor(config, { fetcher = fetch, timeout = 5000 } = {}) {
    this.config = config;
    this.fetcher = fetcher;
    this.timeout = timeout;
    this.aacPreview = new AacPreview({
      executable: config.aacPreviewExecutable,
      container: config.aacPreviewContainer,
    });
    this.status = {
      state: config.url && config.secret ? "unchecked" : "not_configured",
      checkedAt: null,
    };
    if (config.url) {
      const url = new URL(config.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error("媒体管理地址须为HTTP(S)地址且不包含凭据");
    }
  }
  async call(action, parameters = {}) {
    if (!this.config.url || !this.config.secret)
      throw Error("尚未配置媒体地址与管理密钥");
    const url = new URL("/index/api/" + action, this.config.url);
    let result;
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          secret: this.config.secret,
        }),
        signal: AbortSignal.timeout(this.timeout),
        redirect: "error",
      });
      if (!response.ok) throw Error();
      result = await response.json();
    } catch {
      throw Error("媒体节点请求失败或超时");
    }
    if (!result || result.code !== 0) throw Error("媒体节点拒绝请求");
    return result;
  }
  async check() {
    try {
      await this.call("version");
      this.status = { state: "online", checkedAt: new Date().toISOString() };
    } catch (e) {
      this.status = {
        state:
          this.config.url && this.config.secret ? "offline" : "not_configured",
        checkedAt: new Date().toISOString(),
      };
    }
    return this.status;
  }
  async allocate(streamId, tcpMode = 0) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(streamId) ||
      ![0, 1, 2].includes(tcpMode)
    )
      throw Error("接收参数无效");
    const result = await this.call("openRtpServer", {
      port: "0",
      tcp_mode: String(tcpMode),
      stream_id: streamId,
      ...(this.config.rtpBindIp ? { local_ip: this.config.rtpBindIp } : {}),
    });
    if (
      !Number.isInteger(result.port) ||
      result.port < 1 ||
      result.port > 65535
    ) {
      await this.release(streamId).catch(() => {});
      throw Error("媒体节点返回无效接收端口");
    }
    return { streamId, port: result.port };
  }
  async release(streamId) {
    const results = await Promise.allSettled([
      this.call("closeRtpServer", { stream_id: streamId }),
      this.call("close_streams", {
        app: "rtp",
        vhost: "__defaultVhost__",
        stream: streamId,
        force: "1",
      }),
    ]);
    if (results.some((r) => r.status === "rejected"))
      throw Error("媒体资源回收失败");
  }
  async startForward(streamId, ssrc, host, port, tcp = false) {
    const result = await this.call(
      tcp === "passive" ? "startSendRtpPassive" : "startSendRtp",
      {
        vhost: "__defaultVhost__",
        app: "rtp",
        stream: streamId,
        ssrc,
        dst_url: host,
        dst_port: String(port),
        is_udp: tcp ? "0" : "1",
        pt: "96",
        use_ps: "1",
        close_delay_ms: "30000",
      },
    );
    if (
      !Number.isInteger(result.local_port) ||
      result.local_port < 1 ||
      result.local_port > 65535
    ) {
      await this.stopForward(streamId, ssrc).catch(() => {});
      throw Error("媒体转发端口无效");
    }
    return result;
  }
  async senders(streamId) {
    const result = await this.call("listRtpSender", {
      vhost: "__defaultVhost__",
      app: "rtp",
      stream: streamId,
    });
    return Array.isArray(result.data) ? result.data.map(String) : [];
  }
  async stopForward(streamId, ssrc) {
    try {
      await this.call("stopSendRtp", {
        vhost: "__defaultVhost__",
        app: "rtp",
        stream: streamId,
        ssrc,
      });
    } catch (error) {
      const streams = await this.streams();
      if (!streams.some((s) => s.stream === streamId && s.app === "rtp"))
        return;
      const senders = await this.call("listRtpSender", {
        vhost: "__defaultVhost__",
        app: "rtp",
        stream: streamId,
      });
      if (
        Array.isArray(senders.data) &&
        !senders.data.map(String).includes(String(ssrc))
      )
        return;
      throw error;
    }
  }
  async setPaused(streamId, paused) {
    await this.call(paused ? "pauseRtpCheck" : "resumeRtpCheck", {
      stream_id: streamId,
      app: "rtp",
      vhost: "__defaultVhost__",
      ...(paused ? { pause_seconds: "60" } : {}),
    });
  }
  openPreviewMp4(streamId, signal) {
    return this.aacPreview.open(() => this.openFlv(streamId, signal), signal);
  }
  openCompatibleFlv(streamId, signal) {
    return this.aacPreview.open(
      () => this.openFlv(streamId, signal),
      signal,
      true,
    );
  }
  async openFlv(streamId, signal) {
    const url = new URL(
      `/rtp/${streamId}.live.flv`,
      this.config.playUrl || this.config.url,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("媒体播放地址配置无效");
    const response = await this.fetcher(url, { signal, redirect: "error" });
    if (!response.ok || !response.body) throw Error("媒体流获取失败");
    return response;
  }
  async connectRtp(streamId, host, port) {
    await this.call("connectRtpServer", {
      stream_id: streamId,
      dst_url: host,
      dst_port: String(port),
    });
  }
  recordParameters(streamId) {
    return {
      type: "1",
      vhost: "__defaultVhost__",
      app: "rtp",
      stream: streamId,
    };
  }
  async startRecord(streamId, seconds = 900) {
    await this.call("startRecord", {
      ...this.recordParameters(streamId),
      max_second: String(seconds),
    });
  }
  async stopRecord(streamId) {
    try {
      await this.call("stopRecord", this.recordParameters(streamId));
    } catch (error) {
      if (
        (await this.streams()).some(
          (s) => s.stream === streamId && s.app === "rtp",
        )
      )
        throw error;
    }
  }
  async recordFiles(streamId) {
    const common = { vhost: "__defaultVhost__", app: "rtp", stream: streamId };
    const days = await this.call("getMP4RecordFile", common);
    const result = [];
    if (!Array.isArray(days.data?.paths)) throw Error("媒体录像目录格式错误");
    for (const date of days.data.paths.slice(0, 5)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const files = await this.call("getMP4RecordFile", {
        ...common,
        period: date,
      });
      for (const name of files.data?.paths || []) {
        if (
          typeof name === "string" &&
          /^[a-zA-Z0-9_(). -]+\.mp4$/i.test(name) &&
          !name.startsWith(".")
        )
          result.push({ date, name });
      }
    }
    return result;
  }
  async deleteRecordFile(streamId, file) {
    await this.call("deleteRecordDirectory", {
      vhost: "__defaultVhost__",
      app: "rtp",
      stream: streamId,
      period: file.date,
      name: file.name,
    });
  }
  recordingUrl(streamId, file) {
    const path = (
      this.config.recordPath || "/record/rtp/{stream}/{date}/{file}"
    )
      .replace("{stream}", encodeURIComponent(streamId))
      .replace("{date}", encodeURIComponent(file.date))
      .replace("{file}", encodeURIComponent(file.name));
    const url = new URL(path, this.config.playUrl || this.config.url);
    if (
      url.origin !== new URL(this.config.playUrl || this.config.url).origin ||
      !path.startsWith("/") ||
      path.startsWith("//")
    )
      throw Error("录像文件地址配置无效");
    return url;
  }
  async openRecording(streamId, file, range, signal) {
    const url = this.recordingUrl(streamId, file);
    const response = await this.fetcher(url, {
      signal,
      redirect: "error",
      headers: range ? { Range: range } : {},
    });
    if (
      ![200, 206, 416].includes(response.status) ||
      !response.body ||
      /text\/html|application\/json/i.test(
        response.headers.get("content-type") || "",
      )
    )
      throw Error("录像文件不可用");
    return response;
  }
  async streams() {
    const result = await this.call("getMediaList", {
      app: "rtp",
      vhost: "__defaultVhost__",
    });
    return Array.isArray(result.data) ? result.data : [];
  }
}

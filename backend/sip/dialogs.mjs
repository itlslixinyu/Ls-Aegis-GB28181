import { sendSip, transportOf } from "./transport.mjs";
import { expectSuccess } from "./requests.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { response } from "./protocol.mjs";
import { validPlaybackScale } from "../lib/playback-scale.mjs";
const branch = () => "z9hG4bK" + randomBytes(10).toString("hex");
export class SipDialogs {
  constructor(gateway, { timeout = 20000 } = {}) {
    this.gateway = gateway;
    this.timeout = timeout;
    this.calls = new Map();
  }
  send(
    call,
    method,
    { to = call.to, uri = call.target, body = "", sameBranch = false } = {},
  ) {
    const config = this.gateway.config;
    const seq = method === "BYE" ? (call.byeSeq ?? 2) : 1;
    const lines = [
      `${method} ${uri} SIP/2.0`,
      `Via: SIP/2.0/${transportOf(call.device)} ${config.advertisedHost || config.host}:${config.port};rport;branch=${method === "BYE" ? (call.byeBranch ??= branch()) : sameBranch ? call.branch : branch()}`,
      `From: ${call.from}`,
      `To: ${to}`,
      `Call-ID: ${call.id}`,
      `CSeq: ${seq} ${method}`,
      "Max-Forwards: 70",
      `Contact: <sip:${config.serverId}@${config.advertisedHost || config.host}:${config.port}>`,
      ...(method === "INVITE"
        ? [
            `Subject: ${call.channelCode}:${call.ssrc},${config.serverId}:0`,
            "Content-Type: application/sdp",
          ]
        : []),
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ];
    sendSip(
      this.gateway,
      Buffer.from(lines.join("\r\n")),
      call.device,
      () => {},
    );
  }
  invite(
    device,
    channelCode,
    {
      host,
      port,
      ssrc,
      signal,
      playback,
      mediaTransport = "UDP",
      download = false,
      speed = 1,
      streamNumber = 0,
    },
  ) {
    if (this.gateway.state !== "listening")
      return Promise.reject(Error("SIP服务未启用"));
    if (
      !isIPv4(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^\d{10}$/.test(ssrc) ||
      ![0, 1].includes(streamNumber)
    )
      return Promise.reject(Error("RTP接收配置无效"));
    if (signal?.aborted) return Promise.reject(Error("点播已取消"));
    const config = this.gateway.config;
    const call = {
      id: randomUUID(),
      device,
      channelCode,
      ssrc,
      branch: branch(),
      from: `<sip:${config.serverId}@${config.domain}>;tag=${randomBytes(8).toString("hex")}`,
      to: `<sip:${channelCode}@${config.domain}>`,
      target: `sip:${channelCode}@${device.remoteAddress}:${device.remotePort}`,
      state: "inviting",
    };
    const body = [
      "v=0",
      `o=${config.serverId} 0 0 IN IP4 ${host}`,
      download ? "s=Download" : playback ? "s=Playback" : "s=Play",
      ...(playback ? [`u=${channelCode}:0`] : []),
      `c=IN IP4 ${host}`,
      playback
        ? `t=${Math.floor(Date.parse(playback.start) / 1000)} ${Math.floor(Date.parse(playback.end) / 1000)}`
        : "t=0 0",
      `m=video ${port} ${mediaTransport === "UDP" ? "RTP/AVP" : "TCP/RTP/AVP"} 96`,
      ...(mediaTransport === "UDP"
        ? []
        : [
            `a=setup:${mediaTransport === "TCP-PASSIVE" ? "passive" : "active"}`,
            "a=connection:new",
          ]),
      ...(download ? [`a=downloadspeed:${speed}`] : []),
      "a=recvonly",
      "a=rtpmap:96 PS/90000",
      ...(!playback && !download
        ? [`a=streamnumber:${streamNumber}`, `a=streamprofile:${streamNumber}`]
        : []),
      `y=${ssrc}`,
      "",
      "",
    ].join("\r\n");
    return new Promise((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
      call.abort = () => this.abandon(call, "点播已取消");
      call.signal = signal;
      signal?.addEventListener("abort", call.abort, { once: true });
      this.calls.set(call.id, call);
      call.timer = setTimeout(
        () => this.abandon(call, "设备点播响应超时"),
        this.timeout,
      );
      call.timer.unref();
      let delay = 500;
      const send = () => {
        if (call.state !== "inviting") return;
        this.send(call, "INVITE", { body, sameBranch: true });
        if (transportOf(device) === "TCP") return;
        call.retry = setTimeout(() => {
          delay = Math.min(delay * 2, 4000);
          send();
        }, delay);
        call.retry.unref();
      };
      send();
    });
  }
  clear(call) {
    clearTimeout(call.retry);
    clearTimeout(call.byeRetry);
    clearTimeout(call.timer);
    call.signal?.removeEventListener("abort", call.abort);
  }
  expire(call) {
    clearTimeout(call.expiry);
    call.expiry = setTimeout(() => {
      clearTimeout(call.byeRetry);
      this.calls.delete(call.id);
    }, 32000);
    call.expiry.unref();
  }
  abandon(call, reason) {
    if (!["inviting", "proceeding"].includes(call.state)) return;
    this.clear(call);
    this.send(call, "CANCEL", { sameBranch: true });
    call.state = "abandoned";
    call.reject(Error(reason));
    this.expire(call);
  }
  handle(req, remote) {
    const call = this.calls.get(req.headers["call-id"][0]);
    if (
      !call ||
      transportOf(call.device) !== transportOf(remote) ||
      remote.address !== call.device.remoteAddress ||
      remote.port !== call.device.remotePort
    )
      return false;
    const [seq, method] = req.headers.cseq[0].split(/\s+/);
    if (method === "BYE" && seq === String(call.byeSeq || 2)) {
      if (req.status >= 200) {
        clearTimeout(call.byeRetry);
        call.byeFinished = true;
      }
      return true;
    }
    if (method !== "INVITE" || seq !== "1") return false;
    if (req.status < 200) {
      if (call.state === "inviting") {
        call.state = "proceeding";
        clearTimeout(call.retry);
      }
      return true;
    }
    const to = req.headers.to[0];
    if (req.status < 300) {
      const contact =
        req.headers.contact?.[0]?.match(/<?(sip:[^\s>]+)>?/i)?.[1];
      this.send(call, "ACK", { to, uri: contact || call.target });
      if (["inviting", "proceeding"].includes(call.state)) {
        this.clear(call);
        call.to = to;
        call.target = contact || call.target;
        call.state = "established";
        call.resolve({
          id: call.id,
          device: {
            remoteAddress: call.device.remoteAddress,
            remotePort: call.device.remotePort,
            sipTransport: transportOf(call.device),
          },
          channelCode: call.channelCode,
          from: call.from,
          to: call.to,
          target: call.target,
          ssrc: call.ssrc,
          answer: req.body?.toString("utf8") || "",
        });
      } else if (call.state === "abandoned" || call.state === "stopped") {
        call.to = to;
        call.target = contact || call.target;
        void this.end(call);
      }
    } else {
      this.send(call, "ACK", { to, sameBranch: true });
      if (["inviting", "proceeding"].includes(call.state)) {
        this.clear(call);
        call.state = "failed";
        call.reject(Error("设备拒绝点播：" + req.status));
      }
      this.expire(call);
    }
    return true;
  }
  handleBye(req, remote) {
    if (req.method !== "BYE") return false;
    const call = this.calls.get(req.headers["call-id"][0]);
    const tag = (value) => value.match(/;tag=([^;\s]+)/)?.[1];
    if (
      !call ||
      transportOf(call.device) !== transportOf(remote) ||
      call.device.remoteAddress !== remote.address ||
      call.device.remotePort !== remote.port ||
      tag(req.headers.to[0]) !== tag(call.from) ||
      tag(req.headers.from[0]) !== tag(call.to)
    )
      return false;
    sendSip(this.gateway, response(req, 200, "OK"), remote, () => {});
    call.state = "stopped";
    call.remoteEnded = true;
    this.clear(call);
    this.expire(call);
    this.onEnded?.(call.id);
    return true;
  }
  async end(dialog) {
    const call = this.calls.get(dialog.id) || {
      ...dialog,
      branch: branch(),
      state: "established",
    };
    if (call.remoteEnded || call.byeFinished) return;
    this.clear(call);
    call.byeSeq = call.nextSeq || 2;
    call.state = "stopped";
    this.calls.set(call.id, call);
    let delay = 500;
    const send = () => {
      this.send(call, "BYE");
      if (transportOf(call.device) === "TCP") return;
      call.byeRetry = setTimeout(() => {
        delay = Math.min(delay * 2, 4000);
        send();
      }, delay);
      call.byeRetry.unref();
    };
    send();
    this.expire(call);
  }
  async control(dialog, { action, scale, position }) {
    const call = this.calls.get(dialog.id);
    if (!call || call.state !== "established") throw Error("SIP回放对话不存在");
    if (!["pause", "resume", "speed", "seek"].includes(action))
      throw Error("回放操作无效");
    if (action === "speed" && !validPlaybackScale(scale))
      throw Error("回放倍速无效");
    if (action === "seek" && (!Number.isFinite(position) || position < 0))
      throw Error("回放位置无效");
    const cseq = call.nextSeq || 2;
    call.nextSeq = cseq + 1;
    dialog.nextSeq = call.nextSeq;
    const command = action === "pause" ? "PAUSE" : "PLAY";
    const body = [
      `${command} RTSP/1.0`,
      `CSeq: ${cseq}`,
      ...(action === "pause"
        ? ["PauseTime: now"]
        : [
            ...(action === "speed"
              ? [`Scale: ${scale}`]
              : validPlaybackScale(call.playbackScale)
                ? [`Scale: ${call.playbackScale}`]
                : []),
            `Range: npt=${action === "seek" ? position : "now"}-`,
          ]),
      "",
      "",
    ].join("\r\n");
    const answer = await expectSuccess(
      this.gateway.requests.request({
        method: "INFO",
        uri: call.target,
        from: call.from,
        to: call.to,
        remote: call.device,
        callId: call.id,
        cseq,
        body,
        contentType: "Application/MANSRTSP",
      }),
    );
    if (action === "speed") {
      const reported =
        /(?:^|\r?\n)Scale:\s*(-?\d+(?:\.\d+)?)\s*(?:\r?\n|$)/i.exec(
          String(answer?.body || ""),
        );
      const actual = reported ? Number(reported[1]) : scale;
      if (validPlaybackScale(actual)) {
        call.playbackScale = actual;
        dialog.playbackScale = actual;
      }
      if (actual !== scale)
        throw Error(`设备未接受请求的${scale}倍速，实际返回${actual}倍速`);
    }
  }
  close() {
    for (const call of this.calls.values()) {
      if (["inviting", "proceeding"].includes(call.state))
        this.abandon(call, "SIP服务关闭");
      else if (call.state === "established") this.send(call, "BYE");
      this.clear(call);
      clearTimeout(call.expiry);
    }
    this.calls.clear();
  }
}

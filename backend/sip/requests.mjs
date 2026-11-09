import { sendSip, transportOf } from "./transport.mjs";
import { randomUUID, randomBytes } from "node:crypto";
export const xmlEscape = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function decodeXmlBody(req, parser, validator) {
  const prefix = req.body.subarray(0, 180).toString("ascii");
  const contentType = req.headers?.["content-type"]?.[0] || "";
  const charset = contentType.match(
    /;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i,
  );
  const declared = prefix.match(
    /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i,
  )?.[1];
  const b = req.body;
  const bom =
    b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
      ? "utf-8"
      : b[0] === 0xff && b[1] === 0xfe
        ? "utf-16le"
        : b[0] === 0xfe && b[1] === 0xff
          ? "utf-16be"
          : "";
  const encoding = (
    bom ||
    charset?.[1] ||
    charset?.[2] ||
    charset?.[3] ||
    declared ||
    "utf-8"
  ).trim();
  let text;
  try {
    text = new TextDecoder(
      /^(?:GB2312|GBK)$/i.test(encoding) ? "gb18030" : encoding,
      { fatal: true },
    ).decode(req.body);
  } catch {
    throw Error("XML编码无效或内容损坏");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || validator.validate(text) !== true)
    throw Error("XML格式错误");
  return parser.parse(text);
}
export class SipRequests {
  constructor(gateway, { timeout = 8000 } = {}) {
    this.gateway = gateway;
    this.timeout = timeout;
    this.pending = new Map();
  }
  request({
    method = "MESSAGE",
    uri,
    from,
    to,
    remote,
    body = "",
    contentType = "Application/MANSCDP+xml",
    headers = [],
    callId = randomUUID(),
    cseq,
    branch = "z9hG4bK" + randomBytes(12).toString("hex"),
    signal,
    timeout = this.timeout,
  }) {
    if (this.gateway.state !== "listening")
      return Promise.reject(Error("SIP服务未启用"));
    if (this.pending.size >= 256)
      return Promise.reject(Error("信令请求过多，请稍后重试"));
    cseq ??= ++this.gateway.seq;
    const config = this.gateway.config;
    from ??= `<sip:${config.serverId}@${config.domain}>;tag=${randomBytes(10).toString("hex")}`;
    to ??= `<${uri}>`;
    const all = [
      `${method} ${uri} SIP/2.0`,
      `Via: SIP/2.0/${transportOf(remote)} ${config.advertisedHost || config.host}:${config.port};rport;branch=${branch}`,
      `From: ${from}`,
      `To: ${to}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} ${method}`,
      "Max-Forwards: 70",
      ...(!headers.some((h) => /^Contact:/i.test(h))
        ? [
            `Contact: <sip:${config.serverId}@${config.advertisedHost || config.host}:${config.port}>`,
          ]
        : []),
      ...headers,
      ...(body ? ["Content-Type: " + contentType] : []),
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ];
    if (all.slice(0, -3).some((line) => /[\r\n]/.test(line)))
      return Promise.reject(Error("信令参数包含非法字符"));
    const packet = Buffer.from(all.join("\r\n")),
      key = callId + ":" + cseq + " " + method;
    if (signal?.aborted) return Promise.reject(Error("信令请求已取消"));
    return new Promise((resolve, reject) => {
      const task = { key, remote, resolve, reject, branch };
      const finish = (error, result) => {
        if (!this.pending.has(key)) return;
        this.pending.delete(key);
        clearTimeout(task.timer);
        clearTimeout(task.retry);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(Error("信令请求已取消"));
      task.finish = finish;
      this.pending.set(key, task);
      signal?.addEventListener("abort", abort, { once: true });
      task.timer = setTimeout(() => finish(Error("设备信令响应超时")), timeout);
      task.timer.unref();
      let delay = 500;
      const send = () => {
        if (!this.pending.has(key)) return;
        sendSip(this.gateway, packet, remote, (error) => {
          if (error) finish(Error("信令发送失败"));
        });
        if (!this.pending.has(key)) return;
        if (transportOf(remote) === "TCP") return;
        task.retry = setTimeout(() => {
          delay = Math.min(delay * 2, 4000);
          send();
        }, delay);
        task.retry.unref();
      };
      send();
    });
  }
  handle(req, remote) {
    if (!req.status) return false;
    const task = this.pending.get(
      req.headers["call-id"][0] + ":" + req.headers.cseq[0],
    );
    if (
      !task ||
      transportOf(remote) !== transportOf(task.remote) ||
      remote.address !== task.remote.remoteAddress ||
      remote.port !== task.remote.remotePort ||
      req.headers.via[0].match(/(?:^|;)\s*branch=([^;\s]+)/)?.[1] !==
        task.branch
    )
      return false;
    if (req.status >= 200) task.finish(null, req);
    return true;
  }
  close() {
    for (const task of [...this.pending.values()])
      task.finish(Error("SIP服务关闭"));
  }
}
export async function expectSuccess(promise) {
  const result = await promise;
  if (result.status < 200 || result.status >= 300)
    throw Error("对端拒绝请求：" + result.status);
  return result;
}

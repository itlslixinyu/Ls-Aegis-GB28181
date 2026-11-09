import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export const md5 = (value) => createHash("md5").update(value).digest("hex");
export function parseSip(buffer) {
  if (buffer.length > 65507) throw Error("Message too large");
  const split = buffer.indexOf("\r\n\r\n");
  if (split < 0) throw Error("Incomplete message");
  const lines = buffer.subarray(0, split).toString("utf8").split("\r\n");
  const first = lines.shift();
  const match = first.match(/^([A-Z]+) (sip:[^ ]+) SIP\/2.0$/);
  const reply = first.match(/^SIP\/2.0 ([1-6][0-9]{2}) (.*)$/);
  if (!match && !reply) throw Error("Invalid request");
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 1) throw Error("Invalid header");
    const rawKey = line.slice(0, i).toLowerCase();
    const key =
      {
        l: "content-length",
        v: "via",
        f: "from",
        t: "to",
        i: "call-id",
        m: "contact",
        c: "content-type",
      }[rawKey] || rawKey;
    (headers[key] ??= []).push(line.slice(i + 1).trim());
  }
  for (const key of ["via", "from", "to", "call-id", "cseq"])
    if (!headers[key]?.[0]) throw Error("Missing header");
  const body = buffer.subarray(split + 4);
  const length = Number(headers["content-length"]?.[0] || 0);
  if (!Number.isInteger(length) || length !== body.length)
    throw Error("Invalid content length");
  const [cseq, method] = headers.cseq[0].split(/\s+/);
  if (!/^\d+$/.test(cseq) || (match && method !== match[1]))
    throw Error("Invalid CSeq");
  return {
    method: match?.[1],
    uri: match?.[2],
    status: reply ? Number(reply[1]) : undefined,
    headers,
    body,
  };
}
export function response(req, status, reason, extra = []) {
  const h = req.headers;
  const to = h.to[0].includes(";tag=") ? h.to[0] : h.to[0] + ";tag=guanlan";
  return Buffer.from(
    [
      `SIP/2.0 ${status} ${reason}`,
      ...h.via.map((v) => "Via: " + v),
      "From: " + h.from[0],
      "To: " + to,
      "Call-ID: " + h["call-id"][0],
      "CSeq: " + h.cseq[0],
      ...extra,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  );
}
export function createDigest(realm, { now = () => Date.now() } = {}) {
  const secret = randomBytes(32);
  const used = new Map();
  const sign = (value) =>
    createHmac("sha256", secret).update(value).digest("hex");
  function challenge() {
    const value = now() + "." + randomBytes(12).toString("hex");
    return `Digest realm="${realm}", nonce="${value}.${sign(value)}", algorithm=MD5, qop="auth"`;
  }
  function verify(req, deviceId, ha1) {
    const auth = req.headers.authorization?.[0];
    if (!auth?.startsWith("Digest ")) return false;
    const values = {};
    for (const m of auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
      values[m[1]] = m[2] ?? m[3];
    const { username, nonce, uri, response: r, qop, nc, cnonce } = values;
    if (
      username !== deviceId ||
      values.realm !== realm ||
      uri !== req.uri ||
      !nonce ||
      !r ||
      !/^[a-fA-F0-9]{32}$/.test(r)
    )
      return false;
    const parts = nonce.split(".");
    if (parts.length !== 3) return false;
    const raw = parts.slice(0, 2).join(".");
    if (
      now() - Number(parts[0]) > 60000 ||
      now() < Number(parts[0]) ||
      sign(raw) !== parts[2]
    )
      return false;
    if (
      qop &&
      (qop !== "auth" || !cnonce || !nc || !/^[a-fA-F0-9]{8}$/.test(nc))
    )
      return false;
    const key = deviceId + ":" + nonce + ":" + (cnonce || "");
    const count = qop ? parseInt(nc, 16) : 1;
    if (!count || count <= (used.get(key)?.count || 0)) return false;
    const expected = md5(
      qop
        ? `${ha1}:${nonce}:${nc}:${cnonce}:auth:${md5(req.method + ":" + uri)}`
        : `${ha1}:${nonce}:${md5(req.method + ":" + uri)}`,
    );
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(r, "hex")))
      return false;
    for (const [k, v] of used) if (now() - v.at > 60000) used.delete(k);
    used.set(key, { count, at: now() });
    return true;
  }
  return { challenge, verify };
}

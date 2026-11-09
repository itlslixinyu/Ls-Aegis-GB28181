import { randomUUID } from "node:crypto";
import { expectSuccess, xmlEscape } from "../sip/requests.mjs";
const commands = {
  stop: 0,
  right: 1,
  left: 2,
  down: 4,
  up: 8,
  upRight: 9,
  upLeft: 10,
  downRight: 5,
  downLeft: 6,
  zoomIn: 16,
  zoomOut: 32,
  focusNear: 0x42,
  focusFar: 0x41,
};
const isFocus = (action) => action === "focusNear" || action === "focusFar";
export function encodePtz(action, speed = 128, { focusStop = false } = {}) {
  if (
    typeof action !== "string" ||
    !Object.hasOwn(commands, action) ||
    !Number.isInteger(speed) ||
    speed < 1 ||
    speed > 255
  )
    throw Error("云台方向或速度无效");
  const code = action === "stop" && focusStop ? 0x40 : commands[action],
    bytes = [
      0xa5,
      0x0f,
      1,
      code,
      isFocus(action) || code & 3 ? speed : 0,
      code & 12 ? speed : 0,
      code & 48 ? Math.max(1, Math.round(speed / 17)) * 16 : 0,
    ];
  bytes.push(bytes.reduce((a, b) => a + b, 0) % 256);
  return Buffer.from(bytes).toString("hex").toUpperCase();
}
export class DeviceOperations {
  constructor({ db, sip, now = () => Date.now() }) {
    Object.assign(this, { db, sip, now });
    this.active = new Map();
    this.cancelled = new Map();
    this.jobs = new Set();
    this.closing = false;
  }
  channel(id) {
    const row = this.db
      .prepare(
        "SELECT c.*,d.deviceId AS code,d.status AS deviceStatus,d.remoteAddress,d.remotePort,d.registeredUntil,d.lastHeartbeat FROM channels c JOIN devices d ON c.deviceId=d.id WHERE c.id=?",
      )
      .get(id);
    if (!row) throw Error("通道不存在");
    if (
      row.status !== "online" ||
      row.deviceStatus !== "online" ||
      row.registeredUntil < this.now() ||
      row.lastHeartbeat < this.now() - this.sip.config.heartbeatTimeout
    )
      throw Error("设备或通道未在线");
    return row;
  }
  ptz(
    channelId,
    userId,
    { action = "stop", speed = 128, duration = 2000, token } = {},
  ) {
    if (this.closing) throw Error("服务正在关闭");
    if (
      token !== undefined &&
      (typeof token !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(token))
    )
      throw Error("控制编号无效");
    for (const [key, expiry] of this.cancelled)
      if (expiry < this.now()) this.cancelled.delete(key);
    const tokenKey = userId + ":" + token;
    if (token && action !== "stop" && this.cancelled.has(tokenKey))
      throw Error("该控制已取消");
    if (token && action === "stop")
      this.cancelled.set(tokenKey, this.now() + 30000);
    let packet = encodePtz(action, speed);
    if (!Number.isInteger(duration) || duration < 100 || duration > 3000)
      throw Error("云台控制时长须为100至3000毫秒");
    const channel = this.channel(channelId);
    if (this.sip.state !== "listening") throw Error("SIP服务未启用");
    const previous = this.active.get(channelId);
    if (action === "stop" && isFocus(previous?.action))
      packet = encodePtz("stop", speed, { focusStop: true });
    if (token && action === "stop" && previous && previous.token !== token)
      return { commandId: null, status: "ignored" };
    if (
      token &&
      action !== "stop" &&
      previous?.token === token &&
      previous.userId === userId
    )
      return { commandId: previous.commandId, status: "pending" };
    if (action !== "stop" && previous && previous.userId !== userId)
      throw Error("该通道正在由其他用户控制");
    if (previous) {
      clearTimeout(previous.timer);
      previous.controller.abort();
      this.active.delete(channelId);
    }
    const id = randomUUID(),
      controller = new AbortController();
    this.db
      .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        userId,
        channelId,
        action,
        "pending",
        null,
        new Date().toISOString(),
      );
    if (action !== "stop") {
      const item = {
        userId,
        channel,
        controller,
        token,
        commandId: id,
        action,
      };
      item.timer = setTimeout(() => {
        if (this.active.get(channelId) !== item) return;
        this.active.delete(channelId);
        if (token) this.cancelled.set(tokenKey, this.now() + 30000);
        controller.abort();
        const work = this.sendStop(channel, action).catch(() => {});
        this.track(work);
      }, duration);
      item.timer.unref();
      this.active.set(channelId, item);
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?><Control><CmdType>DeviceControl</CmdType><SN>${++this.sip.seq}</SN><DeviceID>${channel.channelCode}</DeviceID><PTZCmd>${packet}</PTZCmd><Info><ControlPriority>5</ControlPriority></Info></Control>`;
    const request = () =>
      this.sip.requests.request({
        uri: `sip:${channel.code}@${channel.remoteAddress}:${channel.remotePort}`,
        remote: channel,
        body,
        signal: controller.signal,
      });
    const response =
      previous &&
      action !== "stop" &&
      isFocus(previous.action) !== isFocus(action)
        ? this.sendStop(previous.channel, previous.action).then(() => {
            controller.signal.throwIfAborted();
            return request();
          })
        : request();
    const work = expectSuccess(response)
      .then(() =>
        this.db
          .prepare("UPDATE commands SET status='acknowledged' WHERE id=?")
          .run(id),
      )
      .catch((error) =>
        this.db
          .prepare("UPDATE commands SET status='failed',error=? WHERE id=?")
          .run(error.message, id),
      );
    this.track(work);
    return { commandId: id, status: "pending" };
  }
  track(work) {
    this.jobs.add(work);
    work.finally(() => this.jobs.delete(work)).catch(() => {});
  }
  async sendStop(channel, action = "stop") {
    const body = `<Control><CmdType>DeviceControl</CmdType><SN>${++this.sip.seq}</SN><DeviceID>${xmlEscape(channel.channelCode)}</DeviceID><PTZCmd>${encodePtz("stop", 128, { focusStop: isFocus(action) })}</PTZCmd><Info><ControlPriority>5</ControlPriority></Info></Control>`;
    try {
      await expectSuccess(
        this.sip.requests.request({
          uri: `sip:${channel.code}@${channel.remoteAddress}:${channel.remotePort}`,
          remote: channel,
          body,
        }),
      );
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          "system",
          channel.id,
          "stop",
          "acknowledged",
          null,
          new Date().toISOString(),
        );
    } catch (error) {
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          "system",
          channel.id,
          "stop",
          "failed",
          error.message,
          new Date().toISOString(),
        );
      throw error;
    }
  }
  async revoke(access) {
    const jobs = [];
    for (const [id, item] of this.active)
      if (
        !access.can(item.userId, "ptz.control") ||
        !access.channel(item.userId, id)
      ) {
        clearTimeout(item.timer);
        item.controller.abort();
        this.active.delete(id);
        jobs.push(this.sendStop(item.channel, item.action).catch(() => {}));
      }
    await Promise.all(jobs);
  }
  async stopUser(userId) {
    const jobs = [];
    for (const [id, item] of this.active)
      if (item.userId === userId) {
        clearTimeout(item.timer);
        item.controller.abort();
        this.active.delete(id);
        jobs.push(this.sendStop(item.channel, item.action).catch(() => {}));
      }
    await Promise.all(jobs);
  }
  async close() {
    this.closing = true;
    const stops = [];
    for (const item of this.active.values()) {
      clearTimeout(item.timer);
      item.controller.abort();
      stops.push(this.sendStop(item.channel, item.action).catch(() => {}));
    }
    this.active.clear();
    await Promise.all([...this.jobs, ...stops]);
  }
}

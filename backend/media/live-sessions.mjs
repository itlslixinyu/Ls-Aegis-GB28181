import { Access } from "../services/access.mjs";
import { randomUUID, randomInt } from "node:crypto";
import { validPlaybackScale } from "../lib/playback-scale.mjs";
const active = ["allocating", "inviting", "waiting_media", "ready"];
export class LiveSessions {
  constructor({
    db,
    media,
    sip,
    config,
    now = () => Date.now(),
    lease = 45000,
    poll = 1000,
  }) {
    Object.assign(this, { db, media, sip, config, now, lease, poll });
    this.access = new Access(db);
    this.running = new Map();
    this.ssrcSequence = randomInt(10000);
    this.closing = false;
    this.sip.dialogs.onEnded = (id) => {
      const task = [...this.running.values()].find((t) => t.dialog?.id === id);
      if (task) {
        task.error = "设备已结束点播";
        void this.stop(task.row.id);
      }
    };
    this.timer = setInterval(() => this.reap().catch(() => {}), 1000);
    this.timer.unref();
  }
  nextSsrc(kind) {
    const domain = this.config.sip.domain || "4101050000";
    const occupied = new Set(
      [...this.running.values()]
        .filter((t) => t.ssrc)
        .map((t) => t.ssrc.slice(-4)),
    );
    for (let i = 0; i < 10000; i++) {
      const tail = String(this.ssrcSequence).padStart(4, "0");
      this.ssrcSequence = (this.ssrcSequence + 1) % 10000;
      if (!occupied.has(tail))
        return (
          (["playback", "download"].includes(kind) ? "1" : "0") +
          domain.slice(3, 8) +
          tail
        );
    }
    throw Error("国标媒体流编号已用尽");
  }
  async recover() {
    for (const row of this.db
      .prepare("SELECT * FROM live_sessions WHERE released=0")
      .all()) {
      try {
        if (row.dialog) await this.sip.dialogs.end(JSON.parse(row.dialog));
        await this.media.release(row.streamId);
        this.db
          .prepare(
            "UPDATE live_sessions SET state='failed',error='服务重启，会话已回收',released=1 WHERE id=?",
          )
          .run(row.id);
      } catch {
        this.db
          .prepare(
            "UPDATE live_sessions SET state='failed',error='服务重启，等待资源回收' WHERE id=?",
          )
          .run(row.id);
      }
    }
    this.db.prepare("DELETE FROM viewers").run();
  }
  create(channel, userId, key, options = null) {
    if (options?.kind === "live") {
      if (![0, 1].includes(options.streamNumber)) throw Error("码流编号无效");
      options =
        options.streamNumber === 0 ? null : { kind: "live", streamNumber: 1 };
    }
    this.access.requireChannel(userId, channel.id);
    const kind = options?.kind || (options ? "playback" : "live");
    if (!this.access.canStream(userId, kind))
      throw Error("当前角色没有该播放功能权限");
    if (key) key = kind + ":" + key;
    if (this.closing) throw Error("服务正在关闭");
    if (key) {
      const previous = this.db
        .prepare("SELECT * FROM live_requests WHERE userId=? AND requestKey=?")
        .get(userId, key);
      if (previous) {
        if (
          previous.channelId !== channel.id ||
          this.db
            .prepare("SELECT options FROM live_sessions WHERE id=?")
            .get(previous.sessionId)?.options !==
            (options ? JSON.stringify(options) : null)
        )
          throw Error("幂等键已用于其他通道");
        const viewer = this.db
          .prepare("SELECT * FROM viewers WHERE id=? AND expiresAt>?")
          .get(previous.viewerId, this.now());
        if (!viewer) throw Error("该请求已结束，请使用新的请求编号");
        return this.snapshot(previous.sessionId, userId, viewer.id);
      }
    }
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM viewers WHERE userId=? AND expiresAt>?",
        )
        .get(userId, this.now()).n >= 64
    )
      throw Error("已达到单个账号的观看数量上限（64路）");
    if (!this.config.media.configured)
      throw Error("请先配置媒体节点地址与密钥");
    if (this.sip.state !== "listening") throw Error("SIP服务未启用");
    const device = this.db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(channel.deviceId);
    if (
      !device ||
      device.status !== "online" ||
      device.registeredUntil < this.now() ||
      device.lastHeartbeat < this.now() - this.config.sip.heartbeatTimeout
    )
      throw Error("设备未在线");
    if (channel.status !== "online") throw Error("通道未在线");
    let row =
      kind === "live"
        ? this.db
            .prepare(
              "SELECT * FROM live_sessions WHERE channelId=? AND kind='live' AND options IS ? AND state IN ('allocating','inviting','waiting_media','ready') ORDER BY createdAt DESC LIMIT 1",
            )
            .get(channel.id, options ? JSON.stringify(options) : null)
        : null;
    let fresh = false;
    if (!row) {
      if (
        this.db
          .prepare("SELECT count(*) AS n FROM live_sessions WHERE released=0")
          .get().n >= 64
      )
        throw Error("播放资源已达到本机开发实例上限");
      fresh = true;
      row = {
        id: randomUUID(),
        channelId: channel.id,
        deviceId: device.id,
        streamId: "gl_" + randomUUID().replaceAll("-", ""),
        state: "allocating",
        kind,
        options: options ? JSON.stringify(options) : null,
        createdAt: new Date(this.now()).toISOString(),
      };
      this.db
        .prepare(
          "INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt,kind,options) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          row.id,
          row.channelId,
          row.deviceId,
          row.streamId,
          row.state,
          row.createdAt,
          row.kind,
          row.options,
        );
    }
    const viewerId = randomUUID();
    this.db
      .prepare("INSERT INTO viewers VALUES(?,?,?,?)")
      .run(viewerId, row.id, userId, this.now() + this.lease);
    if (key)
      this.db
        .prepare("INSERT INTO live_requests VALUES(?,?,?,?,?,?)")
        .run(userId, key, channel.id, row.id, viewerId, this.now());
    if (fresh) {
      const controller = new AbortController();
      const task = { controller, device, channel, row };
      this.running.set(row.id, task);
      task.work = this.run(task);
    }
    return this.snapshot(row.id, userId, viewerId);
  }
  snapshot(id, userId, viewerId) {
    const viewer = this.db
      .prepare(
        "SELECT * FROM viewers WHERE id=? AND sessionId=? AND userId=? AND expiresAt>?",
      )
      .get(viewerId, id, userId, this.now());
    if (!viewer) throw Error("观看会话不存在或已过期");
    const row = this.db
      .prepare("SELECT * FROM live_sessions WHERE id=?")
      .get(id);
    if (!row) throw Error("播放会话不存在");
    this.access.requireDevice(userId, row.deviceId);
    if (!this.access.canStream(userId, row.kind))
      throw Error("当前角色没有该播放功能权限");
    return {
      sessionId: id,
      viewerId,
      state: row.state,
      error: row.error,
      kind: row.kind,
      options: row.options ? JSON.parse(row.options) : null,
      expiresAt: viewer.expiresAt,
      ...(row.state === "ready"
        ? {
            playUrl: `/api/v1/live-sessions/${id}/viewers/${viewerId}/stream.${this.convertsPreviewAudio(id) ? "mp4" : "flv"}`,
          }
        : {}),
    };
  }
  renew(id, userId, viewerId) {
    this.snapshot(id, userId, viewerId);
    const row = this.db
      .prepare("SELECT state FROM live_sessions WHERE id=?")
      .get(id);
    if (!active.includes(row.state)) throw Error("播放会话已结束");
    this.db
      .prepare("UPDATE viewers SET expiresAt=? WHERE id=?")
      .run(this.now() + this.lease, viewerId);
    return this.snapshot(id, userId, viewerId);
  }
  async leave(id, userId, viewerId) {
    const existing = this.db
      .prepare("SELECT * FROM viewers WHERE id=? AND sessionId=?")
      .get(viewerId, id);
    if (existing && existing.userId !== userId)
      throw Error("无权操作其他观看者");
    this.db
      .prepare("DELETE FROM viewers WHERE id=? AND sessionId=? AND userId=?")
      .run(viewerId, id, userId);
    const task = this.running.get(id);
    task?.connections?.get(viewerId)?.forEach((c) => c.abort());
    if (
      !this.db
        .prepare("SELECT 1 FROM viewers WHERE sessionId=? AND expiresAt>?")
        .get(id, this.now())
    )
      await this.stop(id);
  }
  state(id, state, error = null) {
    this.db
      .prepare("UPDATE live_sessions SET state=?,error=? WHERE id=?")
      .run(state, error, id);
  }
  async run(task) {
    const { row, device, channel, controller } = task;
    const cancelled = () => {
      if (controller.signal.aborted) throw Error("观看已结束");
    };
    try {
      const mode = device.mediaTransport || "UDP";
      const allocation = await this.media.allocate(
        row.streamId,
        mode === "UDP" ? 0 : mode === "TCP-PASSIVE" ? 1 : 2,
      );
      task.port = allocation.port;
      cancelled();
      this.state(row.id, "inviting");
      const ssrc = this.nextSsrc(row.kind);
      task.ssrc = ssrc;
      task.dialog = await this.sip.dialogs.invite(device, channel.channelCode, {
        host: this.config.media.rtpHost,
        port: task.port,
        ssrc,
        signal: controller.signal,
        mediaTransport: mode,
        streamNumber:
          row.kind === "live"
            ? row.options
              ? JSON.parse(row.options).streamNumber
              : 0
            : 0,
        ...(["playback", "download"].includes(row.kind)
          ? {
              playback: JSON.parse(row.options),
              download: row.kind === "download",
              speed: JSON.parse(row.options).speed || 1,
            }
          : {}),
      });
      this.db
        .prepare("UPDATE live_sessions SET dialog=? WHERE id=?")
        .run(JSON.stringify(task.dialog), row.id);
      cancelled();
      if (mode !== "UDP") {
        const answer = task.dialog.answer || "",
          m = answer.match(/^m=video (\d+) TCP\/RTP\/AVP /m),
          setup = answer.match(/^a=setup:(active|passive)\r?$/m)?.[1];
        if (!m || setup !== (mode === "TCP-PASSIVE" ? "active" : "passive"))
          throw Error("设备TCP媒体协商不匹配");
        if (mode === "TCP-ACTIVE") {
          const host = answer.match(/^c=IN IP4 ([\d.]+)\r?$/m)?.[1],
            port = Number(m[1]);
          if (host !== device.remoteAddress || port < 1024 || port > 65535)
            throw Error("设备TCP媒体目标不匹配");
          await this.media.connectRtp(row.streamId, host, port);
          cancelled();
        }
      }
      this.state(row.id, "waiting_media");
      const deadline = this.now() + this.config.playTimeout;
      while (this.now() < deadline) {
        cancelled();
        const list = await this.media.streams();
        cancelled();
        const stream = list.find(
          (s) =>
            s.stream === row.streamId && s.app === "rtp" && s.schema === "rtmp",
        );
        if (stream) {
          const tracks = Array.isArray(stream.tracks) ? stream.tracks : [];
          task.previewNeedsAac =
            row.kind === "live" &&
            this.config.media.aacPreviewAuto &&
            tracks.some(
              (track) => track.codec_type === 0 && track.codec_id === 1,
            ) &&
            tracks.some(
              (track) =>
                track.codec_type === 1 && [3, 4].includes(track.codec_id),
            );
          this.state(row.id, "ready");
          return;
        }
        await new Promise((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, this.poll);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      throw Error("等待媒体流超时");
    } catch (e) {
      task.error = controller.signal.aborted ? task.error || null : e.message;
      this.state(row.id, task.error ? "failed" : "stopping", task.error);
      await this.cleanup(task);
    } finally {
      task.finished = true;
    }
  }
  async cleanup(task) {
    if (task.cleaning) return task.cleaning;
    task.cleaning = (async () => {
      try {
        if (task.dialog) await this.sip.dialogs.end(task.dialog);
        await this.media.release(task.row.streamId);
        this.db
          .prepare("UPDATE live_sessions SET released=1 WHERE id=?")
          .run(task.row.id);
        this.state(
          task.row.id,
          task.error ? "failed" : task.completed ? "completed" : "stopped",
          task.error,
        );
        this.running.delete(task.row.id);
      } catch {
        this.state(
          task.row.id,
          "failed",
          task.error || "资源回收失败，稍后重试",
        );
      } finally {
        task.cleaning = null;
      }
    })();
    return task.cleaning;
  }
  async stop(id) {
    const task = this.running.get(id);
    if (!task) return;
    task.controller.abort();
    task.connections?.forEach((set) => set.forEach((c) => c.abort()));
    const state = this.db
      .prepare("SELECT state FROM live_sessions WHERE id=?")
      .get(id)?.state;
    if (task.finished || state === "ready") {
      this.state(id, "stopping", task.error);
      await this.cleanup(task);
    } else await task.work;
  }
  async revoke() {
    for (const task of this.running.values())
      for (const [id, connections] of task.connections || []) {
        const v = this.db
          .prepare("SELECT userId FROM viewers WHERE id=?")
          .get(id);
        if (
          !v ||
          !this.access.device(v.userId, task.row.deviceId) ||
          !this.access.canStream(v.userId, task.row.kind)
        )
          connections.forEach((c) => c.abort());
      }
    const viewers = this.db
      .prepare(
        "SELECT v.*,s.deviceId,s.kind FROM viewers v JOIN live_sessions s ON s.id=v.sessionId",
      )
      .all();
    await Promise.all(
      viewers
        .filter(
          (v) =>
            !this.access.device(v.userId, v.deviceId) ||
            !this.access.canStream(v.userId, v.kind),
        )
        .map((v) => this.leave(v.sessionId, v.userId, v.id)),
    );
  }
  async reap() {
    if (this.reaping || this.closing) return;
    this.reaping = true;
    try {
      await this.revoke();
      const now = this.now();
      const expired = this.db
        .prepare("SELECT * FROM viewers WHERE expiresAt<=?")
        .all(now);
      for (const v of expired)
        this.running
          .get(v.sessionId)
          ?.connections?.get(v.id)
          ?.forEach((c) => c.abort());
      this.db.prepare("DELETE FROM viewers WHERE expiresAt<=?").run(now);
      this.db
        .prepare("DELETE FROM live_requests WHERE createdAt<?")
        .run(now - 86400000);
      for (const [id, task] of this.running) {
        const device = this.db
          .prepare(
            "SELECT status,registeredUntil,lastHeartbeat FROM devices WHERE id=?",
          )
          .get(task.device.id);
        if (
          !device ||
          device.status !== "online" ||
          device.registeredUntil < now ||
          device.lastHeartbeat < now - this.config.sip.heartbeatTimeout
        ) {
          task.error = "设备已离线";
          await this.stop(id);
        } else if (
          !this.db.prepare("SELECT 1 FROM viewers WHERE sessionId=?").get(id)
        )
          await this.stop(id);
        else if (
          this.db.prepare("SELECT state FROM live_sessions WHERE id=?").get(id)
            ?.state === "failed"
        )
          await this.cleanup(task);
        else if (
          this.db.prepare("SELECT state FROM live_sessions WHERE id=?").get(id)
            ?.state === "ready" &&
          now - (task.lastCheck || 0) > 10000
        ) {
          task.lastCheck = now;
          try {
            if (task.paused) {
              if (now - (task.pausedAt || 0) > 30000) {
                await this.media.setPaused(task.row.streamId, true);
                task.pausedAt = now;
              }
              continue;
            }
            const list = await this.media.streams();
            if (
              !list.some(
                (s) =>
                  s.stream === task.row.streamId &&
                  s.app === "rtp" &&
                  s.schema === "rtmp",
              )
            )
              throw Error();
          } catch {
            task.error = "媒体流已断开";
            await this.stop(id);
          }
        }
      }
      for (const row of this.db
        .prepare("SELECT * FROM live_sessions WHERE released=0")
        .all()) {
        if (this.running.has(row.id)) continue;
        try {
          if (row.dialog) await this.sip.dialogs.end(JSON.parse(row.dialog));
          await this.media.release(row.streamId);
          this.db
            .prepare("UPDATE live_sessions SET released=1 WHERE id=?")
            .run(row.id);
        } catch {}
      }
    } finally {
      this.reaping = false;
    }
  }
  authorizeStream(id, userId, viewerId) {
    const snapshot = this.snapshot(id, userId, viewerId);
    if (snapshot.state !== "ready") throw Error("媒体尚未就绪");
    return this.db
      .prepare("SELECT streamId FROM live_sessions WHERE id=?")
      .get(id).streamId;
  }
  convertsPreviewAudio(id) {
    const task = this.running.get(id);
    return (
      task?.row.kind === "live" &&
      (task.previewNeedsAac ||
        this.config.media.aacPreviewDevices?.includes(task.device.deviceId))
    );
  }
  trackConnection(id, viewerId, controller) {
    const task = this.running.get(id);
    if (!task) throw Error("播放会话已结束");
    task.connections ??= new Map();
    let set = task.connections.get(viewerId);
    if (!set) {
      set = new Set();
      task.connections.set(viewerId, set);
    }
    if (set.size >= 2) throw Error("单个观看者连接过多");
    set.add(controller);
    return () => {
      set.delete(controller);
      if (!set.size) task.connections.delete(viewerId);
    };
  }
  async endNotification(deviceId, channelCode, callId) {
    if (!callId) return false;
    const task = [...this.running.values()].find(
      (t) =>
        ["playback", "download"].includes(t.row.kind) &&
        t.device.id === deviceId &&
        t.channel.channelCode === channelCode &&
        t.dialog?.id === callId,
    );
    if (!task) return false;
    task.completed = true;
    await this.stop(task.row.id);
    return true;
  }
  async control(id, userId, viewerId, operation) {
    const snapshot = this.snapshot(id, userId, viewerId);
    if (snapshot.kind !== "playback" || snapshot.state !== "ready")
      throw Error("回放尚未就绪");
    if (!["pause", "resume", "speed", "seek"].includes(operation.action))
      throw Error("回放操作无效");
    if (operation.action === "speed" && !validPlaybackScale(operation.scale))
      throw Error("回放倍速无效");
    if (operation.action === "seek") {
      const duration =
        (Date.parse(snapshot.options?.end) -
          Date.parse(snapshot.options?.start)) /
        1000;
      if (
        !Number.isFinite(operation.position) ||
        operation.position < 0 ||
        operation.position >= duration
      )
        throw Error("回放位置超出录像范围");
    }
    const task = this.running.get(id);
    if (!task?.dialog) throw Error("回放会话不存在");
    const wasPaused = task.paused;
    if (operation.action === "pause")
      await this.media.setPaused(task.row.streamId, true);
    try {
      await this.sip.dialogs.control(task.dialog, operation);
    } catch (error) {
      if (operation.action === "pause" && !wasPaused)
        await this.media.setPaused(task.row.streamId, false).catch(() => {});
      throw error;
    }
    task.paused = operation.action === "pause";
    task.pausedAt = this.now();
    if (wasPaused && !task.paused)
      try {
        await this.media.setPaused(task.row.streamId, false);
      } catch (error) {
        task.error = "媒体回放恢复失败";
        await this.stop(id);
        throw error;
      }

    this.db
      .prepare("UPDATE live_sessions SET dialog=? WHERE id=?")
      .run(JSON.stringify(task.dialog), id);
    return { accepted: true, action: operation.action };
  }
  async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    while (this.reaping)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}

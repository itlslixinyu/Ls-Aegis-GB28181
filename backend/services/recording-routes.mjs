import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RecordingPlanGroups } from "./recording-plan-groups.mjs";
import { RecordingTaskGroups } from "./recording-task-groups.mjs";
export async function recordingRoutes(ctx) {
  const {
      req,
      res,
      url,
      session,
      recordings,
      access,
      media,
      db,
      body,
      send,
      fail,
      audit,
    } = ctx,
    p = url.pathname,
    admin = session.role === "admin";
  const requireAdmin = () => {
    if (!admin) fail(403, "FORBIDDEN", "需要管理员权限");
  };
  const taskGroup = p.match(
    /^\/api\/v1\/recording-task-groups(?:\/([a-zA-Z0-9_-]+)\/channels)?$/,
  );
  if (taskGroup && req.method === "GET") {
    try {
      const service = new RecordingTaskGroups(recordings);
      const deleted = url.searchParams.get("includeDeleted") || "";
      if (!["", "1"].includes(deleted))
        fail(400, "INVALID_RECORDING_QUERY", "历史显示参数无效");
      if (deleted && !admin)
        fail(403, "FORBIDDEN", "只有管理员可查看已删除通道历史");
      const options = {
        page: Number(url.searchParams.get("page") || 1),
        pageSize: Number(url.searchParams.get("pageSize") || 20),
        includeDeleted: deleted === "1",
        date:
          url.searchParams.get("date") ||
          new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
        q: url.searchParams.get("q") || "",
      };
      send(
        200,
        taskGroup[1]
          ? service.channels(session.userId, taskGroup[1], options)
          : service.list(session.userId, options),
      );
      return true;
    } catch (e) {
      fail(
        e.status || 500,
        e.code || "RECORDING_QUERY_FAILED",
        e.status ? e.message : "录像任务查询失败，请稍后重试",
      );
    }
  }
  const transport = p.match(/^\/api\/v1\/devices\/([^/]+)\/media-transport$/);
  if (transport && req.method === "PUT") {
    requireAdmin();
    const { transport: mode } = await body(req),
      id = decodeURIComponent(transport[1]);
    if (!["UDP", "TCP-PASSIVE", "TCP-ACTIVE"].includes(mode))
      fail(400, "INVALID_TRANSPORT", "媒体传输方式无效");
    if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(id))
      fail(404, "DEVICE_NOT_FOUND", "设备不存在");
    if (
      db
        .prepare("SELECT 1 FROM live_sessions WHERE deviceId=? AND released=0")
        .get(id)
    )
      fail(409, "DEVICE_BUSY", "请先结束该设备的点播和录像任务");
    db.prepare("UPDATE devices SET mediaTransport=? WHERE id=?").run(mode, id);
    audit(session.userId, "device.transport", id);
    send(200, { transport: mode });
    return true;
  }
  const groupPlan = p.match(
    /^\/api\/v1\/recording-plan-groups(?:\/([a-zA-Z0-9-]+)(\/enabled|\/channels)?)?$/,
  );
  if (groupPlan) {
    requireAdmin();
    const service = new RecordingPlanGroups(recordings),
      id = groupPlan[1],
      action = groupPlan[2];
    try {
      if (req.method === "GET" && !id) {
        send(200, { items: service.list() });
        return true;
      }
      if (req.method === "GET" && action === "/channels") {
        send(200, { items: service.details(id, session.userId) });
        return true;
      }
      if (req.method === "POST" && !id) {
        const saved = service.save(
          await body(req),
          session.userId,
          null,
          req.headers["idempotency-key"],
        );
        audit(session.userId, "plan.group.create", saved.id);
        send(201, saved);
        return true;
      }
      if (req.method === "PUT" && id && !action) {
        const saved = service.save(await body(req), session.userId, id);
        audit(session.userId, "plan.group.update", id);
        send(200, saved);
        return true;
      }
      if (req.method === "PUT" && action === "/enabled") {
        const v = await body(req);
        const saved = service.enable(id, v.enabled, v.version);
        audit(session.userId, "plan.group.enabled", id);
        send(200, saved);
        return true;
      }
      if (req.method === "DELETE" && id && !action) {
        const version = Number(url.searchParams.get("version"));
        if (!url.searchParams.has("version") || !Number.isInteger(version))
          fail(400, "GROUP_PLAN_INVALID", "请提供计划版本");
        service.remove(id, version);
        audit(session.userId, "plan.group.delete", id);
        send(204);
        return true;
      }
    } catch (e) {
      fail(e.status || 400, e.code || "GROUP_PLAN_INVALID", e.message);
    }
  }
  if (p === "/api/v1/recording-plans") {
    requireAdmin();
    if (req.method === "GET") {
      send(200, { items: recordings.plans() });
      return true;
    }
    if (req.method === "POST") {
      try {
        const v = recordings.savePlan(await body(req), session.userId);
        audit(session.userId, "plan.create", v.id);
        send(201, v);
      } catch (e) {
        fail(e.status || 400, e.code || "PLAN_INVALID", e.message);
      }
      return true;
    }
  }
  const plan = p.match(
    /^\/api\/v1\/recording-plans\/([a-zA-Z0-9-]+)(\/enabled)?$/,
  );
  if (plan) {
    requireAdmin();
    if (
      req.method !== "GET" &&
      db
        .prepare("SELECT 1 FROM recording_plan_members WHERE planId=?")
        .get(plan[1])
    )
      fail(409, "GROUP_PLAN_MANAGED", "请通过分组录像计划统一修改此通道");
    try {
      if (req.method === "PUT" && !plan[2]) {
        send(
          200,
          recordings.savePlan(await body(req), session.userId, plan[1]),
        );
        audit(session.userId, "plan.update", plan[1]);
        return true;
      }
      if (req.method === "PUT" && plan[2]) {
        recordings.enablePlan(plan[1], (await body(req)).enabled);
        audit(session.userId, "plan.enabled", plan[1]);
        send(204);
        return true;
      }
      if (req.method === "DELETE" && !plan[2]) {
        recordings.removePlan(plan[1]);
        audit(session.userId, "plan.delete", plan[1]);
        send(204);
        return true;
      }
    } catch (e) {
      fail(e.status || 409, e.code || "PLAN_UNAVAILABLE", e.message);
    }
  }
  if (p === "/api/v1/recording-jobs") {
    if (req.method === "GET") {
      const kind = url.searchParams.get("kind") || "";
      if (!["", "download", "scheduled"].includes(kind))
        fail(400, "INVALID_RECORDING_KIND", "录像任务类型无效");
      const daily = url.searchParams.get("daily") || "";
      if (!["", "1"].includes(daily) || (daily && kind !== "scheduled"))
        fail(400, "INVALID_RECORDING_QUERY", "按日汇总仅适用于计划录像");
      send(200, {
        items: recordings.list(session.userId, admin, kind, daily === "1"),
      });
      return true;
    }
    if (req.method === "POST") {
      try {
        const j = recordings.download(
          await body(req),
          session.userId,
          req.headers["idempotency-key"],
        );
        audit(session.userId, "record.download", j.id);
        send(202, j);
      } catch (e) {
        fail(e.status || 409, e.code || "DOWNLOAD_UNAVAILABLE", e.message);
      }
      return true;
    }
  }
  const task = p.match(
    /^\/api\/v1\/recording-jobs\/([a-zA-Z0-9-]+)(\/cancel|\/files\/([a-zA-Z0-9-]+))?$/,
  );
  if (task) {
    let j;
    try {
      j = recordings.job(task[1], session.userId, admin);
    } catch (e) {
      fail(404, "JOB_NOT_FOUND", e.message);
    }
    if (req.method === "GET" && !task[2]) {
      send(200, recordings.publicJob(j));
      return true;
    }
    if (req.method === "POST" && task[2] === "/cancel") {
      if (!admin && j.kind === "scheduled")
        fail(403, "FORBIDDEN", "没有录像计划维护权限");
      try {
        await recordings.cancel(j.id, session.userId, admin);
        audit(session.userId, "record.cancel", j.id);
        send(204);
      } catch (e) {
        fail(409, "JOB_BUSY", e.message);
      }
      return true;
    }
    if (req.method === "GET" && task[3]) {
      const file = db
        .prepare("SELECT * FROM recording_files WHERE id=? AND jobId=?")
        .get(task[3], j.id);
      if (!file) fail(404, "FILE_NOT_FOUND", "录像文件不存在或已过期");
      const range = req.headers.range;
      if (
        range &&
        (typeof range !== "string" || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      )
        fail(416, "INVALID_RANGE", "仅支持单段字节范围");
      const index = ctx.ai?.history?.index;
      let indexReleased = false;
      const releaseIndex = () => {
        if (index && !indexReleased) {
          indexReleased = true;
          index.playbacks--;
          index.deferUntil = Date.now() + 15000;
        }
      };
      if (index) {
        index.playbacks++;
        res.once("close", releaseIndex);
        await index.suspend();
      }
      const controller = new AbortController(),
        disconnect = () => controller.abort();
      const device = db
        .prepare("SELECT deviceId FROM channels WHERE id=?")
        .get(j.channelId);
      const untrack = access.track(
        session.userId,
        device?.deviceId,
        controller,
        session.token,
        url.searchParams.get("play") === "1"
          ? "recording.view"
          : "recording.download",
      );
      res.on("close", disconnect);
      const timer = setTimeout(
        disconnect,
        Math.max(1, Math.min(3600000, session.expiresAt - Date.now())),
      );
      let headerTimer = setTimeout(disconnect, 10000);
      try {
        const upstream = await media.openRecording(
          j.streamId,
          file,
          range,
          controller.signal,
        );
        clearTimeout(headerTimer);
        const headers = {
          "Content-Type": "video/mp4",
          "Content-Disposition": `${url.searchParams.get("play") === "1" ? "inline" : "attachment"}; filename="recording.mp4"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        };
        for (const name of [
          "content-length",
          "content-range",
          "accept-ranges",
        ]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        if (upstream.status === 416) {
          res.writeHead(416, headers);
          res.end();
          return true;
        }
        res.writeHead(upstream.status, headers);
        await pipeline(Readable.fromWeb(upstream.body), res, {
          signal: controller.signal,
        });
      } catch {
        if (!res.headersSent && !res.destroyed)
          fail(502, "RECORDING_FILE_UNAVAILABLE", "录像文件获取失败");
      } finally {
        clearTimeout(timer);
        clearTimeout(headerTimer);
        controller.abort();
        res.off("close", disconnect);
        untrack();
        releaseIndex();
        res.off("close", releaseIndex);
      }
      return true;
    }
  }
  return false;
}

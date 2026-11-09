import { recordRange } from "./record-queries.mjs";
export async function featureRoutes(ctx) {
  const {
      req,
      url,
      session,
      db,
      operations,
      records,
      live,
      cascade,
      body,
      send,
      fail,
      audit,
      access,
    } = ctx,
    p = url.pathname;
  const admin = () => {
    if (session.role !== "admin") fail(403, "FORBIDDEN", "需要管理员权限");
  };
  const ptz = p.match(/^\/api\/v1\/channels\/([^/]+)\/ptz$/);
  if (ptz && req.method === "POST") {
    if (!access.can(session.userId, "ptz.control"))
      fail(403, "FORBIDDEN", "没有云台控制权限");
    let result;
    const value = await body(req);
    if (!access.channel(session.userId, decodeURIComponent(ptz[1])))
      fail(404, "CHANNEL_NOT_FOUND", "通道不存在或无权访问");
    try {
      result = operations.ptz(
        decodeURIComponent(ptz[1]),
        session.userId,
        value,
      );
    } catch (error) {
      fail(409, "PTZ_UNAVAILABLE", error.message);
    }
    audit(session.userId, "ptz.command", decodeURIComponent(ptz[1]));
    send(202, result);
    return true;
  }
  const command = p.match(/^\/api\/v1\/commands\/([a-zA-Z0-9-]+)$/);
  if (command && req.method === "GET") {
    if (!access.can(session.userId, "ptz.control"))
      fail(403, "FORBIDDEN", "没有云台控制权限");
    const row = db.prepare("SELECT * FROM commands WHERE id=?").get(command[1]);
    if (!row || (session.role !== "admin" && row.userId !== session.userId))
      fail(404, "COMMAND_NOT_FOUND", "命令不存在");
    if (!access.channel(session.userId, row.channelId))
      fail(404, "COMMAND_NOT_FOUND", "命令不存在或无权访问");
    send(200, row);
    return true;
  }
  if (p === "/api/v1/record-queries" && req.method === "POST") {
    const value = await body(req);
    if (typeof value.channelId !== "string")
      fail(400, "INVALID_CHANNEL", "请选择通道");
    let result;
    try {
      result = records.create(value.channelId, session.userId, value);
    } catch (error) {
      fail(400, "RECORD_QUERY_UNAVAILABLE", error.message);
    }
    audit(session.userId, "record.query", result.taskId);
    send(202, result);
    return true;
  }
  const record = p.match(/^\/api\/v1\/record-queries\/([a-zA-Z0-9-]+)$/);
  if (record && req.method === "GET") {
    try {
      send(200, records.get(record[1], session.userId));
    } catch (error) {
      fail(404, "QUERY_NOT_FOUND", error.message);
    }
    return true;
  }
  if (p === "/api/v1/playback-sessions" && req.method === "POST") {
    const value = await body(req);
    const item =
      typeof value.recordId === "string"
        ? db
            .prepare(
              "SELECT r.* FROM record_items r JOIN record_queries q ON r.queryId=q.id WHERE r.id=? AND q.userId=? AND q.status='succeeded'",
            )
            .get(value.recordId, session.userId)
        : null;
    if (!item) fail(404, "RECORD_NOT_FOUND", "录像不存在或无权访问");
    const channel = db
      .prepare("SELECT * FROM channels WHERE id=?")
      .get(item.channelId);
    if (!channel) fail(404, "CHANNEL_NOT_FOUND", "通道不存在");
    let result;
    try {
      const range = recordRange(
        value.start || item.start,
        value.end || item.end,
      );
      if (range.start < item.start || range.end > item.end)
        throw Error("回放时间超出录像范围");
      const key = req.headers["idempotency-key"];
      if (key && (typeof key !== "string" || key.length > 100))
        throw Error("请求编号无效");
      result = live.create(channel, session.userId, key, range);
    } catch (error) {
      fail(409, "PLAYBACK_UNAVAILABLE", error.message);
    }
    db.prepare("INSERT OR IGNORE INTO viewer_auth VALUES(?,?)").run(
      result.viewerId,
      session.token,
    );
    audit(session.userId, "playback.create", result.sessionId);
    send(202, result);
    return true;
  }
  const control = p.match(
    /^\/api\/v1\/playback-sessions\/([a-zA-Z0-9-]+)\/control$/,
  );
  if (control && req.method === "POST") {
    const value = await body(req);
    try {
      const snapshot = live.snapshot(
        control[1],
        session.userId,
        value.viewerId,
      );
      if (value.action === "seek") {
        const duration =
          (Date.parse(snapshot.options?.end) -
            Date.parse(snapshot.options?.start)) /
          1000;
        if (
          !Number.isFinite(value.position) ||
          value.position < 0 ||
          value.position >= duration
        )
          throw Error("回放位置超出录像范围");
      }
      send(
        200,
        await live.control(control[1], session.userId, value.viewerId, value),
      );
    } catch (error) {
      fail(409, "PLAYBACK_CONTROL_FAILED", error.message);
    }
    return true;
  }
  if (p === "/api/v1/cascade/platforms") {
    admin();
    if (req.method === "GET") {
      send(200, { items: cascade.list() });
      return true;
    }
    if (req.method === "POST") {
      const value = await body(req);
      try {
        const item = cascade.save(value, session.userId);
        audit(session.userId, "cascade.create", item.id);
        send(201, item);
      } catch (error) {
        fail(400, "CASCADE_INVALID", error.message);
      }
      return true;
    }
  }
  const platform = p.match(
    /^\/api\/v1\/cascade\/platforms\/([a-zA-Z0-9-]+)(\/channels|\/register|\/unregister)?$/,
  );
  if (platform) {
    admin();
    const [, id, action] = platform;
    if (req.method === "DELETE" && !action) {
      try {
        await cascade.remove(id);
      } catch (error) {
        fail(409, "CASCADE_DELETE_FAILED", error.message);
      }
      audit(session.userId, "cascade.delete", id);
      send(204);
      return true;
    }
    if (req.method === "PUT" && !action) {
      try {
        send(200, cascade.save({ ...(await body(req)), id }, session.userId));
        audit(session.userId, "cascade.update", id);
      } catch (error) {
        fail(400, "CASCADE_INVALID", error.message);
      }
      return true;
    }
    if (req.method === "GET" && action === "/channels") {
      try {
        send(200, { items: cascade.channels(id) });
      } catch (error) {
        fail(404, "CASCADE_NOT_FOUND", error.message);
      }
      return true;
    }
    if (req.method === "PUT" && action === "/channels") {
      try {
        cascade.assign(id, (await body(req)).items);
        audit(session.userId, "cascade.channels", id);
        send(200, { items: cascade.channels(id) });
      } catch (error) {
        fail(400, "CASCADE_INVALID", error.message);
      }
      return true;
    }
    if (req.method === "POST" && action === "/register") {
      try {
        send(200, await cascade.register(id));
        audit(session.userId, "cascade.register", id);
      } catch (error) {
        fail(409, "CASCADE_REGISTER_FAILED", error.message);
      }
      return true;
    }
    if (req.method === "POST" && action === "/unregister") {
      try {
        await cascade.unregister(id);
        audit(session.userId, "cascade.unregister", id);
        send(204);
      } catch (error) {
        fail(409, "CASCADE_UNREGISTER_FAILED", error.message);
      }
      return true;
    }
  }
  return false;
}

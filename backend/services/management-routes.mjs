import { randomUUID } from "node:crypto";
export async function managementRoutes(ctx) {
  const {
      req,
      res,
      url,
      session,
      db,
      access,
      events,
      history,
      subscriptions,
      live,
      operations,
      body,
      send,
      fail,
      audit,
      config,
      notifyAuthorization = () => {},
    } = ctx,
    p = url.pathname,
    user = session.userId;
  const admin = (permission) => {
    if (permission ? !access.can(user, permission) : session.role !== "admin")
      fail(403, "FORBIDDEN", "当前角色没有此操作权限");
  };
  const revoke = async () => {
    access.sweep();
    notifyAuthorization();
    await live.revoke();
    await operations.revoke(access);
  };
  if (p === "/api/v1/subscriptions" && req.method === "GET") {
    try {
      send(200, subscriptions.list(user, url.searchParams));
    } catch (e) {
      fail(400, "SUBSCRIPTION_QUERY_INVALID", e.message);
    }
    return true;
  }
  const subscription = p.match(
    /^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/subscriptions\/(Alarm|MobilePosition)$/,
  );
  const guard = p.match(/^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/subscriptions\/Alarm\/guard$/);
  if (guard && req.method === "POST") {
    admin("subscriptions.manage");
    await body(req);
    let result;
    try { result = subscriptions.guard.start(user, guard[1]); }
    catch (e) { fail(400, "ALARM_GUARD_FAILED", e.message); }
    audit(user, "alarm.guard", guard[1]);
    send(202, result);
    return true;
  }
  if (subscription && req.method === "PUT") {
    admin("subscriptions.manage");
    if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(subscription[1]))
      fail(404, "DEVICE_NOT_FOUND", "设备不存在");
    const value = await body(req);
    let result;
    try {
      result = subscriptions.set(user, subscription[1], subscription[2], value);
    } catch (e) {
      fail(400, "SUBSCRIPTION_INVALID", e.message);
    }
    audit(
      user,
      value.enabled ? "subscription.enable" : "subscription.disable",
      result.id,
    );
    send(202, result);
    return true;
  }
  if (p === "/api/v1/map/config" && req.method === "GET") {
    send(200, {
      tileConfigured: !!config.map?.tileUrl,
      attribution: config.map?.attribution || "",
    });
    return true;
  }
  const trajectory = p.match(
    /^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/(positions|position-targets)$/,
  );
  if (trajectory && req.method === "GET") {
    if (
      !access.device(user, trajectory[1]) ||
      !db.prepare("SELECT 1 FROM devices WHERE id=?").get(trajectory[1])
    )
      fail(404, "DEVICE_NOT_FOUND", "设备不存在或无权访问");
    try {
      send(
        200,
        trajectory[2] === "position-targets"
          ? history.targets(trajectory[1])
          : history.query(user, trajectory[1], url.searchParams),
      );
    } catch (e) {
      fail(400, "TRAJECTORY_QUERY_INVALID", e.message);
    }
    return true;
  }
  if (p === "/api/v1/groups") {
    if (req.method === "GET") {
      send(200, { items: access.groups(user) });
      return true;
    }
    if (req.method === "POST") {
      admin();
      const v = await body(req);
      if (
        typeof v.name !== "string" ||
        !v.name.trim() ||
        v.name.length > 80 ||
        typeof (v.description ?? "") !== "string" ||
        (v.description || "").length > 300
      )
        fail(400, "GROUP_INVALID", "分组名称或说明无效");
      const id = randomUUID();
      try {
        db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
          id,
          v.name.trim(),
          v.description || "",
          new Date().toISOString(),
        );
      } catch {
        fail(409, "GROUP_EXISTS", "分组名称已存在");
      }
      audit(user, "group.create", id);
      send(201, { id });
      return true;
    }
  }
  const group = p.match(/^\/api\/v1\/groups\/([a-zA-Z0-9-]+)(\/devices)?$/);
  if (group) {
    admin();
    const id = group[1];
    if (!db.prepare("SELECT 1 FROM device_groups WHERE id=?").get(id))
      fail(404, "GROUP_NOT_FOUND", "分组不存在");
    if (req.method === "PUT" && group[2]) {
      const v = await body(req);
      if (
        !Array.isArray(v.deviceIds) ||
        !v.deviceIds.length ||
        v.deviceIds.length > 200 ||
        v.deviceIds.some((d) => typeof d !== "string")
      )
        fail(400, "INVALID_DEVICES", "每次选择1至200台设备");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const d of new Set(v.deviceIds)) {
          if (
            !db.prepare("UPDATE devices SET groupId=? WHERE id=?").run(id, d)
              .changes
          )
            fail(404, "DEVICE_NOT_FOUND", "设备不存在");
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      audit(user, "group.devices", id);
      await revoke();
      send(204);
      return true;
    }
    if (req.method === "PUT" && !group[2]) {
      const v = await body(req);
      if (
        typeof v.name !== "string" ||
        !v.name.trim() ||
        v.name.length > 80 ||
        typeof (v.description ?? "") !== "string" ||
        (v.description || "").length > 300
      )
        fail(400, "GROUP_INVALID", "分组名称或说明无效");
      try {
        db.prepare(
          "UPDATE device_groups SET name=?,description=? WHERE id=?",
        ).run(v.name.trim(), v.description || "", id);
      } catch {
        fail(409, "GROUP_EXISTS", "分组名称已存在");
      }
      audit(user, "group.update", id);
      notifyAuthorization();
      send(204);
      return true;
    }
    if (req.method === "DELETE" && !group[2]) {
      if (
        id === "default" ||
        db.prepare("SELECT 1 FROM devices WHERE groupId=?").get(id) ||
        db.prepare("SELECT 1 FROM user_groups WHERE groupId=?").get(id)
      )
        fail(409, "GROUP_IN_USE", "默认、包含设备或仍有授权的分组不可删除");
      db.prepare("DELETE FROM device_groups WHERE id=?").run(id);
      audit(user, "group.delete", id);
      send(204);
      return true;
    }
  }
  const grants = p.match(/^\/api\/v1\/users\/([a-zA-Z0-9-]+)\/groups$/);
  if (grants) {
    admin();
    const target = db.prepare("SELECT * FROM users WHERE id=?").get(grants[1]);
    if (!target) fail(404, "USER_NOT_FOUND", "用户不存在");
    if (req.method === "GET") {
      send(200, {
        groupIds: db
          .prepare("SELECT groupId FROM user_groups WHERE userId=?")
          .all(target.id)
          .map((g) => g.groupId),
        scopeMode: access.allDevices(target.id) ? "all" : "groups",
        version:
          db
            .prepare("SELECT version FROM user_authorizations WHERE userId=?")
            .get(target.id)?.version ?? 0,
      });
      return true;
    }
    if (req.method === "PUT") {
      if (target.role === "admin")
        fail(409, "ADMIN_GLOBAL", "管理员具有全局权限");
      const v = await body(req);
      if (
        !Array.isArray(v.groupIds) ||
        v.groupIds.length > 1000 ||
        v.groupIds.some(
          (id) =>
            typeof id !== "string" ||
            !db.prepare("SELECT 1 FROM device_groups WHERE id=?").get(id),
        )
      )
        fail(400, "INVALID_GROUPS", "授权分组无效");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          db.prepare("SELECT role FROM users WHERE id=?").get(target.id)
            ?.role === "admin"
        )
          fail(409, "ADMIN_GLOBAL", "管理员具有全局权限");
        if (
          v.version !== undefined &&
          (!Number.isSafeInteger(v.version) ||
            v.version !==
              db
                .prepare(
                  "SELECT version FROM user_authorizations WHERE userId=?",
                )
                .get(target.id)?.version)
        )
          fail(
            409,
            "AUTHORIZATION_CONFLICT",
            "账号授权已更新，请重新读取后再保存",
          );
        db.prepare("DELETE FROM user_groups WHERE userId=?").run(target.id);
        db.prepare(
          "UPDATE user_authorizations SET scopeMode='groups',version=version+1 WHERE userId=?",
        ).run(target.id);
        for (const id of new Set(v.groupIds))
          db.prepare("INSERT INTO user_groups VALUES(?,?)").run(target.id, id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      audit(user, "user.groups", target.id);
      await revoke();
      send(204);
      return true;
    }
  }
  if (p === "/api/v1/alarms" && req.method === "GET") {
    try {
      send(200, events.list(user, url.searchParams));
    } catch (e) {
      fail(400, "ALARM_QUERY_INVALID", e.message);
    }
    return true;
  }
  const alarm = p.match(/^\/api\/v1\/alarms\/([a-zA-Z0-9-]+)(\/actions|\/snapshot)?$/);
  if (alarm) {
    let item;
    try {
      item = events.get(alarm[1], user);
    } catch (e) {
      fail(404, "ALARM_NOT_FOUND", e.message);
    }
    if (req.method === "GET" && alarm[2] === "/snapshot") {
      const image = events.snapshots?.image(item.id);
      if (!image) fail(404, "ALARM_SNAPSHOT_UNAVAILABLE", "告警图片尚未就绪或已过期");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": image.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(image);
      return true;
    }
    if (req.method === "GET" && !alarm[2]) {
      send(200, item);
      return true;
    }
    if (req.method === "POST" && alarm[2] === "/actions") {
      admin("alarms.handle");
      const v = await body(req);
      try {
        item = events.action(item.id, session, v);
      } catch (e) {
        fail(409, "ALARM_CONFLICT", e.message);
      }
      audit(user, "alarm." + v.action, item.id);
      send(200, item);
      return true;
    }
  }
  const location = p.match(/^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/location$/);
  if (location) {
    admin("map.manage");
    const id = location[1];
    if (
      !access.device(user, id) ||
      !db.prepare("SELECT 1 FROM devices WHERE id=?").get(id)
    )
      fail(404, "DEVICE_NOT_FOUND", "设备不存在");
    if (req.method === "PUT") {
      try {
        send(200, events.position(id, await body(req)));
      } catch (e) {
        fail(e.status || 400, e.code || "LOCATION_INVALID", e.message);
      }
      audit(user, "device.location", id);
      return true;
    }
    if (req.method === "DELETE") {
      db.prepare("DELETE FROM device_locations WHERE deviceId=?").run(id);
      audit(user, "device.location.clear", id);
      send(204);
      return true;
    }
  }
  if (p === "/api/v1/map" && req.method === "GET") {
    const groupId = url.searchParams.get("groupId") || "";
    const items = db
      .prepare(
        `SELECT d.id,d.deviceId,d.name,d.status,d.groupId,g.name AS groupName,l.longitude,l.latitude,l.address,l.source,l.updatedAt,(SELECT count(*) FROM alarms a WHERE a.deviceId=d.id AND a.status<>'resolved') AS alarms FROM devices d JOIN device_groups g ON g.id=d.groupId LEFT JOIN device_locations l ON l.deviceId=d.id WHERE ${access.sql(user, "d.id")} AND (?='' OR d.groupId=?) ORDER BY d.name LIMIT 5000`,
      )
      .all(groupId, groupId);
    send(200, {
      items,
      tileConfigured: !!config.map?.tileUrl,
      attribution: config.map?.attribution || "",
      coordinateSystem: "WGS84",
      limit: 5000,
    });
    return true;
  }
  const tile = p.match(/^\/api\/v1\/map\/tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (tile && req.method === "GET") {
    if (!config.map?.tileUrl) fail(503, "MAP_NOT_CONFIGURED", "尚未配置底图");
    const [z, x, y] = tile.slice(1).map(Number);
    if (z > 19 || x >= 2 ** z || y >= 2 ** z)
      fail(400, "MAP_TILE_INVALID", "瓦片坐标无效");
    const target = config.map.tileUrl
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const controller = new AbortController(),
      stop = () => controller.abort();
    res.on("close", stop);
    const timer = setTimeout(stop, 7000);
    try {
      const upstream = await fetch(target, {
        redirect: "error",
        signal: controller.signal,
        headers: { "User-Agent": "Ls-Aegis/0.7.1" },
      });
      const type = upstream.headers.get("content-type")?.split(";")[0];
      if (
        !upstream.ok ||
        !["image/png", "image/jpeg", "image/webp"].includes(type)
      )
        throw Error();
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 2097152) throw Error();
        chunks.push(chunk);
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "private, max-age=604800",
      });
      res.end(Buffer.concat(chunks));
    } catch {
      if (!res.destroyed) fail(502, "MAP_TILE_UNAVAILABLE", "底图服务不可用");
    } finally {
      clearTimeout(timer);
      controller.abort();
      res.off("close", stop);
    }
    return true;
  }
  return false;
}

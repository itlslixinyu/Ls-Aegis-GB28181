import { randomUUID } from "node:crypto";
import {
  permissionCatalog,
  normalizePermissions,
} from "../lib/permission-catalog.mjs";
import { authorization } from "./authorization.mjs";
export async function roleRoutes({
  req,
  url,
  session,
  db,
  body,
  send,
  fail,
  audit,
  transaction,
  access,
  live,
  operations,
  notifyAuthorization = () => {},
}) {
  const p = url.pathname;
  if (!(
    /^\/api\/v1\/roles(?:\/|$)/.test(p) ||
    /^\/api\/v1\/users\/[^/]+\/authorization$/.test(p)
  ))
    return false;
  if (session.role !== "admin")
    fail(403, "FORBIDDEN", "仅系统管理员可配置角色和授权");
  const revoke = async (users) => {
    access.sweep();
    notifyAuthorization(users);
    await live.revoke();
    await Promise.all(users.map((id) => operations.stopUser(id)));
  };
  if (p === "/api/v1/roles" && req.method === "GET") {
    send(200, {
      catalog: permissionCatalog,
      items: db
        .prepare(
          `SELECT r.*,(SELECT COUNT(*) FROM user_authorizations a WHERE a.roleId=r.id) AS users FROM platform_roles r ORDER BY r.builtin DESC,r.createdAt,r.id`,
        )
        .all()
        .map((r) => ({
          ...r,
          permissions:
            r.id === "admin"
              ? permissionCatalog.map((p) => p.key)
              : JSON.parse(r.permissions),
        })),
    });
    return true;
  }
  const route = p.match(/^\/api\/v1\/roles\/([a-zA-Z0-9-]+)$/);
  if (
    (p === "/api/v1/roles" && req.method === "POST") ||
    (route && req.method === "PUT")
  ) {
    const v = await body(req),
      old = route
        ? db.prepare("SELECT * FROM platform_roles WHERE id=?").get(route[1])
        : null;
    if (route && !old) fail(404, "ROLE_NOT_FOUND", "角色不存在");
    if (old?.builtin) fail(409, "BUILTIN_ROLE", "内置角色不可修改");
    if (
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 60 ||
      typeof (v.description ?? "") !== "string" ||
      (v.description || "").length > 300 ||
      Object.keys(v).some(
        (k) => !["name", "description", "permissions", "version"].includes(k),
      )
    )
      fail(400, "INVALID_ROLE", "角色名称、说明或字段无效");
    const permissions = normalizePermissions(v.permissions),
      id = old?.id || randomUUID();
    if (old && (!Number.isSafeInteger(v.version) || v.version !== old.version))
      fail(409, "ROLE_CONFLICT", "角色已更新，请重新读取后再保存");
    transaction(() => {
      if (
        db
          .prepare("SELECT 1 FROM platform_roles WHERE name=? AND id<>?")
          .get(v.name.trim(), id)
      )
        fail(409, "ROLE_EXISTS", "角色名称已存在");
      if (old)
        db.prepare(
          "UPDATE platform_roles SET name=?,description=?,permissions=?,version=version+1 WHERE id=?",
        ).run(
          v.name.trim(),
          v.description || "",
          JSON.stringify(permissions),
          id,
        );
      else
        db.prepare(
          "INSERT INTO platform_roles(id,name,description,permissions,createdAt) VALUES(?,?,?,?,?)",
        ).run(
          id,
          v.name.trim(),
          v.description || "",
          JSON.stringify(permissions),
          new Date().toISOString(),
        );
      audit(session.userId, old ? "role.update" : "role.create", id);
    });
    const users = db
      .prepare("SELECT userId FROM user_authorizations WHERE roleId=?")
      .all(id)
      .map((u) => u.userId);
    await revoke(users);
    send(old ? 200 : 201, { id });
    return true;
  }
  if (route && req.method === "DELETE") {
    transaction(() => {
      const role = db
        .prepare("SELECT * FROM platform_roles WHERE id=?")
        .get(route[1]);
      if (!role) fail(404, "ROLE_NOT_FOUND", "角色不存在");
      if (role.builtin) fail(409, "BUILTIN_ROLE", "内置角色不可删除");
      if (
        db
          .prepare("SELECT 1 FROM user_authorizations WHERE roleId=?")
          .get(role.id)
      )
        fail(409, "ROLE_IN_USE", "角色仍被账号使用，请先调整账号角色");
      db.prepare("DELETE FROM platform_roles WHERE id=?").run(role.id);
      audit(session.userId, "role.delete", role.id);
    });
    send(204);
    return true;
  }
  const target = p.match(/^\/api\/v1\/users\/([a-zA-Z0-9-]+)\/authorization$/);
  if (target) {
    const user = db
      .prepare("SELECT id,role FROM users WHERE id=?")
      .get(target[1]);
    if (!user) fail(404, "USER_NOT_FOUND", "用户不存在");
    if (req.method === "GET") {
      send(200, {
        ...authorization(db, user.id),
        version: authorization(db, user.id).authorizationVersion,
        groupIds: db
          .prepare(
            "SELECT groupId FROM user_groups WHERE userId=? ORDER BY groupId",
          )
          .all(user.id)
          .map((g) => g.groupId),
      });
      return true;
    }
    if (req.method === "PUT") {
      const v = await body(req);
      if (
        Object.keys(v).some(
          (k) => !["roleId", "scopeMode", "groupIds", "version"].includes(k),
        ) ||
        typeof v.roleId !== "string" ||
        !["all", "groups"].includes(v.scopeMode) ||
        !Number.isSafeInteger(v.version) ||
        !Array.isArray(v.groupIds) ||
        v.groupIds.length > 1000 ||
        v.groupIds.some((id) => typeof id !== "string")
      )
        fail(400, "INVALID_AUTHORIZATION", "角色或设备范围参数无效");
      transaction(() => {
        const role = db
          .prepare("SELECT * FROM platform_roles WHERE id=?")
          .get(v.roleId);
        if (!role) fail(400, "INVALID_ROLE", "请选择有效角色");
        if (
          user.role === "admin" &&
          role.id !== "admin" &&
          db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get()
            .n <= 1
        )
          fail(409, "LAST_ADMIN", "必须保留至少一个系统管理员");
        if (user.id === session.userId)
          fail(
            409,
            "SELF_AUTHORIZATION",
            "不能修改当前登录账号的角色或数据范围",
          );
        const current = authorization(db, user.id);
        if (current.authorizationVersion !== v.version)
          fail(
            409,
            "AUTHORIZATION_CONFLICT",
            "账号授权已更新，请重新读取后再保存",
          );
        if (
          user.role === "admin" &&
          role.id !== "admin" &&
          (db
            .prepare("SELECT 1 FROM recording_plans WHERE ownerId=?")
            .get(user.id) ||
            db
              .prepare("SELECT 1 FROM cascade_platforms WHERE ownerId=?")
              .get(user.id) ||
            db
              .prepare(
                "SELECT 1 FROM recording_jobs WHERE ownerId=? AND status IN ('starting','recording','finalizing')",
              )
              .get(user.id))
        )
          fail(
            409,
            "USER_HAS_MANAGED_RESOURCES",
            "该管理员有关联录像或级联配置，请先处理后再调整角色",
          );
        for (const id of v.groupIds)
          if (!db.prepare("SELECT 1 FROM device_groups WHERE id=?").get(id))
            fail(400, "INVALID_GROUPS", "设备分组不存在，请重新读取");
        db.prepare("UPDATE users SET role=? WHERE id=?").run(
          role.id === "admin" ? "admin" : "viewer",
          user.id,
        );
        db.prepare(
          "UPDATE user_authorizations SET roleId=?,scopeMode=?,version=version+1 WHERE userId=?",
        ).run(role.id, role.id === "admin" ? "all" : v.scopeMode, user.id);
        db.prepare("DELETE FROM user_groups WHERE userId=?").run(user.id);
        for (const id of new Set(v.groupIds))
          db.prepare("INSERT INTO user_groups VALUES(?,?)").run(user.id, id);
        audit(session.userId, "user.authorization", user.id);
      });
      await revoke([user.id]);
      send(200, authorization(db, user.id));
      return true;
    }
  }
  return false;
}

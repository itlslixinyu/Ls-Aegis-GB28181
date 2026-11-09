import { permissionCatalog } from "../lib/permission-catalog.mjs";
export function authorization(db, userId) {
  const row = db
    .prepare(
      `SELECT u.role,a.roleId,a.scopeMode,a.version,r.name,r.permissions FROM users u
    LEFT JOIN user_authorizations a ON a.userId=u.id LEFT JOIN platform_roles r ON r.id=a.roleId WHERE u.id=?`,
    )
    .get(userId);
  if (!row)
    return {
      permissions: [],
      roleId: "",
      roleName: "",
      scopeMode: "groups",
      authorizationVersion: 0,
    };
  const admin = row.role === "admin";
  return {
    roleId: admin ? "admin" : row.roleId || "viewer",
    roleName: admin ? "系统管理员" : row.name || "只读用户",
    permissions: admin
      ? permissionCatalog.map((p) => p.key)
      : JSON.parse(row.permissions || "[]"),
    scopeMode: admin ? "all" : row.scopeMode || "groups",
    authorizationVersion: row.version || 0,
  };
}
export function allowed(db, userId, key) {
  return authorization(db, userId).permissions.includes(key);
}
export function routePermission(path, method, url) {
  const p = path.replace(/^\/api\/v1/, "");
  if (/^\/(me(?:\/.*)?|auth\/logout)$/.test(p)) return null;
  if (p.startsWith("/ai/settings")) return "ai.configure";
  if (p.startsWith("/ai/"))
    return method === "GET" || p === "/ai/search" ? "ai.view" : "ai.analyze";
  if (/^\/(users|roles)(\/|$)/.test(p)) return "users.manage";
  if (/^\/groups/.test(p))
    return method === "GET" ? "devices.view" : "groups.manage";
  if (p === "/live-sessions") return "live.preview";
  if (p.startsWith("/live-sessions/")) return null; // Ownership, stream type and current rights checked by LiveSessions.
  if (/^\/(record-queries|playback-sessions)(\/|$)/.test(p))
    return "recording.view";
  if (p.startsWith("/recording-task-groups")) return "recording.view";
  if (
    p.startsWith("/recording-plans") ||
    p.startsWith("/recording-plan-groups")
  )
    return "plans.manage";
  if (p.startsWith("/recording-jobs")) {
    if (/\/files\//.test(p))
      return url.searchParams.get("play") === "1"
        ? "recording.view"
        : "recording.download";
    return method === "GET" ? "recording.view" : "recording.download";
  }
  if (/^\/(channels\/[^/]+\/ptz|commands\/)/.test(p)) return "ptz.control";
  if (p === "/subscriptions" || /\/subscriptions\//.test(p))
    return method === "GET" ? "subscriptions.view" : "subscriptions.manage";
  if (p === "/alarms" || p.startsWith("/alarms/"))
    return method === "GET" ? "alarms.view" : "alarms.handle";
  if (/\/(positions|position-targets)$/.test(p)) return "tracks.view";
  if (/\/location$/.test(p)) return "map.manage";
  if (p === "/map" || p.startsWith("/map/")) return "map.view";
  if (p.startsWith("/cascade/")) return "cascade.manage";
  if (p === "/audit") return "audit.view";
  if (p === "/system/restart") return "system.restart";
  if (p.startsWith("/system/") || p.startsWith("/media-nodes"))
    return "system.configure";
  if (/^\/(devices|channels|tasks|overview)(\/|$)/.test(p))
    return method === "GET" ? "devices.view" : "devices.manage";
  return null;
}

import { allowed, authorization } from "./authorization.mjs";
export class Access {
  constructor(db) {
    this.db = db;
    this.transfers = new Set();
  }
  admin(userId) {
    return (
      this.db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='admin'")
        .get(userId) !== undefined
    );
  }
  can(userId, key) {
    return allowed(this.db, userId, key);
  }
  allDevices(userId) {
    return authorization(this.db, userId).scopeMode === "all";
  }
  canStream(userId, kind) {
    return this.can(
      userId,
      kind === "live"
        ? "live.preview"
        : kind === "download"
          ? "recording.download"
          : "recording.view",
    );
  }
  sql(userId, deviceId = "d.id") {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(deviceId))
      throw Error("权限查询字段无效");
    if (this.allDevices(userId)) return "1=1";
    const user = "'" + String(userId).replaceAll("'", "''") + "'";
    return `EXISTS(SELECT 1 FROM devices _scope JOIN user_groups _grant ON _grant.groupId=_scope.groupId WHERE _scope.id=${deviceId} AND _grant.userId=${user})`;
  }
  device(userId, id) {
    if (!this.admin(userId) && typeof id !== "string") return false;
    return (
      this.allDevices(userId) ||
      !!this.db
        .prepare(
          "SELECT 1 FROM devices d JOIN user_groups g ON g.groupId=d.groupId WHERE d.id=? AND g.userId=?",
        )
        .get(id, userId)
    );
  }
  channel(userId, id) {
    const c = this.db
      .prepare("SELECT deviceId FROM channels WHERE id=?")
      .get(id);
    return !!c && this.device(userId, c.deviceId);
  }
  requireDevice(userId, id) {
    if (!this.device(userId, id)) throw Error("无权访问此设备分组");
  }
  requireChannel(userId, id) {
    if (!this.channel(userId, id))
      throw Error("通道不存在或无权访问此设备分组");
  }
  groups(userId) {
    return this.db
      .prepare(
        `SELECT g.*,(SELECT count(*) FROM devices d WHERE d.groupId=g.id) AS devices FROM device_groups g ${this.allDevices(userId) ? "" : "WHERE EXISTS(SELECT 1 FROM user_groups u WHERE u.groupId=g.id AND u.userId=?)"} ORDER BY g.createdAt,g.id`,
      )
      .all(...(this.allDevices(userId) ? [] : [userId]));
  }
  track(userId, deviceId, controller, authToken, permission = null) {
    const row = { userId, deviceId, controller, authToken, permission };
    this.transfers.add(row);
    return () => this.transfers.delete(row);
  }
  endSession(token) {
    for (const row of this.transfers)
      if (row.authToken === token) row.controller.abort();
  }
  close() {
    for (const row of this.transfers) row.controller.abort();
    this.transfers.clear();
  }
  sweep() {
    for (const row of this.transfers)
      if (
        !this.device(row.userId, row.deviceId) ||
        (row.permission && !this.can(row.userId, row.permission))
      )
        row.controller.abort();
  }
}

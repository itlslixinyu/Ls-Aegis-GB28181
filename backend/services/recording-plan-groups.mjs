import { randomUUID, createHash } from "node:crypto";

const problem = (message, status = 400) =>
  Object.assign(Error(message), { status, code: "GROUP_PLAN_INVALID" });
const settings = (v) => ({
  name: v.name,
  days: v.days,
  startTime: v.startTime,
  endTime: v.endTime,
  enabled: !!v.enabled,
  retentionDays: v.retentionDays,
  segmentSeconds: v.segmentSeconds,
});

// Grouping is a management layer. The existing per-channel scheduler and job IDs
// remain authoritative, so one failed channel never stops its peers.
export class RecordingPlanGroups {
  constructor(recordings) {
    this.recordings = recordings;
    this.db = recordings.db;
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  list() {
    const plans = this.recordings.plans();
    const memberships = this.db
      .prepare("SELECT * FROM recording_plan_members")
      .all();
    const linked = new Set(memberships.map((m) => m.planId));
    const planById = new Map(plans.map((p) => [p.id, p]));
    const membersByGroup = new Map();
    for (const m of memberships) {
      if (!membersByGroup.has(m.groupPlanId))
        membersByGroup.set(m.groupPlanId, []);
      const child = planById.get(m.planId);
      if (child) membersByGroup.get(m.groupPlanId).push(child);
    }
    const groups = this.db
      .prepare(
        "SELECT p.*,g.name AS groupName FROM recording_plan_groups p LEFT JOIN device_groups g ON p.deviceGroupId=g.id ORDER BY p.createdAt DESC,p.id",
      )
      .all()
      .map((row) => {
        const children = membersByGroup.get(row.id) || [];
        return {
          ...JSON.parse(row.config),
          id: row.id,
          name: row.name,
          deviceGroupId: row.deviceGroupId,
          groupName: row.groupName || "原分组已移除",
          version: row.version,
          channelIds: children.map((p) => p.channelId),
          channelCount: children.length,
          enabled:
            children.length > 0 && children.every((p) => p.enabled) ? 1 : 0,
          legacy: false,
        };
      });
    // Legacy rows are shown as single-channel entries, never merged by name.
    for (const p of plans.filter((p) => !linked.has(p.id))) {
      const g = this.db
        .prepare(
          "SELECT d.groupId,g.name FROM channels c JOIN devices d ON d.id=c.deviceId JOIN device_groups g ON g.id=d.groupId WHERE c.id=?",
        )
        .get(p.channelId);
      groups.push({
        ...settings(p),
        enabled: p.enabled,
        id: p.id,
        deviceGroupId: g?.groupId || null,
        groupName: g?.name || "原通道已移除",
        version: 0,
        channelIds: [p.channelId],
        channelCount: 1,
        legacy: true,
      });
    }
    return groups;
  }
  get(id) {
    const row = this.list().find((p) => p.id === id);
    if (!row) throw problem("录像计划不存在", 404);
    return row;
  }
  children(id) {
    const p = this.get(id);
    return this.recordings
      .plans()
      .filter((c) =>
        p.legacy
          ? c.id === id
          : !!this.db
              .prepare(
                "SELECT 1 FROM recording_plan_members WHERE groupPlanId=? AND planId=?",
              )
              .get(id, c.id),
      );
  }
  details(id, userId) {
    const children = this.children(id);
    const jobs = this.recordings.daily(
      userId,
      true,
      children.map((c) => c.id),
    );
    return children.map((p) => ({
      ...p,
      latest: jobs.find((j) => j.channelId === p.channelId) || null,
    }));
  }
  save(value, userId, id, key) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.enabled !== "boolean"
    )
      throw problem("启用状态无效");
    if (
      typeof value.deviceGroupId !== "string" ||
      !this.db
        .prepare("SELECT 1 FROM device_groups WHERE id=?")
        .get(value.deviceGroupId)
    )
      throw problem("请选择有效设备分组");
    if (
      !Array.isArray(value.channelIds) ||
      !value.channelIds.length ||
      value.channelIds.length > 10000 ||
      new Set(value.channelIds).size !== value.channelIds.length ||
      value.channelIds.some((c) => typeof c !== "string" || c.length > 200)
    )
      throw problem("请选择分组内通道，最多10000路且不能重复");
    for (const channel of value.channelIds) {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM channels c JOIN devices d ON d.id=c.deviceId WHERE c.id=? AND d.groupId=?",
          )
          .get(channel, value.deviceGroupId)
      )
        throw problem("所选通道已移除或不属于此分组，请刷新后重选");
      this.recordings.access.requireChannel(userId, channel);
    }
    const config = settings(value);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          ...config,
          deviceGroupId: value.deviceGroupId,
          channelIds: [...value.channelIds].sort(),
        }),
      )
      .digest("hex");
    if (
      key !== undefined &&
      (typeof key !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(key))
    )
      throw problem("请求标识无效");
    return this.transaction(() => {
      if (!id && key) {
        const prior = this.db
          .prepare(
            "SELECT id,requestHash FROM recording_plan_groups WHERE ownerId=? AND requestKey=?",
          )
          .get(userId, key);
        if (prior) {
          if (prior.requestHash !== hash)
            throw problem("请求标识已用于其他内容", 409);
          return this.get(prior.id);
        }
      }
      const old = id ? this.get(id) : null;
      if (old && value.version !== old.version)
        throw problem("计划已被更新，请刷新后重试", 409);
      const children = old ? this.children(id) : [];
      if (
        children.some((p) =>
          this.db
            .prepare(
              "SELECT 1 FROM recording_jobs WHERE planId=? AND status IN ('starting','recording','finalizing')",
            )
            .get(p.id),
        )
      )
        throw problem("计划仍有执行任务，请先停用并等待任务结束", 409);
      const groupId = id || randomUUID();
      if (!old || old.legacy) {
        this.db
          .prepare(
            "INSERT INTO recording_plan_groups(id,deviceGroupId,ownerId,name,config,version,requestKey,requestHash,createdAt) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            groupId,
            value.deviceGroupId,
            userId,
            config.name || "",
            JSON.stringify(config),
            old ? 1 : 0,
            key || null,
            hash,
            new Date(this.recordings.now()).toISOString(),
          );
      } else {
        this.db
          .prepare(
            "UPDATE recording_plan_groups SET deviceGroupId=?,name=?,config=?,version=version+1 WHERE id=?",
          )
          .run(
            value.deviceGroupId,
            config.name || "",
            JSON.stringify(config),
            groupId,
          );
      }
      // Retain child IDs for selected channels so their execution history stays linked.
      for (const child of children.filter(
        (c) => !value.channelIds.includes(c.channelId),
      ))
        this.recordings.removePlan(child.id);
      for (const channelId of value.channelIds) {
        const child = children.find((c) => c.channelId === channelId);
        const saved = this.recordings.savePlan(
          { ...config, channelId },
          userId,
          child?.id,
        );
        this.db
          .prepare("INSERT OR IGNORE INTO recording_plan_members VALUES(?,?)")
          .run(groupId, saved.id);
      }
      return this.get(groupId);
    });
  }
  enable(id, enabled, version) {
    if (typeof enabled !== "boolean") throw problem("启用状态无效");
    return this.transaction(() => {
      const p = this.get(id);
      if (version !== p.version)
        throw problem("计划已被更新，请刷新后重试", 409);
      for (const child of this.children(id))
        this.recordings.enablePlan(child.id, enabled);
      if (!p.legacy)
        this.db
          .prepare(
            "UPDATE recording_plan_groups SET config=?,version=version+1 WHERE id=?",
          )
          .run(JSON.stringify({ ...settings(p), enabled }), id);
      return this.get(id);
    });
  }
  remove(id, version) {
    return this.transaction(() => {
      const p = this.get(id);
      if (version !== p.version)
        throw problem("计划已被更新，请刷新后重试", 409);
      for (const child of this.children(id))
        this.recordings.removePlan(child.id);
      if (!p.legacy)
        this.db.prepare("DELETE FROM recording_plan_groups WHERE id=?").run(id);
    });
  }
}

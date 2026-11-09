const invalid = (message) =>
  Object.assign(Error(message), {
    status: 400,
    code: "INVALID_RECORDING_QUERY",
  });
export class RecordingTaskGroups {
  constructor(recordings) {
    this.recordings = recordings;
    this.db = recordings.db;
    this.access = recordings.access;
  }
  scope(userId, includeDeleted = false) {
    const deleted = includeDeleted && this.access.admin(userId);
    return `WITH ids AS (
      SELECT channelId FROM recording_plans UNION SELECT channelId FROM recording_jobs WHERE kind='scheduled'
    ), scoped AS (
      SELECT ids.channelId,c.name AS channelName,c.channelCode,d.name AS deviceName,
      COALESCE(d.groupId,'__deleted__') AS groupId,COALESCE(g.name,'已删除通道历史') AS groupName
      FROM ids LEFT JOIN channels c ON c.id=ids.channelId LEFT JOIN devices d ON d.id=c.deviceId
      LEFT JOIN device_groups g ON g.id=d.groupId
      WHERE (c.id IS NOT NULL ${deleted ? "OR c.id IS NULL" : ""}) AND ${this.access.sql(userId, "d.id")}
    )`;
  }
  list(userId, { page = 1, pageSize = 20, includeDeleted = false } = {}) {
    this.pagination(page, pageSize);
    const cte =
      this.scope(userId, includeDeleted) +
      `, ranked AS (
      SELECT j.channelId,j.status,j.createdAt,ROW_NUMBER() OVER(PARTITION BY j.channelId ORDER BY CASE WHEN j.status IN ('starting','recording','finalizing') THEN 0 ELSE 1 END,j.createdAt DESC,j.rowid DESC) AS rn
      FROM recording_jobs j JOIN scoped s ON s.channelId=j.channelId WHERE j.kind='scheduled'
    ), files AS (
      SELECT j.channelId,count(f.id) AS files FROM recording_jobs j JOIN scoped s ON s.channelId=j.channelId
      JOIN recording_files f ON f.jobId=j.id WHERE j.kind='scheduled' GROUP BY j.channelId
    ), summary AS (
      SELECT s.groupId AS id,s.groupName AS name,count(*) AS channels,
      sum(CASE WHEN r.status='recording' THEN 1 ELSE 0 END) AS recording,
      sum(CASE WHEN r.status IN ('starting','finalizing') THEN 1 ELSE 0 END) AS processing,
      sum(CASE WHEN r.status IN ('failed','interrupted') THEN 1 ELSE 0 END) AS errors,
      sum(CASE WHEN r.status IS NULL THEN 1 ELSE 0 END) AS waiting,
      sum(COALESCE(f.files,0)) AS files
      FROM scoped s LEFT JOIN ranked r ON r.channelId=s.channelId AND r.rn=1
      LEFT JOIN files f ON f.channelId=s.channelId GROUP BY s.groupId,s.groupName
    )`;
    const items = this.db
      .prepare(
        cte +
          " SELECT * FROM summary ORDER BY recording DESC,errors DESC,name,id LIMIT ? OFFSET ?",
      )
      .all(pageSize, (page - 1) * pageSize);
    const stats = this.db
      .prepare(
        cte +
          " SELECT count(*) AS groups,COALESCE(sum(channels),0) AS channels,COALESCE(sum(recording),0) AS recording,COALESCE(sum(errors),0) AS errors,COALESCE(sum(files),0) AS files FROM summary",
      )
      .get();
    return { items, total: stats.groups, stats, page, pageSize };
  }
  pagination(page, pageSize) {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isSafeInteger((page - 1) * pageSize)
    )
      throw invalid("分页参数无效");
  }
  channels(
    userId,
    id,
    { date, page = 1, pageSize = 20, q = "", includeDeleted = false } = {},
  ) {
    this.pagination(page, pageSize);
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    )
      throw invalid("请选择有效的执行日期");
    if (typeof q !== "string" || q.length > 100)
      throw invalid("搜索内容不能超过100个字符");
    const cte = this.scope(userId, includeDeleted);
    const group = this.db
      .prepare(
        cte + " SELECT groupName AS name FROM scoped WHERE groupId=? LIMIT 1",
      )
      .get(id);
    if (!group)
      throw Object.assign(Error("分组不存在或无权访问"), {
        status: 404,
        code: "RECORDING_GROUP_NOT_FOUND",
      });
    const where =
      " WHERE groupId=? AND (instr(lower(COALESCE(channelName,'')),lower(?))>0 OR instr(COALESCE(channelCode,''),?)>0 OR instr(lower(COALESCE(deviceName,'')),lower(?))>0)";
    const args = [id, q.trim(), q.trim(), q.trim()];
    const rows = this.db
      .prepare(
        cte +
          " SELECT * FROM scoped" +
          where +
          " ORDER BY deviceName,channelCode,channelId LIMIT ? OFFSET ?",
      )
      .all(...args, pageSize, (page - 1) * pageSize);
    const total = this.db
      .prepare(cte + " SELECT count(*) AS n FROM scoped" + where)
      .get(...args).n;
    let jobs = [];
    if (rows.length) {
      const data = this.db
        .prepare(
          `SELECT j.*,j.rowid AS sequence,c.name AS channelName,p.name AS planName,
      date(COALESCE(j.start,j.createdAt),'+8 hours') AS executionDate
      FROM recording_jobs j LEFT JOIN channels c ON c.id=j.channelId LEFT JOIN recording_plans p ON p.id=j.planId
      WHERE j.kind='scheduled' AND j.channelId IN (${rows.map(() => "?").join(",")})
      AND date(COALESCE(j.start,j.createdAt),'+8 hours')=? ORDER BY j.createdAt,j.rowid`,
        )
        .all(...rows.map((r) => r.channelId), date);
      jobs = this.recordings.aggregateDays(data);
    }
    return {
      id,
      name: group.name,
      date,
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        ...row,
        job: jobs.find((j) => j.channelId === row.channelId) || null,
      })),
    };
  }
}

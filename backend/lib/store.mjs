import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { viewerPermissions } from "./permission-catalog.mjs";
export const hashPassword = (
  password,
  salt = randomBytes(16).toString("hex"),
) => `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
export function checkPassword(password, hash) {
  if (typeof password !== "string" || typeof hash !== "string") return false;
  const [salt, key] = hash.split(":");
  if (
    !salt ||
    !/^[a-f0-9]{128}$/i.test(key || "") ||
    hash.split(":").length !== 2 ||
    salt.length > 128
  )
    return false;
  return timingSafeEqual(
    Buffer.from(key, "hex"),
    scryptSync(password, salt, 64),
  );
}
export function openStore(path, legacy) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')));
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, deviceId TEXT UNIQUE NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unregistered', channels INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, userId TEXT, action TEXT NOT NULL, resourceId TEXT, createdAt TEXT NOT NULL);
    INSERT OR IGNORE INTO migrations VALUES(1);`);
  const audit = (userId, action, resourceId = null) =>
    db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?)")
      .run(randomUUID(), userId, action, resourceId, new Date().toISOString());
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=2").get())
    transaction(() => {
      if (legacy && existsSync(legacy)) {
        const rows = JSON.parse(
          readFileSync(legacy, "utf8").replace(/^\uFEFF/, ""),
        );
        if (!Array.isArray(rows)) throw Error("旧设备文件格式不正确");
        for (const row of rows) {
          if (
            !/^\d{20}$/.test(row.deviceId) ||
            typeof row.name !== "string" ||
            !row.name.trim()
          )
            throw Error("旧设备档案包含无效数据，请修正后重新启动");
          db.prepare(
            "INSERT INTO devices(id,deviceId,name,createdAt) VALUES(?,?,?,?)",
          ).run(
            randomUUID(),
            row.deviceId,
            row.name,
            row.createdAt || new Date().toISOString(),
          );
        }
      }
      db.exec("INSERT INTO migrations VALUES(2)");
    });
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=3").get())
    transaction(() => {
      db.exec(`ALTER TABLE devices ADD COLUMN sipHa1 TEXT;
      ALTER TABLE devices ADD COLUMN remoteAddress TEXT;
      ALTER TABLE devices ADD COLUMN remotePort INTEGER;
      ALTER TABLE devices ADD COLUMN registeredUntil INTEGER;
      ALTER TABLE devices ADD COLUMN lastHeartbeat INTEGER;
      INSERT INTO migrations VALUES(3);`);
    });
  db.exec(`CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, channelCode TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(deviceId,channelCode));
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, error TEXT);`);
  db.prepare(
    "UPDATE tasks SET status='failed',error='服务重启，任务已中断' WHERE status='running'",
  ).run();
  db.exec(`CREATE TABLE IF NOT EXISTS live_sessions(id TEXT PRIMARY KEY, channelId TEXT NOT NULL,deviceId TEXT NOT NULL,streamId TEXT UNIQUE NOT NULL,state TEXT NOT NULL,error TEXT,dialog TEXT,released INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS viewers(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES live_sessions(id),userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS viewer_auth(viewerId TEXT PRIMARY KEY REFERENCES viewers(id) ON DELETE CASCADE,authToken TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_requests(userId TEXT NOT NULL,requestKey TEXT NOT NULL,channelId TEXT NOT NULL,sessionId TEXT NOT NULL,viewerId TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(userId,requestKey));
    CREATE INDEX IF NOT EXISTS idx_viewers_session ON viewers(sessionId);
    CREATE INDEX IF NOT EXISTS idx_live_channel ON live_sessions(channelId,state);`);
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=4").get())
    transaction(() => {
      db.exec(
        `ALTER TABLE live_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'live';ALTER TABLE live_sessions ADD COLUMN options TEXT;INSERT INTO migrations VALUES(4);`,
      );
    });
  db.exec(`CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,userId TEXT NOT NULL,channelId TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,error TEXT,createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS record_queries(id TEXT PRIMARY KEY,userId TEXT NOT NULL,channelId TEXT NOT NULL,status TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,error TEXT,createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS record_items(id TEXT PRIMARY KEY,queryId TEXT NOT NULL REFERENCES record_queries(id) ON DELETE CASCADE,channelId TEXT NOT NULL,name TEXT NOT NULL,filePath TEXT,start TEXT NOT NULL,end TEXT NOT NULL,type TEXT NOT NULL);`);
  db.prepare(
    "UPDATE record_queries SET status='failed',error='服务重启，查询已中断' WHERE status='running'",
  ).run();
  db.prepare(
    "UPDATE commands SET status='failed',error='服务重启，命令结果未知' WHERE status='pending'",
  ).run();
  db.exec(`CREATE TABLE IF NOT EXISTS cascade_platforms(id TEXT PRIMARY KEY,name TEXT NOT NULL,serverId TEXT NOT NULL,domain TEXT NOT NULL,localId TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,mediaHost TEXT NOT NULL,expires INTEGER NOT NULL,heartbeat INTEGER NOT NULL,ha1 TEXT NOT NULL,ownerId TEXT NOT NULL REFERENCES users(id),enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'offline',registeredUntil INTEGER NOT NULL DEFAULT 0,nextRegister INTEGER NOT NULL DEFAULT 0,nextHeartbeat INTEGER NOT NULL DEFAULT 0,lastError TEXT,UNIQUE(host,port));
  CREATE TABLE IF NOT EXISTS cascade_channels(platformId TEXT NOT NULL REFERENCES cascade_platforms(id) ON DELETE CASCADE,channelId TEXT NOT NULL,alias TEXT NOT NULL,PRIMARY KEY(platformId,channelId),UNIQUE(platformId,alias));
  CREATE TABLE IF NOT EXISTS cascade_calls(id TEXT PRIMARY KEY,platformId TEXT NOT NULL REFERENCES cascade_platforms(id) ON DELETE CASCADE,callId TEXT NOT NULL,state TEXT NOT NULL,ssrc TEXT NOT NULL,sessionId TEXT,viewerId TEXT,streamId TEXT,error TEXT,released INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL);`);
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=5").get())
    transaction(() => {
      db.exec(
        "ALTER TABLE cascade_calls ADD COLUMN dialog TEXT;INSERT INTO migrations VALUES(5);",
      );
    });
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=6").get())
    transaction(() =>
      db.exec(
        `ALTER TABLE devices ADD COLUMN sipTransport TEXT NOT NULL DEFAULT 'UDP';ALTER TABLE devices ADD COLUMN mediaTransport TEXT NOT NULL DEFAULT 'UDP';ALTER TABLE cascade_platforms ADD COLUMN sipTransport TEXT NOT NULL DEFAULT 'UDP';INSERT INTO migrations VALUES(6);`,
      ),
    );
  db.exec(`CREATE TABLE IF NOT EXISTS recording_plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,channelId TEXT NOT NULL,ownerId TEXT NOT NULL REFERENCES users(id),days TEXT NOT NULL,startTime TEXT NOT NULL,endTime TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,retentionDays INTEGER NOT NULL DEFAULT 7,segmentSeconds INTEGER NOT NULL DEFAULT 900,createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS recording_jobs(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id),channelId TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,planId TEXT REFERENCES recording_plans(id) ON DELETE SET NULL,occurrence TEXT,attempt INTEGER NOT NULL DEFAULT 1,start TEXT,end TEXT,deadline INTEGER NOT NULL,speed INTEGER NOT NULL DEFAULT 1,segmentSeconds INTEGER NOT NULL DEFAULT 900,retentionDays INTEGER NOT NULL DEFAULT 7,sessionId TEXT,viewerId TEXT,streamId TEXT,error TEXT,createdAt TEXT NOT NULL,publishSeen INTEGER NOT NULL DEFAULT 0,finishedAt TEXT,resultStatus TEXT,finalizeUntil INTEGER,UNIQUE(occurrence,attempt));
  CREATE TABLE IF NOT EXISTS recording_files(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES recording_jobs(id) ON DELETE CASCADE,date TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(jobId,date,name));INSERT OR IGNORE INTO migrations VALUES(7);`);
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=8").get())
    transaction(() =>
      db.exec(`
    CREATE TABLE device_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',createdAt TEXT NOT NULL);
    INSERT INTO device_groups VALUES('default','未分组','升级前设备的默认归属',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    ALTER TABLE devices ADD COLUMN groupId TEXT NOT NULL DEFAULT 'default';
    CREATE TRIGGER device_group_insert BEFORE INSERT ON devices WHEN NOT EXISTS(SELECT 1 FROM device_groups WHERE id=NEW.groupId) BEGIN SELECT RAISE(ABORT,'Invalid device group');END;
    CREATE TRIGGER device_group_update BEFORE UPDATE OF groupId ON devices WHEN NOT EXISTS(SELECT 1 FROM device_groups WHERE id=NEW.groupId) BEGIN SELECT RAISE(ABORT,'Invalid device group');END;
    CREATE TRIGGER device_group_delete BEFORE DELETE ON device_groups WHEN EXISTS(SELECT 1 FROM devices WHERE groupId=OLD.id) BEGIN SELECT RAISE(ABORT,'Device group in use');END;
    CREATE TABLE user_groups(userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,groupId TEXT NOT NULL REFERENCES device_groups(id),PRIMARY KEY(userId,groupId));
    INSERT INTO user_groups SELECT id,'default' FROM users WHERE role='viewer';
    CREATE INDEX idx_devices_group ON devices(groupId);
    CREATE TABLE device_locations(deviceId TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,longitude REAL NOT NULL,latitude REAL NOT NULL,address TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE alarms(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL,deviceName TEXT NOT NULL,targetCode TEXT NOT NULL,channelId TEXT,priority INTEGER NOT NULL,method TEXT NOT NULL,type TEXT NOT NULL,description TEXT NOT NULL,occurredAt TEXT NOT NULL,receivedAt TEXT NOT NULL,lastReceivedAt TEXT NOT NULL,repeatCount INTEGER NOT NULL DEFAULT 1,fingerprint TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'new',version INTEGER NOT NULL DEFAULT 1,longitude REAL,latitude REAL);
    CREATE TABLE alarm_actions(id TEXT PRIMARY KEY,alarmId TEXT NOT NULL REFERENCES alarms(id),userId TEXT NOT NULL,username TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE INDEX idx_alarms_device_time ON alarms(deviceId,occurredAt);CREATE INDEX idx_alarms_status ON alarms(status,occurredAt);
    INSERT INTO migrations VALUES(8);`),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=9").get())
    transaction(() =>
      db.exec(`
      CREATE TABLE device_subscriptions(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('Alarm','MobilePosition')),enabled INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL DEFAULT 3600,interval INTEGER NOT NULL DEFAULT 5,status TEXT NOT NULL DEFAULT 'disabled',error TEXT,acceptedAt TEXT,expiresAt INTEGER,lastNotifyAt TEXT,nextAttempt INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,updatedAt TEXT NOT NULL,UNIQUE(deviceId,kind));
      CREATE TABLE position_history(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,targetCode TEXT NOT NULL,longitude REAL NOT NULL,latitude REAL NOT NULL,occurredAt TEXT NOT NULL,receivedAt TEXT NOT NULL,UNIQUE(deviceId,targetCode,occurredAt,longitude,latitude));
      CREATE INDEX idx_position_target_time ON position_history(deviceId,targetCode,occurredAt,id);
      CREATE INDEX idx_position_received ON position_history(occurredAt);
      INSERT INTO migrations VALUES(9);
    `),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=10").get())
    transaction(() =>
      db.exec(
        `CREATE TABLE sip_registrations(deviceId TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,registrar TEXT NOT NULL);INSERT INTO migrations VALUES(10);`,
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=11").get())
    transaction(() =>
      db.exec(`
      CREATE TABLE user_profiles(
        userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        displayName TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
        jobTitle TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '',
        createdAt TEXT, lastLoginAt TEXT, updatedAt TEXT,
        version INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO user_profiles(userId,createdAt,lastLoginAt)
      SELECT u.id,
        (SELECT MIN(a.createdAt) FROM audit a WHERE a.resourceId=u.id AND a.action IN ('user.create','system.setup')),
        (SELECT MAX(a.createdAt) FROM audit a WHERE a.userId=u.id AND a.action='auth.login')
      FROM users u;
      CREATE TRIGGER user_profile_insert AFTER INSERT ON users BEGIN
        INSERT INTO user_profiles(userId,createdAt)
        VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      INSERT INTO migrations VALUES(11);
    `),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=12").get())
    transaction(() => {
      db.exec(`CREATE TABLE platform_roles(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',permissions TEXT NOT NULL,builtin INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL);
      CREATE TABLE user_authorizations(userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,roleId TEXT NOT NULL REFERENCES platform_roles(id),scopeMode TEXT NOT NULL DEFAULT 'groups' CHECK(scopeMode IN ('all','groups')),version INTEGER NOT NULL DEFAULT 0);`);
      const insert = db.prepare(
          "INSERT INTO platform_roles(id,name,description,permissions,builtin,createdAt) VALUES(?,?,?,?,1,?)",
        ),
        now = new Date().toISOString();
      insert.run(
        "admin",
        "系统管理员",
        "平台管理及全部设备权限，内置角色不可修改",
        "[]",
        now,
      );
      insert.run(
        "viewer",
        "只读用户",
        "兼容原只读账号的查看、预览、回放与下载权限",
        JSON.stringify(viewerPermissions),
        now,
      );
      db.exec(`INSERT INTO user_authorizations(userId,roleId,scopeMode) SELECT id,role,CASE WHEN role='admin' THEN 'all' ELSE 'groups' END FROM users;
      CREATE TRIGGER user_authorization_insert AFTER INSERT ON users BEGIN
        INSERT INTO user_authorizations(userId,roleId,scopeMode) VALUES(NEW.id,NEW.role,CASE WHEN NEW.role='admin' THEN 'all' ELSE 'groups' END);
      END; INSERT INTO migrations VALUES(12);`);
    });
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=13").get())
    transaction(() => {
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/013-recording-plan-groups.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=14").get())
    transaction(() =>
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/014-ai-analysis.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=15").get())
    transaction(() =>
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/015-ai-history.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=16").get())
    transaction(() =>
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/016-ai-local-cache.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=17").get())
    transaction(() =>
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/017-ai-motion-query-cache.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=18").get())
    transaction(() =>
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/018-ai-analysis-samples.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=19").get())
    transaction(() =>
      db.exec(
        readFileSync(
          new URL(
            "../../scripts/migrations/019-ai-detection-cache.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=20").get())
    transaction(() => db.exec(readFileSync(new URL("../../scripts/migrations/020-alarm-snapshots.sql", import.meta.url), "utf8")));
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=21").get())
    transaction(() => db.exec(readFileSync(new URL("../../scripts/migrations/021-alarm-qwen-analysis.sql", import.meta.url), "utf8")));
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=22").get())
    transaction(() => db.exec(readFileSync(new URL("../../scripts/migrations/022-retire-detection-cache.sql", import.meta.url), "utf8")));
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=23").get())
    transaction(() => db.exec(readFileSync(new URL("../../scripts/migrations/023-ai-local-index.sql", import.meta.url), "utf8")));
  return { db, audit, transaction };
}

import { PositionHistory } from "../backend/services/position-history.mjs";
import { Access } from "../backend/services/access.mjs";
import { SecurityEvents } from "../backend/services/security-events.mjs";
// Disposable UI verification server. Never used by npm start.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, hashPassword } from "../backend/lib/store.mjs";
import { createServer } from "../backend/server.mjs";
const database = join(mkdtempSync(join(tmpdir(), "vms-ui-")), "test.db");
const { db } = openStore(database);
db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
  "qa",
  "qa-admin",
  hashPassword("qa-only-password-123"),
  "admin",
);
for (const [id, code, name] of [
  ["qa-d1", "34020000001320000001", "[测试] 政务中心视频接入设备"],
  ["qa-d2", "34020000001320000002", "[测试] 园区北门视频接入设备"],
])
  db.prepare(
    "INSERT INTO devices(id,deviceId,name,createdAt) VALUES(?,?,?,?)",
  ).run(id, code, name, new Date().toISOString());
db.prepare("INSERT INTO channels VALUES(?,?,?,?,?)").run(
  "qa-channel",
  "qa-d1",
  "34020000001310000001",
  "[测试] 大厅摄像机",
  "offline",
);
db.prepare("UPDATE devices SET channels=1 WHERE id=?").run("qa-d1");
db.prepare(
  "INSERT INTO cascade_platforms(id,name,serverId,domain,localId,host,port,mediaHost,expires,heartbeat,ha1,ownerId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "qa-platform",
  "[测试] 省级视频汇聚平台",
  "44010000002000000001",
  "4401000000",
  "44010000002000000002",
  "127.0.0.1",
  15070,
  "127.0.0.1",
  3600,
  60,
  "test-fixture-not-a-real-credential",
  "qa",
);
db.prepare(
  "INSERT INTO recording_plans(id,name,channelId,ownerId,days,startTime,endTime,enabled,retentionDays,segmentSeconds,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "qa-plan",
  "[测试] 政务大厅工作日录像",
  "qa-channel",
  "qa",
  "[1,2,3,4,5]",
  "09:00",
  "18:00",
  0,
  7,
  900,
  new Date().toISOString(),
);
db.prepare(
  "INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,error,createdAt) VALUES(?,?,?,?,?,?,?,?)",
).run(
  "qa-job",
  "qa",
  "qa-channel",
  "download",
  "failed",
  Date.now(),
  "[测试] 设备离线，未生成录像文件",
  new Date().toISOString(),
);
db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
  "qa-reader",
  "qa-reader",
  hashPassword("qa-only-password-123"),
  "viewer",
);
for (const [id, name] of [
  ["qa-office", "[测试] 政务办公区"],
  ["qa-north", "[测试] 北门区域"],
])
  db.prepare("INSERT INTO device_groups VALUES(?,?,?,?)").run(
    id,
    name,
    "隔离测试分组",
    new Date().toISOString(),
  );
db.prepare("UPDATE devices SET groupId=? WHERE id=?").run("qa-office", "qa-d1");
db.prepare("UPDATE devices SET groupId=? WHERE id=?").run("qa-north", "qa-d2");
db.prepare("INSERT INTO user_groups VALUES(?,?)").run("qa-reader", "qa-office");
const sampleEvents = new SecurityEvents({
  db,
  access: new Access(db),
  sip: { state: "disabled" },
});
for (const [id, lon, lat, description] of [
  ["qa-d1", 116.4, 39.9, "[测试] 视频遮挡检测"],
  ["qa-d2", 116.405, 39.902, "[测试] 设备防拆检测"],
]) {
  const device = db.prepare("SELECT * FROM devices WHERE id=?").get(id);
  sampleEvents.position(id, {
    longitude: lon,
    latitude: lat,
    address: "[测试] 示例坐标，非真实部署",
  });
  sampleEvents.handle(device, {
    Notify: {
      CmdType: "Alarm",
      SN: "1",
      DeviceID: device.deviceId,
      AlarmPriority: "2",
      AlarmMethod: "5",
      AlarmTime: new Date().toISOString(),
      AlarmDescription: description,
    },
  });
}
const sampleHistory = new PositionHistory({ db, access: new Access(db) });
const traceNow = Date.now();
const traceCount = Math.min(
  2001,
  Math.max(
    18,
    Number.parseInt(process.env.UI_TEST_TRACE_COUNT || "18", 10) || 18,
  ),
);
const realNow = Date.now;
try {
  for (let i = 0; i < traceCount; i++) {
    // Replay one fictional sample per minute before HTTP startup, preserving
    // production ingestion limits. Restore the process clock even on failure.
    const sampledAt = traceNow - (traceCount + 2 - i) * 60000;
    Date.now = () => sampledAt;
    sampleHistory.record(
      "qa-d1",
      "34020000001320000001",
      {
        longitude: 116.39 + i * 0.001,
        latitude: 39.9 + Math.sin(i / 3) * 0.002,
      },
      new Date(sampledAt).toISOString(),
    );
  }
} finally {
  Date.now = realNow;
}
for (const [deviceId, kind] of [
  ["qa-d1", "Alarm"],
  ["qa-d1", "MobilePosition"],
  ["qa-d2", "MobilePosition"],
])
  db.prepare(
    "INSERT INTO device_subscriptions(id,deviceId,kind,enabled,expires,interval,status,updatedAt) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    "qa-sub-" + deviceId + "-" + kind,
    deviceId,
    kind,
    0,
    3600,
    5,
    "disabled",
    new Date().toISOString(),
  );
db.close();
const app = createServer({ database, legacy: null });
if (process.env.UI_TEST_FAIL_SHARES === "1" || process.env.UI_TEST_FAULT_FILE) {
  const application = app.listeners("request")[0];
  app.removeListener("request", application);
  app.on("request", (req, res) => {
    // Local disposable fixture only: errors can be enabled and cleared without
    // modifying production routes or overriding browser networking.
    let fault;
    if (process.env.UI_TEST_FAULT_FILE) {
      try {
        fault = JSON.parse(
          readFileSync(process.env.UI_TEST_FAULT_FILE, "utf8"),
        )[req.method + " " + req.url.split("?")[0]];
      } catch {}
    }
    if (fault) {
      // Delay a real authenticated GET response to test navigation races.
      if (fault.passThrough === true && req.method === "GET") {
        const timer = setTimeout(
          () => application.call(app, req, res),
          Math.min(10000, Math.max(0, Number(fault.delayMs) || 0)),
        );
        res.once("close", () => clearTimeout(timer));
        return;
      }
      req.resume();
      const reply = () => {
        res.writeHead(
          [400, 401, 403, 503].includes(fault.status) ? fault.status : 503,
          { "Content-Type": "application/json; charset=utf-8" },
        );
        res.end(
          JSON.stringify({
            error: {
              code: fault.code || "TEST_UNAVAILABLE",
              message: fault.message || "[测试] 请求暂时失败",
            },
            requestId: "qa-workflow-failure",
          }),
        );
      };
      if (fault.delayMs)
        setTimeout(
          reply,
          Math.min(10000, Math.max(0, Number(fault.delayMs) || 0)),
        );
      else reply();
      return;
    }
    if (
      process.env.UI_TEST_FAIL_SHARES === "1" &&
      req.method === "GET" &&
      /^\/api\/v1\/cascade\/platforms\/[^/]+\/channels$/.test(req.url)
    ) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: {
            code: "TEST_UNAVAILABLE",
            message: "[测试] 共享配置读取失败",
          },
          requestId: "qa-failure",
        }),
      );
    } else application.call(app, req, res);
  });
}
app.listen(3001, "127.0.0.1", () =>
  console.log("Disposable UI fixture: http://localhost:3001"),
);

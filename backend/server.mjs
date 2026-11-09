import { fail, readJsonBody, sendJson } from "./lib/http.mjs";
import { Subscriptions } from "./services/subscriptions.mjs";
import { PositionHistory } from "./services/position-history.mjs";
import { Access } from "./services/access.mjs";
import { SecurityEvents } from "./services/security-events.mjs";
import { AlarmSnapshots } from "./services/alarm-snapshots.mjs";
import { managementRoutes } from "./services/management-routes.mjs";
import { Recordings } from "./services/recordings.mjs";
import { recordingRoutes } from "./services/recording-routes.mjs";
import { AiService } from "./ai/service.mjs";
import { AiSettings } from "./ai/settings.mjs";
import { AlarmAnalysis } from "./ai/alarm-analysis.mjs";
import { DeepSeekClient } from "./ai/deepseek.mjs";
import { aiRoutes } from "./ai/routes.mjs";
import { DeviceOperations } from "./services/device-operations.mjs";
import { RecordQueries } from "./services/record-queries.mjs";
import { featureRoutes } from "./services/feature-routes.mjs";
import { CascadeService } from "./services/cascade.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LiveSessions } from "./media/live-sessions.mjs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { loadConfig, publicConfig } from "./lib/config.mjs";
import { MediaAdapter } from "./media/adapter.mjs";
import { attachFlvWebSockets } from "./media/flv-websocket.mjs";
import { SipGateway } from "./sip/gateway.mjs";
import { md5 } from "./sip/protocol.mjs";
import { openStore, hashPassword, checkPassword } from "./lib/store.mjs";
import { AccessSettings } from "./lib/access-settings.mjs";

import {
  authorization,
  allowed,
  routePermission,
} from "./services/authorization.mjs";
import { roleRoutes } from "./services/role-routes.mjs";
import { AuthorizationEvents } from "./services/authorization-events.mjs";
import {
  publicUser,
  userColumns,
  validateProfile,
  saveProfile,
  initializeProfile,
} from "./services/user-profiles.mjs";
import { dirname, join } from "node:path";
const root = new URL("../", import.meta.url);
const digest = (token) => createHash("sha256").update(token).digest("hex");
function channelPagination(url, legacyLimit) {
  const paged =
    url.searchParams.has("page") || url.searchParams.has("pageSize");
  const page = Number(url.searchParams.get("page") || 1);
  const pageSize = paged
    ? Number(url.searchParams.get("pageSize") || 32)
    : legacyLimit;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    (paged && pageSize > 100) ||
    !Number.isSafeInteger((page - 1) * pageSize)
  )
    fail(400, "INVALID_QUERY", "分页参数不正确");
  return { page, pageSize };
}
export function createServer({
  database = fileURLToPath(new URL("data/platform.db", root)),
  legacy = fileURLToPath(new URL("data/devices.json", root)),
  config = loadConfig(),
  configFile = database === ":memory:"
    ? null
    : join(dirname(database), "access-config.json"),
  mediaAdapter = null,
  sipGateway = null,
  restartPlatform = null,
  aiSettings = null,
  aiFetcher = fetch,
  aiCapture = null,
  aiArchiveReader = null,
  aiLocalModel = null,
  qwenOptions = undefined,
} = {}) {
  const instanceId = randomUUID();
  let restartState = "idle",
    startupFailed = false;
  const settings = new AccessSettings(config, configFile);
  config = settings.active;
  const { db, audit, transaction } = openStore(database, legacy);
  const attempts = new Map();
  const media = mediaAdapter || new MediaAdapter(config.media);
  const sip = sipGateway || new SipGateway({ db, config: config.sip });
  const live = new LiveSessions({ db, media, sip, config });
  const access = new Access(db);
  const history = new PositionHistory({
    db,
    access,
    retentionDays: config.positionRetentionDays || 30,
  });
  const scopeTimer = setInterval(() => {
    access.sweep();
    history.prune();
    authorizationEvents.check();
    if (++authorizationTicks % 15 === 0) authorizationEvents.heartbeat();
  }, 1000);
  scopeTimer.unref();
  const events = new SecurityEvents({ db, sip, access, history });
  events.snapshots = new AlarmSnapshots({ db, media });
  const subscriptions = new Subscriptions({ db, sip, access, events });
  sip.onDeviceNotify = (device, req, xml) =>
    subscriptions.notify(device, req, xml);
  const operations = new DeviceOperations({ db, sip });
  const records = new RecordQueries({ db, sip, operations });
  const recordings = new Recordings({ db, live, media });
  const aiConfig =
    aiSettings ||
    new AiSettings({
      file:
        database === ":memory:"
          ? null
          : join(dirname(database), "ai-config.json"),
    });
  const ai = new AiService({
    db,
    access,
    live,
    media,
    settings: aiConfig,
    client: new DeepSeekClient({ settings: aiConfig, fetcher: aiFetcher }),
    capture: aiCapture,
    archiveReader: aiArchiveReader,
    localModel: aiLocalModel,
  });
  ai.alarmAnalysis = new AlarmAnalysis(ai, qwenOptions);
  events.ai = ai;
  const cascade = new CascadeService({
    db,
    sip,
    media,
    live,
    operations,
    records,
    config,
  });
  sip.onRequest = (req, remote) => cascade.handle(req, remote);
  sip.onDeviceMessage = (device, xml, req) => {
    if (subscriptions.guard.handle(device, xml)) return true;
    if (events.handle(device, xml)) return true;
    if (records.handle(device, xml)) return true;
    const status = xml.Notify;
    if (
      status?.CmdType === "MediaStatus" &&
      String(status.NotifyType) === "121"
    ) {
      void live.endNotification(
        device.id,
        status.DeviceID,
        req?.headers?.["call-id"]?.[0],
      );
      return true;
    }
    return false;
  };
  const fields =
    "id,deviceId,name,status,channels,createdAt,remoteAddress,remotePort,registeredUntil,lastHeartbeat,sipTransport,mediaTransport,groupId,(SELECT g.name FROM device_groups g WHERE g.id=devices.groupId) AS groupName";
  const getSession = (req) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("vms_session="))
      ?.slice(12);
    return token
      ? db
          .prepare(
            "SELECT s.*,u.username,u.role FROM sessions s JOIN users u ON u.id=s.userId WHERE token=? AND expiresAt>?",
          )
          .get(digest(token), Date.now())
      : null;
  };
  let authorizationTicks = 0;
  const authorizationEvents = new AuthorizationEvents(getSession);
  const notifyAuthorization = (users) => authorizationEvents.changed(users);
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status, data) => sendJson(res, status, data, requestId);
    const body = async (request) => {
      const value = await readJsonBody(
        request,
        new URL(request.url, "http://localhost").pathname ===
          "/api/v1/ai/analyses"
          ? 5 * 1024 * 1024
          : 16384,
      );
      const url = new URL(request.url, "http://localhost"),
        path = url.pathname;
      if (
        path.startsWith("/api/v1/") &&
        !["/api/v1/setup", "/api/v1/auth/login"].includes(path)
      ) {
        const latest = getSession(request);
        if (!latest) fail(401, "UNAUTHENTICATED", "请先登录");
        if (request.headers["x-csrf-token"] !== latest.csrf)
          fail(403, "CSRF_REJECTED", "会话校验失败，请重新登录");
        const permission = routePermission(path, request.method, url);
        if (permission && !allowed(db, latest.userId, permission))
          fail(403, "PERMISSION_DENIED", "当前角色没有此功能权限");
        const device = path.match(/^\/api\/v1\/devices\/([^/]+)/);
        const channel = path.match(/^\/api\/v1\/channels\/([^/]+)/);
        if (
          device &&
          !access.device(latest.userId, decodeURIComponent(device[1]))
        )
          fail(404, "DEVICE_NOT_FOUND", "设备不存在或无权访问");
        if (
          channel &&
          !access.channel(latest.userId, decodeURIComponent(channel[1]))
        )
          fail(404, "CHANNEL_NOT_FOUND", "通道不存在或无权访问");
      }
      return value;
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; connect-src 'self'" +
        (/^[a-zA-Z0-9.\[\]:_-]+$/.test(req.headers.host || "")
          ? ` ws://${req.headers.host} wss://${req.headers.host}`
          : ""),
    );
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p === "/api/health")
        return send(200, {
          status: startupFailed ? "degraded" : closing ? "restarting" : "ok",
          instanceId,
          restartState,
          database: "sqlite",
          sip: sip.state,
          media: media.status.state,
        });
      if (closing) fail(503, "PLATFORM_RESTARTING", "平台正在重启，请稍后重试");
      if (p === "/api/hooks/media/publish" && req.method === "POST") {
        const token = config.media.hookToken;
        if (
          !token ||
          digest(url.searchParams.get("token") || "") !== digest(token)
        )
          fail(403, "HOOK_UNAUTHORIZED", "媒体回调认证失败");
        const event = await body(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        const job =
          event.app === "rtp" &&
          typeof event.stream === "string" &&
          (!event.vhost || event.vhost === "__defaultVhost__")
            ? recordings.published(event.stream)
            : null;
        res.end(
          JSON.stringify(
            job
              ? {
                  code: 0,
                  enable_mp4: true,
                  enable_rtmp: true,
                  mp4_as_player: true,
                  mp4_max_second: job.segmentSeconds,
                }
              : { code: 0 },
          ),
        );
        return;
      }
      if (!p.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(req.method)) return send(405, null);
        const asset = p.match(/^\/assets\/([a-zA-Z0-9_.-]+\.(js|css|png))$/);
        const relative =
          p === "/"
            ? "dist/index.html"
            : asset
              ? "dist/assets/" + asset[1]
              : null;
        if (!relative) return send(404, null);
        let content;
        try {
          content = await readFile(new URL(relative, root));
        } catch (e) {
          if (e.code === "ENOENT")
            return send(404, { message: "请先运行 npm run build" });
          throw e;
        }
        res.setHeader(
          "Content-Type",
          (p === "/"
            ? "text/html"
            : asset[2] === "js"
              ? "text/javascript"
              : asset[2] === "png"
                ? "image/png"
                : "text/css") + (asset?.[2] === "png" ? "" : "; charset=utf-8"),
        );
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      const writable = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (
        writable &&
        (req.headers["sec-fetch-site"] === "cross-site" ||
          (req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}` &&
            req.headers.origin !== `https://${req.headers.host}`))
      )
        fail(403, "ORIGIN_REJECTED", "请求来源不允许");
      if (p === "/api/v1/setup" && req.method === "GET")
        return send(200, {
          required: !db.prepare("SELECT 1 FROM users LIMIT 1").get(),
        });
      if (p === "/api/v1/setup" && req.method === "POST") {
        const value = await body(req);
        if (db.prepare("SELECT 1 FROM users LIMIT 1").get())
          fail(409, "ALREADY_SETUP", "管理员已初始化");
        if (
          typeof value.username !== "string" ||
          !/^[a-zA-Z0-9_-]{3,32}$/.test(value.username) ||
          typeof value.password !== "string" ||
          value.password.length < 12 ||
          value.password.length > 128
        )
          fail(
            400,
            "INVALID_ACCOUNT",
            "账号须为3至32位字母数字，密码须为12至128位",
          );
        transaction(() => {
          const id = randomUUID();
          db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
            id,
            value.username,
            hashPassword(value.password),
            "admin",
          );
          audit(id, "system.setup", id);
        });
        return send(201, { initialized: true });
      }
      if (p === "/api/v1/auth/login" && req.method === "POST") {
        const key = req.socket.remoteAddress;
        const now = Date.now();
        let a = attempts.get(key);
        if (!a || now > a.until) {
          a = { count: 0, until: now + 60000 };
          attempts.set(key, a);
        }
        if (a.count >= 10) fail(429, "LOGIN_LIMIT", "登录尝试过多，请稍后重试");
        const v = await body(req);
        if (
          typeof v.username !== "string" ||
          typeof v.password !== "string" ||
          v.password.length > 128
        ) {
          a.count++;
          fail(400, "INVALID_ACCOUNT", "账号或密码格式错误");
        }
        const user = db
          .prepare("SELECT * FROM users WHERE username=?")
          .get(v.username);
        if (!user || !checkPassword(v.password, user.passwordHash)) {
          a.count++;
          fail(401, "INVALID_CREDENTIALS", "账号或密码错误");
        }
        const token = randomBytes(32).toString("hex"),
          csrf = randomBytes(24).toString("hex");
        db.prepare("DELETE FROM sessions WHERE expiresAt<?").run(now);
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
          digest(token),
          user.id,
          csrf,
          now + 8 * 3600000,
        );
        audit(user.id, "auth.login");
        db.prepare("UPDATE user_profiles SET lastLoginAt=? WHERE userId=?").run(
          new Date(now).toISOString(),
          user.id,
        );
        res.setHeader(
          "Set-Cookie",
          `vms_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`,
        );
        return send(200, {
          user: publicUser(db, user.id),
          csrf,
        });
      }
      const session = getSession(req);
      if (!session) fail(401, "UNAUTHENTICATED", "请先登录");
      db.prepare(
        "UPDATE devices SET status='offline' WHERE status='online' AND (registeredUntil<? OR lastHeartbeat<?)",
      ).run(Date.now(), Date.now() - config.sip.heartbeatTimeout);
      if (writable && req.headers["x-csrf-token"] !== session.csrf)
        fail(403, "CSRF_REJECTED", "会话校验失败，请重新登录");
      const permission = routePermission(p, req.method, url);
      if (permission && !allowed(db, session.userId, permission))
        fail(403, "PERMISSION_DENIED", "当前角色没有此功能权限");
      if (p === "/api/v1/me/authorization-events" && req.method === "GET") {
        if (
          req.headers["sec-fetch-site"] === "cross-site" ||
          (req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}` &&
            req.headers.origin !== `https://${req.headers.host}`)
        )
          fail(403, "FORBIDDEN", "权限同步仅允许同源访问");
        authorizationEvents.attach(req, res, session);
        return;
      }
      if (
        await roleRoutes({
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
          notifyAuthorization,
        })
      )
        return;
      if (
        await managementRoutes({
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
          notifyAuthorization,
        })
      )
        return;
      if (p === "/api/v1/me" && req.method === "GET")
        return send(200, {
          user: publicUser(db, session.userId),
          csrf: session.csrf,
        });
      if (p === "/api/v1/me/profile" && req.method === "PUT") {
        const value = await body(req);
        if (!getSession(req)) fail(401, "UNAUTHENTICATED", "请先登录");
        const updated = transaction(() => {
          const user = saveProfile(db, session.userId, value);
          audit(session.userId, "user.profile.self", session.userId);
          return user;
        });
        return send(200, updated);
      }
      if (p === "/api/v1/me/password" && req.method === "POST") {
        const value = await body(req);
        if (!getSession(req)) fail(401, "UNAUTHENTICATED", "请先登录");
        if (
          typeof value?.currentPassword !== "string" ||
          !value.currentPassword.length ||
          value.currentPassword.length > 128 ||
          typeof value.newPassword !== "string" ||
          value.newPassword.length < 12 ||
          value.newPassword.length > 128 ||
          value.currentPassword === value.newPassword
        )
          fail(
            400,
            "INVALID_PASSWORD",
            "新密码须为 12～128 个字符，且与当前密码不同",
          );
        const key = "password:" + session.userId;
        const now = Date.now();
        let attempt = attempts.get(key);
        if (!attempt || now >= attempt.until) {
          attempt = { count: 0, until: now + 60000 };
          attempts.set(key, attempt);
        }
        if (attempt.count >= 5)
          fail(429, "PASSWORD_LIMIT", "尝试过多，请稍后重试");
        const user = db
          .prepare("SELECT passwordHash FROM users WHERE id=?")
          .get(session.userId);
        if (!user || !checkPassword(value.currentPassword, user.passwordHash)) {
          attempt.count++;
          fail(400, "INVALID_CURRENT_PASSWORD", "当前密码不正确");
        }
        const sessions = db
          .prepare("SELECT token FROM sessions WHERE userId=?")
          .all(session.userId);
        const viewers = db
          .prepare("SELECT id, sessionId FROM viewers WHERE userId=?")
          .all(session.userId);
        transaction(() => {
          db.prepare("UPDATE users SET passwordHash=? WHERE id=?").run(
            hashPassword(value.newPassword),
            session.userId,
          );
          db.prepare("DELETE FROM sessions WHERE userId=?").run(session.userId);
          audit(session.userId, "auth.password_change");
        });
        attempts.delete(key);
        authorizationEvents.check();
        sessions.forEach(({ token }) => access.endSession(token));
        await Promise.allSettled([
          operations.stopUser(session.userId),
          ...viewers.map((viewer) =>
            live.leave(viewer.sessionId, session.userId, viewer.id),
          ),
        ]);
        res.setHeader(
          "Set-Cookie",
          "vms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return send(204);
      }
      if (p === "/api/v1/auth/logout" && req.method === "POST") {
        access.endSession(session.token);
        await operations.stopUser(session.userId);
        for (const viewer of db
          .prepare(
            "SELECT v.* FROM viewers v JOIN viewer_auth a ON a.viewerId=v.id WHERE a.authToken=?",
          )
          .all(session.token))
          await live.leave(viewer.sessionId, session.userId, viewer.id);
        db.prepare("DELETE FROM sessions WHERE token=?").run(session.token);
        authorizationEvents.check();
        res.setHeader(
          "Set-Cookie",
          "vms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return send(204);
      }
      if (p === "/api/v1/live-sessions" && req.method === "POST") {
        const v = await body(req);
        if (typeof v.channelId !== "string")
          fail(400, "INVALID_CHANNEL", "请选择通道");
        if (v.streamNumber !== undefined && ![0, 1].includes(v.streamNumber))
          fail(400, "INVALID_STREAM", "请选择主码流或子码流");
        const c = db
          .prepare("SELECT * FROM channels WHERE id=?")
          .get(v.channelId);
        if (!c) fail(404, "CHANNEL_NOT_FOUND", "通道不存在");
        const key = req.headers["idempotency-key"];
        if (key && (typeof key !== "string" || key.length > 100))
          fail(400, "INVALID_REQUEST_KEY", "请求编号无效");
        let result;
        try {
          result = live.create(
            c,
            session.userId,
            key,
            v.streamNumber === 1 ? { kind: "live", streamNumber: 1 } : null,
          );
        } catch (e) {
          fail(409, "PLAY_UNAVAILABLE", e.message);
        }
        db.prepare("INSERT OR IGNORE INTO viewer_auth VALUES(?,?)").run(
          result.viewerId,
          session.token,
        );
        audit(session.userId, "live.create", result.sessionId);
        return send(202, result);
      }
      const viewerRoute = p.match(
        /^\/api\/v1\/live-sessions\/([a-zA-Z0-9-]+)\/viewers\/([a-zA-Z0-9-]+)(\/renew|\/stream\.(?:flv|mp4))?$/,
      );
      if (viewerRoute) {
        const [, id, viewerId, action] = viewerRoute;
        if (req.method === "POST" && action === "/renew") {
          try {
            return send(200, live.renew(id, session.userId, viewerId));
          } catch (e) {
            fail(409, "VIEWER_EXPIRED", e.message);
          }
        }
        if (req.method === "DELETE" && !action) {
          try {
            await live.leave(id, session.userId, viewerId);
            return send(204);
          } catch (e) {
            fail(403, "FORBIDDEN", e.message);
          }
        }
        if (
          req.method === "GET" &&
          ["/stream.flv", "/stream.mp4"].includes(action)
        ) {
          let streamId;
          const mp4 = action === "/stream.mp4";
          try {
            streamId = live.authorizeStream(id, session.userId, viewerId);
            if (mp4 && !live.convertsPreviewAudio(id))
              throw Error("该会话未启用音频转换");
          } catch (e) {
            fail(403, "FORBIDDEN", e.message);
          }
          const controller = new AbortController();
          let untrack;
          try {
            untrack = live.trackConnection(id, viewerId, controller);
          } catch (e) {
            fail(409, "STREAM_BUSY", e.message);
          }
          const disconnect = () => controller.abort();
          res.on("close", disconnect);
          const timeout = setTimeout(disconnect, 10000);
          let expiry;
          try {
            const upstream = mp4
              ? await media.openPreviewMp4(streamId, controller.signal)
              : live.convertsPreviewAudio(id)
                ? await media.openCompatibleFlv(streamId, controller.signal)
                : await media.openFlv(streamId, controller.signal);
            clearTimeout(timeout);
            expiry = setTimeout(
              disconnect,
              Math.max(0, session.expiresAt - Date.now()),
            );
            res.writeHead(200, {
              "Content-Type": mp4 ? "video/mp4" : "video/x-flv",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
            });
            await pipeline(Readable.fromWeb(upstream.body), res, {
              signal: controller.signal,
            });
          } catch {
            if (!res.headersSent && !res.destroyed)
              fail(502, "MEDIA_UNAVAILABLE", "媒体流不可用");
          } finally {
            clearTimeout(timeout);
            clearTimeout(expiry);
            controller.abort();
            res.removeListener("close", disconnect);
            untrack();
          }
          return;
        }
      }
      const liveRoute = p.match(/^\/api\/v1\/live-sessions\/([a-zA-Z0-9-]+)$/);
      if (liveRoute && req.method === "GET") {
        try {
          return send(
            200,
            live.snapshot(
              liveRoute[1],
              session.userId,
              url.searchParams.get("viewerId"),
            ),
          );
        } catch (e) {
          fail(403, "FORBIDDEN", e.message);
        }
      }
      if (p === "/api/v1/channels" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        const channelId = url.searchParams.get("channelId") || "";
        if (q.length > 100 || channelId.length > 200)
          fail(400, "INVALID_QUERY", "搜索参数不正确");
        const { page, pageSize } = channelPagination(url, 500);
        const where = `WHERE (instr(lower(c.name),lower(?))>0 OR instr(c.channelCode,?)>0 OR instr(lower(d.name),lower(?))>0) AND (?='' OR c.id=?) AND ${access.sql(session.userId, "d.id")}`;
        return send(200, {
          items: db
            .prepare(
              `SELECT c.*,d.name AS deviceName,d.status AS deviceStatus,d.groupId FROM channels c JOIN devices d ON c.deviceId=d.id ${where} ORDER BY d.name,d.id,c.channelCode,c.id LIMIT ? OFFSET ?`,
            )
            .all(
              q,
              q,
              q,
              channelId,
              channelId,
              pageSize,
              (page - 1) * pageSize,
            ),
          total: db
            .prepare(
              `SELECT count(*) n FROM channels c JOIN devices d ON c.deviceId=d.id ${where}`,
            )
            .get(q, q, q, channelId, channelId).n,
          page,
          pageSize,
        });
      }
      if (p === "/api/v1/overview" && req.method === "GET")
        return send(200, {
          devices: db
            .prepare(
              `SELECT count(*) AS n FROM devices d WHERE ${access.sql(session.userId, "d.id")}`,
            )
            .get().n,
          onlineDevices: db
            .prepare(
              `SELECT count(*) AS n FROM devices d WHERE ${access.sql(session.userId, "d.id")} AND status='online' AND registeredUntil>? AND lastHeartbeat>?`,
            )
            .get(Date.now(), Date.now() - config.sip.heartbeatTimeout).n,
          channels: db
            .prepare(
              `SELECT count(*) AS n FROM channels c WHERE ${access.sql(session.userId, "c.deviceId")}`,
            )
            .get().n,
          liveSessions: db
            .prepare(
              `SELECT count(*) AS n FROM live_sessions s WHERE s.state='ready' AND ${access.sql(session.userId, "s.deviceId")}`,
            )
            .get().n,
          sip: sip.state,
          media: media.status.state,
        });
      if (
        await aiRoutes({ req, res, url, session, ai, body, send, fail, audit })
      )
        return;
      if (
        await featureRoutes({
          req,
          url,
          session,
          db,
          sip,
          operations,
          records,
          access,
          live,
          cascade,
          body,
          send,
          fail,
          audit,
        })
      )
        return;
      if (
        await recordingRoutes({
          ai,
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
        })
      )
        return;
      if (
        writable &&
        session.role !== "admin" &&
        ![
          "alarms.handle",
          "map.manage",
          "subscriptions.manage",
          "ptz.control",
        ].includes(permission)
      )
        fail(403, "FORBIDDEN", "当前账号没有管理权限");
      if (p === "/api/v1/users" && req.method === "GET") {
        if (session.role !== "admin") fail(403, "FORBIDDEN", "无权管理用户");
        return send(200, {
          items: db
            .prepare(
              `SELECT ${userColumns} FROM users u JOIN user_profiles p ON p.userId=u.id ORDER BY u.username`,
            )
            .all()
            .map((user) => ({ ...user, ...authorization(db, user.id) })),
        });
      }
      if (p === "/api/v1/users" && req.method === "POST") {
        const v = await body(req);
        const requestedRole =
          typeof (v.roleId ?? v.role) === "string"
            ? db
                .prepare("SELECT id FROM platform_roles WHERE id=?")
                .get(v.roleId ?? v.role)
            : null;
        if (
          typeof v.username !== "string" ||
          !/^[a-zA-Z0-9_-]{3,32}$/.test(v.username) ||
          typeof v.password !== "string" ||
          v.password.length < 12 ||
          v.password.length > 128 ||
          !requestedRole
        )
          fail(
            400,
            "INVALID_USER",
            "账号须为3至32位字母数字，密码至少12位，并选择有效角色",
          );
        const id = randomUUID();
        validateProfile(v.profile);
        transaction(() => {
          if (
            db.prepare("SELECT 1 FROM users WHERE username=?").get(v.username)
          )
            fail(409, "DUPLICATE_USER", "账号已存在");
          db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
            id,
            v.username,
            hashPassword(v.password),
            requestedRole.id === "admin" ? "admin" : "viewer",
          );
          initializeProfile(db, id, v.profile);
          db.prepare(
            "UPDATE user_authorizations SET roleId=? WHERE userId=?",
          ).run(requestedRole.id, id);
          audit(session.userId, "user.create", id);
        });
        return send(201, publicUser(db, id));
      }
      const profileRoute = p.match(
        /^\/api\/v1\/users\/([a-zA-Z0-9-]+)\/profile$/,
      );
      if (profileRoute && req.method === "PUT") {
        const value = await body(req);
        const updated = transaction(() => {
          const user = saveProfile(db, profileRoute[1], value);
          audit(session.userId, "user.profile.update", profileRoute[1]);
          return user;
        });
        return send(200, updated);
      }
      const account = p.match(/^\/api\/v1\/users\/([a-zA-Z0-9-]+)$/);
      if (account && req.method === "GET") {
        if (session.role !== "admin")
          fail(403, "FORBIDDEN", "无权查看其他用户资料");
        const user = publicUser(db, account[1]);
        if (!user) fail(404, "USER_NOT_FOUND", "用户不存在");
        return send(200, user);
      }
      if (account && req.method === "DELETE") {
        if (account[1] === session.userId)
          fail(409, "CURRENT_USER", "不能删除当前登录用户");
        transaction(() => {
          if (
            db
              .prepare("SELECT 1 FROM cascade_platforms WHERE ownerId=?")
              .get(account[1])
          )
            fail(409, "USER_HAS_PLATFORMS", "请先删除该用户创建的级联平台");
          if (
            db
              .prepare("SELECT 1 FROM recording_plans WHERE ownerId=?")
              .get(account[1]) ||
            db
              .prepare(
                "SELECT 1 FROM recording_jobs WHERE ownerId=? AND status IN ('starting','recording','finalizing')",
              )
              .get(account[1])
          )
            fail(409, "USER_HAS_RECORDINGS", "该用户仍有关联录像计划或任务");
          const target = db
            .prepare("SELECT id FROM users WHERE id=?")
            .get(account[1]);
          if (!target) fail(404, "USER_NOT_FOUND", "用户不存在");
          db.prepare("DELETE FROM sessions WHERE userId=?").run(target.id);
          db.prepare("UPDATE recording_jobs SET ownerId=? WHERE ownerId=?").run(
            session.userId,
            target.id,
          );
          db.prepare("DELETE FROM users WHERE id=?").run(target.id);
          audit(session.userId, "user.delete", target.id);
        });
        access.sweep();
        await live.revoke();
        authorizationEvents.check();
        return send(204);
      }
      if (p === "/api/v1/media-nodes" && req.method === "GET") {
        if (session.role !== "admin")
          fail(403, "FORBIDDEN", "无权查看媒体节点");
        return send(200, { items: [{ id: "local", ...media.status }] });
      }
      if (p === "/api/v1/media-nodes/local/check" && req.method === "POST")
        return send(200, await media.check());
      if (p === "/api/v1/system/config" && req.method === "GET") {
        if (session.role !== "admin")
          fail(403, "FORBIDDEN", "无权查看接入配置");
        return send(200, {
          ...publicConfig(config),
          sipState: sip.state,
          settings: settings.view(),
          runtime: {
            instanceId,
            restartAvailable: typeof restartPlatform === "function",
            restartState,
          },
        });
      }
      if (p === "/api/v1/system/restart" && req.method === "POST") {
        if (typeof restartPlatform !== "function")
          fail(
            503,
            "RESTART_UNAVAILABLE",
            "当前启动方式不支持在线重启，请使用 npm start 启动平台",
          );
        const value = await body(req);
        if (value.confirm !== true)
          fail(
            400,
            "RESTART_CONFIRM_REQUIRED",
            "请确认重启将短暂中断预览和录像",
          );
        // Validate the persisted configuration before disrupting the running services.
        settings.view();
        if (restartState !== "accepted") {
          audit(session.userId, "system.restart", "local");
          restartState = "accepted";
          res.once("finish", () => {
            Promise.resolve()
              .then(restartPlatform)
              .catch((error) => {
                restartState = "failed";
                console.error("平台重启失败:", error.message);
              });
          });
        }
        res.setHeader("Connection", "close");
        return send(202, { status: "accepted", instanceId });
      }
      if (p === "/api/v1/system/config" && req.method === "PUT") {
        let result;
        try {
          result = settings.save(await body(req));
        } catch (e) {
          fail(e.status || 400, e.code || "CONFIG_INVALID", e.message);
        }
        audit(session.userId, "system.config.update", "local");
        return send(200, result);
      }
      if (p === "/api/v1/audit" && req.method === "GET") {
        if (session.role !== "admin")
          fail(403, "FORBIDDEN", "无权查看审计日志");
        return send(200, {
          items: db
            .prepare(
              "SELECT a.*,u.username FROM audit a LEFT JOIN users u ON a.userId=u.id ORDER BY a.rowid DESC LIMIT 100",
            )
            .all(),
        });
      }
      if (p === "/api/v1/devices" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") || 1),
          pageSize = Number(url.searchParams.get("pageSize") || 20),
          q = url.searchParams.get("q") || "";
        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 100 ||
          q.length > 100
        )
          fail(400, "INVALID_QUERY", "分页或搜索参数不正确");
        const status = url.searchParams.get("status") || "";
        if (status && !["online", "offline", "unregistered"].includes(status))
          fail(400, "INVALID_STATUS", "设备状态无效");
        const groupId = url.searchParams.get("groupId") || "";
        const where = `WHERE (instr(lower(name),lower(?))>0 OR instr(deviceId,?)>0) AND (?='' OR status=?) AND ${access.sql(session.userId, "devices.id")} AND (?='' OR groupId=?)`;
        return send(200, {
          items: db
            .prepare(
              `SELECT ${fields} FROM devices ${where} ORDER BY createdAt DESC,id LIMIT ? OFFSET ?`,
            )
            .all(
              q,
              q,
              status,
              status,
              groupId,
              groupId,
              pageSize,
              (page - 1) * pageSize,
            ),
          total: db
            .prepare(`SELECT count(*) AS n FROM devices ${where}`)
            .get(q, q, status, status, groupId, groupId).n,
          page,
          pageSize,
        });
      }
      if (p === "/api/v1/devices" && req.method === "POST") {
        const v = await body(req);
        if (
          typeof v.deviceId !== "string" ||
          !/^\d{20}$/.test(v.deviceId) ||
          typeof v.name !== "string" ||
          !v.name.trim() ||
          v.name.length > 100
        )
          fail(
            400,
            "INVALID_DEVICE",
            "设备编号须为20位数字，名称须为1至100个字符",
          );
        const device = {
          id: randomUUID(),
          deviceId: v.deviceId,
          name: v.name.trim(),
          createdAt: new Date().toISOString(),
        };
        transaction(() => {
          if (
            db.prepare("SELECT 1 FROM devices WHERE deviceId=?").get(v.deviceId)
          )
            fail(409, "DUPLICATE_DEVICE", "设备编号已存在");
          db.prepare(
            "INSERT INTO devices(id,deviceId,name,createdAt) VALUES(?,?,?,?)",
          ).run(device.id, device.deviceId, device.name, device.createdAt);
          audit(session.userId, "device.create", device.id);
        });
        return send(
          201,
          db.prepare(`SELECT ${fields} FROM devices WHERE id=?`).get(device.id),
        );
      }
      const catalog = p.match(
        /^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/catalog-sync$/,
      );
      if (catalog && req.method === "POST") {
        const device = db
          .prepare("SELECT * FROM devices WHERE id=?")
          .get(catalog[1]);
        if (!device) fail(404, "DEVICE_NOT_FOUND", "设备不存在");
        let taskId;
        try {
          taskId = sip.sync(device);
        } catch (e) {
          fail(409, "SYNC_UNAVAILABLE", e.message);
        }
        audit(session.userId, "device.catalog.sync", device.id);
        return send(202, { taskId });
      }
      const channel = p.match(
        /^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/channels$/,
      );
      if (channel && req.method === "GET") {
        if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(channel[1]))
          fail(404, "DEVICE_NOT_FOUND", "设备不存在");
        if (!access.device(session.userId, channel[1]))
          fail(404, "DEVICE_NOT_FOUND", "设备不存在或无权访问");
        const { page, pageSize } = channelPagination(url, 1000);
        return send(200, {
          items: db
            .prepare(
              "SELECT * FROM channels WHERE deviceId=? ORDER BY channelCode,id LIMIT ? OFFSET ?",
            )
            .all(channel[1], pageSize, (page - 1) * pageSize),
          total: db
            .prepare("SELECT count(*) n FROM channels WHERE deviceId=?")
            .get(channel[1]).n,
          page,
          pageSize,
        });
      }
      const task = p.match(/^\/api\/v1\/tasks\/([a-zA-Z0-9-]+)$/);
      if (task && req.method === "GET") {
        const result = db
          .prepare("SELECT * FROM tasks WHERE id=?")
          .get(task[1]);
        if (!result || !access.device(session.userId, result.deviceId))
          fail(404, "TASK_NOT_FOUND", "任务不存在或无权访问");
        return send(200, result);
      }
      const match = p.match(/^\/api\/v1\/devices\/([a-zA-Z0-9-]+)$/);
      const credential = p.match(
        /^\/api\/v1\/devices\/([a-zA-Z0-9-]+)\/credential$/,
      );
      if (credential && req.method === "PUT") {
        const device = db
          .prepare("SELECT id,deviceId FROM devices WHERE id=?")
          .get(credential[1]);
        if (!device) fail(404, "DEVICE_NOT_FOUND", "设备不存在");
        const v = await body(req);
        if (
          typeof v.password !== "string" ||
          v.password.length < 8 ||
          v.password.length > 128
        )
          fail(400, "INVALID_PASSWORD", "设备密码须为8至128位");
        transaction(() => {
          db.prepare("UPDATE devices SET sipHa1=? WHERE id=?").run(
            md5(device.deviceId + ":" + config.sip.domain + ":" + v.password),
            device.id,
          );
          audit(session.userId, "device.credential.update", device.id);
        });
        return send(204);
      }
      if (match) {
        const device = db
          .prepare(`SELECT ${fields} FROM devices WHERE id=?`)
          .get(match[1]);
        if (!device || !access.device(session.userId, device.id))
          fail(404, "DEVICE_NOT_FOUND", "设备不存在或无权访问");
        if (req.method === "GET") return send(200, device);
        if (req.method === "PATCH") {
          const v = await body(req);
          if (
            typeof v.name !== "string" ||
            !v.name.trim() ||
            v.name.length > 100
          )
            fail(400, "INVALID_DEVICE", "名称须为1至100个字符");
          transaction(() => {
            db.prepare("UPDATE devices SET name=? WHERE id=?").run(
              v.name.trim(),
              device.id,
            );
            audit(session.userId, "device.update", device.id);
          });
          return send(
            200,
            db
              .prepare(`SELECT ${fields} FROM devices WHERE id=?`)
              .get(device.id),
          );
        }
        if (req.method === "DELETE") {
          if (
            db
              .prepare(
                "SELECT 1 FROM live_sessions WHERE deviceId=? AND released=0",
              )
              .get(device.id)
          )
            fail(409, "DEVICE_BUSY", "设备仍有播放会话或待回收资源");
          if (
            db
              .prepare(
                "SELECT 1 FROM tasks WHERE deviceId=? AND status='running'",
              )
              .get(device.id)
          )
            fail(409, "DEVICE_BUSY", "设备任务正在执行");
          transaction(() => {
            if (
              db
                .prepare(
                  "SELECT 1 FROM recording_plans p JOIN channels c ON p.channelId=c.id WHERE c.deviceId=?",
                )
                .get(device.id)
            )
              fail(409, "DEVICE_HAS_PLANS", "请先删除该设备的录像计划");
            if (
              db
                .prepare(
                  "SELECT 1 FROM device_subscriptions WHERE deviceId=? AND (enabled=1 OR status='stopping')",
                )
                .get(device.id)
            )
              fail(
                409,
                "DEVICE_HAS_SUBSCRIPTIONS",
                "请先停止该设备的订阅并等待取消完成",
              );
            db.prepare("DELETE FROM devices WHERE id=?").run(device.id);
            audit(session.userId, "device.delete", device.id);
          });
          return send(204);
        }
      }
      fail(404, "NOT_FOUND", "接口不存在");
    } catch (e) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      if (!e.status) console.error(requestId, e);
      res.writeHead(e.status || 500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({
          error: {
            code: e.code || "INTERNAL_ERROR",
            message: e.status ? e.message : "服务内部错误",
          },
          requestId,
        }),
      );
    }
  });
  const closeFlvSockets = attachFlvWebSockets(server, {
    getSession,
    live,
    media,
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.startSip = async () => {
    try {
      await sip.start();
      await live.recover();
      cascade.start();
      recordings.start();
    } catch (error) {
      startupFailed = true;
      throw error;
    }
  };
  const closeHttp = server.close.bind(server);
  let closing = false;
  let closePromise;
  server.close = (callback) => {
    if (!closePromise) {
      closing = true;
      closeFlvSockets();
      authorizationEvents.close();
      clearInterval(scopeTimer);
      closePromise = (async () => {
        let failure;
        for (const cleanup of [
          () => ai.close(),
          () => access.close(),
          () => subscriptions.close(),
          () => events.close(),
          () => recordings.close(),
          () => cascade.close(),
          () => operations.close(),
          () => records.close(),
          () => live.shutdown(),
          () => sip.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failure ||= error;
          }
        }
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => server.closeAllConnections(), 5000);
            timer.unref();
            closeHttp((error) => {
              clearTimeout(timer);
              if (error && error.code !== "ERR_SERVER_NOT_RUNNING")
                reject(error);
              else resolve();
            });
          });
        } finally {
          db.close();
        }
        if (failure) throw failure;
      })();
    }
    closePromise.then(
      () => callback?.(),
      (error) => callback?.(error),
    );
    return server;
  };
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  import("./main.mjs")
    .then(({ startPlatform }) => startPlatform())
    .catch((error) => {
      console.error("服务启动失败:", error.message);
      process.exitCode = 1;
    });
}

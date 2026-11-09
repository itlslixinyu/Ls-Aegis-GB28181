import sharp from "sharp";
import { localModelInventory } from "./model-inventory.mjs";
import { localModelReady, LOCAL_VERSION } from "./local-model.mjs";
export async function aiRoutes({
  req,
  res,
  url,
  session,
  ai,
  body,
  send,
  fail,
  audit,
}) {
  const path = url.pathname;
  if (!path.startsWith("/api/v1/ai/")) return false;
  const userId = session.userId;
  if (path === "/api/v1/ai/alarm-analyses" && req.method === "POST") {
    const value = await body(req);
    if (
      typeof value.alarmId !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(value.alarmId) ||
      (value.reanalyze !== undefined && typeof value.reanalyze !== 'boolean')
    )
      fail(400, "INVALID_ALARM_ID", "请选择有效告警");
    const result = await ai.alarmAnalysis.enqueue(userId, value.alarmId, {reanalyze:value.reanalyze===true});
    audit(userId, value.reanalyze ? "ai.alarm.reanalyze" : "ai.alarm.enqueue", result.id);
    send(202, result);
    return true;
  }
  if (path === "/api/v1/ai/history-searches" && req.method === "GET") {
    send(200, ai.history.list(userId));
    return true;
  }
  const sampleMatch = path.match(
    /^\/api\/v1\/ai\/history-searches\/([a-zA-Z0-9-]{1,100})\/samples\/([a-zA-Z0-9-]{1,100})(\/image)?$/,
  );
  if (sampleMatch && req.method === "GET") {
    const row = ai.history.samples.row(userId, sampleMatch[1], sampleMatch[2]);
    if (sampleMatch[3]) {
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": row.image.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(Buffer.from(row.image));
    } else send(200, ai.history.samples.public(row));
    return true;
  }
  if (path === "/api/v1/ai/history-searches" && req.method === "POST") {
    const result = ai.history.create(
      userId,
      await body(req),
      req.headers["idempotency-key"],
    );
    audit(userId, "ai.history.search", result.id);
    send(202, result);
    return true;
  }
  const historyMatch = path.match(
    /^\/api\/v1\/ai\/history-searches\/([a-zA-Z0-9-]{1,100})(\/cancel)?$/,
  );
  if (historyMatch) {
    if (req.method === "GET" && !historyMatch[2]) {
      send(
        200,
        ai.history.get(
          userId,
          historyMatch[1],
          Number(url.searchParams.get("page") || 1),
          url.searchParams.get("view") || "matches",
        ),
      );
      return true;
    }
    if (req.method === "POST" && historyMatch[2]) {
      await body(req);
      send(200, ai.history.cancel(userId, historyMatch[1]));
      return true;
    }
  }
  if (path === "/api/v1/ai/status" && req.method === "GET") {
    const config = ai.settings.public();
    send(200, {
      local: {
        ready: localModelReady(),
        qwenReady: ai.qwenRunner.ready(),
        model: LOCAL_VERSION,
        device: "CPU",
        threads: 1,
      },
      recordingFrames: true,
      localPrompt: true,
      provider: config.provider,
      enabled: config.enabled,
      qwenAlarm: ai.alarmAnalysis?.status() || null,
      localEnabled: config.localEnabled,
      hasKey: config.hasKey,
      model: config.model,
      lastTest: config.lastTest
        ? {
            status: config.lastTest.status,
            checkedAt: config.lastTest.checkedAt,
          }
        : null,
    });
    return true;
  }
  if (path === "/api/v1/ai/settings") {
    if (req.method === "GET") {
      send(200, ai.settings.public());
      return true;
    }
    if (req.method === "PUT") {
      const result = ai.settings.save(await body(req), { userId });
      audit(userId, "ai.settings.save", "ai");
      send(200, result);
      return true;
    }
  }
  if (path === "/api/v1/ai/settings/local-index" && req.method === "GET") {
    send(200, ai.history.index.status());
    return true;
  }
  if (path === "/api/v1/ai/settings/local-models" && req.method === "GET") {
    send(200, { items: localModelInventory() });
    return true;
  }
  if (path === "/api/v1/ai/settings/test" && req.method === "POST") {
    const input = await body(req);
    if (input.version !== ai.settings.state.version)
      fail(409, "AI_CONFIG_CONFLICT", "模型配置已更新，请刷新后重试");
    if (ai.testing) fail(429, "AI_TEST_BUSY", "模型连接测试正在进行，请稍候");
    ai.testing = true;
    try {
      const image = await sharp(
        Buffer.from(
          '<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="white"/><rect x="80" y="100" width="140" height="140" fill="#2064dc"/><circle cx="460" cy="170" r="75" fill="#e64646"/></svg>',
        ),
      )
        .jpeg()
        .toBuffer();
      ai.testController = new AbortController();
      ai.settings.tested(
        {
          status: "testing",
          connection: false,
          vision: false,
          message: "正在进行真实模型与合成图测试",
        },
        input.version,
      );
      ai.testPromise = ai.client
        .test(image, ai.testController.signal)
        .catch(() => null)
        .finally(() => {
          ai.testing = false;
          ai.testController = null;
        });
      audit(userId, "ai.settings.test", "deepseek");
      send(202, ai.settings.public());
      return true;
    } catch (e) {
      ai.testing = false;
      throw e;
    }
  }
  if (path === "/api/v1/ai/analyses") {
    if (req.method === "GET") {
      send(
        200,
        ai.list(userId, {
          page: Number(url.searchParams.get("page") || 1),
          pageSize: Number(url.searchParams.get("pageSize") || 20),
          q: url.searchParams.get("q") || "",
          status: url.searchParams.get("status") || "",
        }),
      );
      return true;
    }
    if (req.method === "POST") {
      const result = await ai.create(
        userId,
        await body(req),
        req.headers["idempotency-key"],
      );
      audit(userId, "ai.analysis.create", result.id);
      send(202, result);
      return true;
    }
  }
  if (path === "/api/v1/ai/query-plans" && req.method === "POST") {
    const input = await body(req);
    const result = await ai.create(
      userId,
      { question: input.text, textSearch: true },
      req.headers["idempotency-key"],
    );
    audit(userId, "ai.query.create", result.id);
    send(202, result);
    return true;
  }
  const match = path.match(
    /^\/api\/v1\/ai\/analyses\/([a-zA-Z0-9-]{1,100})(?:\/(image|cancel))?$/,
  );
  if (match) {
    if (!match[2] && req.method === "GET") {
      send(200, ai.get(userId, match[1]));
      return true;
    }
    if (match[2] === "image" && req.method === "GET") {
      const image = ai.image(userId, match[1]);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": image.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(image);
      return true;
    }
    if (match[2] === "cancel" && req.method === "POST") {
      await body(req);
      const result = ai.cancel(userId, match[1]);
      audit(userId, "ai.analysis.cancel", match[1]);
      send(200, result);
      return true;
    }
  }
  if (path === "/api/v1/ai/search" && req.method === "POST") {
    const input = await body(req);
    send(200, ai.search(userId, input));
    return true;
  }
  return false;
}

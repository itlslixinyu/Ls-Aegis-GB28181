const base =
  process.env.PLATFORM_URL || "http://127.0.0.1:" + (process.env.PORT || 3000);
try {
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("巡检地址须为不带凭据的 HTTP(S) 地址");
  const response = await fetch(new URL("/api/health", url), {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  const { data } = await response.json();
  if (
    !response.ok ||
    !data ||
    !["ok", "degraded", "restarting"].includes(data.status)
  )
    throw Error("健康接口响应无效");
  console.log(
    JSON.stringify({
      event: "platform.health",
      status: data.status,
      database: data.database,
      sip: data.sip,
      media: data.media,
      checkedAt: new Date().toISOString(),
    }),
  );
  if (data.status !== "ok") process.exitCode = 1;
} catch {
  console.error(
    JSON.stringify({
      event: "platform.health",
      status: "unreachable",
      message: "健康检查失败或超时",
    }),
  );
  process.exitCode = 1;
}

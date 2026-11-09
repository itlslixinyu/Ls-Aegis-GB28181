import { resolve } from "node:path";
import { createServer } from "./server.mjs";
import { createPlatformRuntime } from "./lib/platform-runtime.mjs";

export function startPlatform() {
  const runtime = createPlatformRuntime({
    createServer,
    host: process.env.HTTP_HOST || "127.0.0.1",
    getOptions: () =>
      process.env.PLATFORM_DATABASE
        ? { database: resolve(process.env.PLATFORM_DATABASE), legacy: null }
        : {},
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () =>
      runtime
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1)),
    );
  return runtime
    .start()
    .then((server) => {
      console.log(
        JSON.stringify({
          event: "platform.started",
          port: server.address().port,
          environment: process.env.APP_ENV || "local",
        }),
      );
      return runtime;
    })
    .catch((error) => {
      console.error("服务启动失败:", error.message);
      process.exitCode = 1;
    });
}

import { loadEnvironment } from "../backend/lib/environment.mjs";
try {
  loadEnvironment(process.argv[2]);
  const { startPlatform } = await import("../backend/main.mjs");
  await startPlatform();
} catch (error) {
  console.error("启动配置无效:", error.message);
  process.exitCode = 1;
}

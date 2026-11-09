import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";

// Explicit profiles never fall back to the real-device local .env.
export function loadEnvironment(
  profile,
  { cwd = process.cwd(), env = process.env } = {},
) {
  if (profile && !["development", "test", "production"].includes(profile))
    throw Error("环境须为 development、test 或 production");
  const file = resolve(cwd, profile ? ".env." + profile : ".env");
  if (!existsSync(file)) {
    if (profile) throw Error("缺少环境配置文件，请先从对应 .example 文件创建");
    return null;
  }
  const values = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(values))
    if (env[key] === undefined) env[key] = value;
  if (profile) env.APP_ENV = profile;
  return file;
}

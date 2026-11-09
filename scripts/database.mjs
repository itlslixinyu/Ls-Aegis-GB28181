import { DatabaseSync, backup } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { openStore } from "../backend/lib/store.mjs";

const [command, file] = process.argv.slice(2);
try {
  if (!["check", "backup", "migrate"].includes(command) || !file)
    throw Error(
      "用法: node scripts/database.mjs check|backup|migrate <数据库路径>",
    );
  const path = resolve(file);
  if (command !== "migrate" && !existsSync(path))
    throw Error("数据库不存在，不创建空库");
  if (command === "backup" || (command === "migrate" && existsSync(path))) {
    const target = resolve(
      "backups",
      "database-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8),
      "platform.db",
    );
    await mkdir(dirname(target), { recursive: true });
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      await backup(source, target);
    } finally {
      source.close();
    }
    console.log(JSON.stringify({ event: "database.backup", path: target }));
  }
  if (command === "migrate") {
    const { db } = openStore(path, null);
    db.close();
  }
  if (command !== "backup") {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = db
        .prepare("PRAGMA integrity_check")
        .get().integrity_check;
      const foreignKeyErrors = db
        .prepare("PRAGMA foreign_key_check")
        .all().length;
      const migration = db
        .prepare("SELECT MAX(version) AS version FROM migrations")
        .get().version;
      console.log(
        JSON.stringify({
          event: "database.check",
          integrity,
          foreignKeyErrors,
          migration,
        }),
      );
      if (integrity !== "ok" || foreignKeyErrors) process.exitCode = 1;
    } finally {
      db.close();
    }
  }
} catch (error) {
  console.error("数据库操作失败:", error.message);
  process.exitCode = 1;
}

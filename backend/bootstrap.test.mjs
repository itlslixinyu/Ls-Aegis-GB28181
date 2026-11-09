import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const mode of ["legacy", "profile"])
  test(
    "独立进程启动入口 " + mode + "：首页与健康可用，数据库隔离",
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "aegis-boot-"));
      const database = join(cwd, "platform.db");
      const env = {
        ...process.env,
        PORT: "0",
        HTTP_HOST: "127.0.0.1",
        SIP_ENABLED: "0",
        MEDIA_URL: "",
        MEDIA_SECRET: "",
        PLATFORM_DATABASE: database,
      };
      if (mode === "profile") {
        delete env.PLATFORM_DATABASE;
        await writeFile(
          join(cwd, ".env.test"),
          "PLATFORM_DATABASE=" +
            database.replaceAll("\\", "/") +
            "\nSIP_ENABLED=0\n",
        );
      }
      const entry = fileURLToPath(
        new URL(
          mode === "legacy" ? "./server.mjs" : "../scripts/start.mjs",
          import.meta.url,
        ),
      );
      const child = spawn(
        process.execPath,
        [entry, ...(mode === "profile" ? ["test"] : [])],
        { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      t.after(async () => {
        if (child.exitCode === null) {
          child.kill();
          await once(child, "exit");
        }
        await rm(cwd, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      });
      const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error("启动入口超时")), 10000);
        let output = "";
        child.once("error", reject);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(Error("启动入口提前退出 " + code));
        });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          for (const line of output.split("\n")) {
            try {
              const value = JSON.parse(line);
              if (value.event === "platform.started") {
                clearTimeout(timeout);
                resolve(value.port);
              }
            } catch {}
          }
        });
      });
      const base = "http://127.0.0.1:" + port;
      assert.equal((await fetch(base)).status, 200);
      const response = await fetch(base + "/api/health");
      assert.equal(response.status, 200);
      const health = (await response.json()).data;
      assert.equal(health.status, "ok");
      assert.equal(health.sip, "disabled");
      await access(database);
    },
  );

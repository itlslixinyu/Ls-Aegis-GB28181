import { spawn } from "node:child_process";
import { setPriority, constants } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as wait } from "node:timers/promises";
import { aiProblem } from "./settings.mjs";
export class AiCapture {
  constructor({ db, live, media, lowPriority = false }) {
    Object.assign(this, { db, live, media, lowPriority });
  }
  async frame(channel, userId, signal) {
    const viewer = this.live.create(channel, userId, undefined, {
      kind: "live",
      streamNumber: 0,
    });
    try {
      const deadline = Date.now() + 20000;
      let snapshot;
      do {
        signal.throwIfAborted();
        snapshot = this.live.snapshot(
          viewer.sessionId,
          userId,
          viewer.viewerId,
        );
        if (snapshot.state === "ready") break;
        if (["failed", "stopped"].includes(snapshot.state))
          throw aiProblem(
            502,
            "AI_CAPTURE_FAILED",
            snapshot.error || "设备点播失败",
          );
        await wait(250, undefined, { signal });
      } while (Date.now() < deadline);
      if (snapshot.state !== "ready")
        throw aiProblem(
          504,
          "AI_CAPTURE_TIMEOUT",
          "设备媒体就绪超时，请检查在线状态后重试",
        );
      const stream = this.db
        .prepare("SELECT streamId FROM live_sessions WHERE id=?")
        .get(viewer.sessionId)?.streamId;
      if (!stream) throw aiProblem(502, "AI_CAPTURE_FAILED", "媒体会话不存在");
      return await this.decode(stream, signal);
    } finally {
      await this.live
        .leave(viewer.sessionId, userId, viewer.viewerId)
        .catch(() => {});
    }
  }
  async decode(stream, signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      upstream = await this.media.openFlv(stream, combined);
    const config = this.media.config,
      command = config.aacPreviewContainer
        ? "docker"
        : config.aacPreviewExecutable || "ffmpeg",
      prefix = config.aacPreviewContainer
        ? [
            "exec",
            "-i",
            config.aacPreviewContainer,
            config.aacPreviewExecutable || "ffmpeg",
          ]
        : [];
    const child = spawn(
      command,
      [
        ...prefix,
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-f",
        "flv",
        "-i",
        "pipe:0",
        "-an",
        ...(this.lowPriority ? ["-filter_threads", "1", "-threads", "1"] : []),
        "-frames:v",
        "1",
        "-vf",
        "scale=1280:-2",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    if (this.lowPriority && child.pid) {
      try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Single-thread limits still apply. */ }
    }
    const source = Readable.fromWeb(upstream.body);
    let size = 0;
    const chunks = [];
    const abort = () => {
      source.destroy();
      child.stdin.destroy();
      child.kill();
    };
    combined.addEventListener("abort", abort, { once: true });
    const input = pipeline(source, child.stdin, { signal: combined }).catch(
      () => {},
    );
    try {
      return await new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            abort();
            reject(aiProblem(502, "AI_CAPTURE_TOO_LARGE", "抓拍输出过大"));
          } else chunks.push(chunk);
        });
        child.once("error", () =>
          reject(
            aiProblem(
              503,
              "AI_CAPTURE_UNAVAILABLE",
              "无法启动抓拍工具，请检查FFmpeg配置",
            ),
          ),
        );
        child.once("close", (code) =>
          code === 0 && size > 0
            ? resolve(Buffer.concat(chunks))
            : reject(
                aiProblem(
                  combined.aborted ? 504 : 502,
                  "AI_CAPTURE_FAILED",
                  combined.aborted
                    ? "抓拍超时或已取消"
                    : "抓拍失败，请检查媒体流和FFmpeg配置",
                ),
              ),
        );
      });
    } finally {
      combined.removeEventListener("abort", abort);
      source.destroy();
      child.stdin.destroy();
      if (child.exitCode === null) child.kill();
      await input;
    }
  }
}

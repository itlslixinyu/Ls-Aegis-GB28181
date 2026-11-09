import { spawn } from "node:child_process";
import { setPriority, constants } from "node:os";
import { aiProblem } from "./settings.mjs";
import { realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { motionChanges, WIDTH, HEIGHT } from "./motion.mjs";
export function archiveTimestamp(file) {
  const name = file.name.startsWith(file.date + "-")
    ? file.name.slice(11)
    : file.name;
  const m = /^(\d{2})-(\d{2})-(\d{2})(?:[-_.]|$)/.exec(name);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(file.date) ||
    !m ||
    +m[1] > 23 ||
    +m[2] > 59 ||
    +m[3] > 59
  )
    return null;
  const value = Date.parse(`${file.date}T${m[1]}:${m[2]}:${m[3]}+08:00`);
  return Number.isFinite(value) &&
    new Date(value + 8 * 3600000).toISOString().slice(0, 10) === file.date
    ? value
    : null;
}
export class AiArchiveReader {
  constructor(media) {
    this.media = media;
  }
  async run(tool, args, signal, maxBytes) {
    signal.throwIfAborted();
    const config = this.media.config,
      override = process.env.AI_ARCHIVE_FFMPEG_EXECUTABLE,
      container = !override && config.aacPreviewContainer,
      exe = override || config.aacPreviewExecutable || "ffmpeg";
    const executable =
      tool === "ffprobe" ? exe.replace(/ffmpeg(?=\.exe$|$)/i, "ffprobe") : exe;
    const command = container ? "docker" : executable;
    const prefix = container
      ? ["exec", "-i", config.aacPreviewContainer, executable]
      : [];
    const controller = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const child = spawn(command, [...prefix, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    try {
      if (child.pid)
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    const abort = () => child.kill();
    controller.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        const failed = () =>
          reject(
            aiProblem(
              controller.aborted ? 504 : 502,
              "AI_ARCHIVE_READ_FAILED",
              controller.aborted
                ? "录像读取超时或已暂停"
                : "录像文件不可读取，请检查文件是否完整及FFmpeg配置",
            ),
          );
        child.once("error", failed);
        child.stdout.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            abort();
            failed();
          } else chunks.push(chunk);
        });
        child.once("close", (code) =>
          code === 0 && size ? resolve(Buffer.concat(chunks)) : failed(),
        );
        if (controller.aborted) {
          abort();
          failed();
        }
      });
    } finally {
      controller.removeEventListener("abort", abort);
      if (child.exitCode === null) child.kill();
    }
  }
  source(file) {
    const url = new URL(this.media.recordingUrl(file.streamId, file));
    if (
      !process.env.AI_ARCHIVE_FFMPEG_EXECUTABLE &&
      this.media.config.aacPreviewContainer &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      url.hostname =
        process.env.AI_ARCHIVE_MEDIA_HOST ||
        this.media.config.rtpHost ||
        "host.docker.internal";
    return url.href;
  }
  async duration(file, signal) {
    const value = JSON.parse(
      (
        await this.run(
          "ffprobe",
          [
            "-v",
            "error",
            "-rw_timeout",
            "10000000",
            "-protocol_whitelist",
            "http,https,tcp,tls,crypto",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            this.source(file),
          ],
          signal,
          65536,
        )
      ).toString("utf8"),
    );
    const seconds = Number(value.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
      throw aiProblem(
        422,
        "AI_ARCHIVE_DURATION_INVALID",
        "录像实际时长无效或超过24小时",
      );
    return seconds;
  }
  async fingerprint(file, signal) {
    // A changed or unverifiable file must never reuse an old decoded frame.
    const url = this.media.recordingUrl(file.streamId, file);
    const localRoot = process.env.AI_ARCHIVE_LOCAL_ROOT;
    if (
      localRoot &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      const prefix = process.env.AI_ARCHIVE_LOCAL_URL_PREFIX || "/record/";
      if (
        prefix.startsWith("/") &&
        prefix.endsWith("/") &&
        url.pathname.startsWith(prefix)
      ) {
        const root = await realpath(localRoot);
        const suffix = decodeURIComponent(url.pathname.slice(prefix.length));
        const path = resolve(root, suffix);
        const underRoot = (value) => {
          const rel = relative(root, value);
          return rel && !rel.startsWith("..") && !isAbsolute(rel);
        };
        if (!underRoot(path))
          throw aiProblem(400, "AI_ARCHIVE_PATH_INVALID", "本地录像路径无效");
        const actual = await realpath(path);
        if (!underRoot(actual))
          throw aiProblem(
            400,
            "AI_ARCHIVE_PATH_INVALID",
            "本地录像路径超出配置目录",
          );
        const info = await stat(actual, { bigint: true });
        if (!info.isFile())
          throw aiProblem(502, "AI_ARCHIVE_READ_FAILED", "录像文件不可读取");
        signal.throwIfAborted();
        return JSON.stringify([
          actual,
          String(info.dev),
          String(info.ino),
          String(info.size),
          String(info.mtimeNs),
          String(info.ctimeNs),
        ]);
      }
    }
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok)
      throw aiProblem(502, "AI_ARCHIVE_READ_FAILED", "录像文件不可读取");
    const size = response.headers.get("content-length"),
      modified = response.headers.get("last-modified"),
      etag = response.headers.get("etag");
    return size && (modified || etag)
      ? JSON.stringify([
          file.streamId,
          file.date,
          file.name,
          size,
          modified,
          etag,
        ])
      : null;
  }
  async frame(file, offset, signal) {
    return this.run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-rw_timeout",
        "10000000",
        "-protocol_whitelist",
        "http,https,tcp,tls,crypto",
        "-ss",
        String(offset),
        "-i",
        this.source(file),
        "-an",
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      signal,
      2 * 1024 * 1024,
    );
  }
  async motion(file, begin, end, signal) {
    const seconds = Math.min(30, Math.max(0, end - begin));
    if (seconds < 1) return { events: [], scannedSeconds: 0 };
    const raw = await this.run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-rw_timeout",
        "10000000",
        "-protocol_whitelist",
        "http,https,tcp,tls,crypto",
        "-ss",
        String(begin),
        "-i",
        this.source(file),
        "-t",
        String(seconds),
        "-an",
        "-vf",
        `fps=1,scale=${WIDTH}:${HEIGHT},format=gray`,
        "-frames:v",
        "30",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      signal,
      WIDTH * HEIGHT * 31,
    );
    return {
      events: motionChanges(raw, begin),
      scannedSeconds: Math.min(
        seconds,
        Math.floor(raw.length / (WIDTH * HEIGHT)),
      ),
    };
  }
}

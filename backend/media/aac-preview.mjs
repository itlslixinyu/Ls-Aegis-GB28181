import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class AacPreview {
  active = 0;

  constructor({ executable = "ffmpeg", container, limit = 8 } = {}) {
    this.command = container ? "docker" : executable;
    this.prefix = container ? ["exec", "-i", container, executable] : [];
    this.limit = limit;
  }

  async open(openSource, signal, compatibility = false) {
    if (this.active >= this.limit) throw Error("音频转换连接数已达上限");
    this.active++;
    let upstream, child;
    try {
      upstream = await openSource();
      signal.throwIfAborted();
      child = spawn(
        this.command,
        [
          ...this.prefix,
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "flv",
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-map",
          "0:a:0",
          ...(compatibility
            ? [
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-threads",
                "2",
              ]
            : ["-c:v", "copy", "-bsf:v", "filter_units=remove_types=35|39|40"]),
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-b:a",
          "64k",
          ...(compatibility
            ? ["-flvflags", "no_duration_filesize"]
            : [
                "-tag:v",
                "hvc1",
                "-movflags",
                "empty_moov+default_base_moof+frag_keyframe",
              ]),
          "-flush_packets",
          "1",
          "-f",
          compatibility ? "flv" : "mp4",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
    } catch (error) {
      this.active--;
      await upstream?.body?.cancel().catch(() => {});
      throw error;
    }
    const stop = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      // Closing the input sends EOF to FFmpeg, including through docker exec.
      const timer = setTimeout(() => child.kill(), 1500);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    };
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", () => child.stdout.destroy(Error("无法启动音频转换")));
    child.once("close", () => {
      this.active--;
      signal.removeEventListener("abort", stop);
    });
    const source = Readable.fromWeb(upstream.body);
    child.stdout.once("close", () => source.destroy());
    void pipeline(source, child.stdin, { signal }).catch(() => {
      if (!signal.aborted && !child.stdout.destroyed)
        child.stdout.destroy(Error("音频转换输入已断开"));
    });
    const body = Readable.toWeb(child.stdout, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
    });
    const reader = body.getReader();
    // Wait for actual output so the caller's startup deadline covers FFmpeg.
    try {
      const first = await reader.read();
      if (first.done) throw Error("音频转换没有输出");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first.value);
          },
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel() {
            return reader.cancel();
          },
        }),
      );
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  }
}

// FFmpeg emits the initialization boxes before media fragments.
function hevcCodec(bytes: Uint8Array) {
  for (let i = 4; i + 17 < bytes.length; i++) {
    if (
      bytes[i] !== 104 ||
      bytes[i + 1] !== 118 ||
      bytes[i + 2] !== 99 ||
      bytes[i + 3] !== 67 ||
      bytes[i + 4] !== 1
    )
      continue;
    const flags = bytes[i + 5];
    const profileSpace = ["", "A", "B", "C"][flags >> 6];
    let compatibility = 0;
    for (let j = 0; j < 32; j++) {
      compatibility =
        compatibility * 2 + ((bytes[i + 9 - (j >> 3)] >> (j & 7)) & 1);
    }
    const constraints = Array.from(bytes.subarray(i + 10, i + 16));
    while (constraints.length && constraints.at(-1) === 0) constraints.pop();
    return [
      "hvc1",
      profileSpace + (flags & 31),
      compatibility.toString(16),
      (flags & 32 ? "H" : "L") + bytes[i + 16],
      ...constraints.map((value) => value.toString(16).padStart(2, "0")),
    ].join(".");
  }
}

function waitFor(
  target: EventTarget,
  event: string,
  signal: AbortSignal,
  action?: () => void,
) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    function finish(error?: unknown) {
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    }
    const done = () => finish();
    const failed = () => finish(Error("浏览器媒体缓冲失败"));
    const aborted = () => finish(signal.reason);
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      action?.();
    } catch (error) {
      finish(error);
    }
  });
}

export function openFragmentedPreview(
  video: HTMLVideoElement,
  url: string,
  onCodecs: (videoCodec: string) => void,
  onFailure: (error: unknown) => void,
) {
  const source = new MediaSource();
  const objectUrl = URL.createObjectURL(source);
  const controller = new AbortController();
  const signal = controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const startup = setTimeout(() => {
    if (
      !signal.aborted &&
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    )
      onFailure(Error("等待实时视频首帧超时"));
  }, 15000);
  const clearStartup = () => clearTimeout(startup);
  video.addEventListener("loadeddata", clearStartup, { once: true });
  const onVideoError = () => {
    if (!signal.aborted)
      onFailure(Error(video.error?.message || "浏览器无法解码实时视频"));
  };
  video.addEventListener("error", onVideoError);
  void (async () => {
    await waitFor(source, "sourceopen", signal, () => {
      video.src = objectUrl;
    });
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw Error("实时转换流不可用");
    reader = response.body.getReader();
    let initial = new Uint8Array(0);
    let buffer: SourceBuffer | undefined;
    let started = false;
    while (!signal.aborted) {
      const part = await reader.read();
      if (part.done) throw Error("实时转换流已断开");
      let bytes = part.value;
      if (!buffer) {
        const combined = new Uint8Array(initial.length + bytes.length);
        combined.set(initial);
        combined.set(bytes, initial.length);
        initial = combined;
        const codec = hevcCodec(initial);
        if (!codec) {
          if (initial.length > 1024 * 1024)
            throw Error("未收到 H.265 视频参数");
          continue;
        }
        const type = `video/mp4; codecs="${codec},mp4a.40.2"`;
        if (!MediaSource.isTypeSupported(type))
          throw Error("当前浏览器不支持此 H.265 实时编码");
        buffer = source.addSourceBuffer(type);
        bytes = initial;
        initial = new Uint8Array(0);
        onCodecs(codec);
      }
      const active = buffer;
      await waitFor(active, "updateend", signal, () =>
        active.appendBuffer(bytes.slice()),
      );
      if (!active.buffered.length) continue;
      const start = active.buffered.start(0);
      const end = active.buffered.end(active.buffered.length - 1);
      if (!started || end - video.currentTime > 10) {
        if (video.currentTime < start || end - video.currentTime > 10)
          video.currentTime = Math.max(start, end - 2);
        started = true;
      }
      if (video.currentTime - start > 20)
        await waitFor(active, "updateend", signal, () =>
          active.remove(start, video.currentTime - 10),
        );
    }
  })().catch((error) => {
    if (!signal.aborted) onFailure(error);
  });
  return {
    play: () => video.play(),
    pause: () => video.pause(),
    destroy() {
      clearStartup();
      video.removeEventListener("loadeddata", clearStartup);
      video.removeEventListener("error", onVideoError);
      controller.abort();
      void reader?.cancel().catch(() => {});
      URL.revokeObjectURL(objectUrl);
    },
  };
}

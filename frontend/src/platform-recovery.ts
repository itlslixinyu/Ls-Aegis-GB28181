interface PlatformHealth {
  instanceId: string;
  status: string;
  restartState?: string;
}

let probing: Promise<PlatformHealth | null> | null = null;
// Concurrent video windows share a health request, without sharing viewer leases.
export function probePlatform(): Promise<PlatformHealth | null> {
  if (!probing) {
    probing = (async () => {
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) return null;
        const value = (await response.json()).data;
        return typeof value?.instanceId === "string" &&
          typeof value.status === "string"
          ? (value as PlatformHealth)
          : null;
      } catch {
        return null;
      } finally {
        probing = null;
      }
    })();
  }
  return probing;
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export async function waitForPlatformRestart(
  previousInstance: string,
  {
    signal,
    timeoutMs = 90000,
    pollMs = 1000,
  }: { signal: AbortSignal; timeoutMs?: number; pollMs?: number },
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const health = await probePlatform();
    if (signal.aborted) return null;
    if (health) {
      if (health.instanceId !== previousInstance)
        return health.status === "ok" ? health.instanceId : null;
      // An ordinary device/media error must not trigger repeated device commands.
      if (health.status === "ok" && health.restartState !== "accepted")
        return null;
      if (health.restartState === "failed") return null;
    }
    await pause(pollMs, signal);
  }
  return null;
}

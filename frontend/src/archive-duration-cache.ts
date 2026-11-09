type Cached = { duration: number; at: number };
type Pending = {
  controller: AbortController;
  users: number;
  settled: boolean;
  promise: Promise<number>;
};
const ttl = 30 * 60 * 1000;
const limit = 1024;
const cache = new Map<string, Cached>();
const pending = new Map<string, Pending>();
const loaded = new Set<string>();
const keyOf = (scope: string, url: string) => JSON.stringify([scope, url]);
const storageKey = (scope: string) => `ls-aegis:archive-durations:${scope}`;
const valid = (entry: Cached) =>
  Number.isFinite(entry?.duration) &&
  entry.duration > 0 &&
  Number.isFinite(entry.at) &&
  entry.at <= Date.now() &&
  Date.now() - entry.at < ttl;

function restore(scope: string) {
  if (loaded.has(scope)) return;
  loaded.add(scope);
  try {
    const entries = JSON.parse(
      sessionStorage.getItem(storageKey(scope)) || "[]",
    );
    if (!Array.isArray(entries) || entries.length > limit) return;
    for (const [url, value] of entries) {
      if (typeof url === "string" && url.length <= 4096 && valid(value))
        cache.set(keyOf(scope, url), value);
    }
  } catch {
    /* Storage is optional; failed reads never manufacture coverage. */
  }
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}
function save(scope: string) {
  try {
    const entries: [string, Cached][] = [];
    for (const [key, value] of cache) {
      const [owner, url] = JSON.parse(key);
      if (owner === scope && valid(value)) entries.push([url, value]);
    }
    sessionStorage.setItem(storageKey(scope), JSON.stringify(entries));
  } catch {
    /* A full or blocked storage falls back to the bounded memory cache. */
  }
}
export function cachedArchiveDuration(
  scope: string,
  url: string,
): number | undefined {
  restore(scope);
  const key = keyOf(scope, url),
    value = cache.get(key);
  if (!value || !valid(value)) {
    cache.delete(key);
    return;
  }
  cache.delete(key);
  cache.set(key, value);
  return value.duration;
}

// Every window subscribes independently. Closing one must not cancel another's probe.
export function readArchiveDuration(
  scope: string,
  url: string,
  probe: (signal: AbortSignal) => Promise<number>,
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) return Promise.resolve(0);
  const cached = cachedArchiveDuration(scope, url);
  if (cached !== undefined) return Promise.resolve(cached);
  const key = keyOf(scope, url);
  let job = pending.get(key);
  if (!job) {
    job = {
      controller: new AbortController(),
      users: 0,
      settled: false,
      promise: Promise.resolve(0),
    };
    const entry = job;
    pending.set(key, entry);
    entry.promise = Promise.resolve()
      .then(() => probe(entry.controller.signal))
      .then(
        (value) => finish(value),
        () => finish(0),
      );
    function finish(value: number) {
      entry.settled = true;
      if (pending.get(key) === entry) pending.delete(key);
      const duration = Number.isFinite(value) && value > 0 ? value : 0;
      if (duration && !entry.controller.signal.aborted) {
        cache.delete(key);
        cache.set(key, { duration, at: Date.now() });
        while (cache.size > limit) cache.delete(cache.keys().next().value!);
        save(scope);
      }
      return duration;
    }
  }
  const entry = job;
  entry.users++;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: number) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      entry.users--;
      if (!entry.users && !entry.settled) {
        if (pending.get(key) === entry) pending.delete(key);
        entry.controller.abort();
      }
      resolve(value);
    };
    const abort = () => finish(0);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else entry.promise.then(finish);
  });
}

export function clearArchiveDurationCache() {
  for (const job of pending.values()) job.controller.abort();
  pending.clear();
  cache.clear();
  loaded.clear();
}

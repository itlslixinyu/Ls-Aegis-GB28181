import { validThumbnail, type VideoThumbnail } from "./video-thumbnail";

// Browser-local snapshots are scoped to the authenticated account. Only IDs
// returned by the authorized channel list are read back into the visible list.
let connection: Promise<IDBDatabase | null> | undefined;
function database() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return (connection ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open("ls-aegis-thumbnails", 2);
      request.onupgradeneeded = () => {
        const store = request.result.objectStoreNames.contains("frames")
          ? request.transaction!.objectStore("frames")
          : request.result.createObjectStore("frames", {
              keyPath: ["accountId", "channelId"],
            });
        if (!store.indexNames.contains("accountId"))
          store.createIndex("accountId", "accountId");
        if (!store.indexNames.contains("accountCaptured"))
          store.createIndex("accountCaptured", ["accountId", "capturedAt"]);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connection = undefined;
        };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}
export async function readThumbnails(accountId: string, channelIds: string[]) {
  const result: Record<string, VideoThumbnail> = {};
  try {
    const db = await database();
    if (!db || !accountId) return result;
    return await new Promise<Record<string, VideoThumbnail>>((resolve) => {
      const tx = db.transaction("frames", "readonly"),
        store = tx.objectStore("frames");
      for (const id of new Set(channelIds)) {
        const req = store.get([accountId, id]);
        req.onsuccess = () => {
          if (validThumbnail(req.result))
            result[id] = {
              pixels: req.result.pixels,
              capturedAt: req.result.capturedAt,
            };
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => resolve({});
    });
  } catch {
    return result;
  }
}
export async function saveThumbnail(
  accountId: string,
  channelId: string,
  frame: VideoThumbnail,
) {
  try {
    if (!accountId || !validThumbnail(frame)) return false;
    const db = await database();
    if (!db) return false;
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction("frames", "readwrite"),
        store = tx.objectStore("frames");
      store.put({
        accountId,
        channelId,
        pixels: frame.pixels,
        capturedAt: frame.capturedAt,
      });
      const all = store
        .index("accountCaptured")
        .openKeyCursor(
          IDBKeyRange.bound(
            [accountId, 0],
            [accountId, Number.MAX_SAFE_INTEGER],
          ),
          "prev",
        );
      let count = 0;
      all.onsuccess = () => {
        const cursor = all.result;
        if (!cursor) return;
        if (++count > 64) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(true);
      tx.onabort = tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}
export async function clearAccountThumbnails(accountId: string) {
  try {
    const db = await database();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction("frames", "readwrite"),
        store = tx.objectStore("frames");
      const req = store.index("accountId").getAllKeys(accountId);
      req.onsuccess = () => req.result.forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => resolve();
    });
  } catch {
    /* Storage is optional; playback must remain available. */
  }
}

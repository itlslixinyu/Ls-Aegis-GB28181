import { currentUser, refreshCurrentUser } from "./api";

// Notifications contain no grants; always reload the authenticated /me snapshot.
// A change arriving during that request requires another snapshot, not a stale
// single-flight result. The caller's generation prevents old-account remounts.
export function connectAuthorizationUpdates(onChanged: () => void) {
  const userId = currentUser.value?.id;
  if (!userId || typeof EventSource === "undefined") return () => {};
  const source = new EventSource("/api/v1/me/authorization-events");
  let closed = false,
    dirty = false,
    syncing = false;
  const sync = async () => {
    if (closed || currentUser.value?.id !== userId) return;
    dirty = true;
    if (syncing) return;
    syncing = true;
    try {
      do {
        dirty = false;
        await refreshCurrentUser();
      } while (dirty && !closed && currentUser.value?.id === userId);
      if (!closed && currentUser.value?.id === userId) onChanged();
    } catch {
      // Existing periodic/403 refresh remains available when reconnecting.
    } finally {
      syncing = false;
    }
  };
  source.addEventListener("authorization", sync);
  source.addEventListener("expired", () => {
    if (closed || currentUser.value?.id !== userId) return;
    source.close();
    void refreshCurrentUser().catch(() => {});
  });
  return () => {
    closed = true;
    source.close();
  };
}

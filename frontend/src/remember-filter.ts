import { ref, watch } from "vue";
import { currentUser } from "./api";

export function rememberFilter<T extends string | number>(
  key: string,
  fallback: T,
  accepts: (value: T) => boolean = () => true,
) {
  const account = currentUser.value?.id;
  const storageKey = `ls-aegis:filter:${account}:${key}`;
  let initial = fallback;
  if (account) {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(storageKey) ?? "null",
      );
      if (
        typeof saved === typeof fallback &&
        (typeof saved !== "number" ||
          (Number.isSafeInteger(saved) && saved >= 0)) &&
        accepts(saved as T)
      )
        initial = saved as T;
    } catch {
      // Browser storage is optional.
    }
  }
  const value = ref<T>(initial);
  watch(
    value,
    (next) => {
      if (!account || currentUser.value?.id !== account) return;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Browser storage is optional.
      }
    },
    { flush: "sync" },
  );
  return value;
}

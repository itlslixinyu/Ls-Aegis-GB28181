import { reactive, ref, watch } from "vue";

export const themes = [
  { id: "government", label: "政务蓝" },
  { id: "classic", label: "经典蓝" },
  { id: "teal", label: "青碧" },
  { id: "slate", label: "深海灰" },
] as const;

const storageKey = "ls-aegis.appearance";
type Theme = (typeof themes)[number]["id"];
function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    return themes.find((theme) => theme.id === saved)?.id ?? "government";
  } catch {
    return "government";
  }
}

export const appearance = ref<Theme>(readTheme());
const defaults = {
  darkSidebar: false,
  breadcrumbs: true,
  tableBorders: true,
  compactTable: false,
  tabs: true,
};
const layoutKey = "ls-aegis.layout";
function readLayout() {
  const layout = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) ?? "{}");
    for (const key of Object.keys(layout) as (keyof typeof layout)[]) {
      if (typeof saved?.[key] === "boolean") layout[key] = saved[key];
    }
  } catch {}
  return layout;
}
export const layout = reactive(readLayout());
export function resetAppearance() {
  appearance.value = "government";
  Object.assign(layout, defaults);
}
watch(
  layout,
  () => {
    const root = document.documentElement;
    root.classList.toggle("dark-sidebar", layout.darkSidebar);
    root.classList.toggle("borderless-tables", !layout.tableBorders);
    root.classList.toggle("compact-tables", layout.compactTable);
    try {
      localStorage.setItem(layoutKey, JSON.stringify(layout));
    } catch {}
  },
  { immediate: true, flush: "sync" },
);
watch(
  appearance,
  (theme) => {
    document.documentElement.dataset.appearance = theme;
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // The selection still applies when storage is unavailable.
    }
  },
  { immediate: true, flush: "sync" },
);

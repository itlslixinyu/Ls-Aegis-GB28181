<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const paths: Record<string, string> = {
  ai: "M8 3h8v4h4v10h-4v4H8v-4H4V7h4Zm0 4h8v10H8Zm2 3v4m4-4v4M1 10h3m16 0h3M1 14h3m16 0h3",
  ptz: "M12 3v5m0 8v5M3 12h5m8 0h5M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  "play-all": "M5 3h16v14M3 7h14v14H3Zm5 4 5 3-5 3Z",
  "close-all": "M5 3h16v14M3 7h14v14H3Zm4 4 6 6m0-6-6 6",
  play: "M8 4l12 8-12 8Z",
  pause: "M7 4v16M17 4v16",
  "fast-forward": "M3 5l9 7-9 7ZM12 5l9 7-9 7Z",
  "fast-rewind": "M21 5l-9 7 9 7ZM12 5l-9 7 9 7Z",
  "volume-on": "M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  "volume-off": "M3 9h4l5-4v14l-5-4H3Zm13 0 6 6m0-6-6 6",
  expand: "M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6",
  restore: "M9 3v6H3m18 0h-6V3M3 15h6v6m6 0v-6h6",
  fullscreen: "M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5",
  moon: "M20.5 14.1A8.6 8.6 0 0 1 9.9 3.5 8.7 8.7 0 1 0 20.5 14.1Z",
  chevron: "M6 9l6 6 6-6",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  config:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9.6 2h4.8l.6 2.6 2.3 1.3 2.5-.8 2.4 4.2-1.9 1.8v2.6l1.9 1.8-2.4 4.2-2.5-.8-2.3 1.3-.6 2.6H9.6L9 20.2l-2.3-1.3-2.5.8-2.4-4.2 1.9-1.8v-2.6L1.8 9.3l2.4-4.2 2.5.8L9 4.6Z",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 1a4 4 0 0 1 0 8m5 9v-2a4 4 0 0 0-3-3.9",
  groups: "M3 4h7v7H3ZM14 4h7v7h-7ZM3 15h7v7H3ZM14 15h7v7h-7Z",
  devices: "M3 5h12v10H3ZM15 8l6-3v10l-6-3M5 20h8m-4-5v5",
  monitoring: "M3 4h18v13H3Zm5 17h8m-4-4v4M10 8l5 3-5 3Z",
  plans: "M4 5h16v16H4Zm3-3v6m10-6v6M4 10h16m-12 4h2m4 0h2m-8 3h2",
  records: "M4 3h16v18H4ZM4 8h16M8 3v5m8-5v5m-6 4 5 3-5 3Z",
  jobs: "M5 3h10l4 4v14H5ZM14 3v5h5m-7 3v7m-3-3 3 3 3-3",
  subscriptions:
    "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4m7-17-2-2M3 4l2-2",
  alarms: "M12 3 2 20h20ZM12 9v5m0 3v.1",
  map: "M8 19 2 21V5l6-2 8 2 6-2v16l-6 2Zm0-16v16m8-14v16",
  tracks:
    "M7 6a3 3 0 1 0 0 .1ZM17 18a3 3 0 1 0 0 .1ZM10 6h7a4 4 0 0 1 0 8H7a4 4 0 0 0 0 8h7",
  cascade: "M9 3h6v6H9ZM2 16h6v6H2Zm14 0h6v6h-6ZM12 9v4M5 16v-3h14v3",
  audit: "M5 3h14v18H5Zm4 5h6m-6 4h6m-6 4h4",
  menu: "M4 6h16M4 12h16M4 18h16",
  fold: "M4 4h16v16H4Zm4 0v16m8-12-4 4 4 4",
  home: "M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8",
  logout: "M9 4H4v16h5m5-13 5 5-5 5M8 12h12",
  user: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2",
  lock: "M5 10h14v11H5Zm3 0V7a4 4 0 0 1 8 0v3m-4 4v3",
  plus: "M12 5v14M5 12h14",
  refresh:
    "M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  close: "M6 6l12 12M6 18 18 6",
  stop: "M6 6h12v12H6Z",
  folder: "M3 5h7l2 3h9v12H3Z",
  pin: "M12 22s8-7 8-13a8 8 0 1 0-16 0c0 6 8 13 8 13ZM12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
};
</script>
<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name] || paths.devices" />
  </svg>
</template>

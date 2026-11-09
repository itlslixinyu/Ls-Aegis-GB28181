<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addMapBase } from "../map-base";
import { api, ApiError, messageOf, type Device } from "../api";
const props = defineProps<{ initialDevice?: string }>();
interface Point {
  id: string;
  targetCode: string;
  longitude: number;
  latitude: number;
  occurredAt: string;
  receivedAt: string;
}
interface Result {
  items: Point[];
  total: number;
  nextCursor: string | null;
  retentionDays: number;
}
const devices = ref<Device[]>([]),
  deviceId = ref(""),
  deviceQuery = ref(""),
  targets = ref<{ code: string; name: string }[]>([]),
  targetCode = ref(""),
  points = ref<Point[]>([]),
  total = ref(0),
  cursor = ref<string | null>(null),
  message = ref(""),
  busy = ref(false),
  searched = ref(false),
  tileConfigured = ref(false),
  tileError = ref(false),
  retentionDays = ref(30),
  host = ref<HTMLElement>(),
  index = ref(0),
  playing = ref(false),
  rowPage = ref(0);
const localTime = (time: Date) => {
  const shifted = new Date(time.getTime() - time.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 19);
};
const end = ref(localTime(new Date())),
  start = ref(localTime(new Date(Date.now() - 3600000))),
  selected = computed(() => points.value[index.value]),
  visibleRows = computed(() =>
    points.value.slice(rowPage.value * 50, rowPage.value * 50 + 50),
  );
let map: L.Map | undefined,
  layers: L.LayerGroup | undefined,
  marker: L.CircleMarker | undefined,
  resize: ResizeObserver | undefined,
  animation: ReturnType<typeof setInterval> | undefined,
  scopeTimer: ReturnType<typeof setInterval> | undefined,
  alive = true,
  generation = 0,
  deviceGeneration = 0,
  targetGeneration = 0,
  requestParams = "";
const time = (v: string) => new Date(v).toLocaleString();
function stop() {
  playing.value = false;
  clearInterval(animation);
}
function clear() {
  stop();
  generation++;
  busy.value = false;
  message.value = "";
  points.value = [];
  total.value = 0;
  cursor.value = null;
  searched.value = false;
  index.value = 0;
  rowPage.value = 0;
  layers?.clearLayers();
  marker?.remove();
  marker = undefined;
}
async function loadDevices() {
  const gen = ++deviceGeneration;
  try {
    const data = await api<{ items: Device[] }>(
      "/devices?" +
        new URLSearchParams({ q: deviceQuery.value, pageSize: "100" }),
    );
    if (alive && gen === deviceGeneration) {
      devices.value = data.items;
      if (
        deviceId.value &&
        !devices.value.some((d) => d.id === deviceId.value)
      ) {
        try {
          const d = await api<Device>("/devices/" + deviceId.value);
          if (alive && gen === deviceGeneration) devices.value.push(d);
        } catch {
          if (alive && gen === deviceGeneration) {
            deviceId.value = "";
            clear();
          }
        }
      }
    }
  } catch (e) {
    message.value = messageOf(e);
  }
}
async function changeDevice() {
  clear();
  const gen = ++targetGeneration;
  targets.value = [];
  targetCode.value = "";
  if (!deviceId.value) return;
  try {
    const data = await api<{ items: { code: string; name: string }[] }>(
      "/devices/" + deviceId.value + "/position-targets",
    );
    if (alive && gen === targetGeneration) {
      targets.value = data.items;
      targetCode.value = data.items[0]?.code || "";
    }
  } catch (e) {
    message.value = messageOf(e);
  }
}
watch(deviceId, changeDevice);
watch([targetCode, start, end], () => clear());
function draw() {
  if (!map || !layers) return;
  layers.clearLayers();
  let segment: L.LatLngTuple[] = [];
  const flush = () => {
    if (segment.length > 1)
      L.polyline(segment, { color: "#245f99", weight: 4, opacity: 0.85 }).addTo(
        layers!,
      );
    segment = [];
  };
  let previous: Point | undefined;
  for (const p of points.value) {
    if (
      previous &&
      (Date.parse(p.occurredAt) - Date.parse(previous.occurredAt) > 300000 ||
        Math.abs(p.longitude - previous.longitude) > 180)
    )
      flush();
    segment.push([p.latitude, p.longitude]);
    previous = p;
  }
  flush();
  if (points.value.length) {
    const first = points.value[0],
      last = points.value.at(-1)!;
    for (const [p, color, label] of [
      [first, "#168369", "起点"],
      [last, "#bc3b3b", "终点"],
    ] as const) {
      const tip = document.createElement("span");
      tip.textContent = label + " · " + time(p.occurredAt);
      L.circleMarker([p.latitude, p.longitude], {
        radius: 7,
        color,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindTooltip(tip)
        .addTo(layers);
    }
  }
  renderCursor();
}
function fit() {
  if (map && points.value.length)
    map.fitBounds(
      L.latLngBounds(
        points.value.map((p) => [p.latitude, p.longitude] as L.LatLngTuple),
      ),
      { padding: [35, 35], maxZoom: 16 },
    );
}
function renderCursor() {
  if (!map) return;
  const p = selected.value;
  if (!p) {
    marker?.remove();
    marker = undefined;
    return;
  }
  if (!marker)
    marker = L.circleMarker([p.latitude, p.longitude], {
      radius: 10,
      color: "#c88b21",
      weight: 3,
      fillColor: "#fff1c9",
      fillOpacity: 1,
    }).addTo(map);
  else marker.setLatLng([p.latitude, p.longitude]);
  marker.bringToFront();
}
function select(i: number, pan = false) {
  index.value = i;
  rowPage.value = Math.floor(i / 50);
  renderCursor();
  if (pan && selected.value)
    map?.panTo([selected.value.latitude, selected.value.longitude]);
}
function play() {
  if (playing.value) {
    stop();
    return;
  }
  if (!points.value.length) return;
  if (index.value >= points.value.length - 1) select(0);
  playing.value = true;
  animation = setInterval(() => {
    if (index.value >= points.value.length - 1) {
      stop();
      return;
    }
    select(index.value + 1, true);
  }, 500);
}
async function query(more = false) {
  if (busy.value || !deviceId.value || !targetCode.value) return;
  stop();
  message.value = "";
  if (!more) {
    clear();
    try {
      const a = new Date(start.value),
        b = new Date(end.value);
      if (
        !start.value ||
        !end.value ||
        !Number.isFinite(a.getTime()) ||
        !Number.isFinite(b.getTime()) ||
        a > b ||
        b.getTime() - a.getTime() > 7 * 86400000
      )
        throw Error("请选择最多7天的有效时间范围");
      requestParams = new URLSearchParams({
        start: a.toISOString(),
        end: b.toISOString(),
        targetCode: targetCode.value,
        limit: "1000",
      }).toString();
    } catch (e) {
      message.value = messageOf(e);
      return;
    }
  }
  const gen = ++generation;
  busy.value = true;
  try {
    const result = await api<Result>(
      "/devices/" +
        deviceId.value +
        "/positions?" +
        requestParams +
        (more && cursor.value
          ? "&cursor=" + encodeURIComponent(cursor.value)
          : ""),
    );
    if (!alive || gen !== generation) return;
    points.value = more ? [...points.value, ...result.items] : result.items;
    total.value = result.total;
    cursor.value = result.nextCursor;
    retentionDays.value = result.retentionDays;
    searched.value = true;
    draw();
    if (!more) {
      select(0);
      fit();
    }
  } catch (e) {
    if (alive && gen === generation) {
      const retryable =
        !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
      if (!more || !retryable) clear();
      message.value = messageOf(e);
    }
  } finally {
    if (alive && gen === generation) busy.value = false;
  }
}
function exportPoints() {
  if (!points.value.length) return;
  const rows = [
    "设备/通道编号,时间(UTC),经度(WGS84),纬度(WGS84)",
    ...points.value.map((p) =>
      [p.targetCode, p.occurredAt, p.longitude, p.latitude].join(","),
    ),
  ];
  const url = URL.createObjectURL(
    new Blob(["\ufeff" + rows.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "position-history.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(async () => {
  try {
    const config = await api<{ tileConfigured: boolean; attribution: string }>(
      "/map/config",
    );
    if (!alive || !host.value) return;
    tileConfigured.value = config.tileConfigured;
    map = L.map(host.value, {
      center: [35, 105],
      zoom: 4,
      minZoom: 2,
      maxZoom: 19,
    });
    addMapBase(map, config.tileConfigured, config.attribution, () => {
      tileError.value = true;
    });
    layers = L.layerGroup().addTo(map);
    resize = new ResizeObserver(() => map?.invalidateSize());
    resize.observe(host.value);
    await loadDevices();
    if (!alive) return;
    if (props.initialDevice) deviceId.value = props.initialDevice;
  } catch (e) {
    message.value = messageOf(e);
  }
  if (!alive) return;
  scopeTimer = setInterval(async () => {
    const id = deviceId.value;
    if (!id) return;
    try {
      await api("/devices/" + id);
    } catch {
      if (alive && id === deviceId.value) {
        clear();
        deviceId.value = "";
        message.value = "设备访问检查失败，请刷新或重新选择。";
        void loadDevices();
      }
    }
  }, 15000);
});
onUnmounted(() => {
  alive = false;
  generation++;
  deviceGeneration++;
  targetGeneration++;
  stop();
  clearInterval(scopeTimer);
  resize?.disconnect();
  map?.remove();
});
</script>
<template>
  <section class="trajectories-view business-page">
    <div class="title">
      <div>
        <h1>历史轨迹回溯</h1>
        <p>按设备、目标与时间检索实际位置上报，查看采样点和逐点播放。</p>
      </div>
      <button
        class="secondary"
        :disabled="!points.length"
        @click="exportPoints"
      >
        导出已加载点
      </button>
    </div>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <div class="panel trajectory-filter">
      <form class="business-filters" @submit.prevent="query(false)">
        <label
          >查找设备<input
            v-model="deviceQuery"
            maxlength="100"
            placeholder="名称或编号，最多显示100台"
            @input="loadDevices" /></label
        ><label
          >目标设备<select v-model="deviceId" required>
            <option value="" disabled>请选择授权设备</option>
            <option v-for="d in devices" :key="d.id" :value="d.id">
              {{ d.name }}
            </option>
          </select></label
        ><label
          >位置目标<select
            v-model="targetCode"
            required
            :disabled="!targets.length"
          >
            <option v-for="t in targets" :key="t.code" :value="t.code">
              {{ t.name }} · {{ t.code }}
            </option>
          </select></label
        ><label
          >开始时间<input
            v-model="start"
            type="datetime-local"
            step="1"
            required /></label
        ><label
          >结束时间<input
            v-model="end"
            type="datetime-local"
            step="1"
            required /></label
        ><button :disabled="busy || !targetCode">
          {{ busy ? "正在查询…" : "查询轨迹" }}
        </button>
      </form>
    </div>
    <div class="panel trajectory-map">
      <div class="panel-heading">
        <h3>轨迹视图</h3>
        <span>{{
          tileConfigured ? "地理底图 · WGS84" : "坐标视图 · 未配置地理底图"
        }}</span
        ><button class="link" :disabled="!points.length" @click="fit">
          适配轨迹
        </button>
      </div>
      <div ref="host" class="trajectory-canvas" aria-label="历史轨迹地图"></div>
      <p v-if="tileError" class="map-warning">
        底图服务暂不可用，轨迹坐标仍可查看。
      </p>
      <p class="panel-note">
        仅展示设备实际上报点；相隔超过5分钟或跨180°经线时断开连线。连线不表示实际道路，手工定位不生成轨迹。保留{{
          retentionDays
        }}天，单次最多查询7天。
      </p>
      <div class="trajectory-playback">
        <button class="secondary" :disabled="!points.length" @click="play">
          {{ playing ? "暂停" : "逐点播放" }}</button
        ><input
          :value="index"
          aria-label="轨迹采样进度"
          type="range"
          min="0"
          :max="Math.max(0, points.length - 1)"
          :disabled="!points.length"
          @input="
            stop();
            select(Number(($event.target as HTMLInputElement).value));
          "
        /><span
          >{{ points.length ? index + 1 : 0 }} / {{ points.length }} 点</span
        ><span>{{ selected ? time(selected.occurredAt) : "暂无采样点" }}</span>
      </div>
      <p class="panel-note">
        逐点播放速度：每0.5秒一个采样点。已加载 {{ points.length }} /
        {{ total }} 点，不插值或补造缺失位置。
      </p>
    </div>
    <div class="panel">
      <div class="panel-heading">
        <h3>位置采样记录</h3>
        <button
          class="secondary"
          :disabled="busy || !cursor || points.length >= 10000"
          @click="query(true)"
        >
          {{
            cursor
              ? points.length >= 10000
                ? "已达10000点，请缩小时间范围"
                : "加载后续采样点"
              : "已加载全部结果"
          }}
        </button>
      </div>
      <div
        class="table-scroll data-table-scroll"
        tabindex="0"
        role="region"
        aria-label="表格内容，可横向滚动"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">上报时间</th>
              <th scope="col">经度</th>
              <th scope="col">纬度</th>
              <th scope="col">目标编号</th>
              <th scope="col">定位</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(p, n) in visibleRows"
              :key="p.id"
              :class="{ 'active-track-row': p.id === selected?.id }"
            >
              <td>{{ rowPage * 50 + n + 1 }}</td>
              <td class="cell-date">{{ time(p.occurredAt) }}</td>
              <td class="mono">{{ p.longitude.toFixed(6) }}</td>
              <td class="mono">{{ p.latitude.toFixed(6) }}</td>
              <td class="mono">{{ p.targetCode }}</td>
              <td>
                <button
                  class="link"
                  @click="
                    stop();
                    select(rowPage * 50 + n, true);
                  "
                >
                  查看点位
                </button>
              </td>
            </tr>
            <tr v-if="!points.length">
              <td colspan="6" class="empty-state">
                {{
                  busy
                    ? "正在读取位置记录…"
                    : searched
                      ? "该时间段没有已保存的位置上报。"
                      : "选择设备与时间后查询历史轨迹。"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button class="secondary" :disabled="rowPage === 0" @click="rowPage--">
          上一页</button
        ><span>第 {{ rowPage + 1 }} 页 · 已加载 {{ points.length }} 点</span
        ><button
          class="secondary"
          :disabled="(rowPage + 1) * 50 >= points.length"
          @click="rowPage++"
        >
          下一页
        </button>
      </div>
    </div>
  </section>
</template>

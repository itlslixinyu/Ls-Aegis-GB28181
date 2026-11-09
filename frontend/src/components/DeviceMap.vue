<script setup lang="ts">
import { can } from "../api";
import { rememberFilter } from "../remember-filter";
import DialogHeading from "./DialogHeading.vue";
import { ref, computed, onMounted, onUnmounted } from "vue";
import * as L from "leaflet";
import { addMapBase } from "../map-base";
import "leaflet/dist/leaflet.css";
import { api, currentUser, messageOf } from "../api";
interface Point {
  id: string;
  deviceId: string;
  name: string;
  status: string;
  groupId: string;
  groupName: string;
  longitude: number | null;
  latitude: number | null;
  address: string | null;
  source: string | null;
  updatedAt: string | null;
  alarms: number;
}
const emit = defineEmits<{
  preview: [channelId: string];
  track: [deviceId: string];
}>();
const host = ref<HTMLElement>(),
  items = ref<Point[]>([]),
  groups = ref<{ id: string; name: string }[]>([]),
  selectedId = ref(""),
  query = rememberFilter("map.query", ""),
  groupId = rememberFilter("map.group", ""),
  message = ref(""),
  loadError = ref(""),
  tileConfigured = ref(false),
  tileError = ref(false),
  busy = ref(false),
  editor = ref<HTMLDialogElement>(),
  editId = ref(""),
  longitude = ref<number | "">(""),
  latitude = ref<number | "">(""),
  address = ref(""),
  armed = ref(false);
const selected = computed(() =>
    items.value.find((p) => p.id === selectedId.value),
  ),
  filtered = computed(() =>
    items.value.filter((p) =>
      (p.name + p.deviceId).toLowerCase().includes(query.value.toLowerCase()),
    ),
  ),
  located = computed(() =>
    filtered.value.filter((p) => p.longitude !== null && p.latitude !== null),
  );
let map: L.Map | undefined,
  layers: L.LayerGroup | undefined,
  resize: ResizeObserver | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  alive = true,
  first = true,
  generation = 0;
function draw() {
  if (!map || !layers) return;
  layers.clearLayers();
  for (const p of located.value) {
    const icon = L.divIcon({
      className:
        "camera-pin " +
        (p.alarms
          ? "has-alarm"
          : p.status === "online"
            ? "is-online"
            : "is-offline"),
      html: '<span aria-hidden="true">▣</span>',
      iconSize: [28, 32],
      iconAnchor: [14, 30],
    });
    const marker = L.marker([p.latitude!, p.longitude!], {
      icon,
      keyboard: true,
      title: p.name,
      alt: "设备位置：" + p.name,
    });
    marker.on("click", () => {
      selectedId.value = p.id;
    });
    marker.addTo(layers);
  }
  if (first && located.value.length) {
    fit();
    first = false;
  }
}
function fit() {
  if (!map || !located.value.length) return;
  map.fitBounds(
    L.latLngBounds(
      located.value.map((p) => [p.latitude!, p.longitude!] as [number, number]),
    ),
    { padding: [35, 35], maxZoom: 15 },
  );
}
function pick(p: Point) {
  selectedId.value = p.id;
  if (p.latitude !== null && p.longitude !== null)
    map?.setView([p.latitude, p.longitude], Math.max(map.getZoom(), 14));
}
async function load() {
  const gen = ++generation;
  try {
    const data = await api<{
      items: Point[];
      tileConfigured: boolean;
      attribution: string;
    }>("/map?groupId=" + encodeURIComponent(groupId.value));
    if (!alive || gen !== generation) return;
    items.value = data.items;
    if (!map) {
      tileConfigured.value = data.tileConfigured;
      initialize(data.attribution);
    }
    draw();
    loadError.value = "";
  } catch (e) {
    if (alive && gen === generation) loadError.value = messageOf(e);
  }
}
function initialize(attribution: string) {
  if (!host.value) return;
  map = L.map(host.value, {
    center: [35, 105],
    zoom: 4,
    minZoom: 2,
    maxZoom: 19,
    worldCopyJump: true,
    attributionControl: true,
  });
  layers = L.layerGroup().addTo(map);
  addMapBase(map, tileConfigured.value, attribution, () => {
    tileError.value = true;
  });
  map.on("click", (event: L.LeafletMouseEvent) => {
    if (!armed.value) return;
    longitude.value = Number(event.latlng.wrap().lng.toFixed(6));
    latitude.value = Number(event.latlng.lat.toFixed(6));
    editId.value = selectedId.value;
    address.value = "";
    armed.value = false;
    editor.value?.showModal();
  });
  resize = new ResizeObserver(() => map?.invalidateSize());
  resize.observe(host.value);
}
async function poll() {
  await load();
  if (alive) timer = setTimeout(poll, 15000);
}
onMounted(async () => {
  await poll();
  try {
    groups.value = (
      await api<{ items: { id: string; name: string }[] }>("/groups")
    ).items;
    if (!alive) return;
    if (groupId.value && !groups.value.some((g) => g.id === groupId.value)) {
      groupId.value = "";
      await load();
    }
  } catch (e) {
    message.value = messageOf(e);
  }
});
onUnmounted(() => {
  alive = false;
  clearTimeout(timer);
  resize?.disconnect();
  map?.remove();
});
function edit(p: Point) {
  editId.value = p.id;
  longitude.value = p.longitude ?? "";
  latitude.value = p.latitude ?? "";
  address.value = p.address || "";
  message.value = "";
  editor.value?.showModal();
}
async function save() {
  busy.value = true;
  message.value = "";
  try {
    await api(`/devices/${editId.value}/location`, "PUT", {
      longitude: longitude.value,
      latitude: latitude.value,
      address: address.value,
    });
    editor.value?.close();
    await load();
    const p = items.value.find((p) => p.id === editId.value);
    if (p) pick(p);
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function clear() {
  if (!selected.value) return;
  busy.value = true;
  message.value = "";
  try {
    await api(`/devices/${selected.value.id}/location`, "DELETE");
    await load();
  } catch (e) {
    message.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function preview() {
  if (!selected.value) return;
  try {
    const data = await api<{ items: { id: string; status: string }[] }>(
      `/devices/${selected.value.id}/channels`,
    );
    const c = data.items.find((c) => c.status === "online");
    if (!c) throw Error("该设备尚无在线通道");
    emit("preview", c.id);
  } catch (e) {
    message.value = messageOf(e);
  }
}
</script>
<template>
  <section class="business-page" id="device-map-view">
    <div class="title">
      <div>
        <h1>设备地图</h1>
        <p>按授权分组查看设备位置、在线状态与未处置告警。</p>
      </div>
      <div class="row-actions">
        <button class="secondary" @click="fit">查看全部点位</button
        ><button
          v-if="can('map.manage')"
          class="secondary"
          @click="armed = !armed"
        >
          {{ armed ? "取消取点" : "地图取点" }}
        </button>
      </div>
    </div>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <p v-if="armed" class="scope-banner">
      请点击地图选择坐标，再指定设备保存。手动坐标优先于设备定位上报。
    </p>
    <div class="map-workspace">
      <aside class="panel map-resources">
        <div class="panel-heading">
          <h3>设备点位</h3>
          <span>{{ located.length }} / {{ filtered.length }} 已定位</span>
        </div>
        <label
          >设备分组<select v-model="groupId" @change="load">
            <option value="">全部授权分组</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select></label
        ><label
          >查找设备<input
            v-model="query"
            placeholder="设备名称或编号"
            @input="draw"
        /></label>
        <div class="map-device-list">
          <button
            v-for="p in filtered"
            :key="p.id"
            :class="{ selected: selectedId === p.id }"
            @click="pick(p)"
          >
            <span>{{ p.name }}</span
            ><small
              >{{ p.groupName }} ·
              {{
                p.longitude === null
                  ? "未设置坐标"
                  : p.status === "online"
                    ? "在线"
                    : "离线"
              }}</small
            ><b v-if="p.alarms" class="map-alarm-count"
              >{{ p.alarms }} 条待处置</b
            >
          </button>
          <p v-if="!filtered.length" class="panel-note">暂无有权访问的设备</p>
        </div>
      </aside>
      <div class="panel map-stage">
        <div class="map-status">
          <span>{{
            tileConfigured ? "地理底图 · WGS84" : "坐标视图 · 未配置地理底图"
          }}</span
          ><span class="map-legend"
            ><i class="legend-online"></i>在线
            <i class="legend-offline"></i>离线
            <i class="legend-alarm"></i>告警</span
          >
        </div>
        <div
          ref="host"
          class="device-map-canvas"
          aria-label="设备位置地图"
        ></div>
        <p v-if="tileError" class="map-warning">
          底图服务暂不可用，设备坐标仍可查看。
        </p>
        <p v-if="!located.length" class="map-empty-note">
          当前范围无设备坐标。管理员可手动设置或接收设备定位上报。
        </p>
        <p class="panel-note">
          {{
            tileConfigured
              ? "底图由部署环境配置；平台仅代理当前视野的瓦片请求。"
              : "当前显示经纬度网格，不包含道路或行政区划。可通过部署配置接入自建瓦片服务。"
          }}
          最多展示5000台授权设备。
        </p>
      </div>
      <aside v-if="selected" class="panel map-detail">
        <div class="panel-heading">
          <h3>设备详情</h3>
          <button class="link" @click="selectedId = ''">收起</button>
        </div>
        <h3>{{ selected.name }}</h3>
        <button
          v-if="can('tracks.view')"
          class="secondary"
          @click="emit('track', selected.id)"
        >
          历史轨迹
        </button>
        <p class="mono">{{ selected.deviceId }}</p>
        <dl class="event-details">
          <dt>所属分组</dt>
          <dd>{{ selected.groupName }}</dd>
          <dt>连接状态</dt>
          <dd>{{ selected.status === "online" ? "在线" : "离线 / 待注册" }}</dd>
          <dt>经度</dt>
          <dd>{{ selected.longitude ?? "未设置" }}</dd>
          <dt>纬度</dt>
          <dd>{{ selected.latitude ?? "未设置" }}</dd>
          <dt>位置来源</dt>
          <dd>
            {{
              selected.source === "manual"
                ? "手动设置"
                : selected.source === "device"
                  ? "设备上报"
                  : "未设置"
            }}
          </dd>
          <dt>位置说明</dt>
          <dd>{{ selected.address || "—" }}</dd>
          <dt>未处置告警</dt>
          <dd>{{ selected.alarms }} 条</dd>
        </dl>
        <button
          v-if="can('live.preview')"
          :disabled="selected.status !== 'online'"
          @click="preview"
        >
          实时预览
        </button>
        <div v-if="can('map.manage')" class="actions">
          <button class="secondary" @click="edit(selected)">设置位置</button
          ><button
            class="secondary"
            :disabled="busy || selected.longitude === null"
            @click="clear"
          >
            清除位置
          </button>
        </div>
        <p class="panel-note">
          清除手动位置后，后续设备定位上报可重新设置点位。
        </p>
      </aside>
    </div>
  </section>
  <dialog
    @cancel="busy && $event.preventDefault()"
    class="business-dialog"
    ref="editor"
  >
    <form @submit.prevent="save">
      <DialogHeading :disabled="busy">设置设备位置</DialogHeading>
      <label
        ><span class="field-label">目标设备</span
        ><select autofocus v-model="editId" required>
          <option disabled value="">请选择设备</option>
          <option v-for="p in items" :key="p.id" :value="p.id">
            {{ p.name }}
          </option>
        </select></label
      ><label
        ><span class="field-label">经度（WGS84）</span
        ><input
          v-model.number="longitude"
          type="number"
          min="-180"
          max="180"
          step="any"
          required /></label
      ><label
        ><span class="field-label">纬度（WGS84）</span
        ><input
          v-model.number="latitude"
          type="number"
          min="-90"
          max="90"
          step="any"
          required /></label
      ><label
        ><span class="field-label">位置说明</span
        ><input v-model="address" maxlength="300"
      /></label>
      <p class="panel-note">
        手动设置后，设备上报不会覆盖此坐标。请使用与底图一致的WGS84坐标。
      </p>
      <p v-if="message" class="error">{{ message }}</p>
      <div class="actions">
        <button
          :disabled="busy"
          type="button"
          class="secondary"
          @click="editor?.close()"
        >
          取消</button
        ><button :disabled="busy">保存位置</button>
      </div>
    </form>
  </dialog>
</template>

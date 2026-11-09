import * as L from "leaflet";
export function addMapBase(
  map: L.Map,
  configured: boolean,
  attribution: string,
  onError: () => void,
) {
  map.attributionControl.setPrefix(false);
  if (configured) {
    L.tileLayer("/api/v1/map/tiles/{z}/{x}/{y}", {
      maxZoom: 19,
      attribution: undefined,
    })
      .on("tileerror", () => {
        onError();
      })
      .addTo(map);
    const attributionElement = L.DomUtil.create("span");
    attributionElement.textContent = attribution || "自建地图服务";
    map.attributionControl.addAttribution(attributionElement.outerHTML);
  } else {
    const Grid = L.GridLayer.extend({
      createTile(coords: L.Coords) {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#edf2f6";
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = "#d6e0e9";
        ctx.strokeRect(0, 0, 256, 256);
        ctx.beginPath();
        ctx.moveTo(128, 0);
        ctx.lineTo(128, 256);
        ctx.moveTo(0, 128);
        ctx.lineTo(256, 128);
        ctx.stroke();
        const point = map!.unproject(
          L.point(coords.x * 256, coords.y * 256),
          coords.z,
        );
        ctx.fillStyle = "#8c9bab";
        ctx.font = "11px sans-serif";
        ctx.fillText(
          `${point.lng.toFixed(2)}°, ${point.lat.toFixed(2)}°`,
          8,
          18,
        );
        return canvas;
      },
    });
    new Grid().addTo(map);
    map.attributionControl.addAttribution("WGS84 坐标网格 · 未配置地理底图");
  }
}

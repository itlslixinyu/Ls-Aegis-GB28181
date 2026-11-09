export const permissionCatalog = [
  ["devices.view", "设备查看", "基础管理"],
  ["live.preview", "实时预览", "视频业务", ["devices.view"]],
  ["ptz.control", "云台控制", "视频业务", ["live.preview"]],
  ["recording.view", "录像查询与回放", "视频业务", ["devices.view"]],
  ["recording.download", "录像导出与下载", "视频业务", ["recording.view"]],
  ["ai.view", "AI结果与检索", "AI", ["devices.view"]],
  ["ai.analyze", "AI画面分析", "AI", ["ai.view"]],
  ["ai.configure", "AI模型配置", "AI", [], true],
  ["alarms.view", "告警查看", "事件与位置", ["devices.view"]],
  ["alarms.handle", "告警确认与处置", "事件与位置", ["alarms.view"]],
  ["map.view", "设备地图", "事件与位置", ["devices.view"]],
  ["map.manage", "地图点位维护", "事件与位置", ["map.view"]],
  ["tracks.view", "历史轨迹", "事件与位置", ["devices.view"]],
  ["subscriptions.view", "订阅查看", "事件与位置", ["devices.view"]],
  [
    "subscriptions.manage",
    "告警与位置订阅维护",
    "事件与位置",
    ["subscriptions.view"],
  ],
  ["devices.manage", "设备接入维护", "平台管理", [], true],
  ["plans.manage", "录像计划维护", "平台管理", [], true],
  ["users.manage", "用户与角色授权", "平台管理", [], true],
  ["groups.manage", "设备分组维护", "平台管理", [], true],
  ["cascade.manage", "国标级联维护", "平台管理", [], true],
  ["audit.view", "平台操作审计", "平台管理", [], true],
  ["system.configure", "接入配置维护", "平台管理", [], true],
  ["system.restart", "重启平台", "平台管理", [], true],
].map(([key, label, group, dependencies = [], adminOnly = false]) => ({
  key,
  label,
  group,
  dependencies,
  adminOnly,
}));
export const viewerPermissions = [
  "devices.view",
  "live.preview",
  "recording.view",
  "recording.download",
  "alarms.view",
  "map.view",
  "tracks.view",
  "subscriptions.view",
];
export function normalizePermissions(keys) {
  if (
    !Array.isArray(keys) ||
    keys.length > permissionCatalog.length ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        !permissionCatalog.some((p) => p.key === k && !p.adminOnly),
    )
  )
    throw Object.assign(Error("权限项无效；平台管理权限仅限系统管理员"), {
      status: 400,
      code: "INVALID_PERMISSIONS",
    });
  const result = new Set(keys);
  const add = (key) => {
    for (const dependency of permissionCatalog.find((p) => p.key === key)
      .dependencies) {
      result.add(dependency);
      add(dependency);
    }
  };
  keys.forEach(add);
  return permissionCatalog.filter((p) => result.has(p.key)).map((p) => p.key);
}

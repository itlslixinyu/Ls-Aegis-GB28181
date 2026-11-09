// Explicitly creates and cleans temporary business records on a local instance.
// Passwords, cookies and CSRF tokens stay in memory and never enter the report.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const origin = process.env.ACCEPTANCE_ORIGIN || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
  throw Error("Only local instances are accepted");
if (!process.env.ACCEPTANCE_PASSWORD) throw Error("Set ACCEPTANCE_PASSWORD");
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  blocked: [],
  cleanup: [],
};
const created = {};
let admin, viewer;
async function client(username, password) {
  const response = await fetch(origin + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, "Login must succeed");
  const { data } = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return {
    user: data.user,
    async request(path, method = "GET", value, expected = 200) {
      const result = await fetch(origin + "/api/v1" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": data.csrf,
        },
        body: value === undefined ? undefined : JSON.stringify(value),
        signal: AbortSignal.timeout(15000),
      });
      const json = result.status === 204 ? null : await result.json();
      assert.equal(
        result.status,
        expected,
        `${method} ${path}: ${json?.error?.code || result.status}`,
      );
      return json?.data;
    },
  };
}
async function check(name, run) {
  await run();
  report.checks.push({ name, status: "passed" });
}
async function counts() {
  const [devices, groups, users] = await Promise.all([
    admin.request("/devices"),
    admin.request("/groups"),
    admin.request("/users"),
  ]);
  return {
    devices: devices.total,
    groups: groups.items.length,
    users: users.items.length,
  };
}
async function disableSubscriptions() {
  if (!created.device) return;
  for (const kind of ["Alarm", "MobilePosition"])
    await admin.request(
      `/devices/${created.device}/subscriptions/${kind}`,
      "PUT",
      { enabled: false, expires: 60, interval: 5 },
      202,
    );
  for (let attempt = 0; attempt < 30; attempt++) {
    const rows = await admin.request(`/subscriptions?q=${created.code}`);
    if (rows.items.every((row) => !row.enabled && row.status === "disabled"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error("Temporary subscriptions did not stop");
}
try {
  admin = await client("admin", process.env.ACCEPTANCE_PASSWORD);
  assert.equal(admin.user.role, "admin");
  report.checks.push({ name: "真实admin登录及角色", status: "passed" });
  report.before = await counts();
  const stamp = Date.now().toString();
  created.code = "3402000000132" + stamp.slice(-7);
  const name = "验收临时-" + stamp;
  await check("新建分组", async () => {
    created.group = (await admin.request("/groups", "POST", { name }, 201)).id;
  });
  await check("添加20位国标设备档案", async () => {
    created.device = (
      await admin.request(
        "/devices",
        "POST",
        { name, deviceId: created.code },
        201,
      )
    ).id;
  });
  await check("编辑设备名称", async () => {
    const row = await admin.request(`/devices/${created.device}`, "PATCH", {
      name: name + "-已编辑",
    });
    assert.equal(row.name, name + "-已编辑");
  });
  await check("重复国标编号被拒绝", () =>
    admin.request("/devices", "POST", { name, deviceId: created.code }, 409),
  );
  await check("配置设备接入密码", () =>
    admin.request(
      `/devices/${created.device}/credential`,
      "PUT",
      { password: randomBytes(16).toString("hex") },
      204,
    ),
  );
  for (const transport of ["UDP", "TCP-PASSIVE", "TCP-ACTIVE"])
    await check("保存并读取媒体传输配置 " + transport, async () => {
      await admin.request(`/devices/${created.device}/media-transport`, "PUT", {
        transport,
      });
      assert.equal(
        (await admin.request(`/devices/${created.device}`)).mediaTransport,
        transport,
      );
    });
  await check("设备加入分组", async () => {
    await admin.request(
      `/groups/${created.group}/devices`,
      "PUT",
      { deviceIds: [created.device] },
      204,
    );
    assert.equal(
      (await admin.request(`/devices/${created.device}`)).groupId,
      created.group,
    );
  });
  await check("设备搜索与分页", async () => {
    assert.equal(
      (await admin.request(`/devices?q=${created.code}&pageSize=1`)).total,
      1,
    );
  });
  await check("手工位置保存与地图读取", async () => {
    await admin.request(`/devices/${created.device}/location`, "PUT", {
      longitude: 116.4,
      latitude: 39.9,
      address: "验收手工点位，不是真实设备定位",
    });
    const point = (
      await admin.request(`/map?groupId=${created.group}`)
    ).items.find((item) => item.id === created.device);
    assert.equal(point.longitude, 116.4);
    assert.equal(point.source, "manual");
  });
  const viewerPassword = randomBytes(20).toString("hex");
  await check("创建临时只读账号", async () => {
    const username = "acceptance_" + stamp;
    created.user = (
      await admin.request(
        "/users",
        "POST",
        { username, password: viewerPassword, role: "viewer" },
        201,
      )
    ).id;
    viewer = await client(username, viewerPassword);
  });
  await check("只读账号默认无设备权限", async () => {
    assert.equal((await viewer.request("/devices")).total, 0);
  });
  await check("分组授权后仅能看到测试设备", async () => {
    await admin.request(
      `/users/${created.user}/groups`,
      "PUT",
      { groupIds: [created.group] },
      204,
    );
    const rows = await viewer.request("/devices");
    assert.equal(rows.total, 1);
    assert.equal(rows.items[0].id, created.device);
  });
  await check("只读账号不能新增设备", () =>
    viewer.request("/devices", "POST", { name, deviceId: created.code }, 403),
  );
  await check("撤销分组后即时失去设备和地图权限", async () => {
    await admin.request(
      `/users/${created.user}/groups`,
      "PUT",
      { groupIds: [] },
      204,
    );
    assert.equal((await viewer.request("/devices")).total, 0);
    assert.equal((await viewer.request("/map")).items.length, 0);
    await viewer.request(`/devices/${created.device}`, "GET", undefined, 404);
  });
  for (const kind of ["Alarm", "MobilePosition"])
    await check("未注册设备订阅停留等待态 " + kind, async () => {
      await admin.request(
        `/devices/${created.device}/subscriptions/${kind}`,
        "PUT",
        { enabled: true, expires: 60, interval: 5 },
        202,
      );
      const row = (
        await admin.request(`/subscriptions?q=${created.code}&kind=${kind}`)
      ).items[0];
      assert.equal(row.status, "waiting");
    });
  await check("存在有效订阅时阻止删除设备", () =>
    admin.request(`/devices/${created.device}`, "DELETE", undefined, 409),
  );
  await check("停止订阅并回收至disabled", disableSubscriptions);
  for (const path of [
    "/system/config",
    "/media-nodes",
    "/recording-plans",
    "/recording-jobs",
    "/alarms",
    "/map/config",
    "/cascade/platforms",
    "/audit",
  ])
    await check("管理入口读取 " + path, () => admin.request(path));
  await check("未注册设备目录同步明确拒绝", () =>
    admin.request(`/devices/${created.device}/catalog-sync`, "POST", {}, 409),
  );
  await check("未注册设备不生成虚假通道", async () => {
    assert.equal(
      (await admin.request(`/devices/${created.device}/channels`)).items.length,
      0,
    );
  });
  const range = new URLSearchParams({
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date().toISOString(),
  });
  await check("历史轨迹为空且手工点位不充当轨迹", async () => {
    assert.equal(
      (await admin.request(`/devices/${created.device}/positions?${range}`))
        .total,
      0,
    );
  });
  report.blocked = [
    "真实SIP注册和目录同步",
    "实时画面解码与物理云台",
    "设备录像检索和回放",
    "录像下载与计划录制文件",
    "真实告警和位置NOTIFY及轨迹",
    "实际上级国标级联与媒体转发",
    "公网HTTPS、NAT与带宽长稳",
  ].map((name) => ({
    name,
    status: "not_verified",
    reason: "设备和媒体节点尚未部署；没有实际公网及上级平台环境",
  }));
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  for (const [name, cleanup] of [
    ["订阅停止", disableSubscriptions],
    [
      "临时账号删除",
      async () => {
        if (created.user)
          await admin.request(
            `/users/${created.user}`,
            "DELETE",
            undefined,
            204,
          );
      },
    ],
    [
      "临时设备删除",
      async () => {
        if (created.device)
          await admin.request(
            `/devices/${created.device}`,
            "DELETE",
            undefined,
            204,
          );
      },
    ],
    [
      "临时分组删除",
      async () => {
        if (created.group)
          await admin.request(
            `/groups/${created.group}`,
            "DELETE",
            undefined,
            204,
          );
      },
    ],
  ]) {
    try {
      await cleanup();
      report.cleanup.push({ name, status: "passed" });
    } catch (error) {
      report.cleanup.push({ name, status: "failed", message: error.message });
      process.exitCode = 1;
    }
  }
  if (admin) {
    report.after = await counts();
    try {
      assert.deepEqual(report.after, report.before);
      report.dataRestored = true;
    } catch {
      report.dataRestored = false;
      process.exitCode = 1;
    }
    await admin.request("/auth/logout", "POST", {}, 204);
  }
  report.finishedAt = new Date().toISOString();
  report.temporaryIds = created;
  await writeFile(
    new URL("../docs/admin-flow-results.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}

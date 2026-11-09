# 海康GB28181移动侦测告警接入与实测

日期：2026-11-08。目标：DS-IPC-T12HV3-LA，固件V5.7.20 build241205，设备国标配置GB/T28181-2022，UDP信令。未接入ISAPI/SDK，未改摄像机编码、区域、布防时段或检测目标。

## 修改与使用

- backend/services/alarm-guard.mjs：独立国标SetGuard命令生命周期，12秒超时、每设备并发合并、8项上限、停止/重启清理。保存到既有tasks表，不新增迁移。SIP 200与匹配SN/DeviceID的DeviceControl业务成功分别处理。
- backend/services/subscriptions.mjs：订阅显式传StartAlarmPriority=1、EndAlarmPriority=4、AlarmMethod=0；列表提供最近布防任务状态，关闭回收布防请求。这些条件为标准可选字段，原先省略不能单独定性为标准违规。
- backend/server.mjs、services/management-routes.mjs：关联布防业务应答；POST /api/v1/devices/:id/subscriptions/Alarm/guard需要订阅维护、设备范围及CSRF权限。当前用户点击订阅行“国标布防”显式发起，不自动撤防或代改摄像机检测规则。失败或超时保留明确结果，不假定布防成功。
- frontend/src/components/Subscriptions.vue、Alarms.vue：布防入口及状态；原描述为空且国标方式5/类型2时，显示“移动侦测告警（运动目标检测）”，保留原始方式/类型及原始描述。没有伪造设备文字描述。
- backend/alarm-guard.test.mjs、subscriptions.test.mjs：增加匹配/不匹配应答、200不冒充完成、重复点击、超时、拒绝、权限及CSRF验证。

参考GB28181-2022 A.2.3.1.5 GuardCmd布防，以及Alarm订阅条件和运动目标检测方式5/类型2。参考文本：https://ossrs.net/lts/zh-cn/assets/files/GBT28181-2022-e617420a7a79d48164835321c4ecc429.pdf （镜像文本标有报批稿）；现行标准信息：https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=8BBC2475624A6C31DC34A28052B3923D 。未复制WVP代码。

## 正式设备实测

数据库先备份，完整重启后台进程加载修复。2026-11-08 04:02:56发起SetGuard，设备返回关联业务应答成功。告警订阅已收到合法NOTIFY、状态active，lastNotifyAt更新。用户确认已在摄像机检测区域走动；04:03之后持续收到方法5/类型2的运动目标检测告警，真实入库并在正式页面查看详情。04:04:38快照包含66条去重事件、114次接收；相同指纹上报重复次数增加，没有创建同指纹多行。原始摘要：gb-alarm-real-20261108.json。

第一条设备告警早于本次手动SetGuard成功，因此只能确认本次完整修复后的链路已实测可用，不能声称已通过逐项对照证明“缺少SetGuard”是唯一根因。未进行新旧字段A/B重放。移动位置订阅仍无定位通知，与本次移动侦测告警无关。

设备事件时间较本机接收时间约快1～2秒；本轮不改设备时间。摄像机目标仍为“人”，没有将结果外推为车辆侦测或准确率测试。未验收其他型号、固件、设备重启后布防保持、长时间续订和多摄像机容量。

## 验证与恢复

5项相关用例通过，覆盖布防、本机真实UDP/TCP订阅、HTTP权限与CSRF（协议测试对端为本机模拟器，独立于上述海康真机结果）。类型检查及构建通过；原有包体积提示保留。本轮未运行全量测试，此前历史轨迹迁移版本硬编码12的既有失败未修改。

首页/健康接口均200。重启产生短暂录像空档，04:04:08计划录像恢复为recording，error为空，源流ready；没有将该状态当作播放器逐帧或新录像文件完整性验收。正式告警页已显示“移动侦测告警（运动目标检测）”。后端代码升级须完整重启进程；页面里的重启只应用配置。

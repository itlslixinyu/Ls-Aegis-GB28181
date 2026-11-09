# 移动侦测告警自动抓图

日期：2026-11-08。使用项目gb-feature-contract、gb-backend-service、gb-media-session及gb-frontend-flow约束。

## 已实现

国标方式5/类型2告警正常入库并应答，不等抓图完成。backend/services/alarm-snapshots.mjs只打开现有ready直播源的独立FLV读取；不会发起INVITE、创建观看者、改变或结束预览/录像会话。无视频源、并发繁忙、失败、超时与过期在详情明确显示；不以旧告警补拍充当事件画面。全局最多1次抓图、10秒超时、同通道30秒内连续告警复用同一截图并显示实际抓图时间；独立FFmpeg单线程/低优先级，JPEG最长边960、上限512KiB。不调用大模型、不上传外部服务。

迁移20在既有数据库新增alarm_snapshots与alarm_snapshot_links。图片保存7天、500张/100MiB定时清理；告警仍保留，图片清理后显示已过期。ALARM_SNAPSHOT_ENABLED=0停用，重启生效。迁移及运行参数见.env.example；本机已在升级前使用SQLite在线备份保存完整一致性备份。迁移19为此前已有AI检测缓存迁移，本次不修改其内容。

详情GET /api/v1/alarms/:id返回snapshot元数据，图片GET /api/v1/alarms/:id/snapshot沿用alarms.view及设备范围校验，返回JPEG/no-store。前端详情10秒复核和更新，不清空填写中的处置备注；撤权读取失败时关闭详情。图片不是摄像机原始事件抓拍，时间可能与触发时刻有延迟；单通道连续告警共用截图。

## 文件

新增backend/services/alarm-snapshots.mjs、backend/alarm-snapshots.test.mjs、scripts/migrations/020-alarm-snapshots.sql；更新backend/lib/store.mjs、backend/server.mjs、backend/services/security-events.mjs、management-routes.mjs、backend/ai/capture.mjs（仅告警抓图启用低优先级与额外线程限制）、frontend/src/components/Alarms.vue、.env.example和docs/workflows.md。

## 验证边界

单元/HTTP覆盖同通道共享、无源跳过、异步失败、关闭取消、图片保留清理、登录/设备范围/撤权、JPEG及no-store。既有直播和录像回归验证同源共享、退出回收、超时补偿与恢复。类型检查、构建通过，原有大包提示保留。测试对端使用本机模拟器，与真机证据分开。

用户明确允许在隔离验证通过后完整重启一次后台加载新接口，接受短暂预览中断和录像空档。本轮不把这次升级重启描述为零中断。抓图功能自身不操作原视频会话；CPU和带宽仍有小量消耗，不承诺所有负载下完全没有影响。

真机目标：海康DS-IPC-T12HV3-LA、V5.7.20 build241205、GB/T28181-2022，仍使用原H.265接入。本次不改变SIP和媒体协议配置。实际告警抓图及录像恢复结果待下方补充。

## 本轮实测结果

用户允许备份后重启一次正式后台，已完成迁移20；首页与健康接口200。计划录像自动恢复，抓图测试期间保持recording，源流ready。直接读取既有海康源单帧约1284ms/86KB；在独立内存库通过模拟告警触发完整SecurityEvents→AlarmSnapshots→真实现有媒体源链路，JPEG约22KB、484ms，图片状态ready，随后在18104隔离平台实际验证详情显示、鉴权及桌面/390px窄屏。正式源流ID、观看租约ID、录像任务ID与状态在真实媒体读取前后完全相同，未新增观看者，未发送点播或停止命令。详细摘要：alarm-snapshot-isolated-real-20261108.json。图片与测试页面均明确标注隔离事件，未写入正式告警或图片表。

新增3项抓图单元/HTTP测试通过，告警规范化、布防、直播会话和录像回归通过；类型检查及前端构建通过。正式抓图模块已加载。本轮真实摄像机新移动侦测告警自动关联图尚待现场验收：用户选择稍后再走动，截至测试结束正式alarm_snapshots表仍无新行。因此不能把隔离模拟触发的真实画面抓取描述为正式真实告警抓图已验收。历史告警不会补拍，且没有就绪预览/录像源时明确跳过。后续用户触发新告警后可继续核对正式详情和图片。

补充：随后实际收到新告警，首次被标为跳过。排查发现生产计划录像源的kind是recording，初版查询仅允许live，已修复为仅允许live/recording并继续排除playback/download。新增专门的录像源复用用例通过；按真实recording源类型再次运行隔离事件完整链路，1089ms取得26319字节JPEG，原源流/观看者/录像任务均不变。首次跳过记录保留，不补拍、不伪装成功。修正代码尚待用户允许再次加载重启后启用。

## 最终正式验收（取代此前待加载/待现场验收状态）

用户再次明确允许修正后的后台重启，已备份并加载修正。2026-11-08 04:40:25计划录像恢复，源流ready、录像recording、无错误。用户确认已走动，真实GB28181方式5/类型2新告警触发自动抓图：04:40:44.078请求，04:40:45.631完成，耗时1553ms，JPEG25553字节，状态ready、error为空。连续告警关联到同一图片。正式登录页面已实际打开新告警详情并看到抓图人物画面和时间，无需AI密钥。

抓图前后生产源流ID、观看租约ID、录像任务ID及状态相同，录像持续recording；首页/健康接口200。对照报告：alarm-snapshot-real-20261108.json，正式页面证据保存在私有.tmp/alarm-snapshot-real-detail.png。未测试长时间高并发或其他固件，未将升级重启造成的空档算作抓图自身影响。原先误跳过的告警仍保留原状态，不补拍。

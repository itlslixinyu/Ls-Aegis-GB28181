# 计划录像按日执行记录（2026-11-05）

## 当前行为

- 录像计划页面按“通道＋北京时间执行开始日”汇总，每天一条执行记录。中断重试、服务重启恢复及同日其他时段的文件归入同一条记录；跨日计划按时段开始日归属。
- 展开“执行过程”查看各次开始时间、状态和中断原因。异常后重新进入录制状态显示“已恢复录制”。
- 取流失败或意外中断写入现有告警管理，来源为平台，类型为recording-interrupted。每次后台尝试使用独立去重键；不冒充设备上报，不自动替用户处置告警。恢复状态在执行记录查看。
- 自动重试仅发生在计划启用且当前执行时段内；失败退避1、2、4、5分钟，之后每5分钟重试。服务中断在文件确认结束后等待1分钟接续，不再因三次失败而永久停止当次计划。
- 手动结束不自动重启当前时段；停用后不录制，重新启用沿用既有接续规则。
- 底层每次取流仍独立保存资源、文件及权限，防止重试覆盖历史媒体地址。汇总文件携带原jobId，回放和下载始终使用真实所属任务。历史数据不删除，不需要数据库迁移。

## 接口与文件

`GET /api/v1/recording-jobs?kind=scheduled&daily=1`返回最近200个通道日及其全部尝试，增加dailyKey、executionDate、attempts及files[].jobId；按日筛选在限制数量前完成。未带daily的接口保留原任务列表行为。录像任务中心同样使用按日计划汇总，并保留独立设备录像导出。服务端继续按设备分组控制访问。

## 录像任务页面同步调整

录像任务页面并行读取按日计划记录与最近200项设备录像导出，再按创建时间排列。计划录像与执行记录使用相同的日期、稳定行标识、历史展开及原文件jobId，结束任务仍指向当前最新尝试；导出任务不合并。任一列表请求失败即显示错误，不把部分列表作为完整结果。录像回放资料库的原读取方式不变。

本轮类型检查、构建及48项前端相关回归通过；隔离浏览器验证三次计划执行汇总为一行、独立导出仍单列、展开三次历史并从原任务地址回放文件，通过仅回放权限账号的访问检查。正式站点只读核对录像任务为3行计划日记录，与执行记录一致；1440、3380和390宽度无页面整体横向溢出。

修改文件为`frontend/src/components/RecordingCenter.vue`、`scripts/video-pages-browser-test.mjs`及契约文档。证据：`.tmp/recording-jobs-daily-components.log`、`.tmp/recording-jobs-daily-browser.log`、`.tmp/video-formal-录像任务-desktop.png`。本轮仅更新前端构建，没有重启服务或中断录像。

主要修改：`backend/services/recordings.mjs`、`backend/services/recording-routes.mjs`、`frontend/src/components/RecordingCenter.vue`、`frontend/video-business.css`。契约见`docs/workflows.md`。

## 验证与本机更新

- 57项相关回归通过：录像调度、重启恢复、告警去重、文件归属、HTTP权限、前端组件及请求层。最后调整服务中断退避后，8项录像服务测试再次通过。
- 类型检查及前端构建通过。`scripts/video-pages-browser-test.mjs`隔离平台浏览器验证同通道同日汇总一行、两次执行历史、文件原jobId、表单、回放权限及三种屏幕尺寸通过。
- 用户明确授权本机更新和重启。数据库已在线备份到`backups/database-1793884202992-3b193e39/platform.db`，未修改计划配置、账号授权或相机编码。
- 更新脚本首次因Windows PowerShell中文路径编码导致启动失败，改为由脚本目录定位项目后已恢复。正式首页200、健康ok、SIP listening；当前进程18040。
- 正式验证时间2026-11-05 21:15：原在录海康通道自动恢复，当天9次执行汇总一条，77个分段保留；大华当天12次执行汇总一条、103个文件，已过当天09:00—18:00计划时段，保持已完成，没有强行启动。前一天另保留一条记录。
- 实际用Range读取中断前录像分段成功；平台生成一条本次中断告警。正式浏览器复核四个视频菜单及1440、3380、390宽度，无页面横向溢出。

证据：`.tmp/recording-daily-tests.log`、`.tmp/recording-daily-unit.log`、`.tmp/recording-daily-browser.log`、`.tmp/recording-daily-before.json`、`.tmp/recording-daily-verified.json`、`.tmp/video-formal-录像计划-desktop.png`。

本次验证范围是录像调度恢复、告警、文件访问及页面，不是新的设备/固件或国标协议兼容性验收。相机主子码流编码未改；未另行执行长时间预览、音视频解码和完整分段播放测试。

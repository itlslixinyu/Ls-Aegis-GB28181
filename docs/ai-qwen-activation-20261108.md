# 千问上传分析正式启用与重启验收

2026-11-08，用户明确授权更新并重启本机平台。本轮操作与后续验证均在本机正式平台完成，不将隔离模型响应冒充真实推理。

## 备份与启用

维护前备份：backups/qwen-activate-1794089743071/platform.db。源库采用只读事务建立一致快照再备份，避免持续写入导致增量备份反复重试。备份完整性ok、外键错误0、迁移21，共344个录像条目。最初普通增量备份未完成，不能将backups/database-1794089667684-c4f9ab2e下的空文件当作有效备份。

正式平台已加载新后端，迁移22生效，ai_detection_cache表不存在。模型清单仅保留Chinese-CLIP及Qwen；前端千问上传入口正式可用，不再出现等待后端更新提示。维护过程中有正常重启录像空档，不能描述为全程连续。

直接复合终止启动命令曾被自动审批拦截；平台已有重启流程已实际执行。随后对已确认的具体后端进程使用范围更小的独立终止和启动命令成功更新，未更改系统执行策略、权限或防火墙。最终进程26648，HTTP首页和健康接口正常、SIP监听正常；媒体可用性以真实预览和录像验证，健康接口media=unchecked不冒充媒体检测通过。

## 发现并修复

首次上传真实图片，模型加载后被手动分析服务的3GiB内存门槛提前中止。该阈值本应仅用于启动前；已将localResourceReason分为启动3GiB和运行1GiB，保留模型工作集上限及低优先级保护。运行期QWEN_RESOURCE_BUSY改为原任务回队列，finishedAt清空，继续遵守15分钟排队超时、用户取消和录像预览优先。模型未完成不写假结果。

修改backend/ai/service.mjs，新增backend/ai.test.mjs回归：验证运行期传入false门槛、资源中止后同一ID回到queued而非failed。另补backend/ai-http.test.mjs，确认旧detections接口404、状态没有yoloReady、qwenReady为布尔。修复后相关20项测试通过，HTTP额外断言通过。首次失败记录保留作为真实历史，不掩盖错误。

## 浏览器及真机实测

Codex内置浏览器使用已登录账号，将现有海康监控JPEG作为本地上传样本，源文件.tmp/ai-deploy-preview.jpg。未修改账号密码、授权、云端配置或真实设备参数。

- 第一次成功记录26f0afd5-1825-4582-ac9d-df37c21b9b4a，千问真实CPU运行，模型版本local-qwen3-vl-2b-q4-k-m:q8-vision:384:p3g1:t2，elapsedMs=16776、峰值工作集约2337MiB；页面显示中文描述和标签。对象表为空，数量与置信度显示未提供，无目标框，不伪造检测能力。
- 同图再次提交记录d5b5a6c4-86fe-423c-bcbc-06adccfd6bde，usage.local=true、cached=true，创建至完成79ms，页面显示已复用结果；结果与第一次一致，不新起模型推理。该数字为本次记录耗时，不是硬件性能保证或一般网络端到端耗时。
- 打开已有相似结果，定位原文件2026-11-08-05-25-28-2.mp4第166秒。视频readyState=4、1920×1080、error=null。上传图片本身没有原录像关联，本轮定位验证的是有recording关联的历史结果，不伪造上传文件的录像链接。
- 实时预览海康DS-IPC-T12HV3-LA / V5.7.20 build241205 / GB28181-2022，1920×1080、readyState=4、paused=false、error=null，播放时间从11.5秒推进到21.2秒。测试结束只关闭验收页面自身的预览观看者，不关闭共享录制源。
- 原计划62bf2fab-787c-49c7-97cf-2237ec61df7a所有配置字段与备份完全一致、仍启用。任务804a405b-8caa-40d7-bdac-62a0c2975509于06:20:28自动续录，attempt=13、status=recording、error=null。媒体目录已有正在增长的新分段.2026-11-08-06-20-30-0.mp4，检查时983040字节且更新时间持续前进。原文件仍在，未修改计划以强制恢复。

本轮未重新验证设备录像机多路性能，也不声称模型描述完全准确。照片描述和检索候选均需结合原始画面判断。

## 证据

.tmp/qwen-activation-backup.json、qwen-activation-after.json、qwen-final-recording.json、qwen-restart-tests.log、qwen-memory-fix-tests.log；截图：qwen-upload-live-result.jpg、qwen-upload-live-cache.jpg、qwen-restart-real-preview.jpg。验收使用独立临时浏览器标签页，已关闭，用户原标签页保留。

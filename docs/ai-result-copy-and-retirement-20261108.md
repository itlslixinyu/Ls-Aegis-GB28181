# AI结果文案与旧检测功能退役验收

日期：2026-11-08。范围：现有AI页面、图片分析服务和派生缓存，不改SIP、播放器、录像计划或真实设备设置。

## 已发布与已验证

前端已原子发布到dist，首页及入口资源HTTP200。旧存量参考图显示“检索参考图 / 已保存”；本地检索命中显示“相似画面 / 已匹配”；原始录像采样显示“录像采样画面 / 已采样”；千问成功记录显示中文描述、标签及“分析完成”。不把相似度分数当作识别置信度，不把保存参考图当作完成识别。旧技术性摘要通过统一前端助手映射，不篡改历史分析内容。

Codex内置浏览器已可控制，本轮实际点开正式库的参考图、相似结果及千问告警分析详情。参考图没有识别状态或目标标注按钮；千问展示真实中文描述及标签。相似结果定位原录像的第166秒，HTML视频readyState=4、1920×1080、error=null；关闭弹窗停止详情播放器。390×844检查documentWidth=390、dialogWidth=358，恢复默认视口。

千问当前接口只提供描述和标签，objects为空，无目标框、精确计数或置信度。界面显示“未提供”，不会伪造0个、100%或按类别数量冒充目标数量。接口日后实际返回物体数量及置信度时，表格按真实值显示。

正式平台健康ok、SIP监听；原录像计划启用、配置保持，录像任务d2483806-774c-450a-96ad-ea6ced14597a始终recording、attempt=11、error=null。本轮没有重启后端、切换媒体节点或修改录像计划；未新启动真实摄像机分析，也未发送图片至云端。录像定位验证使用既有海康DS-IPC-T12HV3-LA / V5.7.20 build241205 / GB28181-2022的历史MP4，不是对新设备协议兼容性的验收。

## 后端实现（已于后续维护更新生效）

删除backend/ai/yolo.mjs、yolo-worker.mjs、专用测试和setup/benchmark脚本，移除直接onnxruntime-node依赖及前端AiDetections、目标框绘制和布局助手。删除GET/POST detections路由及相关队列锁；模型清单仅保留Chinese-CLIP与千问。历史迁移19保留可追溯性，新增迁移22删除ai_detection_cache派生结果，不删除ai_jobs、告警图或录像。

POST /ai/analyses新增localAnalysis:true，上传图片可使用千问且不依赖云端密钥。沿用异步任务状态、权限、CSRF、幂等和取消。完全相同的正规化图像字节、同账号和模型版本才复用未过期结果，不用感知哈希作为身份。历史检索优先，本地手动和告警千问互斥；排队超时15分钟，运行遵循内存及预览录像保护，高负载时等待或停止本地分析。前端对旧后端缺少qwenReady字段的情况禁用新增入口并说明待更新，避免将参数发给旧接口误走云端。

首次前端验收时，正式进程仍运行之前载入的后端模块，旧detections路由的彻底退役、迁移22与千问上传新参数必须下次维护重启才生效；不能将源码删除描述为运行中旧路由已卸载。本轮遵守不中断预览录像要求，未迁移正式库或重启。新手动千问工作流使用注入模型完成隔离测试，本轮未重新跑真实模型推理，不声称其真机耗时或准确率已验收。

## 修改与测试

主要修改：backend/ai/service.mjs、routes.mjs、alarm-analysis.mjs、history-search.mjs、history-analysis.mjs、history-samples.mjs、model-inventory.mjs；frontend/src/ai-types.ts及AiAnalyses、AiResultDialog、AiSearch、AiModels；backend/lib/store.mjs与迁移22；package.json/package-lock.json；README及工作流。旧YOLO验收文档已标为历史归档。

相关后端39项通过，追加的退役迁移测试通过，共40项；AI前端组件6项通过；vue-tsc与Vite构建通过。迁移验证使用独立临时数据库，缓存表移除后账号保留、完整性ok、重复打开成功，未使用openStore打开正式库。仅保留Vite原有大包提醒。

证据：.tmp/ai-copy-tests.log、.tmp/ai-copy-publish.json、.tmp/ai-qwen-result-copy.jpg。历史文件及离线备份未删除。

后续已按用户授权完成进程更新与真实验证，见[正式启用验收](ai-qwen-activation-20261108.md)。

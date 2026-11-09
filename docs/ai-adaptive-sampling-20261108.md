# 自适应采样与候选片段合并

状态：已按用户授权备份、更新并重启正式平台，新调度已生效。重启前的未完成检索保留记录并标记中断，重新发起可复用已有缓存。

## 新规则

| 查询时长 | 基础代表帧间隔 |
| --- | --- |
| 不超过15分钟 | 10秒 |
| 15分钟至1小时 | 30秒 |
| 1至6小时 | 2分钟 |
| 6至24小时 | 5分钟 |

长查询按整个查询时间轴对齐，起止补帧不再对每个文件重复执行，重叠文件同通道同一时刻不重复采样。长查询每通道分散安排8个低分辨率变化窗口，总计最多240秒；设备事件按时间桶合并，保留事件线索。短查询保留原变化检测方式。

先完成粗筛，再选最多6个高相关度或设备事件锚点做前后精查，每点最多4帧；不再每个文件独立精查。精查可跨相邻录像文件边界，仍逐次经过权限、取消、超时及预览/录像资源检查。缓存、外部复核最多4个代表候选/1次调用不变。

同通道、相隔不超过15秒、向量高度相近的候选合并为虚拟时间片段，选择最高相关度的代表图。不跨通道、不跨长空档合并；合并区间只代表相近候选采样范围，不证明目标连续存在。usage.segment记录起止及合并数量，无数据库迁移，不重编码或创建大量磁盘视频切片。

前端默认展示候选片段，保留按需查看采样图；点击仍定位代表图原录像。长查询标记partial/truncated并提示可能遗漏短暂目标，空结果不能断言整段绝对没有目标。

## 实测

- 后端采样策略/历史检索/HTTP共19项，前端相关20项通过；类型检查和构建通过。
- 24小时调度：基础289张，对比10秒间隔8640张减少约96.7%；同一时间线拆成96个文件仍为289张，均匀变化窗口总计240秒。48个虚拟半小时文件的管线测试确认末尾设备事件被采样并触发精查。
- 实际解码：生成一小时320×180、1fps合成MP4，在00:30:00—00:30:10显示红色矩形，加入00:30:04设备事件。隔离HTTP服务通过项目原生FFprobe/FFmpeg读取真实文件，完成126张（121张基础、1张事件、4张精查），变化扫描240秒。特征向量使用确定性颜色桩，**不是千问/Chinese-CLIP的真实识别精度测试**。
- 浏览器显示00:30:00—00:30:09合并片段及粗筛风险提示，点击定位原文件1800秒，320×180、readyState4、无解码错误。重复查询复用126张及8个变化窗口缓存，实际FFmpeg取帧累计仍126次，没有新增解码。
- 隔离录像哨兵保持recording，recordStopped=0；正式库只读核对计划与备份一致、recording且无错误。没有停止正式平台、取消用户检索或控制真实设备。

## 文件与证据

backend/ai/sampling-policy.mjs、history-analysis.mjs、history-samples.mjs、history-search.mjs；frontend/src/ai-types.ts、components/AiRangeResults.vue、AiSearch.vue；backend/ai-sampling-policy.test.mjs、ai-history.test.mjs。

证据：.tmp/ai-adaptive-video-summary.json、ai-adaptive-video-report.json、ai-adaptive-segments-proof.jpg。新前端仅构建于frontend/.tmp/ai-pages-style，未发布到正式dist，待与后端一起更新。

## 正式更新与验收

本节取代前文隔离阶段的未发布状态。用户明确授权测试环境直接重启后，备份backups/ai-recording-frame-1794108304604，增量发布前端，核对并停止旧后端17500，启动新后端29888。首页及资源HTTP200、健康ok、SIP listening。

正式admin浏览器用海康已有录像00:00:02—00:16:02、线索“汽车”、verify=false实测。任务记录确认samplingPolicy=adaptive-coarse-v1、基础间隔30秒：读取6个文件，60张采样（33张基础、21张精查），24张缓存命中、36张新采样；真实Chinese-CLIP本地推理约18.96秒、峰值工作集约347MiB，未调用外部复核。任务以partial完成且error=null，这是粗筛覆盖风险标记；返回4个相似候选，不等于确定发现目标。实际变化扫描统计241.999秒：计划窗口为240秒，真实录像文件交界存在少量重叠解码，不应将240秒描述为所有真实输入下的严格解码上限。

点击00:01:13候选打开原录像文件内71秒，1920×1080、readyState4、无错误。真实实时预览1920×1080，播放时间从15.93增长至22.85秒、未暂停、无解码错误；仅关闭本轮测试窗口。原录像计划配置与备份一致，自动续录为recording，第19次尝试、无错误。未替换摄像机编码或控制真实云台。

正式证据：.tmp/ai-adaptive-formal-verification.json、ai-adaptive-formal-proof.jpg；启动日志ai-adaptive-formal.log/.err。本轮没有证明所有短暂目标都能检出，本机千问单图摘要矛盾仍为独立未解决问题。

## 视频切片工具

TransNet V2检测镜头边界，PySceneDetect按内容变化检测场景；不等同于识别固定监控里物品出现。针对本项目，建议以设备移动事件、低分辨率变化检测或背景减除生成事件时间段，再进行语义筛查。本轮未安装这些额外模型/依赖。

官方资料：[TransNet V2](https://github.com/soCzech/TransNetV2/)、[PySceneDetect](https://www.scenedetect.com/docs/latest/api/detectors.html)、[OpenCV背景减除](https://docs.opencv.org/4.13.0/d1/dc5/tutorial_background_subtraction.html)。

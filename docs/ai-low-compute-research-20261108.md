# 低算力录像检索：边缘计算、识别算法与 Agent / Skill 调研

调研日期：2026-11-08。用户要求查找互联网方案，尽量减少计算量。本轮只研究、读取本机硬件和保存方案，没有改动服务代码、安装第三方Skill、下载模型、调用DeepSeek、重启服务或修改录像计划。下面的路线均为建议，不能描述为已经实现。

## 结论

建议采用“设备事件优先 + 按需硬件解码 + 小模型初筛 + 事件/画面向量缓存 + DeepSeek少量复核”。边缘计算把工作放到设备附近，并不天然消除计算；应先减少需要解码和推理的数据。Agent负责组织查询和工具调用，Skill负责开发/评测流程，二者不会自行降低视频识别模型的运算量。

当前实现是按查询抽样后将拼图直接交给DeepSeek。已有文件级定位和结果复用，但没有本地目标检测、向量索引或设备智能元数据检索。下一轮应优先降低这条路径的重复解码与大模型依赖，不扩大业务模块。

## 本机事实与未测范围

只读系统信息：Intel Core i7-8700，6核12线程；Intel UHD Graphics 630；物理内存约16GiB。另一个显示设备OrayIddDriver属于显示驱动，不能当成独立AI显卡。没有据此宣称任何真实视频并发能力。项目64台模拟摄像机的在线状态不代表64路真实解码/识别已通过。

OpenVINO系统要求列出第6～14代Intel Core CPU；可作为本机CPU推理候选。UHD核显是否能在具体Windows驱动、运行时版本上完成推理，以及H.265硬件解码是否真正启用，需分别实测；不得以设备名称或“hwaccel”参数存在作为加速成功证据。

来源：[OpenVINO系统要求](https://docs.openvino.ai/2026/about-openvino/release-notes-openvino/system-requirements.html)、[Frigate视频硬解文档](https://docs.frigate.video/configuration/hardware_acceleration_video/)。

## 路线比较

| 路线 | 降低平台计算的方法 | 适用与限制 | 建议 |
| --- | --- | --- | --- |
| 设备/NVR智能元数据 | 使用已有目标类别、事件时间和区域，先检索元数据 | 取决于设备能力，历史事件不一定保留 | 支持时优先 |
| 小模型检测与属性筛选 | 只检测查询需要的类别，对目标框做颜色/外观分析 | 固定类别有限；夜间颜色和小目标有误差 | 通用识别基础 |
| 图文向量检索 | 代表画面/目标裁剪只计算一次特征，查询比较向量 | 初次提取仍需算力；相似度不等同于同一实物 | 以文/以图检索核心 |
| DeepSeek直接看采样图 | 无需本地模型即可理解复杂描述 | 外部调用与重复采样仍有费用和延迟 | 保留为候选复核 |
| 独立NPU边缘盒子 | 将解码/推理从平台主机分离 | 增加设备、驱动和运维，容量依模型与解码而定 | 本机测不够再考虑 |

### 1. 优先使用摄像机或录像机已有结果

ONVIF Profile M定义了分析元数据、对象分类以及事件接口，可作为统一接入方向。国标视频仍保持GB28181，智能元数据作为可选能力适配，不把平台绑死在海康或大华。设备不支持时回退到通用本地识别。仅支持ONVIF视频或GB28181注册，不代表支持Profile M/智能元数据，也不代表能查询过去的分析事件。

对已有历史录像，只有当相关事件曾被保存或设备允许查询历史元数据时，才能直接用于缩小范围。无元数据不能认定无目标，也不能强制剔除该时段。

来源：[ONVIF Profile M](https://www.onvif.org/profiles/profile-m/)。

### 2. 解码与预筛选先省下来

先按通道、时段、事件和已有缓存缩小候选。历史文件按连续区间复用解码进程，避免每张采样都重复启动FFmpeg与初始化解码器；按文件版本、偏移和模型版本缓存缩略图/特征。

新增数据可选低分辨率子码流做分析，原主码流继续预览/录像，H.265与G.711A要求保留。已有主码流录像没有对应子码流文件时，不能声称可以从过去取到子码流。仅在解码后缩小尺寸或降低送检帧率，并不必然减少前面的完整解码成本。

可在查询时做低成本帧差/背景变化、区域筛选与相似帧去重，再调用检测器。Frigate采用运动区域触发检测，并单独强调解码开销和硬件加速。这里只参考其处理思路，不替换本平台或复制其业务代码。

运动过滤须保留定期背景代表帧、静止目标和人工指定时段的完整回查路径。不能因“没有运动”漏掉静置包裹或停放车辆；同一物体出现/离开的变化也需要留样。

来源：[Frigate目标检测](https://docs.frigate.video/configuration/object_detectors/)、[运动检测](https://docs.frigate.video/configuration/motion_detection/)、[高CPU排查](https://docs.frigate.video/troubleshooting/cpu/)。

### 3. 小模型负责常见目标，大模型处理难题

可先比较PP-PicoDet-XS与一个Nano级YOLO检测器，统一导出ONNX或OpenVINO；评测FP32与INT8的实际端到端表现，不能把厂商特定设备的FPS照搬到i7-8700。PicoDet官方提供轻量模型和多种部署后端；OpenVINO提供后训练量化流程。

“找白色汽车”可拆成汽车类别、目标框、颜色和时间过滤，简单条件用规则解析即可。复杂自然语言可让DeepSeek只返回一次经过服务端校验的结构化条件，再检索本地结果；不要让模型生成并直接执行SQL或控制设备。

检测器不认识的物品，应保留整景图文检索或按需复核入口；不能因为固定类别表里没有该类别就直接返回不存在。先使用预训练模型，现场标注证明有必要时再考虑训练。

来源：[PicoDet官方说明](https://raw.githubusercontent.com/PaddlePaddle/PaddleDetection/release/2.8/configs/picodet/README.md)、[OpenVINO量化](https://docs.openvino.ai/2026/openvino-workflow/model-optimization-guide/quantizing-models-post-training/basic-quantization-flow.html)。

### 4. 用图文特征缓存实现以文搜物、以图搜图

候选可比较CLIP ViT-B/32与SigLIP2 Base：图像/目标裁剪生成向量后缓存，输入文本或参考图编码后查相似向量，再核对候选附近录像。中文线索必须纳入评测；英文CLIP路线需查询翻译/别名转换，不能假定中文直接输入效果合格。SigLIP2提供图文检索能力，可作多语言候选，但本机性能和中文安防场景召回仍未测。

这类本地检索不需要每张图写一段大模型描述。第一次查询未索引的旧录像仍需读取画面，后续查询才受益于缓存；不能做到完全不看画面便知道录像内容。相似画面不保证是同一辆车、同一件实物，结果需回原录像确认。

Frigate也采用图像/文本嵌入的本地语义检索，但其文档明确了资源要求以及重建索引的开销，不应直接把整套系统当成“零算力方案”。

MobileCLIP虽然针对效率优化，其公开模型许可写明研究用途限制，暂不作为政企业务默认权重。应分别核查代码、模型权重和数据许可；不要将Skill许可证当作模型商用授权。

来源：[CLIP](https://github.com/openai/CLIP)、[SigLIP2模型卡](https://huggingface.co/google/siglip2-base-patch16-224)、[Frigate语义检索](https://docs.frigate.video/configuration/semantic_search/)、[MobileCLIP模型许可](https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE_MODELS)。

## 找到的Agent / Skill

已通过skill-installer辅助脚本查询当前官方精选目录，未发现专用安防边缘识别Skill；以下另在作者官方仓库找到，只阅读未安装或执行其脚本。

| Skill | 来源 | 与本项目的关系 |
| --- | --- | --- |
| yolo-inference | Ultralytics官方 | 推理、检测结果、跟踪及采样参数参考 |
| yolo-export | Ultralytics官方 | ONNX/OpenVINO等部署、量化与基准测试参考 |
| transformers-js | Hugging Face官方 | 可在Node/JS体系内评估本地图像/文本模型，减少架构改造 |
| gb-media-session、gb-acceptance | 当前项目 | 维护媒体租约、录像隔离、权限与真机验收 |

官方入口：[Ultralytics Skills](https://github.com/ultralytics/skills)、[yolo-export说明](https://raw.githubusercontent.com/ultralytics/skills/main/skills/yolo-export/SKILL.md)、[transformers-js说明](https://raw.githubusercontent.com/huggingface/skills/main/skills/transformers-js/SKILL.md)。第三方Skill只作为待审阅开发资料，不接受其自动上传、云部署等行为；本轮未启用这些功能。

建议的职责划分是：查询规划、边缘识别工作进程、结果复核与性能验收。识别工作进程是普通程序，不需要每路摄像机运行一个语言Agent。项目AGENTS.md仍采用默认单Agent执行，没有因本次搜索擅自建立并行Agent。

## 如果以后确需独立边缘设备

Rockchip官方RKNN Model Zoo包含RK3588等平台的检测及CLIP等示例，可作为下一阶段验证来源。公开模型推理表不等于摄像机端到端容量：还需计入H.265解码、前后处理、模型切换、内存带宽及同时录制。现阶段不建议先购买或承诺64路实时AI。

来源：[Rockchip官方模型示例](https://github.com/airockchip/rknn_model_zoo)。

## 适合本项目的推进顺序（未实施）

1. 建立现有按需查找的解码/网络/模型耗时基线，比较原始取帧与复用解码、缩略图缓存、硬解的差异，不改录像编码。
2. 在隔离进程中用同一份录像比较小检测器及图文特征，优先CPU可运行方案，再单独验证UHD630的可用加速；先1路，再4路，逐级增加。
3. 查询先执行结构化过滤、本地匹配，仅将少数疑难候选发DeepSeek复核；保存候选来源和覆盖范围，复用结果时继续复核权限与源文件版本。
4. 再按设备能力增加ONVIF/厂商智能事件适配；事件不存在的旧录像仍走通用按需路径。静止目标、夜间、雨天、小目标和非固定类别分别验收。

评测至少同时记录：整机CPU/内存/功耗（能测时）、每小时录像扫描耗时、实际解码帧数、每次检索大模型调用、候选召回/误报、预览丢帧、录像空档、搜索冷启动/缓存命中耗时。算力更低但大量漏检不算优化成功。性能目标需实测后确定，本报告不声称已节省某个百分比。

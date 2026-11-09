> 历史验收归档：YOLO功能现已退役，本文不代表当前运行能力。图片中文分析由千问承担。

# YOLO11n本地测试与模型清单

日期：2026-11-08。

本轮按 gb-feature-contract、gb-backend-service、gb-frontend-flow 和 gb-acceptance 项目Skill实施。未新增检测业务模块。

## 实测

本机Intel i7-8700、Intel UHD630；此次使用CPU单线程，没有使用GPU。下载官方 Ultralytics assets v8.4.0 的 YOLO11n ONNX（10,930,182字节），SHA256：634279b40c07c6391472c51ad45b81ebc48706a9a1fe72dd3396322acd0c053b。来源：https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.onnx 。许可证：AGPL-3.0 / Ultralytics Enterprise，未来产品分发需核对对应许可。

运行 `node scripts/setup-yolo-local.mjs` 下载并校验；`node scripts/benchmark-yolo-local.mjs .tmp/ai-hik-frame-test.jpg` 在已有1280×720海康截图上测试。预处理采用640×640等比例填充、RGB归一化；类别置信度0.25、同类别NMS IoU 0.45。加载272ms；6次推理148/125/119/122/130/120ms，后5次平均123ms；测试进程峰值218MiB（含图像处理及运行库）。得到4个汽车候选，置信度约0.46～0.58，已人工查看绘框图片；未做标注集准确率评估，不保证无遗漏。结果图：`.tmp/yolo11n-result.jpg`；原始报告：`data/ai-models/yolo11n/benchmark.json`。

仅证明本机能运行单张图像推理，未测试视频解码、多路并发、持续实时检测、检测告警或YOLO辅助录像检索，不以123ms推理时间承诺端到端帧率。本轮读取已有图片，未连接设备或发出SIP命令。既有海康样本对应DS-IPC-T12HV3-LA、V5.7.20 build241205、GB/T28181-2022；此次不是新的协议兼容性验收。

## 模型设置

`backend/ai/model-inventory.mjs`提供本地清单，`routes.mjs`新增管理员只读接口；`frontend/src/ai-types.ts`、`components/AiModels.vue`展示Chinese-CLIP、英文CLIP、YOLO11n的用途、已安装状态、默认检索选择、大小、许可和离线实测摘要。DeepSeek配置保留。枚举不加载模型、不联网、不返回路径或密钥；安装状态指所需权重文件存在，不代表校验、加载或业务接入已经完成。

`backend/ai-http.test.mjs`覆盖清单访问权限及数据字段；相关HTTP测试、类型检查和构建通过，构建保留原有大包提示。18102隔离平台已实际验证桌面、390px窄屏及首页/健康接口200。

后续正式生效复验：平台内“重启平台”仅在同一Node进程重建服务，不会重新加载ES模块，因此此前建议以此更新后端代码不正确。本次备份数据库后完整重启Node后台进程，正式3000页面已实际显示Chinese-CLIP、CLIP、YOLO11n，首页与健康接口200，SIP监听正常。后端代码升级须完整重启进程；平台内重启只应用配置。此次未将页面显示和健康状态当作媒体恢复或录像连续性验收。

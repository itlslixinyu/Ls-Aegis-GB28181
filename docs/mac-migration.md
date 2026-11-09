# Mac 开发迁移说明（2026-11-09）

这是当前 Windows 工作目录的开发交接，包含尚未发布的 Qwen 修复，不代表 Mac 兼容性或新模型验收已经通过。先读 README.md、AGENTS.md、docs/workflows.md；项目仍是 Node 原生后端与 Vue/Vite 前端，没有迁移到框架或新数据库。

## 从 Git 获取和启动

1. 在 Mac 安装 Git、Node.js 24（与 CPU 架构匹配，Apple Silicon 使用 arm64）。运行 `node -v`，确认主版本至少 24。
2. `git clone <仓库地址> ls-aegis`，然后 `cd ls-aegis`。
3. `npm ci`。不要复制 Windows 的 node_modules，sharp、ONNX Runtime 等包含平台相关二进制。
4. `cp .env.development.example .env.development`。
5. `npm run typecheck`、`npm run build`。
6. `npm run start:development`，保持终端运行。默认访问 http://127.0.0.1:3005，另开终端运行 `curl -f http://127.0.0.1:3005/` 和 `curl -f http://127.0.0.1:3005/api/health`；同时检查健康返回中的 status，不仅检查 HTTP 200。

开发环境使用独立的 `data/development/platform.db`，SIP 默认关闭、媒体配置为空。首次启动账号初始化规则见 backend/lib/store.mjs；现有 Windows 管理员密码没有写入仓库。前端热更新可另开终端执行 `npm run dev`，代理目标检查 vite.config.mjs，默认先以构建后的同源页面验证后端。

## Git 包含和不包含什么

提交源码、锁文件、环境示例、迁移 SQL、项目 Skills、文字验收材料和修复交接。排除 `.env`、data、backups、.tmp、dist、node_modules、日志、密钥、模型、原始告警图及页面截图。部分历史 Markdown 的图片链接指向本机证据，单独克隆后无法显示，这是有意保留的历史引用。

Git 克隆不会带走原账号、设备、告警、历史索引和录像。如果需要继续原现场数据，应通过可信的本地传输另行迁移：

- SQLite 在线备份取得一致的 platform.db；服务运行时不能只复制主库而漏掉 WAL。可在 Windows 执行 `node scripts/database.mjs backup data/platform.db`，等待完成，使用命令输出的备份文件。
- 同时保管相应目录的 access-config.json、ai-config.json 和 ai-master.key。加密的 AI 配置依赖原密钥。这些文件含现场信息，不上传 Git。
- 原录像约14.3GiB，位于 data/media；模型与 Windows 工具约2.2GiB。它们留在 Windows 本机，本轮尚未生成完整数据迁移包。
- 若将原库放到 data/development/platform.db，配套配置应放到同目录。先在副本上处理真实接入配置、自动录像计划和后台任务，防止开发环境自动连接现场。
- 修正配置及库中 Windows 绝对路径后才能访问旧录像。将视频文件搬到 Mac 并不会自动修正所有历史条目的路径。

不要同时让 Windows 和 Mac 用同一平台标识接入同一设备。迁移现场接入前需明确切换原平台、网络地址、SIP/RTP端口和媒体节点，并单独验证。

## Mac 上仍需适配的功能

| 部分 | 当前情况与下一步 |
| --- | --- |
| 本地 Qwen | backend/ai/qwen-runner.mjs 的 ready() 限定 win32，固定 llama-mtmd-cli.exe，使用 PowerShell 进程内存监控和 Windows CPU mask。不能直接在 Mac 启用；需适配本机 llama.cpp 可执行路径、资源监控、调度参数和退出回收，再做真实图推理。GGUF 权重可另传，但 Windows exe/dll 不能运行。 |
| Chinese-CLIP | 权重不在 Git。npm run ai:setup 使用项目清单下载；Mac ONNX Runtime、架构及推理仍需实测。不要默认退回英文模型。 |
| FFmpeg/FFprobe | 使用 Mac 对应版本；将配置中的 Windows exe 路径替换为本机实际路径。两者放在同一目录。 |
| ZLMediaKit | 当前本机服务不随 Git 迁移；需独立安装或接入授权的媒体节点，再配置 MEDIA_URL、MEDIA_SECRET、MEDIA_RTP_HOST 等。 |
| 浏览器测试脚本 | 多个 scripts/*browser-test.mjs 固定 Windows Chrome 路径，Mac 运行前需调整。PowerShell 安装/基准脚本也不是 Mac 脚本。 |

先验证无真实接入的开发页面和服务；Mac 的媒体、SIP、真机和模型兼容性本轮均未实测。

## Qwen 工作交接：不能当作修复完成

源码默认仍为已发布 threads2/p6i1；新增 candidate 为 p9i2，未设为默认，也未重启正式后端。后处理已修正结构化条目共享颜色/位置的误拒绝，并排除时间戳类实体。36项相关后端/HTTP测试在 Windows 通过：

```sh
node --test backend/alarm-analysis.test.mjs backend/alarm-analysis-http.test.mjs backend/ai.test.mjs backend/ai-http.test.mjs
```

p9i2 的8张真实原图整轮已完成尝试，但验收失败：2张人物图识别到人物；白天汽车图包含未经静态图证明的“行驶”；过曝汽车图超时；夜间图有车辆但位置仍有疑点；反光图的模型原始判断仍误认车灯，目前靠像素质量规则输出不确定外观，不能宣称模型已正确识别其类别；屏幕图因内存不足取消；宽屏图输出屏幕及图像，仍需核对。解析成功不能等同内容正确。完整交接见 qwen-grounding-fix-20261109.md。

原始8张JPEG保留在 Windows docs/evidence/qwen-multiscene-20261108/；SHA256及原始输出文字见 docs/qwen-multiscene-20261108.json，新候选原始诊断在 Windows .tmp/qwen-repair-20261109/final-eight.json。需另行本地传输这8张图，继续使用同一最终配置完整复测，不换图、不按文件名填答案、不只拦截错误结果。全部内容验收通过后才可正式启用。

Windows 后台告警 AI 与索引仍暂停（qwenAlarmEnabled=false、indexEnabled=false，localEnabled=true），现有录像服务未因迁移停止。用户授权暂停的 Docker/WSL 保持停止。Git 迁移没有恢复这些开关，也没有发布候选。

## 接手顺序

1. Mac 执行 npm ci、类型检查、构建，启动并检查首页及健康接口。
2. 在独立数据库中验证页面及权限，再按需迁移现场数据副本。
3. 完成 Qwen 的 Mac 运行器及资源保护适配，另传原8张图并核对哈希。
4. 修正无依据目标、动作及位置描述，完整重复真实推理并人工核对；未通过不得正式启用。
5. 单独安排媒体和真实设备迁移验收，不凭首页可访问就报告 SIP/录像可用。

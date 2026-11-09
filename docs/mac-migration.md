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
- 原录像约14.3GiB，位于 data/media，不在数据库/模型包内。数据库、模型及8图复测材料现有独立本地包，操作见下方“数据库、模型及复测材料恢复”；Windows工具不打包到Mac。
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

## 数据库、模型及复测材料恢复（补充）

Windows 输出目录为 `transfer/mac-20261109/`。请通过移动硬盘、局域网文件传输等方式将下列文件放到 Mac 的同一目录，例如 `~/Downloads/ls-aegis-transfer/`。包里有账号哈希、现场配置、AI主密钥及真实照片，仅供本人迁移，不上传Git或公开分享。

| 文件 | 内容与解压目的地 |
| --- | --- |
| database-private.tar.gz | SQLite一致性快照、原 access-config.json、ai-config.json、ai-master.key、导出信息；解到单独备份目录，不直接覆盖正在运行的数据库。 |
| models.tar | Qwen3-VL Q4_K_M、Q8视觉投影、Chinese-CLIP量化ONNX及分词/预处理配置；在仓库根解压，得到 data/ai-models/。不含Windows exe/dll。 |
| retest-private.tar.gz | 原8图及历次候选诊断、旧测试脚本；在仓库根解压，得到 docs/evidence/... 和 .tmp/qwen-repair-20261109/。 |
| models-manifest.json | 12个模型文件的大小与SHA256。 |
| SHA256SUMS | 上述数据包和模型清单的SHA256。 |

先更新代码到包含本补充的最新提交，并安装Node24及依赖。以下命令均在仓库根执行，目标目录不存在时使用：

```sh
git pull --ff-only
npm ci
# 可先在传输目录校验整个包
(cd "$HOME/Downloads/ls-aegis-transfer" && shasum -a 256 -c SHA256SUMS)
mkdir -p transfer/mac-original
tar -xzf "$HOME/Downloads/ls-aegis-transfer/database-private.tar.gz" -C transfer/mac-original
tar -xf "$HOME/Downloads/ls-aegis-transfer/models.tar"
tar -xzf "$HOME/Downloads/ls-aegis-transfer/retest-private.tar.gz"
node scripts/database.mjs check transfer/mac-original/snapshot/platform.db
node scripts/prepare-mac-development.mjs transfer/mac-original/snapshot data/mac-development
cp .env.development.example .env.development
```

编辑 `.env.development`：将 `PLATFORM_DATABASE` 改为 `data/mac-development/platform.db`，保留 `SIP_ENABLED=0`、空媒体URL和密钥。脚本生成的持久接入配置也关闭SIP、清空媒体连接；因为持久配置会覆盖环境配置，所以不能仅改.env。不要把原 access-config.json 再覆盖到开发副本。

开发副本保留账号、设备档案、告警图片、分析结果、录像目录及索引记录。脚本仅在新目标目录操作：禁用录像计划和级联注册、关闭遗留会话/观看租约、取消未完成录像和AI任务、删除浏览器登录会话、暂停云端分析/自动告警AI/索引。原始快照保留不变，原账号密码仍可登录，但Mac需重新登录。脚本拒绝覆盖已存在目录；如已建立 data/development，使用这里的新目录即可，无需删除旧数据。

```sh
node scripts/database.mjs check data/mac-development/platform.db
npm run build
npm run start:development
# 另开终端
curl -f http://127.0.0.1:3005/api/health
```

先确认页面和健康，再验证历史告警图与分析记录。数据库有录像“条目”，没有录像文件本体；旧记录过期清理仍可能按应用规则执行，应保留原始快照。重放历史视频、录像帧提取或检索精查，需要另传 data/media，并调整历史路径/本地根路径和Mac FFmpeg；本包仅支持已有图片的复测，不代表完整录像迁移。

模型默认目录正是 `data/ai-models/chinese-clip-vit-base-patch16/` 和 `data/ai-models/qwen3-vl-2b-q4/`，不要多嵌套一层目录，也不要把两份GGUF拆开。配置内不要沿用Windows绝对模型路径。可核对模型文件：

```sh
node --input-type=module -e 'import {localModelReady} from "./backend/ai/local-model.mjs"; console.log({chineseClipFilesReady:localModelReady()})'
```

该命令仅检查文件/版本就绪，不证明Mac实际推理通过。Qwen的Mac运行器仍待适配，权重放好后也不能直接启用原Windows运行器。`scripts/setup-qwen-vl-local.mjs`包含Windows运行库下载，不要当作Mac安装命令运行。

### 接着做8张原图复测

材料中 `.tmp/qwen-repair-20261109/before.json` 的 samples 是原8图相对路径和SHA256；final-eight.json 是失败候选的原始输出。先核对图，再改Mac运行器与复测脚本，不要复用before.json里Windows健康实例作为新实例。

旧 `.tmp/.../verify.mjs` 固定 `data/platform.db`、localhost:3000和Windows实例信息，因此不能原样用于Mac验收。完成Mac运行器后，可先使用已有单图入口：

```sh
mkdir -p .tmp/mac-retest
node scripts/verify-qwen-caption.mjs --image docs/evidence/qwen-multiscene-20261108/car-day.jpg --database data/mac-development/platform.db --report .tmp/mac-retest/car-day.json --repeat 1
```

该入口默认使用发布profile，而非candidate；要验证新候选，应在接手修改中显式选定并记录同一最终profile，完整运行8张。入口的passed仅表示脚本条件满足，最终仍逐图人工核对人物/车辆、额外目标、颜色位置、动作和时间戳；不能把JSON合法或不报错当成视觉内容正确。全部通过前保持自动AI关闭。

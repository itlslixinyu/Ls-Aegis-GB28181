# 告警原图车辆识别修正

后续8张真实告警图复测未全面通过，发现结构化结果误拒绝及描述细节问题；本文是此前单图修正记录，不能代表当前多场景完整验收通过。最新结论见[多场景复测](qwen-multiscene-20261108.md)。

2026-11-08核对11:45:41记录ee4a5d80-0cc9-400c-92e6-fad9f54c0465及原图：道路、路口和停车区可见多辆汽车，旧版“未见人员或车辆”明显错误。

## 当前状态

最终配置的原图连续两次真实推理和一张室内无车对照通过；30项后端、5项前端测试及类型检查、构建通过。用户手动停止旧后台后，已更新前后端、启动新版36064并正式开启告警自动分析。原11:45:41告警已在正式页面通过“重新分析原图”完成新推理：35.976秒、峰值2507.93MiB，正确生成汽车及位置描述和“汽车”标签。原ID、图片时间和图片SHA256保持一致，usage.reanalysis=true，无cached/similarScene标志。

桌面与390×844窄屏均检查通过，截图为[qwen-quality-formal-desktop-20261108.png](qwen-quality-formal-desktop-20261108.png)及[qwen-quality-formal-narrow-20261108.png](qwen-quality-formal-narrow-20261108.png)。最终本地接入、告警自动分析及后台索引均已开启，采样间隔仍为120秒。结果页面已保留。

## 修改文件与行为

- backend/ai/qwen-runner.mjs：640像素、256～512图像token、2048上下文、64微批、224输出token。通用提示要求模型按JSON输出最多5项物体名称、颜色和位置，没有预填汽车或这张图的答案。描述和标签来自模型字段，不补造车辆。模型版本640:p6i1:t2隔离旧结果缓存；仍不提供目标框、置信度或精确计数。
- backend/ai/alarm-analysis.mjs、routes.mjs、frontend/src/components/Alarms.vue：告警详情增加“重新分析原图”。显式受理后保留原ID、原图和图片时间，清空旧结果并排队，跳过相似缓存。权限、CSRF、队列上限、60秒全局启动间隔、超时、取消和撤权回收继续生效。仅原归属账号或管理员可发起，原账号仍须具备设备分析权限。
- backend/ai/service.mjs同步读取启动内存预算；默认2线程、低优先级、全局单任务，启动需3584MiB，运行低于1024MiB或模型工作集超过2800MiB继续让出资源，单次120秒上限不变。
- scripts/verify-qwen-caption.mjs支持离线真实模型验证。期待词只检查输出，不送入模型提示；数据只读，验证不抓图、不调用SIP或云端。
- backend/alarm-analysis.test.mjs、alarm-analysis-http.test.mjs、frontend-components.test.mjs补充结构化结果、重分析权限、幂等、缓存跳过、内存门槛及迟到响应等回归。

## 真实模型验证

使用这条记录的已有JPEG，每次独立启动模型进程，没有结果缓存。原图SHA256为690959c05edcdc9f5afce615d8763a88890be1baa276eca8ff60669c8d39f967。原始JSON、摘要、标签、参数和指标见[qwen-quality-verification-20261108.json](qwen-quality-verification-20261108.json)。

| 样本 | 模型结果要点 | 耗时 | 峰值工作集 |
| --- | --- | --- | --- |
| 原图第1次 | 汽车（白色，画面中下部和右上部分）；另有建筑物、道路、树木、交通标线；标签含汽车 | 36.332秒 | 2508.01MiB |
| 同一原图第2次 | 同上；未输出未见车辆、运动、天气或时间戳 | 36.328秒 | 2507.82MiB |
| 室内无车对照 | 人（黑色，右上角）、灰色窗帘、红色徽章；无汽车描述或标签 | 34.628秒 | 2507.83MiB |

```powershell
node scripts/verify-qwen-caption.mjs --image .tmp/reported-alarm-ee4a5d80-0cc9-400c-92e6-fad9f54c0465.jpg --repeat 2 --expect 汽车 --reject '未见|行驶|移动|阴天|晴朗|货车|2026' --report .tmp/qwen-quality-final-original-ub64.json
node scripts/verify-qwen-caption.mjs --image .tmp/latest-qwen-check/3.jpg --expect '人物|人|男子' --reject '汽车|车辆|轿车|货车|行驶' --report .tmp/qwen-quality-final-control-ub64.json
```

自由描述试稿虽识别出车辆，仍补写天气、运动或循环标签，未采用。1024图像token试验触发内存保护，未采用。首次室内对照因内存不足中断；临时暂停后台索引并减少微批后重测通过。告警自动分析和后台索引均已恢复。

运行库提示低视觉预算会影响定位精度，核对过[对应版本mtmd实现](https://github.com/ggml-org/llama.cpp/blob/b12189/tools/mtmd/mtmd-cli.cpp)。本轮只验证此原图车辆识别及一张无车对照，不代表全场景准确率或精确目标定位达标。

## 检查与发布准备

- 后端：node --test backend/alarm-analysis.test.mjs backend/alarm-analysis-http.test.mjs backend/ai.test.mjs backend/ai-http.test.mjs，30项通过。
- 前端：node --test --test-name-pattern '告警原图重分析|千问|AI.*本地' backend/frontend-components.test.mjs，5项通过。
- npm run typecheck和暂存目录Vite构建通过。构建时发现同一工作区有其他前端更新，保留并在类型同步后重新检查，没有覆盖这些修改。
- 备份backups/qwen-quality-1794111843501/platform.db，完整性ok、外键错误0；备份保留旧结果和录像计划。暂存前端.tmp/qwen-quality-dist。
- 自动审批拒绝含强制结束旧后端进程的更新脚本（blocked by policy，未提供具体原因），脚本未执行。改为用户手动停止后台37292，启动器确认3000无监听后启动新版36064；新健康实例54fcdd71-91cf-47eb-b10c-4d5aa45e2541。
- 正式首页、新入口JS/CSS均200，健康ok、SIP listening。录像计划逐字段与备份一致，录像任务bb1c2b60-2cdd-4cf0-8e21-1e74447a51c6恢复recording、无错误，源ef5718d0-71a7-409b-beef-e7c08e4bcc4e为ready；文件数从备份时464增加至468。
- 用户授权后已向并行聊天协调发布/浏览器操作。正式验收最终使用localhost域名，避免与127.0.0.1隔离测试的同名Cookie互相覆盖。观察到的subscription.disable不是本轮操作，没有擅自恢复或改动该订阅。

未批量重算其他旧记录。本轮不涉及SIP协议变更或设备固件兼容性验收。

# 录像中断、告警与自动恢复实测

日期：2026-11-05，以下时间均为北京时间。使用现有admin登录，未修改账号、授权、录像计划或相机编码。

## 测试对象与操作

选择当前正在执行计划的海康测试摄像机（192.168.31.223）。历史设备登记为DS-IPC-T12HV3-LA、固件V5.7.20 build 241205、GB/T28181-2022，本次未重新读取固件或重新做协议兼容认证。恢复后的录像在浏览器实际解码为1920×1080。

仅关闭该录像任务的媒体RTP源，模拟取流中断；没有调用“结束任务”或停用计划。后两种属于主动停止，按产品规则不会自动恢复当前时段。本次未重启平台、修改网络规则或改变相机配置。大华计划已过当日执行窗口，未擅自延长其录像时段；本轮真实中断证据仅覆盖在录海康通道。

## 实测结果

| 时间 / 检查 | 结果 |
| --- | --- |
| 22:37:21 中断 | 原任务dcd281c9-a3b4-4f17-9449-0bbe45d55b0e媒体源关闭 |
| 22:37:21.755 告警 | 生成recording-interrupted告警，id为c2c9a482-444d-49ed-9160-afc416794cc1，repeatCount始终为1 |
| 22:42:54 新任务创建，22:42:57观测到恢复 | 自动创建f747025f-0e07-4f93-b0f9-cebb71146417并进入recording；本次命中最长5分钟退避，另有约30秒文件确认时间 |
| 原执行记录 | 同一dailyKey始终只有一行，执行过程由9次变10次，原失败任务及文件保留；浏览器已展开执行过程核对 |
| 新录像分段 | 等待原计划300秒分段自然封口，得到2026-11-05-22-42-54-0.mp4，时长300.032秒 |
| 下载 | 中断前文件6,609,372字节，恢复后文件38,386,762字节；完整下载200且长度与响应一致，分别计算SHA-256并保存 |
| 回放接口与权限 | Range请求206、inline；完整下载attachment，回放字节与下载前1024字节一致；匿名访问401 |
| 浏览器实际播放 | 两文件均1920×1080，播放时间及解码帧数增长、paused=false、error=0；分别跳至50%和95%附近继续播放通过 |
| 计划及资源 | 更新前后计划列表完全一致；旧会话released=1，新会话ready，测试结束仍recording |

浏览器实际检查了告警页面、当天唯一执行行及录像回放页面。没有仅凭HTTP200或任务状态判定播放成功。录像不是整段逐帧看完；本轮检查开头、中段和尾段实际解码，未另验收音轨可听性或音画同步。

## 发现与处理

本次真实闭环未发现需要修改业务代码的阻断问题。故障注入时，媒体源并发关闭使测试工具收到一次部分资源回收错误；核对旧流确已消失，后续确认旧会话资源已释放，因此继续观察同一故障，未重复关闭恢复后的流。验证脚本增加了已中断任务续查路径，避免重复注入。

录像、HTTP权限及媒体适配器14项相关回归通过。本轮没有重新运行全项目测试或构建，因为未改业务实现。

## 证据

- `.tmp/recording-interruption-real.mjs`：真实故障注入/续查、告警去重、恢复、新分段、完整下载与访问检查。
- `.tmp/recording-interruption-real-result.json`：任务、告警、文件字节数及校验值。
- `.tmp/recording-interruption-browser.mjs`、`.tmp/recording-interruption-browser-result.json`：正式浏览器播放与跳转数据。
- `.tmp/recording-interruption-before.mp4`、`.tmp/recording-interruption-after.mp4`：实际完整下载文件。
- `.tmp/recording-interruption-browser-history.png`、`.tmp/recording-interruption-browser-alarm.png`、`.tmp/recording-interruption-playback-before.png`、`.tmp/recording-interruption-playback-after.png`：页面与播放截图。
- `.tmp/recording-interruption-regression.log`：14项回归结果。

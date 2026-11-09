# 模拟视频与样例回放

- 用户要求将64台信令模拟摄像机增加模拟画面，并验证录像回放；后续明确不扩展更多录制路数。
- 使用本机已有官方ZLMediaKit镜像内FFmpeg6.1.1生成20秒循环测试图案，画面明确显示“LS-AEGIS SIMULATED VIDEO”，640×360、10fps、H.264视频和静音AAC音轨。文件为 `.tmp/simulated-cameras/sample.mp4`，不使用真实摄像机画面。
- 模拟器通过本机原生媒体节点装载测试MP4，按需转PS/RTP，并实际回应国标INVITE/ACK/BYE。只接受本机目标地址；未知设备、非本机媒体目标或设备历史回放请求被拒绝，不假装设备内有历史录像。
- Windows节点对中文绝对路径的文件打开失败；使用相对于 `data/media/native-runtime` 的 `../../../.tmp/simulated-cameras/sample.mp4` 已验证成功。未改变媒体配置、密钥或真实设备编码。
- 分组名升级为“模拟摄像机（测试视频）”，仍有64台独立注册摄像机。当前视频模拟器进程2208，源流名 `ls_simulated_camera_source`；停止时按对话SSRC停止专用转发，注销模拟设备，仅关闭自身测试源。
- 现场发现用户已创建名为“测试”的64通道分组计划，15分钟分段、保留7天；未另外创建计划，也未修改它的设置。目前原型账号最多4个并发录像任务，海康占1个，所以实际模拟录制为013、014、015三路，不能据此宣称64路录像并发完成。
- 为提供可立即查看的完整样例，针对这三路模拟流提前收尾一个MP4片段，并立刻按原900秒参数继续录制；任务及计划关联不变。`.tmp/simulated-recording-sample.mjs` 只选专用模拟分组，不操作海康流。后台正常发现文件后，平台录像资源列表出现这三路。
- 正式浏览器实测013/014/015三路同时回放，均640×360、readyState4、无加载错误；观察播放进度从约0.19秒持续至55.76秒。已保留样例回放页及截图 `.tmp/simulated-video-playback-20261107.png`。
- 隔离自动测试2项通过：64台UDP认证、心跳、目录、注销；视频协商PS/RTP、共用源、拒绝外部目标、BYE回收。非模拟计划配置未改变，海康录像仍正常执行。未验证64路同时视频或录像的性能。

源能力依据：[ZLMediaKit REST API](https://github.com/ZLMediaKit/docs/blob/main/src/guide/media_server/restful_api.md)、[官方loadMP4File实现](https://github.com/ZLMediaKit/ZLMediaKit/blob/master/server/WebApi.cpp)。协议测试仅针对当前本机软件模拟器，不代表真实厂商固件兼容性。

视频模式启动使用 `SIMULATED_CAMERA_VIDEO=1` 环境变量和原模拟启动脚本；控制与状态仍使用 `.tmp/simulated-cameras/control.json`、`status.json`。不随系统重启自动运行。

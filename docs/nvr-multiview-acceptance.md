# NVR与多画面完善验收

日期：2026-11-03。版本仍为v0.7.1，仅完善现有业务。

后续调整：用户要求取消8画面，已改为六档布局并补充32条分页，最新状态见[分页验收](channel-pagination-acceptance.md)。下文保留本次调整前的实测记录。

## 本轮修复

- 实时预览支持1、4、8、9、16、25、36画面；对应1×1、2×2、4×2、3×3、4×4、5×5、6×6。先选窗口再选在线通道，单画面保留所选通道，缩小布局卸载多余播放器并释放观看租约。窄屏在画面区内横向滚动，保留所选窗口数。
- 多画面改用同源WebSocket-FLV，避免多个长期HTTP-FLV连接占满浏览器HTTP/1连接池，影响后续拉流、状态查询与续租。新增`ws`依赖，原HTTP-FLV接口保留。此变更不代表已通过36路物理视频的解码、带宽或性能验收。
- WebSocket升级校验Origin、登录、观看归属、租约及设备权限；过期、退出或撤权关闭流，上游断开不会暴露媒体密钥；客户端不能向媒体服务发送数据。转发带背压与超时清理。
- 单账号观看者保护阈值16改为64，允许完整36窗口并为其他既有观看引用留出余量；实例仍最多64个未释放源流。这些是保护阈值，不是生产容量承诺。
- NVR XML兼容BOM、HTTP/MIME charset及XML声明，GB2312/GBK使用GB18030解码；损坏数据拒绝处理。完整目录按父设备与事务合并；乱序、重传、跨设备同编号和离线子通道不会相互覆盖，分批失败保留旧目录。
- 播放失败时清除就绪、播放和暂停状态，避免底部仍显示“实时预览”；自然结束后的迟到失败不覆盖结束状态。
- 修复服务重启清空所有注册绑定、导致仍认为自己已注册的设备无法通过心跳恢复的问题。迁移10新增`sip_registrations`记录平台身份；同平台未过期UDP绑定可保留，绑定失效、平台身份变更及旧TCP连接必须重新注册。有效UDP绑定仅可通过匹配端点的有效Keepalive恢复在线。

## 自动验证

`node --test --test-timeout=30000 backend/*.test.mjs`：106项通过，无跳过；`npm run typecheck`与`npm run build`通过。

新增13项回归覆盖：七种布局与卸载行为、播放失败/结束状态、36个不同NVR通道与64观看者阈值、分批目录/编码/父设备隔离、36条实际WebSocket连接及二进制转发、HTTP查询不被阻塞、鉴权/跨域/租约/退出/上游失败，以及重启绑定与心跳恢复。协议与媒体替身用于隔离测试，未写入正式设备数据。

## 本机真实验证

目标：海康DS-IPC-T12HV3-LA，固件V5.7.20 build 241205；GB/T28181-2022设置、UDP信令、TCP-ACTIVE媒体。该设备是IPC，不能用它证明物理NVR兼容性。

- 已认证重新注册并生成迁移10的绑定记录；正式服务再次重启后保持在线并收到心跳。
- 浏览器WebSocket-FLV实际播放1920×1080 H.265；两个窗口同时解码，均为`readyState=4`、1920×1080。缩小布局移除多余视频元素，单画面保留所选通道；租约回收后数据库仅保留有效观看者。
- 1440×960逐一点击七种布局，实际DOM窗口数及行列全部符合上述映射；36画面只播放一路真实摄像机，其余为空窗口。
- 390×844检查36窗口：页面未产生横向溢出，画面区351px、内容840px，滚动限定在该区域；已恢复浏览器默认尺寸。
- 正式数据库迁移版本10，`PRAGMA integrity_check=ok`，`foreign_key_check`无异常。保留现有设备名称、分组、通道及用户数据。
- 最终首页HTTP 200，`/api/health`为`status=ok / sip=listening / media=online`；管理员媒体检查HTTP 200，真实设备在线且一条通道。

真实视频截图只存本机私有`data/evidence/nvr-wall-36-20261103.jpg`及`nvr-wall-mobile-20261103.jpg`，不作为公开样例。此前单摄像机完整记录见[海康接入验收](hikvision-live-acceptance.md)。

## 尚待真机验收

真实硬盘录像机及其多个不同通道、离线子通道切换、断网恢复、不同编码/厂家/固件、36路同时解码和长期负载仍需目标设备验证。录像、云台、告警、订阅及级联的其余既有业务边界保持[开发状态](development-status.md)中的描述，不能从本轮直播通过推断其全部通过。

## 参考

- [RFC7303 XML媒体类型](https://www.rfc-editor.org/rfc/rfc7303.html)：XML编码判定。
- [Chromium连接池实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/socket/client_socket_pool_manager.cc)：HTTP与WebSocket连接池限制不同。
- [ws官方文档](https://github.com/websockets/ws/blob/master/doc/ws.md)：WebSocket升级与连接生命周期。
- [NGINX WebSocket代理](https://nginx.org/en/docs/http/websocket.html)：反向代理Upgrade/Connection配置。

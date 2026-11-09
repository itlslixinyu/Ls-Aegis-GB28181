# 互联网使用条件与当前差距

核对日期：2026-11-01。针对当前独立开发版本，不把 WVP 的示例参数当作实际部署环境。本次只核查条件，未开放防火墙、未部署公网入口。

2026-11-03补充：本机已接入一台海康IPC并通过网页直播，SIP及本地ZLMediaKit已配置；仍未部署公网入口。以下“尚未部署”描述保留此前核查时点。最新多画面使用WebSocket-FLV，公网反向代理还需支持WS升级，HTTPS网页使用WSS。

## 当前状态

- 网页运行在 `http://localhost:3000`，HTTP 仅监听 `127.0.0.1`。
- 本机没有 `.env`；SIP 未启用，ZLMediaKit 未配置，现有设备未注册且没有通道。用户确认设备与媒体尚未部署。
- 可以管理档案和配置；还不能通过互联网接入真实设备、观看视频或取得实际录像。

## 三条链路分别准备

| 链路 | 必要条件 | 当前程序相关配置 |
| --- | --- | --- |
| 浏览器→平台 | 可达的 HTTPS 入口，建议域名和有效证书；同主机反向代理到本机 HTTP。也可先通过 VPN 使用 | `PORT` 默认3000；HTTPS环境设置 `COOKIE_SECURE=1`，然后重启 |
| 设备/上级↔SIP | 直连可达IPv4或受控VPN；监听、NAT和防火墙相互匹配；双方平台编号、域及设备接入密码一致 | `SIP_ENABLED=1`；`SIP_HOST` 为实际监听网卡或 `0.0.0.0`；`SIP_PUBLIC_IP` 为对端可达IPv4；`SIP_PORT` 默认8116，同端口UDP和TCP |
| 设备/上级↔媒体 | 部署支持RTP代理、HTTP-FLV、MP4和相关API的ZLMediaKit；对端能到达SDP中声明的媒体IP和实际媒体端口 | `MEDIA_RTP_HOST` 为设备可达地址；`MEDIA_URL`/`MEDIA_SECRET` 为后端管理连接；`MEDIA_PLAY_URL` 为后端可达HTTP文件/流地址 |

公网访问网页通常放行443/TCP。SIP按实际使用放行8116/UDP、8116/TCP；媒体端口按ZLMediaKit实际配置及返回值分别处理UDP/TCP。需要路由器端口映射时，保留SDP声明的媒体端口对应关系，不能只映射网页端口。

**页面展示的接收40000～45000、发送50000～55000目前是提示值，没有自动配置或约束ZLMediaKit。** 接收器通过 `openRtpServer(port=0)` 动态分配，实际范围由媒体节点的 `[rtp_proxy] port_range` 等配置决定；级联发送还需核对实际 `local_port`。不能直接按页面数字配置防火墙后就宣布网络打通。字段与版本以[ZLMediaKit官方配置](https://docs.zlmediakit.com/guide/media_server/config_file.html)为准。

复杂NAT、代理Contact和Record-Route并非当前完整支持范围。TCP主动接收需要媒体节点能连接设备注册IPv4；设备在私网且无回程路由时不能靠选择TCP自动解决。跨网初次部署宜先建立站点VPN或使用双方明确可达的直连网络，再验证UDP或TCP被动接收。

## 网页反向代理

下面为配置片段；`map`放在`http`上下文，`location`放在HTTPS `server`内。证书、域名、运行目录和内部访问控制需按实际服务器补齐，尚未应用到本机。

```nginx
# http {} 内
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# HTTPS server {} 内
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

保留原始Host和浏览器Origin供同源校验使用，不要改写成内部平台地址；显式转发Upgrade/Connection以支持WebSocket。关闭响应缓冲，使保留的HTTP-FLV接口持续传递。读超时表示两次上游读取之间的空闲时间，不是允许无限播放；平台会话与租约仍然有效。[NGINX WebSocket代理文档](https://nginx.org/en/docs/http/websocket.html)

ZLMediaKit管理API和文件/播放端口限制在后端网络，浏览器继续使用平台同源鉴权代理。当前未实现直接媒体端口的播放鉴权，不应把它当作平台登录控制的一部分。跨主机媒体回调通过受控内部代理连接平台；公共入口可限制该回调路径。

## 录像、地图和运行条件

- 录像：媒体MP4目录可写、磁盘及保留策略满足业务；数据库索引和实际媒体文件分别备份。完整导出还需独立 `MEDIA_HOOK_TOKEN`、ZLMediaKit的 `on_publish` 回调以及匹配的 `MEDIA_RECORD_PATH`，见[录像操作说明](recording-and-tcp.md)。回调凭据不要写进公开日志或示例截图。
- 地图：配置可达的XYZ底图和署名；设备和底图坐标系必须匹配。当前使用WGS84，不自动转换GCJ-02/BD-09；未配置底图只显示明确标注的网格。
- 时钟与运维：设备、平台和媒体节点同步时间；安排自动启动、异常重启、日志轮转、数据库及文件备份，并实际做恢复测试。本次已做升级前备份，尚未完成灾难恢复演练。
- 带宽：按设备码率、同时拉取源流数、同时观看者数和录像导出分别估算。示例4Mbps×10个观看连接约需40Mbps出口，另计协议开销；这不是本版本的实测容量。
- 容量：目前是单进程SQLite版本，没有生产集群、生产容量或长时间压力验收，不能根据示例配置承诺设备数/并发路数。
- 境内云服务器对外提供网站时，按实际服务性质核实备案及服务商接入要求；参见[工信部非经营性互联网信息服务备案规定](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)。

## 上线前必须补验

按“设备添加→接入密码→真实注册/心跳→目录/通道→预览/停止→云台/自动停止→录像检索/回放/导出文件→计划跨日与保留清理→真实告警/订阅/位置轨迹→授权撤回→实际上级级联”执行。随后从外网浏览器和外网设备分别测试断网、重连、退出、超时和端口释放，核对实际文件可播放、时间范围及权限。

当前没有真实设备、媒体和上级平台，以上步骤没有被业务接口测试或69项本地回归替代。实际admin业务验收见[本轮记录](admin-flow-acceptance.md)。

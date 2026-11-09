# AI画面分析与检索契约（实施中）

用户明确授权新增左侧AI模块、使用DeepSeek及所提供密钥进行真实验证，常规实现自行决策。此功能为新增授权范围，未完成部分不可写成已实现。独立开发，不复制参考项目代码。

## 资料核实

2026-11-07官方资料及账号实测：DeepSeek官方 `/models` 返回 Flash 支持 text/image，Pro为text。采用 `deepseek-flash` 的Chat Completions图像输入及JSON结构输出。图像描述是模型推断，需要人工复核；第一阶段不做身份识别。模型密钥只在后端加密保存，不返给浏览器，不写审计日志。

- [DeepSeek图像输入](https://api-docs.deepseek.com/guides/vision/)
- [DeepSeek接口](https://api-docs.deepseek.com/api/create-chat-completion/)
- [结构化JSON](https://api-docs.deepseek.com/guides/json_mode/)
- [Sharp图像输入限制](https://sharp.pixelplumbing.com/api-constructor/)

## 页面及行为

AI一级菜单提供画面分析、智能检索、模型配置。画面分析支持上传图片或选择有权限的国标通道抓拍；明确选择后才采集/发送单帧，不自动轮询全部设备或增加录像计划。保留来源、时间、文字描述、物体类别/数量及任务状态。智能检索支持文字描述和参考图片，检索当前可访问的已分析画面；图片相似度与描述匹配不能当作目标身份或事实确认。

模型配置只允许管理员维护，固定DeepSeek官方地址；空密钥保留，显式清除才删除，版本冲突409。连接测试用合成图，不发送真实摄像机画面。连接通过与图像真实验证分别记录。

## 接口草案

- GET/PUT `/api/v1/ai/settings`：公开配置/保存，密钥仅写入。
- POST `/api/v1/ai/settings/test`：真实模型/合成图验证，超时有明确错误。
- POST `/api/v1/ai/analyses`：图片或通道，问题及幂等键，202返回任务。
- GET `/api/v1/ai/analyses`、`/{id}`、`/{id}/image`：权限过滤的列表、状态/结果、同源图片。
- POST `/{id}/cancel`：仅取消本任务，不能停止其他观看者或录像。
- POST `/api/v1/ai/search`：按文字或参考图片查询当前可访问分析记录，结果注明匹配方法。

任务queued/running/succeeded/failed/cancelled/interrupted；并发有全局及账号上限，外部调用有截止和取消，服务重启将未完成任务标记中断，不无限重发产生费用。抓拍独立观看租约，成功、失败、取消均释放自己的引用。失去功能/分组权限后不再返回结果或图片。

数据库新增迁移脚本，不改原设备、账号或录像计划。图像限大小/像素，正规解码后转JPEG并清理EXIF；保留期清理有界。检索先按服务端权限过滤候选，禁止通过分数或总数泄漏无权设备。

## 验收目标

真实DeepSeek合成图请求、错误密钥/余额不足/超时/无效JSON处理；画像抓拍及独立租约回收；不同设备组与撤权；重复提交/排队/取消/重启；文字及图片检索可解释；桌面/窄屏实际浏览器操作；已有录像计划指纹对比。当前海康计划被用户后续重新启用，AI实现不覆盖此设置。

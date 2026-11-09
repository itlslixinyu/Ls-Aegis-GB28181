# 用户管理与角色权限二次复查（2026-11-05）

本轮仅完善现有用户管理、角色配置和账号授权，不新增业务模块。浏览器使用临时内存数据库与隔离测试账号；未修改正式账号的资料、密码、角色或分组授权。

## 修复与完善

- 修复刷新时权限初始化切换默认页面、提前覆盖已保存页面的问题；初始化完成后再持久化当前页面。用户管理刷新后保留页面和检索条件。
- 用户资料编辑增加“重新读取”；保存冲突保留草稿，点击后获取最新资料和版本，可继续保存。用户详情补充设备权限范围。
- 角色编辑增加“重新读取”；版本冲突保留草稿并阻止反复提交旧版本。读取中禁止保存；角色已删除时给出说明；关闭弹窗后迟到结果不覆盖新打开的角色。
- 角色列表并发刷新按最新请求结果展示；删除角色后清除失效的用户角色筛选，有效筛选继续保留。
- 账号授权显示所选角色说明及权限摘要，空角色说明仅保留个人中心。手动从管理员切换为业务角色时回到指定分组范围，避免自动沿用全部设备；重新读取仍尊重服务端已保存的范围。
- 用户列表加载期间禁止点击创建按钮；浏览器测试同步等待按钮可用，避免加载尚未结束时无效点击。

## 验证结果

1. `node --test backend/frontend-components.test.mjs backend/frontend-api.test.mjs backend/authorization-sync.test.mjs`：48项通过，包含新增4项筛选、冲突恢复、迟到响应和授权范围测试。
2. `npm run typecheck`、`npm run build`：通过。构建保留入口包超过500kB的体积建议。
3. `node scripts/roles-browser-test.mjs`：通过。新增浏览器检查覆盖角色版本冲突保留草稿、显式重读、失效角色筛选清理、权限摘要、管理员切回业务角色的范围；既有11类角色及空角色、操作按钮、分组与即时生效场景继续通过。桌面及390px布局通过。
4. `node scripts/users-browser-test.mjs`：通过。实际创建测试账号、校验邮箱/电话、刷新保留页面和检索、详情备注按文本显示、管理员资料冲突与重读、用户本人资料冲突与重读、资料跨入口同步、权限拒绝和删除测试账号；桌面及390px布局通过。本脚本不执行改密。

自动审批曾多次超时，未把未启动或未完成的测试当作通过。后续上述两个浏览器脚本实际执行完成并退出0。用户浏览器测试曾发现刷新回退问题，修复后完整复测通过。

## 文件与运行

主要代码：`frontend/src/App.vue`、`components/Administration.vue`、`RolesPanel.vue`、`UserAuthorization.vue`。新增复测脚本 `scripts/users-browser-test.mjs`，扩展 `scripts/roles-browser-test.mjs` 与 `backend/frontend-components.test.mjs`。

前端已构建至 `dist/`，现有服务按请求读取构建文件，本轮无需重启。正式账号、密码、角色、授权范围、分组与录像计划对比上一轮备份保持一致，两个计划任务仍在录制。本轮未连接或控制真实摄像机，也不新增媒体兼容性验收结论。

收尾时独立读取正式首页/健康接口的命令因自动审批超时未启动，本轮不新增该项通过结论；前述浏览器页面验证均是在隔离测试平台完成。

相关截图：`.tmp/roles-assignment-mobile.png`、`.tmp/user-info-details-mobile.png`、`.tmp/user-info-users-desktop.png`、`.tmp/user-info-personal-mobile.png`。相关回归日志：`.tmp/users-roles-second-unit.log`。

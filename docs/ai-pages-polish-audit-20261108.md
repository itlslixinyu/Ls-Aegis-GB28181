# 智能检索续查与修复（2026-11-08）

使用 Product Design audit 与项目 gb-frontend-flow Skill，依据本轮浏览器截图检查，不新增业务模块。

## 检查步骤及结果

1. 录像检索初始页（1280×720）：原条件栏上下两层滚动，通道卡片被挤住；已调整为矮屏下侧栏整体滚动，监看区保持一屏。截图 .tmp/ai-audit-01-start.jpg → .tmp/ai-audit-03-short-screen-fixed.jpg。
2. 历史分析列表：原加载失败被静默吞掉，可能误认为没有记录。新增等待、失败与刷新重试状态，刷新期间禁用重复点击；迟到的旧响应不覆盖新列表。查看历史结果失败前先清空旧查询画面，避免结果归属混淆。实际浏览器刷新返回17条现有记录，未创建模型任务。截图 .tmp/ai-audit-04-history-final.jpg。
3. 画面分析工作区：1280×720 原超出18px且来源区被双滚动挤压；修正最低高度与侧栏滚动后，document scrollHeight=720、scrollWidth=1280。移除内层 main，分析画面以有名称的 region 表示。390×844 分析记录无整页横向溢出。截图 .tmp/ai-audit-05-analysis.jpg → .tmp/ai-audit-07-analysis-fixed.jpg。
4. 模型配置：检查本地开关、告警参数与模型清单的分区，保持既有布局；内容可自然向下滚动。未保存任何参数或调用模型。截图 .tmp/ai-audit-06-models.jpg。

## 可访问性与验证边界

- 录像检索两个视图入口增加 aria-pressed；历史表格增加 aria-busy；错误使用 alert。键盘 Tab 实际可将焦点移到分析记录按钮，焦点轮廓可见。
- 截图与 DOM 检查不能证明完整 WCAG 合规；未执行屏幕阅读器端到端测试。
- 加载失败、撤权与迟到响应通过组件回归验证，未人为切断正式服务制造浏览器错误。
- 类型检查、Vite 构建通过，AI 相关组件测试12/12通过。增量更新前端，首页及入口资源HTTP200，后端未重启。
- 未修改模型设置、设备配置或录像计划，未新增推理负载；发布后健康正常、媒体在线，既有录像任务 recording，error=null。

修改：frontend/src/components/AiSearch.vue、frontend/src/components/AiAnalyses.vue、backend/frontend-components.test.mjs。

# M6 人工验收清单（20260917T161508Z_943a95e）

本文件由受控的 manual-acceptance-results.json 投影生成；自动脚本不会把人工项改为 pass。

## MANUAL-M1-01 · 课程切换与有据回答
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 127.0.0.1 教师 Origin
- 浏览器 B：Codex in-app browser / localhost 学生 Origin
- 操作：在人工智能导论课程提交资料不足问题；本轮未完成切换课程后的有据回答复核。
- 预期：课程切换后命中对应课程资料并返回可核验依据。
- 实际：资料不足问题正确进入待教师确认，但未执行本条要求的课程切换与有据回答。
- 结果：blocked
- 证据备注：缺少完整人工步骤，保持 blocked；未用 API 自动化结果冒充人工通过。

## MANUAL-M1-02 · 跨浏览器待办与回复
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 127.0.0.1 教师 Origin
- 浏览器 B：Codex in-app browser / localhost 学生 Origin
- 操作：学生提交“栈和队列的区别是什么？”，教师端看到 pending、保存回复，学生刷新读取回复。
- 预期：两个独立浏览器会话完成待办与回复回流。
- 实际：业务链路成功：pending、教师回复与学生回流均可见；但环境只有同一 IAB 后端的两个 Origin，不满足不同浏览器/Profile。
- 结果：blocked
- 证据备注：功能现象已走通，但 REQ-M6 §178/§179 的独立浏览器条件未满足，因此 blocked。

## MANUAL-M2-01 · A/B 页面数值变化
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 教师页
- 浏览器 B：不适用
- 操作：依次导入 dataset-a.csv 与 dataset-b.csv，完成质检、确认与研判。
- 预期：更换输入文件后平均分、及格率、分层人数和 analysisRun 均变化。
- 实际：A：平均 68、及格率 70%、2/5/3；B：平均 92.5、及格率 100%、10/0/0，analysis 标识不同。
- 结果：pass
- 证据备注：页面实时显示两组不同结果，未依赖静态快照。

## MANUAL-M2-02 · 异常文件、刷新与离线
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 教师页
- 浏览器 B：不适用
- 操作：导入 invalid-mixed.csv，检查逐行错误；刷新后重新进入导入页确认最近批次。
- 预期：异常逐行定位、刷新保持，离线时明确失败且不回退静态假数据。
- 实际：8 行中有效 2、排除 6、重复 1、warning 1，逐行错误可见；刷新保持最近批次。未在导入页单独执行离线步骤。
- 结果：blocked
- 证据备注：异常与刷新已验证，离线子场景未完成，因此 blocked。

## MANUAL-M3-01 · 发布→学生完成→教师反馈
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 127.0.0.1 教师 Origin
- 浏览器 B：Codex in-app browser / localhost 学生 Origin
- 操作：教师基于 3/5/2 研判发布 v1；学生收到巩固组任务并提交反馈；教师刷新查看完成统计。
- 预期：两个独立浏览器会话完成发布→学生完成→教师反馈。
- 实际：业务链路成功：学生完成后教师看到 1/10、巩固组 1/2 和脱敏反馈；但不是两个独立浏览器/Profile。
- 结果：blocked
- 证据备注：功能现象已走通，严格双浏览器条件未满足，保持 blocked。

## MANUAL-M3-02 · 撤回→历史→v2
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 教师页
- 浏览器 B：Codex in-app browser / 学生页
- 操作：在已发布 v1 页面尝试“撤回当前版本”，计划继续创建并发布 v2。
- 预期：v1 撤回后 active 消失、history/completion 保留，v2 正常发布。
- 实际：受控 IAB 未暴露页面 prompt/confirm，点击后未发生撤回，未继续伪造 v2 流程。
- 结果：blocked
- 证据备注：环境阻止完成真实 UI 撤回步骤；自动化 M3/M6 E2E 已覆盖但不替代本项人工验收。

## MANUAL-M4-01 · 双角色登录与越权
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 127.0.0.1 教师 Origin
- 浏览器 B：Codex in-app browser / localhost 学生 Origin
- 操作：分别登录教师和学生；携带学生 Cookie 打开 teacher.html。
- 预期：独立浏览器会话隔离；学生调用教师接口 403；教师越权班级 403。
- 实际：学生访问教师页被重定向至教师登录页，角色隔离有效；未能用两个独立浏览器/Profile 和 DevTools 完成两条 403 页面请求。
- 结果：blocked
- 证据备注：只有 Origin 级 Cookie 隔离，不能冒充不同浏览器，保持 blocked。

## MANUAL-M4-02 · localStorage 篡改、logout 与返回
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 教师 Origin
- 浏览器 B：Codex in-app browser / 学生 Origin
- 操作：教师、学生分别退出并刷新受保护页面。
- 预期：localStorage 篡改无效；logout 后返回/刷新不能继续调用受保护 API。
- 实际：两端 logout 后均回到公开首页，教师受保护页刷新无法继续；未执行 DevTools localStorage 篡改。
- 结果：blocked
- 证据备注：logout 子场景通过，localStorage 篡改子场景未完成，整项 blocked。

## MANUAL-M5-01 · 四种正式导出
- 时间：2026-09-18T00:12:23.6593841+08:00
- 浏览器 A：Codex in-app browser / 127.0.0.1:4174 学生页；教师导出沿用上一轮证据
- 浏览器 B：不适用
- 操作：重新验证学生本人学习记录 JSON 的当前课程与全部授权课程；按约束不重试、不修改 Print。
- 预期：四种正式导出和学生 learning-record 均由服务端受控生成。
- 实际：学生当前课程与全部授权课程均显示受控文件已生成，并返回独立 exportId/watermark；上一轮教师 JSON、CSV、Excel 已通过。Print 仍受当前 IAB popup 策略阻止，未伪装为通过。
- 结果：blocked
- 证据备注：learning-record 缺陷已修复并人工通过；Print 子项留待正常 Chrome/Edge 复核，因此整项拆分后保持 blocked。

## MANUAL-M5-02 · 服务或审计失败不下载
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 教师页
- 浏览器 B：不适用
- 操作：先停止 Node 服务执行报告导出；再以仅测试进程参数注入 auditWriter 失败并导出。
- 预期：服务或严格审计失败时不下载、不生成 fallback 文件。
- 实际：服务停止显示“本地导出服务不可用，正式数据未下载”；审计失败显示“本次未生成下载”。
- 结果：pass
- 证据备注：两种故障均 fail closed；未增加公开 HTTP 调试后门。

## MANUAL-M5-03 · 公开合成样例
- 时间：2026-09-17T23:21:19.6485751+08:00
- 浏览器 A：Codex in-app browser / 导出确认页
- 浏览器 B：不适用
- 操作：点击“下载公开合成样例”，核对下载链接与说明。
- 预期：显式下载固定合成样例，不对应当前账号、课程、班级或实时业务数据。
- 实际：链接指向 assets/samples/public-export-demo.json，带 download 属性；页面明确标注固定人工审查合成样例。
- 结果：pass
- 证据备注：公开样例与正式受控导出入口分离。

## MANUAL-M6-01 · 服务重启综合回归
- 时间：2026-09-18T00:12:23.6593841+08:00
- 浏览器 A：Codex in-app browser / 127.0.0.1:4174 教师页
- 浏览器 B：不适用（本轮仅复核上一轮失败的 analysis 子项）
- 操作：在临时 runtime SQLite 生成研判，记录 analysisRunId，停止并重启 Node 服务；使用原 remember Session 刷新并进入学情研判页，再切换班级并切回。
- 预期：Session 恢复且 QA/reply、analysis、task history、completion 全部仍可从页面读取。
- 实际：重启后 Session 自动恢复；页面恢复同一 analysis_d7c8f0cd-de06-494c-9733-8635b42e768e、批次、平均分 68、及格率 70%、知识点、2/5/3 分层、建议与 evidence。切换无历史班级显示真实空状态，切回原班级恢复同一 ID，未新建研判。上一轮已通过的 QA/reply、task history、completion 证据继续有效。
- 结果：pass
- 证据备注：上一轮唯一失败的 analysis 页面恢复子项已真实复核通过，MANUAL-M6-01 改为 pass。


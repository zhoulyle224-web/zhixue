# 智学双擎 PPT 最终内容稿

状态：`not_ready`。内容稿已完成，但尚无经过打开检查的最终 `.pptx`，不能标记“最终 PPT 已完成”。

统一口径：两个核心场景；匿名合成数据；final fixture 分层 3/5/2；M6 final run `20260917T171802Z_2db5f2b`；产品测试 175/175、Skill 26/26、E2E 10/10；8 项人工验收 blocked。

## P1 封面

- 智学双擎
- 校园学情研判与个性化学习智能体
- 副标题：有据答疑 × 真实研判 × 教学反馈闭环
- 不放组织名称、校徽或成员单位。

## P2 场景与痛点

- 学生：课后问题需要及时回答，但答案必须基于当前课程资料。
- 教师：成绩、知识点与反馈分散，难以快速形成可执行分层任务。
- 成功标准：有据回答/证据不足转人工；真实文件质检/研判/发布/反馈可追溯。
- 不使用未核验的节省时间、准确率或采纳率数字。

## P3 为什么只选两个核心场景

1. 学生课后即时答疑：高频、可验证、直接连接课程证据。
2. 教师学情智能研判：从数据到教学决策，能形成教师确认闭环。

身份、导出、安全、部署是支撑能力，不包装成第三个主场景。

## P4 一张业务闭环图

```text
学生提问 → 课程证据检索 → 有据回答 / 教师待办
                                ↓
匿名数据导入 → 质检确认 → 固定研判 → 教师确认任务
                                      ↓
学生完成与反馈 ← 发布与撤回 ← 教师查看反馈
        └────────────→ 下一轮研判
```

## P5 M1 有据答疑

- Session actor + enrollment 决定学生与课程范围。
- 当前课程知识包检索并返回 resourceId/title/section/snippet。
- 无依据不猜答，形成持久化教师待办。
- 教师回复回到同一学生历史；跨课程不可见。

现场可见证据：回答引用、pending 状态、教师回复。
技术证据：M1-T01～T20；M6-E2E-02/03；run `20260917T171802Z_2db5f2b`。

## P6 M2 真导入与研判

- 真实上传 CSV/JSON，不用固定演示快照替代。
- 逐行质检 → confirm → completed analysis。
- 恢复 batch、analysisRunId、概览、知识点、分层、建议和 evidence。
- final fixture：10 名匿名学生，分层 3/5/2。

现场可见证据：文件名、质量报告、analysisRunId、3/5/2、刷新后同一结果。
技术证据：M2/M2.5、M6-FIX-04/05；run `20260917T171802Z_2db5f2b`。

## P7 M3 教学任务闭环

- 草案固定引用 analysisRunId 与 sourceBatchId。
- 教师可编辑后发布；学生读取本人 active task。
- 学生完成与反馈回流教师摘要。
- `revoked` 与 `superseded` 均为终态，历史、assignment、completion、feedback 不删除。

现场可见证据：草案、发布人数、学生任务、完成、教师反馈。
技术证据：M3-T01～T28、M3-V01/V02、M6-E2E-04/05；run `20260917T171802Z_2db5f2b`。

## P8 系统架构

```text
Browser
  → api-client / qa-client / task-client / export-client
  → Node HTTP API
  → Auth + Authorization + CSRF
  → QA / Import & Analysis / Task / Export services
  → read-only baseline SQLite + writable runtime SQLite
  → local knowledge packs and rule Skills
```

公开静态版只用于展示；正式写能力、Session 与导出在本地 Node 版。

## P9 Skill 与智能体规范

- 参照帝王蟹 Skill 规范：显式输入、结构化输出、异常合同、人工确认。
- 五个 Skill 已注册，26/26 契约测试通过。
- `openclaw/` 提供语义兼容配置映射，不代表当前实时 OpenClaw runtime。
- AI Coding 用于实现、检查与测试辅助，不是运行时依赖。

## P10 数据安全

- opaque Session + HttpOnly Cookie + CSRF 轮换。
- 服务端角色与对象级授权；客户端身份字段不可信。
- baseline 只读，runtime 独立；静态路径访问 SQLite 为 404。
- 最终包不含 runtime、Session、audit、日志、`.env` 或密钥。
- 数据为匿名合成数据，不是实际组织数据。

技术证据：M4-T01～T45、M6-E2E-06/07/09；run `20260917T171802Z_2db5f2b`。

## P11 异常处理

- 资料不足 → 教师待办。
- 导入错误 → 行号、字段和原因。
- 非法角色、context、enrollment → 401/403。
- CSRF 丢失但 Session 有效 → `/api/auth/me` 安全轮换。
- 审计失败或服务失败 → 无文件、无静态回退。

技术证据：M1/M2/M4/M5 blocking tests、M6-E2E-08。

## P12 测试与复现

- M6 final run：`20260917T171802Z_2db5f2b`。
- Node：175/175，fail 0，skip 0，todo 0。
- Skill：26/26。
- M6 E2E：10/10。
- Matrix：pass 169 / fail 0 / blocked 8。
- baseline SHA-256 未变化。

边界：8 项严格人工验收仍 blocked，自动化不能替代；因此不宣称 M6 或 M7 已全部完成。

## P13 部署与能力边界

- Node.js >= 22.13 的本地路径已做 clean staging 冒烟。
- Windows 一键脚本已用无浏览器参数实测。
- Linux 与 Docker 配置存在，但当前环境未实际复现，状态为 `not_ready`。
- JSON/CSV/SpreadsheetML `.xls` 是服务端导出；PDF 是打印 HTML 后由浏览器另存。
- 参照帝王蟹 Skill 规范，不声称实时调用；OpenClaw 同样不声称实时运行。

## P14 总结与交付状态

- 价值：让学生更快获得有依据的支持，让教师把分散数据变成可确认任务。
- 源码、README、部署手册、测试摘要、评分矩阵、视频脚本和 PPT 内容稿已准备。
- 最终视频与 `.pptx` 尚未产出；M6 manual 仍有 blocked。
- 结论必须保持：`M7 not ready for submission`。

## 制作与检查说明

- 页面正文不堆证据路径，页脚或备注引用 `docs/评分证据矩阵.md`。
- 截图必须来自 final ZIP 解压后的本地 Node 版，不使用旧截图。
- 生成 `.pptx` 后逐页检查字体、裁切、备注、文档属性和组织标识；未完成前保持 `not_ready`。

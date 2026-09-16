# 智学双擎

面向教师教学与学生学习双端场景的本地智能辅助 MVP，核心闭环为：

```text
课后即时答疑 -> 高频问题沉淀 -> 学情智能研判 -> 教师确认 -> 个性化任务反馈
```

项目聚焦两个稳定、可演示、可落地的核心场景：

- 学生课后即时答疑：基于课程资料回答并附引用，资料不足自动转教师。
- 教师学情智能研判：导入匿名数据、质检、计算画像、分层和教学建议。

## 核心特性

- 本地优先：Node.js 内置 HTTP 与 SQLite 能力，无需外网和 npm 安装。
- 标准化 Skill：五个教育 Skill 具有明确输入、输出和异常契约。
- 教师确认：智能体只生成建议和草案，不自动发布高风险动作。
- 数据安全：数据库只读、页面白名单、导出脱敏、水印和 JSONL 审计。
- 异常降级：模型或 API 不可用时回到本地规则 Skill 和同源快照。
- 一键运行：支持 Windows、Linux 和 Docker Compose。

## 快速启动

环境要求：Node.js 22.13 或更高版本。

最简单的 Windows 一键部署方式：

```text
双击项目根目录的“deploy-and-open.bat”或“一键部署并打开.bat”
```

脚本会自动选择可用端口、后台启动服务并打开默认浏览器。

Windows：

```powershell
.\scripts\start-zhixue.ps1
```

Linux：

```bash
chmod +x scripts/start-zhixue.sh
./scripts/start-zhixue.sh
```

Docker：

```bash
docker compose up -d --build
```

打开 [http://127.0.0.1:8080](http://127.0.0.1:8080)。

## 演示账号

| 角色 | 账号 | 密码 |
|---|---|---|
| 教师 | `teacher2026` | `demo123` |
| 学生 | `student2026` | `demo123` |

演示身份只用于功能验收，生产环境必须接入校方统一身份认证。

## 测试

```bash
npm test
```

测试覆盖：

- 5 个 Skill、26 项契约用例。
- 9 项本地 API、导出、安全和页面集成用例。
- 数据库静态暴露、越权导出、提示注入、PII 脱敏用例。

单独核验 Skill：

```bash
node scripts/verify-skills.cjs
```

## 目录

```text
assets/                 页面、样式、读模型和五个 Skill
server/                 本地 API、Skill 运行时、导出与审计
data/                   匿名 SQLite 数据和运行时审计
openclaw/               Agent/Workflow/Tool/Memory/Guardrails 配置
prompts/                系统、任务、工具、拒答与脱敏提示词
docs/                   参赛方案、部署、测试、视频和 PPT 材料
scripts/                Windows/Linux 启动和备份脚本
tests/                  本地 API 与页面集成测试
```

## 关键接口

| 接口 | 方法 | 用途 |
|---|---|---|
| `/api/health` | GET | 检查 SQLite、Skill 和本地运行状态 |
| `/api/catalog` | GET | 获取课程与班级目录 |
| `/api/dashboard` | GET | 获取教师或学生脱敏看板 |
| `/api/qa` | POST | 调用课程答疑 Skill |
| `/api/import/validate` | POST | 导入 CSV/JSON 并执行逐行质检 |
| `/api/import/:batchId/confirm` | POST | 幂等确认已质检批次 |
| `/api/analyze` | POST | 直接分数模式调用 Skill；批次模式每次生成独立 `analysisRunId` |
| `/api/analysis/:analysisRunId?context=teacher:...` | GET | 按固定 ID 读取已完成研判及来源证据 |
| `/api/import/latest?context=teacher:...` | GET | 仅供教师页面恢复最近批次，不作为任务来源 |
| `/api/export` | GET | 鉴权、脱敏、水印和导出 |
| `/api/skills` | GET | 获取 Skill 注册状态 |

## 文档导航

- [完整参赛优化方案](docs/参赛优化方案.md)
- [部署手册](docs/部署手册.md)
- [测试用例](docs/测试用例.md)
- [演示视频脚本](docs/演示视频脚本.md)
- [PPT 大纲](docs/PPT大纲.md)
- [评分自评表](docs/评分自评表.md)
- [M2.5 修改与验收报告](M2.5_修改与验收报告_20260917.md)
- [OpenClaw 适配](openclaw/README.md)
- [提示词版本管理](prompts/README.md)

## 项目边界

- 当前课程答疑使用可解释的关键词检索，进阶方案为 SQLite FTS5 加本地向量重排。
- 当前模型为可选能力，没有模型时规则 Skill 可完整演示主流程。
- 当前登录为演示认证，生产版需接 CAS、OAuth2 或校方统一身份认证。
- M2.5 的 `context` 仅用于本地班级隔离，不等同于服务端身份授权；M4 服务端鉴权尚未实现。M3 后续必须固定 `sourceAnalysisRunId` 与 `sourceBatchId`，不可引用动态 `latest`。
- 当前数据为匿名合成数据，真实数据必须经过校内授权、分级分类和脱敏。
- PDF 导出使用本地打印页另存，避免引入重型 PDF 字体依赖。

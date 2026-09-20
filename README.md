# 智学双擎

智学双擎是一套本地优先的教学辅助系统，形成教师与学生连续的个性化教学闭环：

1. 学生智能答疑：依次使用当前课程资料、计算机公共基础、通用基础和本人授权画像，支持连续追问；资料不足时由学生确认是否转教师。
2. 教师学情研判：直接读取本人所授课程、班级和学生数据，从班级概览下钻到独立学生详情，并查看或调整系统自动生成的个人学习方案。

```text
班级数据直读 → 学生概览 → 独立学生详情 → 自动个性化方案
→ 教师查看或调整 → 学生答疑与学习 → 效果评估 → 下一轮调整
```

## 30 秒启动与验收

面向普通 Windows 用户的发布 ZIP 已内置 Node.js，解压后不需要安装依赖，也不需要联网；源码开发环境要求 Node.js 22.13 或更高版本。

```bash
node server/local-api.mjs --port 8080
```

浏览器打开 `http://127.0.0.1:8080`。

| 角色 | 合成演示账号 | 密码 | 权限 |
|---|---|---|---|
| 教师 | `teacher2026` | `demo123` | 可进入教师端，并在不退出登录的情况下查看只读学生观察视角 |
| 学生 | `student2026` | `demo123` | 只能进入学生端 |

运行测试与发布检查：

```bash
npm test
npm run test:static
npm run test:acceptance
node scripts/prepare-submission.mjs
```

项目运行时只依赖 Node.js 内置模块，不需要下载前端框架或数据库 ORM。`npm run build`
会生成 `dist/client` 静态站点、`dist/server` 公开版 Worker 与部署元数据；本地正式版
仍由 `server/local-api.mjs` 启动。

公网 Node 版默认启用独立演示沙箱：浏览器首次登录时生成随机沙箱编号，同一浏览器切换
教师/学生身份会继续使用同一数据空间，不同访客的问答、研判、任务和导出记录相互隔离。
沙箱 SQLite 保存在 `ZHIXUE_DATA_DIR/sandboxes/`，默认 24 小时后自动清理。

数据说明：提交包只包含匿名合成演示数据，不含真实个人、真实组织身份或统一身份配置。完整能力以本地 Node 版为准；公开静态版是受限展示版，不提供正式写操作。

当前自动回归：Node 产品测试 190/190、Skill 31/31，fail 0。历史 M6 人工验收状态仍以 `evidence/m6/` 为准，自动化结果不替代尚未执行的人工项。

## 一键启动

Windows 发布包解压后可直接双击 `deploy-and-open.bat` 或 `一键部署并打开.bat`。脚本优先使用包内 `runtime/node.exe`，仅在源码目录缺少内置运行环境时才回退到系统 Node.js；它只在 8080～8090 中选择空闲端口或复用已识别的智学双擎实例，不会终止无关进程。

必须先把 ZIP **完整解压**到普通文件夹，再双击启动文件；不要在压缩包预览窗口里直接运行。发布流程会强制把批处理写成 Windows CRLF 换行，避免双击后命令被截断而瞬间退出。若启动失败，窗口会保留明确原因和重试提示。

也可使用：

```powershell
.\scripts\start-zhixue.ps1 -Port 8080
```

Linux/macOS 脚本：

```bash
chmod +x scripts/start-zhixue.sh
./scripts/start-zhixue.sh
```

Docker 配置已提供，但是否已复现必须以[部署手册](docs/部署手册.md)中的实际状态为准，不能因配置存在就视为验证通过。

## 公网部署

面向中国大陆的参赛演示优先使用腾讯云 CloudBase 云托管。仓库根目录的 `Dockerfile`
直接运行完整 Node 服务，`/var/data` 挂载 CloudBase 对象存储以保存独立沙箱 SQLite。
详细控制台配置和验收步骤见[国内 CloudBase 部署方案](docs/国内CloudBase部署方案.md)。

生产环境至少需要以下配置：

```text
HOST=0.0.0.0
ZHIXUE_DATA_DIR=/var/data
ZHIXUE_COOKIE_SECURE=1
ZHIXUE_TRUST_PROXY=1
ZHIXUE_SANDBOX_TTL_HOURS=24
```

智能问答默认运行“离线知识检索模式”，不需要密钥。若要启用国内可访问的 OpenAI-compatible 模型增强，可在服务端额外配置：

```text
ZHIXUE_MODEL_API_URL=https://你的服务商地址/v1/chat/completions
ZHIXUE_MODEL_API_KEY=仅保存在服务端的密钥
ZHIXUE_MODEL_NAME=模型名称
```

未配置或调用失败时会明确降级，不会伪装成大模型生成；密钥不会进入浏览器、Git 或发布 ZIP。本轮没有更新 CloudBase 版本或控制台配置。

`/var/data` 必须挂载持久存储。`render.yaml` 仅保留为海外部署备选，不作为国内正式入口；
相关备选步骤见[公网部署方案](docs/公网部署方案.md)。

## 两个核心场景

### 学生智能答疑

- Session 中的学生身份是唯一身份真相；课程范围必须通过 enrollment 校验。
- 新会话优先使用当前课程 K2，再使用计算机公共基础 K1 和通用基础 K0；简单算术由确定性计算器完成。
- 支持连续追问、来源层级、Provider 状态和可定位引用；证据不足时先澄清或建议转教师，学生确认后才形成教师待办。
- 提示注入、越权与敏感文本在服务端边界被拒绝或脱敏。

### 教师观察与个性化教学

- 主路径直接读取 SQLite 业务表中的班级、学生、成绩、知识点、出勤、任务、错题和风险证据；CSV/JSON 仅保留为高级补录说明。
- 教师观察视角保持教师 Session；班级页只显示学生概览，选择具体学生后进入独立详情路由，不冒充学生身份。
- 学习相关数据按当前教学关系自动向任课教师开放，其他学生不可见；学生端不再要求手动选择共享权限。
- 学生直接登录端完整保留，学生可独立提问、追问、完成任务和提交反馈。
- 个人方案由画像 Skill 按学生当前数据自动生成并生效，教师可以查看和调整，不需要执行发布动作。
- 教师基于固定 analysis run 建草案、修改、发布、撤回；学生完成与反馈保留历史。
- 服务重启后从 runtime SQLite 恢复 Session、QA、研判、任务、完成与反馈。

## 身份、导出与异常边界

- 本地 Node 版使用服务端 opaque Session、HttpOnly Cookie、CSRF 轮换、角色与对象级授权。
- 本方案不是生产统一身份系统；未实现 CAS、OAuth、SAML 或 LDAP。
- 正式导出只接受 `POST /api/export`：教师可导出授权范围内的报告、问题和复盘；学生只能导出本人有效选课范围的学习记录。
- JSON、CSV、Excel 兼容 XML（`.xls`）由服务端生成；“PDF”路径是打印 HTML 后由浏览器另存，不是服务端原生 PDF。
- 导出严格审计失败时不返回文件，也不回退到静态演示快照。

## 核心接口

| 接口 | 方法 | 用途 |
|---|---|---|
| `/api/health` | GET | 健康检查 |
| `/api/auth/login` | POST | 建立服务端 Session |
| `/api/auth/me` | GET | 恢复 actor 并轮换 CSRF |
| `/api/auth/logout` | POST | 撤销当前 Session |
| `/api/catalog` | GET | 获取当前 actor 授权目录 |
| `/api/dashboard` | GET | 获取教师或学生授权看板 |
| `/api/teacher/classes/:id/students` | GET | 教师读取授权班级学生列表 |
| `/api/teacher/students/:no/observation` | GET | 教师读取学生详情、智能分析与自动个性化方案 |
| `/api/student/sharing-preferences` | GET/PUT | 兼容接口；GET 返回自动开放策略，PUT 明确拒绝手动修改 |
| `/api/qa/sessions/*` | POST | 新建会话、连续问答与显式转教师 |
| `/api/plans/*` | GET/POST/PUT | 自动生成个人方案、教师调整与学生读取 |
| `/api/qa`、`/api/qa/*` | GET/POST | 学生答疑、历史、教师待办与回复 |
| `/api/import/*` | GET/POST | 数据质检、确认与最近批次恢复 |
| `/api/analyze`、`/api/analysis/*` | GET/POST | 创建和读取固定研判 |
| `/api/tasks/*` | GET/POST/PUT | 草案、发布、撤回、完成与反馈 |
| `/api/export` | POST | 受控正式导出 |
| `/api/skills` | GET | Skill 注册状态 |

## 测试证据

- 唯一测试事实来源：`evidence/m6/20260917T171802Z_2db5f2b/`。
- 当前自动化：190/190，fail 0，skip 0，todo 0。
- Skill：31/31（10 个 Skill 均注册并通过契约检查）。
- M6 E2E：10/10。
- Acceptance Matrix：pass 169 / fail 0 / blocked 8。
- baseline SQLite SHA-256：`bba0fc13a8332286be5acef3e190fcb3abf54f92648254c100073e83873922c4`。

blocked 人工项没有被自动化结果替代，详见[测试与验收摘要](docs/测试与验收摘要.md)。

## 数据与能力边界

- baseline SQLite 与 fixtures 均为确定性匿名合成数据，不代表真实试点或真实教学效果。
- 参照帝王蟹 Skill 规范组织输入、输出、异常与人工确认；仓库没有可核验的当前实时帝王蟹调用证据。
- `openclaw/` 是语义兼容的配置映射，不代表当前实时运行 OpenClaw runtime。
- AI Coding 用于开发与测试辅助，不是系统运行时依赖。
- 公网模型不是主流程必需项；离线检索、确定性计算、画像和计划 Skill 可运行基础闭环，模型增强状态会如实标识。

完整声明见[能力边界声明](docs/能力边界声明.md)。

## 目录与交付

```text
assets/        页面、客户端和课程知识包
server/        HTTP/静态边界、身份、授权、导入研判、任务、导出服务
data/          合成 baseline（runtime 不进入提交包）
tests/         M1～M6 自动化与合成 fixtures
scripts/       启动、测试、发布检查和 staging 生成
docs/          部署、测试、评分、视频与 PPT 内容稿
evidence/m6/   唯一 final run 证据
release/       由发布脚本生成的干净提交目录与 manifest
```

交付导航：

- [架构说明](docs/架构说明.md)
- [公网部署方案](docs/公网部署方案.md)
- [参赛交付总览](docs/参赛交付总览.md)
- [部署手册](docs/部署手册.md)
- [评分证据矩阵](docs/评分证据矩阵.md)
- [最终验收与提交检查单](docs/最终验收与提交检查单.md)
- [演示视频脚本](docs/演示视频脚本.md)
- [PPT 最终内容稿](docs/PPT大纲.md)

# OpenClaw 适配说明

本项目提供 OpenClaw 兼容的声明式配置样例，核心目标是把页面内可运行的 Skill 契约映射到平台侧 Agent、Workflow、Tool、Memory 与 Guardrails。

## 使用边界

- `zhixue.yaml` 表达的是业务语义，不假设所有 OpenClaw 发行版使用完全相同的原生字段。
- 接入实际平台时，保留 `id`、`input_schema`、`output_schema`、`permissions`、`failure_policy` 等语义，再由平台适配器映射字段名。
- 若平台已经注册同名 Skill，应只保留一个执行入口，禁止前端规则实现与平台 Skill 双重决策。
- 当前仓库完全离线可演示；没有配置模型时，继续使用本地确定性 Skill 作为降级路径。

## 推荐接入顺序

1. 注册 `assets/skills` 中的五个 Skill，并校验标准输入输出。
2. 导入 `zhixue.yaml`，先启用 `after_class_loop` 工作流。
3. 连接只读 SQLite 或校内数据服务，禁止智能体直接获得数据库写权限。
4. 接入 Ollama/vLLM 后，将模型异常自动切回规则 Skill。
5. 开启脱敏、水印、审计和人工确认开关，完成试点验收后再扩大范围。

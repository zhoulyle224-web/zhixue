# 智学双擎匿名合成数据

## 文件

- `zhixue_demo.sqlite`：确定性生成的只读合成 baseline。
- `zhixue_demo.summary.json`：baseline 表记录数量摘要。
- `web_snapshots.json`：公开展示所需的脱敏读模型。
- `../scripts/build_demo_database.py`：固定随机种子的生成器。
- `../scripts/check_demo_database.py`：完整性、外键、范围与闭环检查。

全部学生、教师、课程、班级、成绩、行为、问答和任务记录均为匿名合成数据，不对应任何真实个人或具体组织，不构成真实试点结果。课程与数据结构仅参照公开通行的计算机类专业教学要素设计；最终提交材料不保留具体组织名称、域名或链接。

## 覆盖的数据域

| 数据域 | 主要内容 |
|---|---|
| 组织与身份 | 泛化部门、专业、班级、教师、学生 |
| 教学安排 | 学期、课程、教学班、选课 |
| 课程证据 | 章节、知识点、资源、题目映射 |
| 学习过程 | 成绩、题目得分、出勤、课堂互动、在线事件 |
| 答疑与画像 | 多轮问答、引用、掌握度、错题与风险 |
| 教学闭环 | 研判、分层任务、完成反馈与建议 |
| 数据治理 | 导入批次、质量问题与审计结构 |

SQLite 的 `INTEGER`、`REAL`、`TEXT`、`BLOB`、`NULL` 均有覆盖；JSON 结构以 `TEXT` 保存，日期时间使用 ISO 8601 文本。数据刻意包含空值、重复、格式错误和范围异常，用于质检演示。

## 基线性质与安全边界

- 6 个计算机类专业、6 个班级、180 名匿名学生、10 名合成教师。
- baseline 只读；Session、QA、研判、任务、完成、反馈与导出审计写入 `data/runtime/`。
- `data/runtime/`、WAL/SHM、日志、Session 和审计不会进入最终提交包。
- baseline SHA-256 必须与 M6 final evidence 一致：`bba0fc13a8332286be5acef3e190fcb3abf54f92648254c100073e83873922c4`。
- 页面与接口不会静态暴露 `/data/*.sqlite`。

## 重建与检查

```powershell
python scripts\build_demo_database.py
python scripts\check_demo_database.py
```

不得为了清理文本直接手改 SQLite；如需改变 baseline，必须修改生成器、重建并重新执行 M6。

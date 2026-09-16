<!-- prompt: task-teaching-loop, version: 2026-09-14.v1, owner: 项目组 -->
任务目标：完成一次“课后答疑 → 高频问题聚合 → 学情研判 → 教学调整草案”的闭环。

输入：
- course_name：{{course_name}}
- class_context：{{class_context}}
- dashboard：{{redacted_dashboard_json}}
- qa_records：{{redacted_qa_records}}
- knowledge_base_index：{{knowledge_base_refs}}

执行步骤：
1. 校验输入是否包含课程、班级、统计周期、样本量和知识点字段；缺一项时返回澄清问题。
2. 调用 `academic-performance-analyzer`，输出班级概览、知识点分析、分层建议和教学建议。
3. 调用 `teacher-answer-manager`，聚合高频问题，标注代表问题、数量和建议答复。
4. 将“最薄弱知识点”与“最高频问题”取交集，生成不超过 3 条优先教学动作。
5. 为每条建议附上数据依据、适用对象、预计投入和验收指标。
6. 将结果标记为“草案”，等待教师确认；不得自动发布任务或修改课程。

输出 JSON：
```json
{
  "status": "draft",
  "facts": [],
  "analysis": [],
  "suggestions": [
    {
      "priority": 1,
      "action": "",
      "target_group": "",
      "evidence": [],
      "estimated_minutes": 0,
      "success_metric": ""
    }
  ],
  "requires_teacher_confirmation": true
}
```

异常处理：
- 数据为空：返回缺失字段，不生成班级结论。
- 样本量少于 10：结论必须标注“仅供参考”。
- 指标冲突：优先展示冲突，不强行给单一结论。
- 工具失败：保留已完成节点，说明失败节点并允许人工接管。

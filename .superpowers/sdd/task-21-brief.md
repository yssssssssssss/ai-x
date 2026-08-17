### Task 21: 增加四类专业报告模板

**用户收益：** 竞品、VOC、设计走查和无障碍审查分别得到适合自己的专业报告。

**Files:**
- Create: `schemas/deliverables/competitive-analysis-report.schema.json`
- Create: `schemas/deliverables/voc-diagnosis-report.schema.json`
- Create: `schemas/deliverables/design-audit-report.schema.json`
- Create: `schemas/deliverables/accessibility-audit-report.schema.json`
- Create: `orchestrator/prompts/deliverables/competitive-analysis-report.md`
- Create: `orchestrator/prompts/deliverables/voc-diagnosis-report.md`
- Create: `orchestrator/prompts/deliverables/design-audit-report.md`
- Create: `orchestrator/prompts/deliverables/accessibility-audit-report.md`
- Create: `orchestrator/report-rubrics/competitive-analysis-report.yaml`
- Create: `orchestrator/report-rubrics/voc-diagnosis-report.yaml`
- Create: `orchestrator/report-rubrics/design-audit-report.yaml`
- Create: `orchestrator/report-rubrics/accessibility-audit-report.yaml`
- Create: `orchestrator/report-templates/competitive-analysis-report.yaml`
- Create: `orchestrator/report-templates/voc-diagnosis-report.yaml`
- Create: `orchestrator/report-templates/design-audit-report.yaml`
- Create: `orchestrator/report-templates/accessibility-audit-report.yaml`
- Modify: `orchestrator/deliverable-registry.yaml`
- Modify: `orchestrator/evidence-policy.yaml`
- Test: `tests/multi-deliverable-contract.test.ts`

**Interfaces:**
- Produces: 五个 task type 的完整 Active mapping。

- [x] **Step 1: 写契约失败测试**

每种 task type 断言 Registry、Schema、Prompt、Rubric、Template、Evidence Policy 全部存在且能加载。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/multi-deliverable-contract.test.ts`

Expected: FAIL。

- [x] **Step 3: 定义报告必需维度**

- Competitive：样本、维度矩阵、差异、影响、行动建议、截图对比。
- VOC：数据集、主题、频率、情感、代表原话、严重度、优先级。
- Design Audit：页面、问题、原则、严重度、截图标注、整改、复测。
- A11y：平台、POUR 原则、控件、A/B/C、P0–P3、读屏表现、整改、验证。

所有 Schema `additionalProperties=false`，关键数组 `minItems=1`。

- [x] **Step 4: 更新 Registry/Policy**

映射：

```text
user_research_planning → research_plan
competitive_research → competitive_analysis_report
voc_diagnosis → voc_diagnosis_report
design_audit → design_audit_report
a11y_audit → accessibility_audit_report
```

- [x] **Step 5: 运行测试和阶段门禁**

Run:

```bash
pnpm exec tsx --test tests/multi-deliverable-contract.test.ts tests/registry-linter.test.ts tests/research-planning-service.test.ts
pnpm quality
```

Observed final joint evidence (2026-08-17): the Task 20 + Task 21 eight-file suite completed with 202 total / 201 passed / 1 existing provider skip / 0 failed. `pnpm typecheck`, Registry linter, and Knowledge linter all passed. Initial RED execution was not separately recorded; review and commit remain pending.

- [ ] **Step 6: 提交**

精确暂存本 Task 列出的 schema/prompt/rubric/template/registry/policy/test 文件；禁止暂存其他工作树变化。

Commit: `git commit -m "feat: add task-specific research deliverables"`

---

## Phase 7：恢复、并行和 Gold


### Task 18: ReportDocument 和专业模板 Composer

**用户收益：** 报告从字段列表升级为有封面、执行摘要、核心指标、分析、视觉证据、建议和附录的完整文档。

**Files:**
- Create: `schemas/report-document.schema.json`
- Create: `apps/orchestrator-runtime/src/report/report-document-composer.ts`
- Create: `orchestrator/report-templates/research-plan.yaml`
- Modify: `apps/orchestrator-runtime/src/runtime/config-loader.ts`
- Test: `tests/report-document.test.ts`

**Interfaces:**
- Produces: `composeReportDocument(input): ReportDocument`。

- [x] **Step 1: 写失败测试**

覆盖缺执行摘要、无 Evidence 的 Fact block、dangling asset、重复 section/block ID、required question 无 section、专业 research-plan happy path。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/report-document.test.ts`

Expected: FAIL。

- [x] **Step 3: 定义模板 YAML**

模板固定章节：cover、executive-summary、background、scope-method、key-metrics、findings、question-analysis、visual-evidence、comparison、conclusion、recommendations、risks、appendix。

- [x] **Step 4: 实现 Composer**

Composer 只接收 verified Deliverable/Manifest/Assets/Charts/Review；按模板生成 blocks。没有视觉数据时省略视觉 block，不生成占位图。

- [ ] **Step 5: 运行测试和提交**

Run: `pnpm exec tsx --test tests/report-document.test.ts tests/current-report-markdown.test.ts`

Main-agent final evidence after the four reviewer fixes: report-document + chart-spec + chart-renderer + current-report-markdown 39/39 passed; `pnpm typecheck` passed. The Task17 producer-to-ReportDocument gate is closed; Task19 renderer consumption and commit remain pending.

```bash
git add schemas/report-document.schema.json \
  apps/orchestrator-runtime/src/report/report-document-composer.ts \
  orchestrator/report-templates/research-plan.yaml \
  apps/orchestrator-runtime/src/runtime/config-loader.ts \
  tests/report-document.test.ts
git commit -m "feat: compose professional current reports"
```


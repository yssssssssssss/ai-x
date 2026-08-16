### Task 17: Chart Spec、Evidence 校验和 SVG Renderer

**用户收益：** 报告自动生成可信对比图、趋势图和热力图，所有数字都能点回来源。

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/package.json`
- Modify: `apps/web/pnpm-lock.yaml`
- Create: `schemas/chart-spec.schema.json`
- Create: `apps/orchestrator-runtime/src/report/chart-spec-validator.ts`
- Create: `apps/orchestrator-runtime/src/report/chart-renderer.ts`
- Create: `apps/web/src/reporting/ChartBlock.tsx`
- Test: `tests/chart-spec.test.ts`
- Test: `tests/chart-renderer.test.ts`

**Interfaces:**
- Produces: `validateChartSpec(spec, evidenceResolver)`、服务端 SEALED SVG Artifact 和交互式 ECharts SVG block。

- [ ] **Step 1: 安装服务端和 Web 依赖**

Run:

```bash
pnpm add echarts
pnpm --dir apps/web add echarts
```

- [ ] **Step 2: 写失败测试**

覆盖 unsupported type、series 长度不匹配、无 Evidence、dangling Evidence、null→0、误导性 non-zero baseline、happy path；Renderer 测试 SVG 无 script/foreignObject/remote URL，并通过 VisualAssetService seal 为 `chart_svg`。

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/chart-spec.test.ts tests/chart-renderer.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现 Schema 和 Validator**

Validator 检查每个 series 的 evidenceIds；数据点必须存在于解析后的 Evidence Value；缺失值保持 null。

- [ ] **Step 5: 实现服务端和 Web SVG Renderer**

服务端使用 ECharts SSR SVG renderer 从已验证 Chart Spec 生成 SVG 字节，经 `VisualAssetService.derive` seal；Web `ChartBlock` 使用 ECharts `renderer: 'svg'` 提供交互视图，颜色从 actor/competitor stable key 派生，组件 unmount 时 dispose，并在旁边提供表格型文本替代。Markdown Bundle 和 Print 使用已封存 SVG，不依赖客户端重新计算数据。

- [ ] **Step 6: 运行测试和 Web Build**

Run:

```bash
pnpm exec tsx --test tests/chart-spec.test.ts tests/chart-renderer.test.ts
pnpm --dir apps/web build
```

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml \
  apps/web/package.json apps/web/pnpm-lock.yaml \
  schemas/chart-spec.schema.json \
  apps/orchestrator-runtime/src/report/chart-spec-validator.ts \
  apps/orchestrator-runtime/src/report/chart-renderer.ts \
  apps/web/src/reporting/ChartBlock.tsx \
  tests/chart-spec.test.ts \
  tests/chart-renderer.test.ts
git commit -m "feat: render evidence-bound report charts"
```


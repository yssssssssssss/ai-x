### Task 19: Web、Print PDF 和 Markdown Bundle Renderer

**用户收益：** 同一份报告可在线交互阅读、打印成 PDF，也可下载 Markdown+图片继续编辑。

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/pnpm-lock.yaml`
- Create: `apps/web/src/reporting/ReportDocumentView.tsx`
- Create: `apps/web/src/reporting/ImageBlock.tsx`
- Create: `apps/web/src/reporting/ImageComparisonBlock.tsx`
- Create: `apps/web/src/reporting/report-print.css`
- Create: `apps/web/src/reporting/report-bundle.ts`
- Modify: `apps/web/src/components/stages/CurrentStage4Report.tsx`
- Modify: `apps/web/src/pages/Workbench.tsx`
- Modify: `apps/web/src/api/client.ts`
- Test: `tests/report-bundle.test.ts`

**Interfaces:**
- Consumes: `CurrentReportPackageResponse`。
- Produces: Web view、Print view、ZIP bundle。

- [x] **Step 1: 安装 ZIP 依赖**（依赖与锁文件已存在；本次未运行安装命令）

Run: `pnpm --dir apps/web add fflate`

- [x] **Step 2: 写 Bundle 失败测试**

验证 ZIP 含 `report.md`、`assets/`、`evidence-manifest.json`、`visual-assets.json`、`report-review.json`；blocked asset 不进入 ZIP；Markdown 使用相对路径。

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/report-bundle.test.ts`

Expected: FAIL。

- [x] **Step 4: 实现 Web Blocks**

支持章节导航、Metric/Table/Chart/Image/Comparison/Evidence/Recommendation/Risk；点击 Finding 展开 Evidence；图片支持原图/标注切换；所有图片有 alt。

- [x] **Step 5: 实现 Print CSS**

A4、封面、目录、页眉页脚、page-break、SVG 不截断、表格重复表头、黑白打印可区分。

- [x] **Step 6: 实现 Bundle**

使用 `fflate.zipSync`，只加入 owner 已读取且 `exportPolicy!=block` 的 assets；Manifest 与 Markdown 一起打包。

- [x] **Step 7: 运行测试和 Build**

Run:

```bash
pnpm exec tsx --test tests/report-bundle.test.ts
pnpm --dir apps/web build
```

Observed by Main after all five reviewer fixes: lease execution, report package, report bundle, and ControlPlane suites 130 total / 129 pass / 1 existing provider skip / 0 fail; `pnpm typecheck` passed; Web build passed with a 246 KB main chunk and lazy ECharts.

- [x] **Step 8: 浏览器验收**

在 1280×800 和 1440×900 验证：导航、Chart、图片放大、对比、Evidence 展开、Print Preview、ZIP 下载；控制台无错误。

Observed by Main at 1280×800 and 1440×900: report render, `#comparison` navigation, Evidence `e1`/`e2` expansion, 125% zoom, interactive Chart plus one table, and print mode with actions/interactive Chart hidden, sealed SVG visible, and repeated table heading behavior. Separate pre-render Gateway blocker: clarification persisted no ambiguities but remained `awaiting_clarification`, and retry returned 500; this is not a Task19 renderer failure.

### Reviewer Fix Closure

1. Production composition deterministically discovers exact sealed attempt Visual Assets and Chart inputs, verifies binding/hash/schema/spec/table/lineage, and passes them through `LeaseExecutionEngine`.
2. Terminal recovery invalidates `report_document` with Evidence Manifest, Deliverable, and Review.
3. The Web boundary fail-closes the full VisualAssetManifest presentation shape, explicit export policy, exact referenced Asset set, and package Task/Plan/Attempt binding.
4. Web and optional Chart tables consume the complete sealed columns once, export a pure table shape, emit explicit header associations, and enforce row width.
5. Markdown consumes the same sealed columns directly and keeps header, separator, and data widths equal without a duplicate `Series`.

Final observed evidence is 130 total / 129 pass / 1 existing provider skip / 0 fail for the affected four-suite set; typecheck and Web build passed. This documentation sync ran no command and created no commit.

- [ ] **Step 9: 阶段门禁和提交**

Run: `pnpm quality`

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml \
  apps/web/src/reporting/ReportDocumentView.tsx \
  apps/web/src/reporting/ImageBlock.tsx \
  apps/web/src/reporting/ImageComparisonBlock.tsx \
  apps/web/src/reporting/report-print.css \
  apps/web/src/reporting/report-bundle.ts \
  apps/web/src/components/stages/CurrentStage4Report.tsx \
  apps/web/src/pages/Workbench.tsx \
  apps/web/src/api/client.ts \
  tests/report-bundle.test.ts
git commit -m "feat: deliver professional multimodal reports"
```

---

## Phase 6：多任务 Deliverable


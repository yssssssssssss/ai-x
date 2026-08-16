### Task 16: VisualAssetService 和安全远程图片

**用户收益：** 截图可稳定展示、可放大、可追溯来源；内部图片不会被意外公开。

**Files:**
- Create: `schemas/visual-asset-manifest.schema.json`
- Create: `schemas/image-annotation.schema.json`
- Create: `apps/orchestrator-runtime/src/report/visual-asset-service.ts`
- Create: `apps/orchestrator-runtime/src/report/image-annotation-service.ts`
- Modify: `packages/api-contract/research-deliverable.ts`
- Modify: `apps/agent-api/src/routes/control-tasks.ts`
- Test: `tests/visual-asset-service.test.ts`
- Test: `tests/image-annotation-service.test.ts`
- Test: `tests/auth-isolation.test.ts`

**Interfaces:**
- Produces: ingest/derive/readVerified、结构化 annotation overlay 和 asset read route。

- [ ] **Step 1: 写安全失败测试**

覆盖 HTTP URL、loopback/private/link-local/metadata IP、重定向私网、MIME 欺骗、超大文件、Tool Artifact 无对应 pointer、foreign owner、blocked export。

- [ ] **Step 2: 写正常测试**

覆盖 ai-spider `oss_url`、用户 PNG、原图→annotated derived lineage、Heatmap derived lineage、Manifest hash；Annotation 测试坐标边界、Finding 引用、原图 Asset 引用和不可变原图。

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm exec tsx --test tests/visual-asset-service.test.ts tests/auth-isolation.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现 Ingest**

远程 URL 只能来自已验证 Tool Artifact JSON Pointer；每次 DNS/redirect 后重新验证地址；下载到临时文件，完成 MIME/size/dimension 后再写 Binary Artifact。

- [ ] **Step 5: 实现 Annotation 和 Heatmap Derive**

`image-annotation.schema.json` 只允许矩形、圆点、箭头和编号 callout；每个标注必须包含归一化坐标、findingId、label 和 severity。`ImageAnnotationService` 保存 overlay JSON，并由受控 SVG Renderer 与原图合成新的 Derived Artifact；不得修改原图。

- [ ] **Step 6: 实现 Asset Route**

统一 owner 404；按 Manifest 设置 Content-Type；不返回 storage URI；`exportPolicy=block` 返回 404。

- [ ] **Step 7: 运行测试和提交**

Run: `pnpm exec tsx --test tests/visual-asset-service.test.ts tests/image-annotation-service.test.ts tests/auth-isolation.test.ts tests/evidence-service.test.ts`

```bash
git add schemas/visual-asset-manifest.schema.json \
  schemas/image-annotation.schema.json \
  apps/orchestrator-runtime/src/report/visual-asset-service.ts \
  apps/orchestrator-runtime/src/report/image-annotation-service.ts \
  packages/api-contract/research-deliverable.ts \
  apps/agent-api/src/routes/control-tasks.ts \
  tests/visual-asset-service.test.ts \
  tests/image-annotation-service.test.ts \
  tests/auth-isolation.test.ts
git commit -m "feat: manage verified report visual assets"
```


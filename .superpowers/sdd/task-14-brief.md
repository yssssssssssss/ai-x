### Task 14: Verified Core Report Package 读取重验

**用户收益：** Phase 4 用户拿到经过完整性、身份、Evidence 图和终局 Review 重验的核心报告包；Phase 5 文档与视觉资产未生成时不会返回伪数据。

**Files:**
- Modify: `packages/api-contract/control-workflow.ts`
- Modify: `packages/api-contract/research-deliverable.ts`
- Create: `apps/orchestrator-runtime/src/report/current-report-package-reader.ts`
- Modify: `apps/orchestrator-runtime/src/report/current-deliverable-service.ts`
- Modify: `apps/agent-api/src/control-runtime.ts`
- Modify: `database/control-plane.ts`
- Test: `tests/report-package.test.ts`
- Test: `tests/control-api-integration.test.ts`
- Test: `tests/auth-isolation.test.ts`

**Interfaces:**
- Produces: `CurrentReportPackageResponse`，`presentationMode` 为 `legacy_text | current_text | multimodal`。
- Phase 4 `current_text` 只返回 deliverable、evidenceManifest、reportReview；不创建 `reportDocument` 或 `visualAssetManifest`。
- Phase 5 Tasks 16–19 才把 package 扩展为要求文档和视觉资产的 `multimodal`。

- [x] **Step 1: 写失败测试**

覆盖 review-gated happy path；missing/tampered/wrong Task/Plan/Attempt Review；非 pass Review；Evidence Artifact/Finding Graph 读取重验；历史 marker fallback；foreign/missing 404。

- [x] **Step 2: 运行并确认失败**

`tests/report-package.test.ts` 首次因 reader 模块不存在失败；真实 E2E 首次因缺少 Review fixture 进入 paused，随后暴露 reviewing 状态 lease seal fence。

- [x] **Step 3: 实现 Verified Core Package Reader**

所有 JSON Artifact 通过 `readVerifiedJson()`；校验 SEALED、Artifact 与 JSON Task/Plan/Attempt、schemaVersion；逐项重读 referenced Evidence Artifact，并重新执行 Manifest 与 Finding Graph 验证。

- [x] **Step 4: 使用 Artifact marker 保持历史兼容**

新交付写 `research-deliverable-v1-review-gated`，必须存在最终 SEALED `report-review-v1`、绑定最终 Deliverable、`verdict=pass` 且 revisionRound 匹配；旧 `research-deliverable-v1` 返回 `legacy_text`。未知 marker 或新任务缺 Review 均拒绝，绝不静默降级。

- [x] **Step 5: 运行测试和类型门禁**

```bash
pnpm exec tsx --test --test-concurrency=1 tests/report-package.test.ts tests/control-api-integration.test.ts tests/auth-isolation.test.ts tests/report-review-service.test.ts
pnpm typecheck
```

- [x] **Step 6: 提交**

```bash
git commit -m "feat: serve verified current report packages"
```

---

## Phase 5：专业多模态报告


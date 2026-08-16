### Task 25: 五类语义 Gold、真实 Smoke 和最终发布门禁

**用户收益：** 系统不仅“测试通过”，还要在五类真实研究任务中持续证明理解、编排和报告质量。

**Files:**
- Create: `tests/fixtures/current-semantic-gold.json`
- Create: `tests/current-semantic-gold.test.ts`
- Modify: `scripts/current-real-smoke.ts`
- Modify: `tests/current-real-smoke.test.ts`
- Modify: `apps/orchestrator-runtime/src/gold/gold-batch-service.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: 25 个语义场景、五类真实 smoke profile、Report Package 评审门禁。

- [ ] **Step 1: 创建 25 个固定场景**

每个 task type 各五个：明确、模糊、缺输入、约束冲突、PII。每个 fixture 声明 expected task type、required clarification keys、required question themes、forbidden capabilities、required report sections。

- [ ] **Step 2: 写离线语义测试**

测试固定 planner/provider fixture 是否满足：需求字段、澄清、问题覆盖、能力约束、报告章节和 Evidence 引用。测试不通过源文本匹配实现细节，而验证公开契约和业务不变量。

- [ ] **Step 3: 扩展真实 Smoke**

Smoke receipt 增加：Requirement Version、Problem Graph counts、Capability Decisions、Report Review verdict、Chart/Visual counts、Report Package IDs；继续禁止输出 Secret/Base64/Prompt。

- [ ] **Step 4: 恢复 Current Gold**

Gold 只计入：真实 Gateway、实际模型 pin 匹配、真实 Core Tool、Report Review pass、完整 Report Package、独立认证评审。Infra failure 不占能力名额。

- [ ] **Step 5: 运行完整本地门禁**

Run:

```bash
pnpm quality
pnpm --dir apps/web build
```

Expected: 全部非真实 Provider 测试通过；真实测试仅在缺凭证时明确 skip。

- [ ] **Step 6: 运行真实门禁**

使用命令级安全注入：

```bash
ALLOW_REAL_PROVIDER=1 \
LLM_PROVIDER=gateway \
TOOL_ADAPTER=real \
CURRENT_SMOKE_PROFILE=competitive_analysis_report \
pnpm smoke:current:real
```

依次运行五个 profile；每个必须产生真实 Report Package 和无秘密 Receipt。

- [ ] **Step 7: 浏览器终验**

对五类任务各打开一份报告，验证章节、图表、Screenshot、Evidence、Print 和 Bundle；记录任务 ID 和 Report Package Artifact IDs。

- [ ] **Step 8: 最终提交**

```bash
git add tests/fixtures/current-semantic-gold.json \
  tests/current-semantic-gold.test.ts \
  scripts/current-real-smoke.ts \
  tests/current-real-smoke.test.ts \
  apps/orchestrator-runtime/src/gold/gold-batch-service.ts \
  .env.example \
  .github/workflows/ci.yml
git commit -m "test: gate trusted multimodal research reports"
```

---


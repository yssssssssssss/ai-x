### Task 22: 执行 Tool Retry Policy

**用户收益：** 短暂网络错误自动恢复；安全和数据错误不会被无意义重试。

**Files:**
- Create: `apps/orchestrator-runtime/src/control/tool-retry-policy.ts`
- Modify: `apps/orchestrator-runtime/src/control/lease-execution-engine.ts`
- Test: `tests/tool-retry-policy.test.ts`

**Interfaces:**
- Produces: `invokeWithRetry(input)`。

- [ ] **Step 1: 写失败测试**

覆盖 network、timeout、429、5xx 重试；schema/auth/safety/integrity 不重试；max attempts；每次 Receipt 独立；Lease 丢失立即停止。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm exec tsx --test tests/tool-retry-policy.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 Policy**

读取 Manifest `max_attempts/backoff_seconds`；每次 sleep 前后检查 active Lease；attempt 从 1 开始，达到上限返回最后一个结构化失败。

- [ ] **Step 4: 运行测试和提交**

Run: `pnpm exec tsx --test tests/tool-retry-policy.test.ts tests/lease-execution-engine.test.ts`

```bash
git add apps/orchestrator-runtime/src/control/tool-retry-policy.ts \
  apps/orchestrator-runtime/src/control/lease-execution-engine.ts \
  tests/tool-retry-policy.test.ts
git commit -m "feat: execute tool retry policies"
```


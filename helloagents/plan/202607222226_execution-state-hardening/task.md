# 任务清单: 任务执行状态机加固与质量门

目录: `helloagents/plan/202607222226_execution-state-hardening/`

## 执行规则

- [√] 所有实施前重新检查工作区；不得覆盖、重置或清理 `external-tools/vision-brand-lab` 的既有修改。
- [√] 不执行真实模型、浏览器或外部实验室调用作为 CI 验证；所有新增测试必须可离线重复运行。
- [√] 每个状态机改动先增加可失败的回归测试，再实施修复；不得仅以手工验证替代测试。

## 1. P0 - 原子执行状态机

- [√] 1.1 在 `tests/` 新增状态机用例：缺少媒体不改变任务状态、并发执行只有一个请求领取成功、终态任务拒绝重跑。验证 [why.md#需求-原子领取任务执行](why.md#需求-原子领取任务执行) 与 [why.md#需求-前置条件失败不污染状态](why.md#需求-前置条件失败不污染状态)。
- [√] 1.2 在 `database/repository.ts` 与 `apps/orchestrator-runtime/src/runtime/checkpoint-store.ts` 实现带前置状态的 `claimTaskExecution` 和 `claimTaskResume`，返回明确领取结果。验证 [how.md#数据模型](how.md#数据模型)。
- [√] 1.3 在 `apps/orchestrator-runtime/src/orchestrator.ts` 提取无副作用的执行前置校验，将媒体校验移动到领取前，并使用 1.2 的原子领取接口。验证 [why.md#场景-缺少必传设计稿](why.md#场景-缺少必传设计稿)。
- [√] 1.4 在 `apps/agent-api/src/routes/tasks.ts` 映射领域错误到 `404`、`409`、`422`、`502/504`；流式接口输出等价错误事件。验证 [how.md#api-设计](how.md#api-设计)。
- [√] 1.5 运行 P0 相关测试，并确认重复 execute 不产生第二次工具调用、执行日志或报告写入。

## 2. P1 - HTTP 可测试性与质量门

- [√] 2.1 在 `apps/agent-api/src/` 将 `createApp()` 与 `listen()` 分离，保留现有启动命令行为。验证 [why.md#需求-可操作的-api-失败语义](why.md#需求-可操作的-api-失败语义)。
- [√] 2.2 在 `tests/` 使用 Node 原生 HTTP 创建 API 集成测试，覆盖鉴权、execute、resume、缺媒体和状态冲突。依赖任务 1.4。
- [√] 2.3 在 `package.json` 增加聚合质量检查脚本，不改变现有单项命令。验证 TypeScript、测试、两个 lint 与 Web 构建均被执行。
- [√] 2.4 新增 `.github/workflows/ci.yml`，在 Node 20 环境运行 2.3 的确定性检查；不得注入真实服务密钥。验证 [how.md#测试与部署](how.md#测试与部署)。

## 3. P1 - 报告反馈评测基础

- [√] 3.1 在 `database/repository.ts` 与 `apps/agent-api/src/routes/feedback.ts` 增加 owner 范围内的反馈查询和聚合，只返回评分、采纳率与脱敏样本统计。
- [√] 3.2 在 `scripts/` 或 `tests/` 基于 `report:replay` 增加固定指标比较：证据引用率、无依据推断数、行动项验证字段和报告生成模式。验证 [why.md#需求-可回归的报告质量](why.md#需求-可回归的报告质量)。
- [√] 3.3 为 3.1 与 3.2 增加离线夹具测试；不得让用户反馈自动修改线上模型、prompt 或 skill 配置。

## 4. P2 - 后续独立方案

- [ ] 4.1 评估 `GET /api/topology` 的公开边界；若不需要匿名访问，为路由加认证并补回归测试。
- [ ] 4.2 在 P0/P1 稳定后，创建独立方案包拆分 `Orchestrator` 的规划、执行和报告职责；本方案不执行该重构。
- [ ] 4.3 如未来引入异步 worker 或多地域部署，再设计执行心跳、租约过期和人工恢复流程；不得在当前同步模型中预置队列。

## 5. 安全检查

- [√] 5.1 审核 SQL 条件更新、任务归属校验和错误映射，确认状态冲突不会泄露其他用户的任务信息。
- [√] 5.2 审核媒体与工具错误输出，确认不会在 API、SSE、日志或反馈聚合中暴露文件路径、原始材料、提示词或密钥。
- [√] 5.3 审核 CI workflow，确认它仅启动临时 PostgreSQL、执行本地迁移和确定性质量检查；不调用真实网关、外部 CLI 或浏览器自动化。

## 6. 最终验收

- [√] 6.1 `npx tsc --noEmit`、`npm test`、`npm run lint:registry`、`npm run lint:knowledge`、`npm --prefix apps/web run build` 全部通过。
- [?] 6.2 CI 在干净环境中通过，且 PR 必须显示该检查结果。
> 备注: workflow 已完成 YAML 解析与本地质量门验证；需推送到 GitHub 后取得实际 job 结果。
- [?] 6.3 手工验证：重复点击执行、刷新后重试、缺少图片、工具失败后 resume、终态任务重试均符合状态转换表。
> 备注: 离线回归已覆盖上述状态转换；真实 HTTP/UI 验证随 P1 API 集成测试和部署 smoke 执行。
- [√] 6.4 使用历史任务 `1e1a65f0-ced6-4f2e-8866-37f2a6657251` 在 `LLM_PROVIDER=mock` 下运行回放；比较文件仅含任务 ID、版本、范围、聚合指标与差异，不含原始步骤产物。该次 `mock_demo` 仅验证指标和链路，不作为真实模型质量结论。

## 任务状态符号

- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认

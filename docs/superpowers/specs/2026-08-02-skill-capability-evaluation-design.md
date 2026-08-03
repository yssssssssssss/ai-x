# Skill 全量能力评测设计

## 目标

为 `orchestrator/skill-registry.yaml` 中全部 `status: active` 的 Skill 各生成一份可复现结果，并提供统一评分卡，支持人工横向比较 Skill 的方法正确性、交付完整性、证据纪律与可执行性。

当前基线为 22 个 active Skill。运行时必须以注册表实时发现结果为准，不在代码中硬编码数量；本次验收要求发现数为 22。

## 已确认决策

- 使用标准合成样例，不依赖真实业务材料。
- 隔离评测 Skill，不执行任何外部 Tool。
- 采用独立 Skill Eval Runner，不经过 planner、数据库和最终报告合成。
- 每个 Skill 运行一次，并生成原始结果与统一评分卡。
- 使用真实 LLM；`LLM_PROVIDER=mock` 时拒绝运行。
- 自动评分只作为人工评估参考，不宣称为最终质量结论。

## 不做的事情

- 不评估 Tool 网络可用性、结果质量或路由准确率。
- 不评估 Orchestrator 的 plan/select/execute/report 全链路。
- 不使用真实用户、访谈或生产业务数据。
- 不做同一 Skill 的多次重复运行和稳定性统计。
- 不改变现有 Skill 内容、注册表或生产执行语义。

## 架构

新增一个独立批量评测入口，复用现有 `SkillLoader`、`LLMClient` 和 `SchemaValidator`：

```text
skill-registry
  -> 发现全部 active Skill
  -> 读取 evaluations/skills/cases/<skill-id>.json
  -> 加载 Skill 正文与 output schema
  -> 调用真实 LLM 生成 Skill 输出
  -> 对有 schema 的原生 Skill 执行 schema 校验
  -> 使用独立评审 prompt 生成评分卡
  -> 写入单 Skill 产物
  -> 生成全局 summary.md、summary.csv、manifest.json
```

Runner 绕开 `SkillActorRunner` 的 workspace 写入依赖，但复用与生产运行一致的 Skill prompt 约束：严格执行 `SKILL.md`，仅基于输入材料和固定 `tool_outputs` 工作，无证据判断必须标注为推断。

## 标准样例设计

每个 Skill 对应一个 JSON case：

```ts
interface SkillEvaluationCase {
  skill_id: string;
  title: string;
  research_goal: string;
  input_materials: Record<string, unknown>;
  tool_outputs: Record<string, unknown>[];
  expected_deliverables: string[];
  risk_checks: string[];
}
```

约束：

1. `skill_id` 必须与文件名及 active registry 条目一致。
2. 样例采用统一的电商、直播或商品体验背景，但按 Skill 所需材料定制。
3. 样例必须足以产生完整交付物，不用关键数据缺失来人为压低得分。
4. Tool 依赖型 Skill 使用固定、合成且符合对应 Tool 输出语义的 `tool_outputs`。
5. 合成材料必须明确标注为评测数据，不得在结果中被表述为真实业务事实。
6. 视觉类 Skill 在隔离评测中使用页面结构描述和固定视觉分析结果；本轮只评估其分析整合与交付能力，不评估图像感知能力。

## 输出结构

每次运行写入独立目录：

```text
skill-evaluations/<run-id>/
├── manifest.json
├── summary.md
├── summary.csv
└── <skill-id>/
    ├── input.json
    ├── output.json
    ├── output.md
    ├── scorecard.json
    └── error.json        # 仅失败时存在
```

`manifest.json` 至少记录：

- `run_id`
- 开始与结束时间
- LLM provider、model、model version（运行时可获得时）
- active Skill 总数和 ID 列表
- 每个 Skill 的执行状态、Skill 内容 hash、case hash、token 信息和耗时
- 成功、失败、需人工复核数量

## 评分卡

评分总分 100：

| 维度 | 权重 |
|---|---:|
| 遵循 Skill 工作流和交付要求 | 20 |
| 研究方法正确性 | 20 |
| 结果完整性与结构 | 20 |
| 证据与推断边界 | 15 |
| 结论可执行性 | 15 |
| 风险、缺失数据和适用边界处理 | 10 |

评分调用必须读取 Skill 正文、评测 case 和原始输出，并返回结构化评分卡：

```ts
interface SkillScorecard {
  skill_id: string;
  total_score: number | null;
  verdict: 'pass' | 'needs_review' | 'fail';
  dimensions: Array<{
    id: string;
    score: number;
    max_score: number;
    evidence: string[];
    defects: string[];
  }>;
  critical_defects: string[];
  review_notes: string[];
}
```

判定规则：

- `pass`：总分不低于 80，且无关键缺陷。
- `needs_review`：总分 60–79，或存在需要人工确认的问题。
- `fail`：总分低于 60、生成失败、schema 校验失败，或严重违反证据边界。

评分必须引用输出中的具体内容作为依据。评分失败不能覆盖原始输出；Runner 应写入 `total_score: null`、`verdict: 'needs_review'` 的降级评分卡并记录错误，不得编造分数。

## 执行和恢复

- 默认并发数为 3；`--concurrency` 仅允许 1–3，避免触发 LLM 限流。
- 单个 Skill 失败不终止批次，其余 Skill 继续执行。
- 已有完整 `output.json` 和 `scorecard.json` 的 Skill 在 `--resume` 模式下跳过。
- 提供单 Skill 过滤参数，用于预检和重跑。
- 输出写入采用临时文件后原子替换，避免中断留下看似完整的 JSON。
- 不打印环境变量、API key 或完整敏感请求头。

## 验证和验收

实现验收必须满足：

1. registry linter 和现有测试通过。
2. case 校验发现全部 22 个 active Skill，且无缺失、重复或未知 case。
3. `LLM_PROVIDER=mock` 的测试证明 Runner 会在发起生成前拒绝运行。
4. 单 Skill 测试证明能生成输入、输出、评分卡和 manifest 状态。
5. 单 Skill 失败测试证明批次继续执行并生成 `error.json`。
6. `--resume` 测试证明完整结果不会重复调用 LLM。
7. 真实 LLM 预检至少成功运行一个 Skill。
8. 全量运行结束后 manifest 必须包含 22 个 Skill 状态；每个成功项必须同时存在 `output.json`、`output.md`、`scorecard.json`。
9. 有 output schema 的 Skill 必须完成 schema 校验。
10. `summary.md` 和 `summary.csv` 能按总分展示全部 Skill，并明确自动评分仅供人工参考。

## 预期文件

- 新增 `evaluations/skills/types.ts`：case、结果、评分卡类型。
- 新增 `evaluations/skills/case-loader.ts`：加载并校验 registry 与 case 一致性。
- 新增 `evaluations/skills/evaluator.ts`：单 Skill 生成和独立评分。
- 新增 `evaluations/skills/report-writer.ts`：单项产物及全局汇总。
- 新增 `evaluations/skills/run.ts`：CLI、并发、过滤、恢复和退出码。
- 新增 `evaluations/skills/cases/*.json`：22 个标准合成样例。
- 新增对应测试文件，沿用 `node:test`、`tsx --test` 和现有测试风格。
- 修改 `package.json`，增加全量评测脚本。

## 风险

- 同一模型生成并评分可能产生偏好相关性。通过独立评审 prompt、强制引用证据及人工复核标记降低风险，但不能消除。
- 单次运行不能反映输出稳定性。本轮目标是建立可审阅基线，稳定性评测明确不在范围内。
- 合成材料不能代表真实业务噪声。后续可在本基线之上挑选关键 Skill 做真实材料复测。

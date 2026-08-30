# 长链路项目验证手册

> 适用场景：一次请求会依次经过规划、编译、外部 Tool、多个执行节点、聚合、校验和报告生成，且其中包含真实模型、外部服务、数据库或文件产物。
>
> 目标：把日常调试的反馈周期压到最短，只在最终验收时支付完整真实链路的时间和费用。

## 完整 smoke 只负责发现边界和最终验收

完整真实 smoke 不应成为日常调试命令。它可以在开始时运行一次，用于发现当前最先失败的阶段，也可以在所有局部问题修好后运行一次，确认整条链路可用。两次之间的排查和修改都应使用离线重放、分支恢复或终端重建。

一次真实 smoke 如果需要 509 秒，连续重跑 10 次，仅等待就超过 84 分钟。真实模型的输出还会变化，外部服务也可能临时不可用。每次从头执行会重复支付已经成功的规划、搜索、模型调用和报告生成成本，同时让失败样本发生变化。

默认工作流如下：

```text
短超时 Preflight
  -> 首次真实运行，捕获第一个失败点
  -> 固化输入、计划、产物和回执
  -> 在最窄层级稳定复现
  -> 添加回归测试并做最小修复
  -> 扩大到相邻层级验证
  -> 最后运行一次完整真实 smoke
```

同一个问题还不能在局部环境中稳定复现时，停止重跑完整 smoke。继续重跑只会增加等待时间和噪声。

长链路通常一次只暴露最早失败。修好 Planner 后才看到执行错误，修好执行后才看到报告错误。如果每次都从入口开始，越靠后的缺陷越贵。错误详情不足还会额外消耗一次运行来补日志，外部服务波动则可能让两次运行停在不同位置。

## 把验证拆成四层

| 层级 | 处理的问题 | 固定输入 | 执行范围 | 何时升级到下一层 |
|---|---|---|---|---|
| 规划重放 | 需求理解、问题图、能力分配、候选计划、DAG 和 binding | Requirement、ProblemGraph、DemandGraph、模型结构化输出 | Planner、Resolver、Compiler | 同一 fixture 连续稳定通过，非法依赖和合同错误已有回归测试 |
| 执行恢复 | Tool、Contributor、并发调度、Artifact、状态机和重试 | Task、冻结 Plan、已完成步骤、SEALED Artifact、receipt | 从失败节点或受影响分支继续 | 修复后的分支通过，未受影响节点没有再次调用 |
| 终端重建 | Synthesizer、Ledger、Canonical、Report Package | 已验证的 Contribution、Evidence、checkpoint | 只重建失败的终端阶段及其下游 | 报告合同、完整性和导出检查通过 |
| 完整 smoke | 跨层集成、真实 Provider、真实外部服务和部署配置 | 受控场景和明确的验收条件 | 从入口到最终产物 | 仅作为最终验收结果 |

Preflight 位于四层之前。它只检查环境是否具备运行条件，不承担业务验证。

## 第一次失败必须保存现场

真实运行一旦失败，先保存现场，再读错误和改代码。至少保留以下材料：

- 原始输入与归一化后的 Requirement。
- ProblemGraph、Capability Demand、Portfolio 或 Candidate。
- 编译后的冻结 Plan，以及 Plan 的 schema 版本和内容哈希。
- Task、Attempt、步骤状态、失败步骤编号和依赖关系。
- 已成功节点的 Artifact、状态、内容哈希和 provenance。
- Tool 与模型 receipt，包括输入哈希、实现版本、模型版本和 trace ID。
- 失败类型、原始异常链、脱敏后的错误消息、发生时间和阶段耗时。
- 代码版本、配置版本、Registry、Prompt、Schema 和 Knowledge 快照标识。

CI 或控制台可以只显示错误类型和消息哈希，但本地诊断包必须保留可关联的脱敏错误详情。只输出 `error_type` 和 `message_hash` 无法定位问题，还会迫使开发者再次运行整条链路。

建议把一次失败保存为一个独立目录：

```text
tests/fixtures/long-chain/<scenario-id>/
  manifest.json
  input/
    request.json
    requirement.json
  planning/
    problem-graph.json
    demand-graph.json
    portfolio.json
    plan.json
  execution/
    task.json
    attempt.json
    steps.json
    receipts/
    artifacts/
  terminal/
    contributions.json
    evidence.json
    canonical.json
  failure.json
```

运行时产生的原始文件可以放在忽略提交的目录中。进入仓库的 fixture 必须去除凭证、个人信息、内部地址和大段受版权限制的内容。二进制或体积较大的产物可以只保留内容寻址引用和最小测试样本。

### manifest 必须能判断 fixture 是否过期

`manifest.json` 至少记录：

```json
{
  "schemaVersion": 1,
  "scenarioId": "example-multi-stage-answer",
  "capturedAt": "2026-08-25T00:00:00Z",
  "sourceRevision": "<git-sha>",
  "failureStage": "execution.contributor",
  "expectedOutcome": "reproduces-invalid-input-binding",
  "identities": {
    "requirementHash": "sha256:<hash>",
    "planHash": "sha256:<hash>",
    "registryHash": "sha256:<hash>",
    "promptSetHash": "sha256:<hash>",
    "schemaSetHash": "sha256:<hash>",
    "knowledgeSnapshot": "<version>"
  },
  "providers": [
    {
      "kind": "llm",
      "name": "<provider>",
      "model": "<model>",
      "responseCaptured": true
    }
  ],
  "redaction": {
    "checked": true,
    "notes": []
  }
}
```

时间戳不能证明两个 checkpoint 等价。是否允许复用，应由执行语义相关的身份字段决定。

## 录制重放和模型质量评测分开做

录制的模型或 Tool 输出用于稳定复现编排缺陷，测试断言应关注 schema、依赖、证据归属和状态转换。它不能证明当前模型仍有同样的输出质量。

模型质量需要另一套固定样本集和评分规则。需要评估随机波动时，对同一输入运行多个样本并统计通过率，不用单次端到端 smoke 代替。三类验证各自回答不同问题：

| 验证方式 | 回答的问题 |
|---|---|
| fixture 重放 | 代码面对已知输入时是否仍满足合同 |
| 批量模型评测 | 当前模型在一组代表性输入上的质量和波动是否可接受 |
| 完整真实 smoke | 各真实边界在当前环境中能否串起来 |

## 先按失败阶段选择最短路径

| 首个失败阶段 | 常见症状 | 排查入口 | 修复后的最小验证 |
|---|---|---|---|
| Planning | 非法 binding、逆向依赖、重复 wiring、Owner 冲突、计划不满足 schema | 固定 Requirement 和模型输出，离线运行 Planner、Resolver、Compiler | 规划回归测试和 Compiler 合同测试 |
| Execution | 输入没有传到节点、步骤错误暂停、重试重复调用成功节点、Artifact 状态不对 | 固定 Task 和 Plan，从失败步骤或受影响分支恢复 | 分支级执行测试、状态机测试、checkpoint 复用测试 |
| External infrastructure | 连接拒绝、鉴权失败、配额不足、服务健康但业务接口不可用 | 独立 preflight 和最小探针 | preflight 通过，不运行完整业务链路 |
| Terminal/report | Contribution 已完成，但聚合、Ledger、Canonical、渲染或打包失败 | 固定 SEALED Contribution 和 Evidence，执行 terminal rebuild | 报告合同、完整性、安全和导出测试 |
| Integrity/security | 来源错配、未封存产物被复用、provisional 被升级、敏感信息泄露 | 固定产物与 provenance，直接运行校验器 | 负向测试，确认错误输入仍被拒绝 |

如果当前只能看到顶层 `Error`，先补诊断信息，不要猜测失败阶段。每个阶段都应输出结构化的 `started`、`completed` 或 `failed` 事件，并携带 `runId`、`taskId`、`attemptId`、`stage`、`durationMs` 和安全的关联标识。

## 标准排障流程

### 1. 定义成功条件和成本边界

运行前写清楚本次场景必须验证什么，例如真实 Provider 被调用、指定 Contributor 生成受支持证据、报告包含可追溯引用。与本次风险无关的场景不要顺带执行。

同时记录命令、超时、允许的真实调用、预期外部依赖和产物位置。没有这些信息，超时和挂起很难区分。

### 2. 运行短超时 Preflight

Preflight 应在昂贵调用前完成，并单独设置较短超时。检查内容包括：

- 必需环境变量存在且格式正确，日志不得打印密钥值。
- Provider 的鉴权、模型可用性、配额或限流状态满足当前场景。
- 外部 Tool 的健康接口和最小业务探针都可用。
- 数据库连接、迁移版本和测试数据命名空间可用。
- Artifact 目录或对象存储可写，剩余空间满足预期产物大小。
- Registry、Prompt、Schema 和配置可以加载并互相引用。
- 超时、取消和清理逻辑可执行，不会遗留占用资源的进程。

`health = 200` 只证明服务进程活着。真实链路依赖某个业务端点时，preflight 需要用无副作用的最小请求验证该端点的合同。

### 3. 只捕获第一个真实失败

首次真实运行应打开结构化进度日志和诊断包。失败后立即停止，不用临时脚本继续绕过错误跑后面的阶段。绕过会改变现场，也容易让临时逻辑混进正式代码。

### 4. 固化为可重复的 fixture

对非确定性边界录制输入和输出。规划问题固定模型生成结果，Tool 问题固定响应或 receipt，执行问题保存冻结 Plan 和已封存产物，报告问题保存 Contribution 与 Evidence。fixture 只包含复现所需的最小数据。

保留一份原始捕获包用于调查，再从中裁剪可提交的回归 fixture。不要直接手写一个看起来相似的样本，手写样本经常会漏掉触发缺陷的字段组合。

### 5. 先让局部回归测试失败

用固定现场写出一个稳定失败的测试。测试名称应描述被破坏的不变量，例如：

- Compiler 拒绝跨 Contributor 的非法 binding。
- retry 不再次调用已有精确 checkpoint 的 Tool。
- Required Contribution 为 degraded 时任务保持暂停。
- terminal rebuild 不把 provisional Finding 提升为 supported。

测试不能依赖真实网络、当前时间、随机模型输出或共享数据库状态。

### 6. 做最小修复

优先修正产生错误状态的最早位置，并在边界处保留拒绝性校验。不要让报告层猜测 Planner 的意图，也不要让执行器静默修补一个非法 DAG。Compiler 能确定生成的 wiring 不应交给模型生成。

### 7. 按半径扩大验证

验证顺序固定为：

1. 新增的单个回归测试。
2. 所属模块的测试文件。
3. 相邻模块的合同和集成测试。
4. 类型检查、Lint、Schema 和 Registry 校验。
5. 与改动有关的离线测试套件。
6. 一次完整真实 smoke。

某一级失败时回到对应层修复，不跳到完整 smoke 碰运气。

## checkpoint 只有完全匹配才能复用

执行恢复的收益来自跳过成功节点，错误复用则会污染后续结论。checkpoint 至少要比较以下执行身份：

- Requirement、Task 和冻结 Plan 的版本或内容哈希，例如 `planHash`。
- 节点 ID、Actor ID、角色、实现版本和 `stepHash`。
- 输入 Artifact ID、内容哈希及其 `SEALED` 状态。
- Tool 输入、Provider、模型、Prompt、Schema 和策略版本，例如 `inputHash`、`inputSchemaHash`、`outputSchemaHash` 和 `configHash`。
- 输入清单及其 `manifestHash`，Artifact 的 hash 和 size 必须重新校验。
- Registry、Knowledge 和运行时能力快照。
- 安全、租约、审批或数据权限中会改变执行结果的字段。
- Task、Plan、Attempt 的归属关系，禁止跨任务借用碰巧同名的产物。

任何执行身份不匹配时，该节点及其下游失效。无关分支可以继续复用。不要用任务 ID、文件存在或步骤状态为 `succeeded` 作为唯一复用依据。

常见改动对应的失效范围：

| 改动 | 最小失效范围 |
|---|---|
| Planner 或 Compiler 逻辑 | 重新生成 Plan，并执行所有受新 Plan 影响的节点 |
| 单个 Contributor 的实现、Prompt 或 Schema | 该 Contributor 及依赖它的聚合和报告节点 |
| Tool Adapter 或 Tool 输入 | 使用该 Tool 的节点及其下游 |
| Synthesizer 或 Ledger | 聚合节点及报告链路，保留有效 Contributor |
| 报告模板、布局或导出器 | 只重建 Report Package |
| Registry、Knowledge 或安全策略 | 由身份比较计算受影响节点，无法证明等价时从该边界后重跑 |

### retry 创建新 Attempt

恢复执行不修改旧 Attempt。retry 应创建新 Attempt，用 `retryOf` 指向失败记录，并把可复用产物重新校验后关联到新 Attempt。旧 Artifact 保持不可变，新产物重新 seal，同时记录来源 Artifact ID。相同幂等键必须返回同一个恢复结果。

正式 retry 前先恢复运行状态：把已过期 lease 对应的运行中任务标记为 worker lost，隔离 `STAGING` Artifact，清除或失效旧的终端产物。只有被成功步骤引用、归属正确且校验通过的 `SEALED` 输出可以进入复用判断。

skip 和 abort 是另外两种操作。skip 会改变计划时，应创建 Plan revision 并重新确认，而且不能删除仍被下游依赖或绑定的步骤。abort 只负责终止，不参与恢复。

## 外部依赖失败不进入业务调试

连接拒绝、DNS、证书、鉴权、配额和服务未启动都属于环境失败。它们应使用独立错误类型，并让 smoke 在规划或执行前退出。业务断言不应把这类错误包装成 Contributor degraded 或报告缺失。

外部服务的最小运维合同应包含：

- 一条不会修改业务数据的 readiness 探针。
- 一条覆盖真实请求 schema 的低成本业务探针。
- 明确的启动方式、端口、依赖版本和关闭方式。
- 连接、请求和总任务三层超时。
- 可判断是否重试的错误分类。
- 本地不可用时的明确跳过规则，禁止静默使用假结果冒充真实验证。

真实 Provider 测试需要显式开关，例如 `ALLOW_REAL_PROVIDER=1`。默认命令不能意外产生费用或把敏感数据发到外部系统。

错误分类决定下一步动作：

| 错误类别 | 默认动作 |
|---|---|
| capacity、network、timeout、HTTP 429、HTTP 5xx | 在退避、次数和总时长上限内重试 |
| schema、authentication、configuration、safety | 直接失败，修正输入或配置后再验证 |
| Skill contract drift、Knowledge configuration drift | 重新规划，不复用旧 Plan |
| authenticity、model drift、missing receipt、Artifact invalidation | Fail closed，重新取得可信产物 |
| deliverable validation | 上游身份完全匹配时才允许 terminal rebuild |

Required Contributor 失败或 degraded 时应阻断任务。Optional Contributor 才能记录 gap 后继续，不能为了让 smoke 通过而临时降低 Required 约束。

## 并发只用于彼此隔离的工作

类型检查、纯函数单测、Schema 校验和只读 Lint 可以并行。使用同一个数据库、端口、任务记录、Artifact 目录或 Provider 配额的测试默认串行，除非每个进程都有独立命名空间。

不要并发运行两个共享环境的完整 smoke。它们会争用 lease、覆盖 fixture、触发限流，也会让日志无法归属。并行执行前至少隔离：

- 数据库 schema 或测试租户。
- 端口和外部服务实例。
- Artifact 根目录。
- `runId`、Task 和幂等键。
- Provider 配额与并发上限。

## 项目至少要提供五类验证入口

下面是建议接口，不代表当前仓库已经存在这些脚本。命令名称可以不同，但能力不能缺：

```bash
# 1. 验证外部依赖和运行环境
pnpm run verify:preflight -- --scenario <scenario>

# 2. 从已保存的规划现场重放
pnpm run verify:planning -- --fixture <fixture-dir>

# 3. 创建新 Attempt，从失败步骤或受影响分支恢复
pnpm run verify:resume -- --task <task-id> --retry-of <attempt-id>

# 4. 只重建聚合和报告
pnpm run verify:terminal -- --fixture <fixture-dir>

# 5. 最终完整真实验收
ALLOW_REAL_PROVIDER=1 pnpm run verify:real -- --scenario <scenario>
```

每个入口应支持机器可读输出、明确退出码、独立超时和固定产物目录。若项目只有第 5 个命令，应先补前四类入口，再继续处理需要多轮调试的长链路问题。普通测试套件跳过真实环境用例时，`passed` 只说明离线部分通过，不能代替真实验收。

## 接入新项目时先填阶段表

复制这份手册后，先用项目中的真实模块和命令填完下表。某个格子答不出来，说明该阶段还不能独立调试：

| 阶段 | 输入身份 | 持久化输出 | 非确定性依赖 | 局部重放入口 | checkpoint 失效条件 | 验收断言 |
|---|---|---|---|---|---|---|
| `<stage>` | `<hash/version>` | `<artifact>` | `<provider/tool/none>` | `<command/API>` | `<fields>` | `<invariant>` |

再选择一个覆盖主要分支、成本可控的代表性场景作为完整 smoke。不要把所有业务变体塞进一个场景，变体应由离线参数化测试或批量评测覆盖。

## 三份检查清单

### 开发前

- [ ] 场景的成功条件、真实边界和成本上限已经写明。
- [ ] 每个阶段有稳定 ID、输入输出合同和结构化进度事件。
- [ ] 非确定性边界可以录制和重放。
- [ ] 长耗时步骤完成后会写入不可变 checkpoint。
- [ ] 外部依赖有独立 preflight，失败类型不会混入业务错误。
- [ ] fixture 和诊断包有脱敏规则与保存位置。

### 提交前

- [ ] 缺陷已由最小 fixture 稳定复现。
- [ ] 回归测试先失败，修复后通过。
- [ ] 成功分支在 retry 中没有被重复调用。
- [ ] 相关负向测试仍然拒绝非法输入和不可信产物。
- [ ] 类型、Lint、Schema、Registry 和相关离线测试通过。
- [ ] 临时调试脚本、真实响应和后台进程已经清理。

### 最终 smoke 前

- [ ] 所有局部问题都有回归测试。
- [ ] Provider、Tool、数据库和存储的 preflight 通过。
- [ ] 当前代码、fixture、Prompt、Schema 与 Registry 版本已记录。
- [ ] 没有其他 smoke 占用同一环境。
- [ ] 进度日志和失败诊断包已启用。
- [ ] 超时、费用上限和人工停止条件明确。

## 故障记录模板

每次长链路失败都按同一格式记录，避免下一位开发者重新还原上下文：

```markdown
# <scenario> failure record

- Run ID:
- Source revision:
- Command:
- Started at / duration:
- First failed stage:
- Error type:
- Sanitized error:
- External dependency state:
- Fixture path:
- Task / Attempt / Plan identity:
- Last valid checkpoint:
- Expected invariant:
- Actual result:
- Minimal reproduction command:
- Regression test:
- Suspected invalidation radius:
- Fix verification:
- Final smoke result:
```

故障记录只写已观察到的事实。推测单独标注，不要把猜测写成根因。

## 停止条件

出现以下任一情况时，不再启动新的完整 smoke：

- 同一个失败还没有转成离线 fixture 或可恢复 checkpoint。
- 外部服务 preflight 未通过。
- 顶层错误没有原始异常链，无法确认首个失败阶段。
- fixture 的执行身份与当前代码不匹配，且失效范围尚未确定。
- 修复没有对应的回归测试。
- 上一次 smoke 或调试进程仍在运行。
- 当前改动只涉及报告模板，却准备重新调用 Planner、Tool 或 Contributor。

完整真实 smoke 失败后，重新进入分层流程。除非失败由一次性基础设施抖动明确造成，并且有可审计证据，否则不要原样重试。

## 适用边界

这套方法适合跨多个阶段、包含昂贵或不稳定依赖的系统，包括 Agent 编排、数据流水线、媒体处理、发布流水线和多服务事务。单个纯函数或几秒内完成的确定性测试不需要 checkpoint 和 fixture 目录，直接运行对应测试更快。

项目无法在中间阶段恢复时，第一项工程工作应是增加稳定的阶段边界和持久化输出。缺少这些边界，任何排障技巧最终都会退化成从头重跑。

# 任务清单: 编排可靠性与证据化报告

目录: `helloagents/plan/202607211446_orchestration-reliability/`

## 执行规则

- [ ] 所有实施前先审阅工作区已有未提交改动；不得使用 reset、clean、checkout 或覆盖写入来处理冲突。
- [ ] 任何需要真实网关调用的验证只使用无敏感探针输入，并记录模型、能力、时间、状态和脱敏错误类别，不记录密钥或原始输入。
- [ ] 每一阶段完成后运行其验收测试；失败不得跳过并进入下一阶段，除非任务明确标记为 `degraded` 并经确认。

## P0 - 配置基线与真实能力验证

- [√] 0.1 在 `.env.example` 中声明文本主备顺序 `GPT-5.4-joybuilder,GPT-5.2-joybuilder,GPT-5-joybuilder`，补齐等价的 `VLM_*` 配置说明、注释和空值语义；不得提交真实密钥。验证 why.md#需求-三模型故障切换。
- [√] 0.2 在 `apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts` 和 `apps/orchestrator-runtime/src/runtime/config-loader.ts` 中统一候选模型解析、去重和空配置报错；主模型必须是列表第一项。验收: 重复、空白和主备重复配置均有确定行为。
- [√] 0.3 在 `scripts/` 新增无敏感模型能力探针。探针分别验证每个候选的文本请求与图片请求，输出 `text/vision` 能力和失败类别；生产网关调用必须由显式环境开关启用。
- [-] 0.4 在 `scripts/start-labs.mjs` 与三个实验室的启动/健康路径中增加配置指纹和模型能力健康输出。
  > 备注: 现有服务正在运行，受控重启与进程环境迁移留待真实能力探针通过后一起执行，避免中断当前服务。
- [√] 0.5 执行一次受控真实验证: 分别验证三个模型的文本能力和图片能力，记录结果后填写能力矩阵。
  > 结果: 三个模型文本请求均为 HTTP 200。使用真实图片、生产 `GatewayLLMClient` 路径验证后，`GPT-5.2-joybuilder` 成功生成图片描述和中文文字识别结果；`GPT-5.4-joybuilder`、`GPT-5-joybuilder` 在 20 秒内超时。最小 1x1 图片返回的 HTTP 400 被判定为无效测试样本，不作为模型视觉能力结论。视觉配置已收敛为仅 `GPT-5.2-joybuilder`，并显式复用文本网关。

## P1 - 模型路由与实验室故障切换

- [√] 1.1 在 `apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts` 实现请求级候选选择、失败分类、`Retry-After` 处理和请求预算。验收: 默认顺序为 `5.4 -> 5.2 -> 5`；400/401/403/422 不切换，超时/网络错误/5xx/配额 429 可切换。
- [√] 1.2 在 `apps/orchestrator-runtime/src/runtime/` 为失败候选增加最小熔断状态（closed/open/half-open）及脱敏遥测字段。验收: 连续失败后不再持续请求故障候选，冷却后允许一次恢复探测。
- [√] 1.3 在独立路由测试中覆盖 503、普通 429、不可切换 401 和候选冷却。验收: 每个场景断言尝试顺序、最终模型和错误类别。
- [√] 1.4 在 `external-tools/vision-brand-lab/` 中实现显式继承或独立 VLM 候选链、可恢复错误切换和降级原因。
- [√] 1.5 在 `external-tools/attention-analysis-lab/` 中实现与 1.4 等价的视觉切换契约。
- [√] 1.6 在 `external-tools/virtual-user-lab/` 中补齐候选模型切换；规则模拟输出 `reasonCode=llm_failed|llm_not_configured`，不再静默伪装为 LLM 结果。

## P2 - Tool 与 Skill 结构化契约

- [√] 2.1 在 `schemas/` 定义版本化的通用结果信封 Schema。验收: `status`、`findings`、`evidence`、`limitations`、`payload` 可被 AJV 校验。
- [√] 2.2 在 `apps/orchestrator-runtime/src/runtime/config-loader.ts` 和 `runtime/skill-loader.ts` 中将缺少输出 Schema 的活跃 Skill 标记为不合格，而不是静默跳过验证。
- [√] 2.3 22 个活跃 Skill 已全部登记统一输出 Schema；两个原生 Skill及六个历史未执行 Skill 均保留领域 `payload_schema`。
- [√] 2.4 为六个未执行 Skill 创建受控执行夹具和领域契约测试。
  > 备注: 该测试证明可加载、可执行、可校验，不代表基于真实脱敏研究材料的业务结论已经验收。
- [?] 2.5 更新 9 个 Tool 的输出 Schema 与 adapter 映射，统一写出 `succeeded/degraded/failed` 和来源等级。
  > 备注: 视觉与虚拟用户工具已具备机器可读降级状态；其余工具保持既有领域 Schema，待独立兼容迁移。
- [√] 2.6 扩展 `harness/linters/registry-linter.ts`，校验所有活跃 Skill 的输出 Schema 与可选 payload Schema 文件存在。

## P3 - 证据审阅与独立报告汇总

- [√] 3.1 在 `apps/orchestrator-runtime/src/runtime/context-builder.ts` 中投影结构化证据、失败摘要、审阅意见和任务目标；原始媒体被剔除并受预算限制。
- [√] 3.2 在 `apps/orchestrator-runtime/src/` 实现 `ReportSynthesisAgent` 并从 `orchestrator.ts#finalizeReport` 调用。执行记录使用 `actor_id=report_synthesis`，仍使用同一个全局任务编排器。
- [√] 3.3 在 `apps/orchestrator-runtime/src/` 增加确定性证据完整性校验器并接入汇总前流程。无法回链的 `tool_result` 自动降级为 `llm_inference` 并写入风险项。
- [√] 3.4 升级 `schemas/research-report.schema.json`、`apps/orchestrator-runtime/src/report-renderer.ts` 和报告测试为 V2：摘要、核心问题、维度分析、优先行动、报告元数据和证据覆盖成为完整报告的核心区块；HTML 与 JSON 同时展示证据/推断和 Mock 演示标记。
- [√] 3.5 增加完整证据、部分工具失败、无来源推断和 Mock 演示四类验证：成功执行写出 `evidence-ledger.json`，部分失败不伪造来源，无回链证据自动降级为 inference，Mock 报告明确标记为演示用途。

## P4 - 依赖图调度与受控并行

- [√] 4.1 在 `apps/orchestrator-runtime/src/orchestrator.ts` 中为计划步骤支持 `depends_on`；依赖必须引用此前步骤，因此拒绝循环、未来和不存在的依赖。现有计划未声明依赖时保持串行。
- [√] 4.2 实现仅对连续 `tool + depends_on: []` 步骤生效的批次调度器，默认最大并发 3，可通过 `ORCHESTRATOR_TOOL_PARALLELISM=1` 回退串行。Skill、审阅和汇总保持串行。
- [?] 4.3 在 `tests/` 覆盖稳定结果排序和并发成功路径。
  > 备注: 并发批次部分失败与取消/限流的真实外部环境演练尚未完成；失败后的成功同批工具已由 run state 去重，需在真实 adapter 上继续验证。

## P5 - 可观测性、发布与回归

- [ ] 5.1 在执行记录和任务进度 API 中增加模型尝试、能力、降级原因、Schema 校验和调度批次的脱敏事件。验收: 可按任务追溯结论来源和模型切换，且不暴露密钥/原始敏感材料。
- [ ] 5.2 在 `apps/agent-api` 与 `apps/web` 的现有状态展示中呈现模型/工具降级和报告限制，不把 `degraded` 显示为成功。验收: 用户能区分外部事实、算法计算、模拟和 LLM 推断。
- [ ] 5.3 建立上线前检查清单: 三模型能力矩阵、9 个 Tool 当前健康、22 个 Skill 契约、报告四类端到端场景、并发回退。验收: 未通过项目不得启用新默认路由或并行 feature flag。
- [ ] 5.4 更新项目运行文档和变更记录，说明模型配置、视觉前提、结果来源语义、报告汇总边界及回滚步骤。验收: 新环境可仅依赖文档完成配置与健康验证。

## 安全检查

- [ ] S1 审核配置读取、日志、探针和报告上下文，确认 API Key、用户材料、图片内容和内部 URL 不被泄露。
- [ ] S2 审核模型错误分类与重试预算，确认认证/参数类错误不会被无止境重试，模型熔断不会绕过安全策略。
- [ ] S3 审核外部证据引用，确认 URL 协议、内容长度、来源标签和渲染转义满足现有安全要求。

## 最终验收

- [√] V1 运行注册表和 Schema lint，所有活跃 Skill 输出契约有效。
- [√] V2 运行模型路由、视觉 VLM、虚拟用户降级、报告汇总、依赖调度的单元与集成测试。
- [√] V3 在显式真实验证开关下，以无敏感样例完成三模型文本/视觉探针，保存脱敏验收记录。
  > 结果: 文本链路三模型均通过；真实图片视觉链路仅 `GPT-5.2-joybuilder` 通过。`GPT-5.4-joybuilder`、`GPT-5-joybuilder` 视觉请求超时，不进入 VLM 候选。
- [ ] V4 执行 4 类端到端任务: 完整成功、主模型故障切换、视觉降级、部分工具失败；人工核对最终 HTML 报告的引用和限制。
- [ ] V5 完成工作区冲突审阅、变更说明和回滚演练后，才将新模型链路与并行功能设为默认。

## 任务状态符号

- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认

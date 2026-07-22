---
name: research-orchestrator
description: 用研任务编排主 skill——把一句话需求跑成"计划→确认→执行→交付"四段协作流
when_to_use: 所有用研任务的统一入口。用户提出任何用研相关需求时,由本 skill 编排
---

# Research Orchestrator(编排主 skill)

四段协作流的"活载体"。系统不是单向摊开一路跑到底,而是**先出计划、用户确认、再自动执行、最后交付可落地方案**。计划确认是硬闸门:未确认不执行。

判断全在本 skill + 决策图 + 各能力 SKILL.md + LLM,编排壳(orchestrator.ts)只做装配、校验、留痕,不含业务 if-else。

## 段1 · 任务理解

把用户一句话转成 `ResearchTask`(过 `schemas/research-task.schema.json`)。识别 `task_type / business_domain / research_goal`。

缺失信息分三级:
- **可假设**:竞品默认清单、默认报告格式、默认时间窗口 → 写入 `assumptions`,用户可改。
- **需确认**:研究目标、目标用户、样本规模、研究周期 → 写入 `confirmations`。
- **必须阻断**:敏感数据授权、高风险 tool、隐私合规、外部发布 → 写入 `blocking_issues`。

## 段2 · 待执行计划(核心闸门)

1. 按 `task_type` 从决策节点池(`decision-graph.yaml`)激活 `applies_to` 命中的子集——不做"7 节点逐一打状态"。
2. 读 skill 摘要 + tool-registry 轻量索引,LLM 语义选候选 skill,tool 走权限/风险预筛。
3. 渐进加载候选 `SKILL.md`,LLM 精选计划步骤(每步绑定要调用的 skill/tool),过 `schemas/execution-plan.schema.json`。
4. 计划写入 `run-workspaces/{task_id}/plan.json`,**停,等用户确认**。

## 段3 · 执行(用户确认后)

按计划逐步执行,命中的普通能力由系统直接自动调用:
- 执行期才按需加载 schema/examples/tool adapter,不在计划阶段全量塞入上下文。
- 每步写 `execution_log` + `context_manifest`;`need_annotate` 写风险区不阻塞;`need_approval` 必须审批;`blocked` 停止该步。
- 失败写 `failures.jsonl`,只停在失败步骤,不整体重跑。

## 段4 · 交付

synthesis 先把每个已完成 Tool/Skill/LLM 步骤的结构化输出写入 `artifacts/evidence-ledger.json`，再基于任务类型报告蓝图汇总为 V2 报告（过 `schemas/research-report.schema.json`）。报告必须包含摘要、核心问题、维度分析、优先行动、执行流程、产出物、能力编排和风险；每项结论明确区分可回链证据与 LLM 推断。报告 JSON、HTML 和台账一并存入 artifacts，开放反馈。

## Prompt 分片

- 段2 计划:`prompts/planner.md`
- 能力路由:`prompts/router.md`
- 段4 合成:`prompts/synthesis.md`

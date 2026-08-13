// RoutedPlanner —— 常规路由支路:节点激活 → 引导召回 → 状态判定 → 候选生成(depth/speed)+ 幻觉校验。
// 大块 prompt 常量就近安放本文件;retrieveGuidance 纯函数移入此处(唯一使用者),
// 由 orchestrator.ts re-export 保住 tests 的老 import 路径(D3)。planner 不反向依赖 orchestrator。

import {
  loadDecisionGraph,
  loadToolManifest,
  loadToolInputSchema,
  type DecisionNode,
} from '../runtime/config-loader.ts';
import { hashPrompt } from '../runtime/llm-client.ts';
import { searchKnowledge } from '../knowledge/index.ts';
import type { GuidanceRef, PlanCandidate } from '../plan-types.ts';
import type {
  DecisionStateRec,
  PlanArtifacts,
  PlanContext,
  PlannerDeps,
  PlanStrategy,
} from './plan-strategy.ts';

// 引导召回:对每个激活的决策节点,用其 related_tags 从知识库召回方法论/模型(每节点 top-3),
// 供"决策状态判定"与"计划生成"两个 LLM 调用作正典依据,并进 context_manifest 溯源。纯函数,可测。
export function retrieveGuidance(nodes: DecisionNode[]): GuidanceRef[] {
  const out: GuidanceRef[] = [];
  for (const n of nodes) {
    const tags = n.related_tags ?? [];
    if (tags.length === 0) continue;
    for (const h of searchKnowledge({ guide_tags: tags, limit: 3 })) {
      out.push({
        node: n.key,
        id: h.id,
        title: h.title,
        summary: h.summary ?? '',
        source_path: h.source_path,
        content_hash: h.content_hash,
      });
    }
  }
  return out;
}

export class RoutedPlanner implements PlanStrategy {
  constructor(private readonly deps: PlannerDeps) {}

  async plan(ctx: PlanContext): Promise<PlanArtifacts> {
    const { llm, validator, skillLoader } = this.deps;
    const { task, emit } = ctx;

    // 段2a 决策节点激活:按 applies_to 过滤(数据驱动,非领域分支)
    const graph = loadDecisionGraph();
    const activated = graph.nodes.filter((n) => n.applies_to.includes(task.task_type));
    emit({ phase: 'activate', status: 'done', label: '激活决策节点', detail: `${activated.length} 个 · ${activated.map((n) => n.key).join(' / ')}` });

    // 引导召回:按激活节点的 related_tags 从知识库取方法论,喂给下面两个 LLM 调用作正典依据。
    const guidance = retrieveGuidance(activated);
    const guidanceSources = guidance;
    emit({ phase: 'guidance', status: 'done', label: '召回方法论知识', detail: `${guidanceSources.length} 条方法卡片` });

    // 段2b 决策状态判定:LLM 对激活节点逐一判 6 态,过 schema
    emit({ phase: 'states', status: 'start', label: '判定节点状态' });
    const statesGen = await llm.generateStructured<DecisionStateRec[]>({
      prompt:
        `对以下激活的决策节点逐一判定状态:${activated.map((n) => n.key).join(', ')}\n` +
        `结合 context.guidance 里按节点召回的用研方法论/模型判断每个节点状态与 reason,引用方法论时点名(如 JTBD/5W2H)。`,
      schema: {},
      schemaName: 'decision-states',
      context: { activated: activated.map((n) => n.key), task, guidance },
      receipt: {
        stage: 'planning_decision',
        contextManifestHash: hashPrompt('', { activated: activated.map((n) => n.key), task, guidance }),
        expectedModel: this.deps.expectedActualModel ?? llm.identity.requestedModel,
      },
    });
    // 只保留本次实际激活的节点状态(防 fixture 含多余节点)
    const activatedKeys = new Set(activated.map((n) => n.key));
    const decisionStates = statesGen.data.filter((s) => activatedKeys.has(s.node_key));
    for (const s of decisionStates) validator.validateOrThrow('decision-state', s);
    emit({ phase: 'states', status: 'done', label: '判定节点状态', detail: `${decisionStates.length} 个节点已判定` });

    // 段2c 能力路由 + 候选计划生成:一次 LLM 产出 2 份候选(depth / speed)。
    // depth = 覆盖广、有交叉验证/复核,步骤数偏多;speed = 最短路径拿关键结论,可略过 reviewer/合成型 LLM 步。
    // 两份候选应有明显 skill/tool 差异,不能只是同一计划步骤数缩水。
    emit({ phase: 'candidates', status: 'start', label: '生成候选方案' });
    const activeSkills = skillLoader.listActiveSkills();
    const activeTools = skillLoader.listActiveTools();
    const skillIds = activeSkills.map((s) => s.id);
    const toolIds = activeTools.map((t) => t.id);
    const toolCtx = activeTools.map((t) => {
      const manifest = loadToolManifest(t.path);
      return { id: t.id, name: t.name, tier: t.tier ?? 'optional', input_schema: loadToolInputSchema(manifest.input_schema) };
    });
    const planGen = await llm.generateStructured<{ candidates: Array<Omit<PlanCandidate, 'activated_nodes'>> }>({
      prompt:
        `基于任务与候选能力,生成 2 份"待用户挑选"的执行计划候选,分别对应 depth 与 speed 两种取向。\n` +
        `硬约束:\n` +
        `- 顶层结构 { candidates: [ {id, title, rationale, tradeoffs, steps, assumptions}, ... ] },且必须恰好 2 项。\n` +
        `- 每个 step 必须含字段:step_no(从 1 递增的整数)、step_name(该步中文简述)、actor_type、actor_id;可选 purpose/input/requires_approval。禁止用 step_id,禁止省略 step_no 或 step_name。\n` +
        `- requires_approval 语义:仅当该步涉及个人隐私数据(PII)、敏感数据授权、对外发布/投放、付费或不可逆的外部副作用时才标 true;纯公开信息检索、竞品分析、范围澄清、汇总提炼、质量复核等只读且仅用公开信息的步骤一律 false 或省略。不要因"需要用户确认范围/口径"就标 true——范围澄清用 assumptions(editable:true)表达,而非审批步。\n` +
        `- 第 1 项 id="depth"(深度优先:方法论完整、覆盖广、含复核/交叉验证),第 2 项 id="speed"(速度优先:最短路径拿关键结论)。\n` +
        `- 两份 steps 必须在 skill/tool 组合上存在明显差异(不同能力或不同顺序),不允许只是 speed 版把 depth 版删几行。\n` +
        `- actor_type=skill 步的 actor_id 只能取:[${skillIds.join(', ')}];actor_type=tool 步的 actor_id 只能取:[${toolIds.join(', ')}];禁止编造清单外 id。\n` +
        `- 若需 LLM 自身推理步骤(汇总/提炼)用 actor_type=llm;质量复核用 actor_type=reviewer。\n` +
        `- tool 步必须在 step.input 里按该 tool 的 input_schema(见 context.tools[].input_schema)生成入参;无图字段留空,并在 assumptions 标注『需用户提供设计稿』。\n` +
        `- tool 分层(context.tools[].tier):core=平台常在的公开检索(如网页检索),optional=依赖外部后端的增强能力(截图库/实验室)。` +
        `关键结论的证据必须由 core 能力支撑,报告在无任何 optional 能力时也应成立;optional 只作增强、不得作为唯一证据来源,也不得置于关键结论的必经依赖上。若某 skill 的 required_tools 含 optional tool,可纳入计划但须让报告在其缺失时仍可产出。\n` +
        `- rationale(为什么这样组合,引用方法论点名如 JTBD/5W2H)与 tradeoffs(明显代价,如"耗时约翻倍"/"覆盖窄可能漏点")必填,各控制在 1-2 句。\n` +
        `- title 用中文短语,例如"深度优先·方法论覆盖" / "速度优先·关键结论"。\n` +
        `选方法/排步骤时参考 context.guidance 召回的方法卡片,使方法选择有正典依据。`,
      schema: {},
      schemaName: 'execution-plan-candidates',
      context: {
        task,
        skills: activeSkills.map((s) => ({ id: s.id, when_to_use: s.when_to_use, required_tools: s.required_tools })),
        tools: toolCtx,
        guidance,
      },
      receipt: {
        stage: 'planning',
        contextManifestHash: hashPrompt('', { task, skills: activeSkills, tools: toolCtx, guidance }),
        expectedModel: this.deps.expectedActualModel ?? llm.identity.requestedModel,
      },
    });
    validator.validateOrThrow('current-plan-candidates', planGen.data);
    const activatedNodeKeys = activated.map((n) => n.key);
    const candidates: PlanCandidate[] = planGen.data.candidates.map((candidate) => ({
      ...candidate,
      activated_nodes: activatedNodeKeys,
    }));
    // 幻觉能力校验:每份候选独立过一遍
    for (const cand of candidates) {
      const bad = cand.steps.filter((s) => {
        if (s.actor_type === 'skill') return !skillLoader.getSkill(s.actor_id);
        if (s.actor_type === 'tool') return !skillLoader.getTool(s.actor_id);
        return false;
      });
      if (bad.length > 0) {
        throw new Error(
          `候选 ${cand.id} 包含 registry 中不存在的能力(疑似 LLM 幻觉): ` +
            bad.map((s) => `${s.actor_type}:${s.actor_id}`).join(', '),
        );
      }
    }
    const planProvenance = {
      modelName: planGen.modelName, modelVersion: planGen.modelVersion,
      promptHash: planGen.promptHash, traceId: planGen.traceId,
    };
    emit({ phase: 'candidates', status: 'done', label: '生成候选方案', detail: `${candidates.length} 份 · ${candidates.map((c) => c.id).join(' / ')}` });

    return { activated, decisionStates, candidates, planProvenance, guidanceSources };
  }
}

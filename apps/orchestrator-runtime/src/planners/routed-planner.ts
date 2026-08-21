// RoutedPlanner —— 常规路由支路:节点激活 → 引导召回 → 状态判定 → 候选生成(depth/speed)+ 幻觉校验。
// 大块 prompt 常量就近安放本文件;retrieveGuidance 纯函数移入此处(唯一使用者),
// 由 orchestrator.ts re-export 保住 tests 的老 import 路径(D3)。planner 不反向依赖 orchestrator。

import { join } from 'node:path';

import {
  getConfigRoot,
  loadDecisionGraph,
  loadToolManifest,
  loadToolInputSchema,
  loadToolRegistry,
  type DecisionNode,
} from '../runtime/config-loader.ts';
import { hashPrompt } from '../runtime/llm-client.ts';
import { searchKnowledge } from '../knowledge/index.ts';
import type { GuidanceRef, PlanCandidate } from '../plan-types.ts';
import type { PlanningProvenance, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type {
  CurrentPlanStep,
  EvidenceRequirement,
  ProblemGraph,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  DecisionStateRec,
  PlanArtifacts,
  PlanContext,
  PlannerDeps,
  PlanProvenance,
  PlanStrategy,
} from './plan-strategy.ts';
import {
  CapabilityResolver,
  type CapabilityApproval,
  type CapabilityResolution,
  type CapabilityToolState,
} from './capability-resolver.ts';
import {
  ProblemGraphPlanner,
  type ProblemGraphProvenance,
} from './problem-graph-planner.ts';
import {
  MAX_BROWSER_CAPTURE_COUNT,
  MAX_BROWSER_FALLBACK_RESULTS,
  PlanCompiler,
  PlanCompilerValidationError,
  frozenVisualSourceQueries,
  type CurrentPlanCandidateProposal,
} from './plan-compiler.ts';
import { loadSchemaText, resolveSchema } from '../runtime/schema-registry.ts';
import { SchemaValidationError, type SchemaValidator } from '../schema/validator.ts';
import { resolvePlannerGuidance, type ResolvedProfileSpec } from './planning-guidance-adapter.ts';

interface SchemaWithDefinitions {
  $defs: Record<string, object>;
}

const currentPlanCandidatesSchemaText = loadSchemaText(resolveSchema('current-plan-candidates'));
if (!currentPlanCandidatesSchemaText) {
  throw new Error('current-plan-candidates schema is not registered');
}
const currentPlanCandidatesSchemaValue: unknown = JSON.parse(currentPlanCandidatesSchemaText);
if (!currentPlanCandidatesSchemaValue || typeof currentPlanCandidatesSchemaValue !== 'object' || !('$defs' in currentPlanCandidatesSchemaValue)) {
  throw new Error('current-plan-candidates schema has no definitions');
}
const currentPlanCandidatesSchema = currentPlanCandidatesSchemaValue as object & SchemaWithDefinitions;

const currentExecutionPlanSchemaText = loadSchemaText(resolveSchema('current-execution-plan'));
if (!currentExecutionPlanSchemaText) {
  throw new Error('current-execution-plan schema is not registered');
}
const currentExecutionPlanSchemaValue: unknown = JSON.parse(currentExecutionPlanSchemaText);
if (!currentExecutionPlanSchemaValue || typeof currentExecutionPlanSchemaValue !== 'object' || !('$defs' in currentExecutionPlanSchemaValue)) {
  throw new Error('current-execution-plan schema has no definitions');
}
const currentExecutionPlanSchema = currentExecutionPlanSchemaValue as SchemaWithDefinitions;
const legacyCandidateDefinitions = currentPlanCandidatesSchema.$defs;

function currentPlanProposalSchemaFor(profileIds: readonly string[]): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        minItems: profileIds.length,
        maxItems: profileIds.length,
        items: profileIds.map((profileId) => ({
          allOf: [
            { $ref: '#/$defs/candidate' },
            { properties: { id: { const: profileId } } },
          ],
        })),
        additionalItems: false,
      },
    },
    $defs: {
      ...currentExecutionPlanSchema.$defs,
      assumption: legacyCandidateDefinitions.assumption,
      candidate: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'rationale', 'tradeoffs', 'steps', 'assumptions'],
        properties: {
          id: { enum: ['speed', 'depth', 'breadth', 'focused', 'mixed_method', 'decision', 'remediation'] },
          title: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 },
          tradeoffs: { type: 'string', minLength: 1 },
          steps: { type: 'array', minItems: 1, items: { $ref: '#/$defs/step' } },
          assumptions: { type: 'array', items: { $ref: '#/$defs/assumption' } },
        },
      },
    },
  };
}

const currentPlanProposalSchema = currentPlanProposalSchemaFor(['depth', 'speed']);

function recoverableCandidateSchemaFeedback(
  validator: SchemaValidator,
  schema: object,
  value: unknown,
): string[] {
  try {
    validator.validateSchemaOrThrow(schema, value, 'current-plan-candidates');
    return [];
  } catch (error) {
    if (
      !(error instanceof SchemaValidationError)
      || error.errors.some((issue) => !/\/input_bindings\/\d+\/source_step_no must be >= 1$/u.test(issue))
    ) {
      throw error;
    }
    return error.errors.map((issue) => (
      `candidate schema: ${issue}; source_step_no must reference a real earlier step (>= 1), `
      + 'and planning_input must be copied directly into step.input instead of bound from a pseudo step 0'
    ));
  }
}

interface InputSchema {
  $ref?: string;
  const?: unknown;
  default?: unknown;
  enum?: unknown[];
  type?: string | string[];
  required?: string[];
  properties?: Record<string, InputSchema>;
  items?: InputSchema;
  oneOf?: InputSchema[];
  anyOf?: InputSchema[];
  minItems?: number;
  minimum?: number;
}

function resolveInputSchema(root: InputSchema, schema: InputSchema): InputSchema {
  if (!schema.$ref?.startsWith('#/')) return schema;
  let resolved: unknown = root;
  for (const segment of schema.$ref.slice(2).split('/')) {
    if (!resolved || typeof resolved !== 'object') return schema;
    resolved = Reflect.get(resolved, segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  return resolved && typeof resolved === 'object' ? resolved as InputSchema : schema;
}

function taskInputValue(field: string, task: ResearchTaskV2): unknown {
  if (field === 'query' || field === 'research_goal' || field === 'goal') return task.research_goal;
  if (field === 'business_domain') return task.business_domain;
  if (field === 'target_audience') return task.target_audience;
  if (field === 'scope') return task.scope;
  if (field === 'constraints') return task.constraints;
  if (field === 'success_criteria') return task.success_criteria;
  if (field === 'expected_deliverables') return task.expected_deliverables;
  return undefined;
}

function requiredInputValue(
  root: InputSchema,
  rawSchema: InputSchema,
  field: string,
  task: ResearchTaskV2,
): unknown {
  const schema = resolveInputSchema(root, rawSchema);
  const taskValue = taskInputValue(field, task);
  if (taskValue !== undefined) return structuredClone(taskValue);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  const alternative = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alternative) return requiredInputValue(root, alternative, field, task);
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type;
  if (type === 'object' || schema.properties) return buildSchemaInput(root, schema, task);
  if (type === 'array') {
    return Array.from(
      { length: schema.minItems ?? 0 },
      () => requiredInputValue(root, schema.items ?? {}, field, task),
    );
  }
  if (type === 'integer') return Math.ceil(schema.minimum ?? 0);
  if (type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  return task.research_goal;
}

function buildSchemaInput(
  root: InputSchema,
  rawSchema: InputSchema,
  task: ResearchTaskV2,
): Record<string, unknown> {
  const schema = resolveInputSchema(root, rawSchema);
  const input: Record<string, unknown> = {};
  for (const field of schema.required ?? []) {
    const propertySchema = schema.properties?.[field];
    if (!propertySchema) throw new Error(`Input schema required property ${field} has no definition`);
    input[field] = requiredInputValue(root, propertySchema, field, task);
  }
  return input;
}

export interface CurrentPlanArtifacts {
  activated: DecisionNode[];
  decisionStates: DecisionStateRec[];
  candidates: CurrentPlanCandidateProposal[];
  planProvenance: PlanProvenance;
  guidanceSources: GuidanceRef[];
  problemGraph: ProblemGraph;
  problemGraphProvenance: ProblemGraphProvenance;
  capabilityResolution: CapabilityResolution;
  planningProvenance: PlanningProvenance;
}

const ROUTED_STEP_LIMITS = {
  speed: 4,
  depth: 8,
  breadth: 8,
  focused: 6,
  mixed_method: 8,
  decision: 7,
  remediation: 7,
} as const;
const DEFAULT_BROWSER_CAPTURE_COUNT = MAX_BROWSER_CAPTURE_COUNT;

function scoringDimensions(
  input: Record<string, unknown>,
  fallback: readonly string[] | undefined,
): string[] | null {
  if (!Object.hasOwn(input, 'dimensions')) return fallback ? [...fallback] : null;
  if (!Array.isArray(input.dimensions)) return null;
  const dimensions = input.dimensions.map((value) => (
    typeof value === 'string' ? value.trim() : ''
  ));
  if (
    dimensions.length < 2
    || dimensions.some((dimension) => !dimension)
    || new Set(dimensions).size !== dimensions.length
  ) return null;
  return dimensions;
}

function explicitCompetitiveScoringWeights(
  requirement: ResearchTaskV2,
): Record<string, number> | undefined {
  const dimensions = requirement.comparison_dimensions;
  if (!dimensions) return undefined;
  const userStatements = requirement.constraints
    .filter((constraint) => constraint.source === 'user')
    .map((constraint) => constraint.statement);
  const percentages = dimensions.map((dimension) => {
    for (const statement of userStatements) {
      const offset = statement.indexOf(dimension);
      if (offset < 0) continue;
      const suffix = statement.slice(offset + dimension.length);
      const match = /^\s*(?:[（(]\s*)?(?:权重\s*)?(?:为|[:：=])?\s*(\d+(?:\.\d+)?)\s*[%％]/u.exec(suffix);
      if (match) return Number(match[1]);
    }
    return null;
  });
  if (
    percentages.some((value) => value === null || !Number.isFinite(value) || value < 0 || value > 100)
    || Math.abs(percentages.reduce<number>((sum, value) => sum + (value ?? 0), 0) - 100) > 0.001
  ) return undefined;
  return Object.fromEntries(dimensions.map((dimension, index) => [
    dimension,
    percentages[index]! / 100,
  ]));
}

function freezeCompetitiveScoringWeights(
  candidate: Omit<CurrentPlanCandidateProposal, 'activated_nodes'>,
  fallbackDimensions?: readonly string[],
  explicitWeights?: Readonly<Record<string, number>>,
): Omit<CurrentPlanCandidateProposal, 'activated_nodes'> {
  return {
    ...candidate,
    steps: candidate.steps.map((step) => {
      if (
        step.actor_type !== 'skill'
        || step.actor_id !== 'competitive-web-research'
      ) return step;
      const dimensions = scoringDimensions(step.input, fallbackDimensions);
      if (!dimensions) return step;
      const input = fallbackDimensions
        ? { ...step.input, dimensions }
        : step.input;
      // The declared dimensions are the source of truth. A model may return
      // malformed, reordered, or non-normalized weights; preserving those
      // values defers a deterministic chart contract failure until execution.
      // Freeze explicit user weights or equal weights before candidate
      // validation. When no dimensions were declared, keep the model path
      // untouched so planning does not invent a comparison matrix.
      const weights = explicitWeights
        ? Object.fromEntries(
            dimensions.map((dimension) => [dimension, explicitWeights[dimension]]),
          )
        : Object.fromEntries(
            dimensions.map((dimension) => [dimension, 1 / dimensions.length]),
          );
      return {
        ...step,
        input: {
          ...input,
          scoring_weights: weights,
        },
      };
    }),
  };
}

function freezePlaywrightFallbackPools(
  candidate: Omit<CurrentPlanCandidateProposal, 'activated_nodes'>,
  researchGoal: string,
): Omit<CurrentPlanCandidateProposal, 'activated_nodes'> {
  const capturePagesBySourceStep = new Map<number, number>();
  const captureOptionsByStep = new Map<number, Record<string, unknown>>();
  for (const [stepIndex, step] of candidate.steps.entries()) {
    if (step.actor_id !== 'playwright-page-capture') continue;
    const rawCapture = step.input.capture;
    const capture = rawCapture && typeof rawCapture === 'object' && !Array.isArray(rawCapture)
      ? rawCapture as Record<string, unknown>
      : {};
    const maxPages = Number.isInteger(capture.max_pages)
      && Number(capture.max_pages) >= 1
      && Number(capture.max_pages) <= DEFAULT_BROWSER_CAPTURE_COUNT
      ? Number(capture.max_pages)
      : DEFAULT_BROWSER_CAPTURE_COUNT;
    captureOptionsByStep.set(stepIndex, {
      ...capture,
      max_pages: maxPages,
      unique_hostnames: true,
    });
    for (const binding of step.input_bindings) {
      if (binding.target_pointer !== '/pages' || binding.source_pointer !== '/results') continue;
      capturePagesBySourceStep.set(
        binding.source_step_no,
        Math.max(capturePagesBySourceStep.get(binding.source_step_no) ?? 0, maxPages),
      );
    }
  }
  if (capturePagesBySourceStep.size === 0) return candidate;
  return {
    ...candidate,
    steps: candidate.steps.map((step, index) => {
      const frozenCapture = step.actor_id === 'playwright-page-capture'
        ? captureOptionsByStep.get(index)
        : undefined;
      if (frozenCapture) {
        return {
          ...step,
          input: { ...step.input, capture: frozenCapture },
        };
      }
      const maxPages = capturePagesBySourceStep.get(index + 1);
      if (step.actor_id !== 'tavily-web-search' || maxPages === undefined) return step;
      const maxResults = Math.min(MAX_BROWSER_FALLBACK_RESULTS, maxPages * 2);
      return {
        ...step,
        input: {
          ...step.input,
          query: frozenVisualSourceQueries(researchGoal, maxPages),
          max_results: maxResults,
        },
      };
    }),
  };
}

function freezeCompetitiveScoringWeightEnvelope(input: {
  candidates: Array<Omit<CurrentPlanCandidateProposal, 'activated_nodes'>>;
  researchGoal: string;
  fallbackDimensions?: readonly string[];
  explicitWeights?: Readonly<Record<string, number>>;
}): {
  candidates: Array<Omit<CurrentPlanCandidateProposal, 'activated_nodes'>>;
} {
  return {
    candidates: input.candidates.map((candidate) => (
      freezeCompetitiveScoringWeights(
        freezePlaywrightFallbackPools(candidate, input.researchGoal),
        input.fallbackDimensions,
        input.explicitWeights,
      )
    )),
  };
}

function routedCandidateValidationFeedback(input: {
  candidates: Array<Omit<CurrentPlanCandidateProposal, 'activated_nodes'>>;
  profileSpecs: readonly ResolvedProfileSpec[];
  planningProvenance: PlanningProvenance;
  task: ResearchTaskV2;
  problemGraph: ProblemGraph;
  problemGraphProvenance: ProblemGraphProvenance;
  capabilityResolution: CapabilityResolution;
  evidenceRequirements: EvidenceRequirement[];
  activatedNodes: string[];
}): string[] {
  const compiler = new PlanCompiler();
  const issues: string[] = [];
  const profileById = new Map(input.profileSpecs.map((profile) => [profile.id, profile]));
  for (const candidate of input.candidates) {
    const profile = profileById.get(candidate.id);
    if (!profile) {
      issues.push(`${candidate.id}: routed_candidate_profile_not_requested`);
      continue;
    }
    const maxSteps = profile.max_steps ?? ROUTED_STEP_LIMITS[candidate.id];
    if (candidate.steps.length > maxSteps) {
      issues.push(
        `${candidate.id}: routed_step_limit_exceeded: actual=${candidate.steps.length}, max=${maxSteps}`,
      );
    }
    try {
      compiler.compile({
        candidate: { ...candidate, activated_nodes: input.activatedNodes },
        task: input.task,
        problem_graph: input.problemGraph,
        problem_graph_provenance: input.problemGraphProvenance,
        capability_resolution: input.capabilityResolution,
        evidence_requirements: input.evidenceRequirements,
        activated_nodes: input.activatedNodes,
        planning_provenance: input.planningProvenance,
        requireCompetitiveWeightContract: true,
      });
    } catch (error) {
      if (!(error instanceof PlanCompilerValidationError)) throw error;
      issues.push(`${candidate.id}: ${error.kind}: ${error.issueIds.join(', ')}`);
    }
  }
  return issues;
}

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
    const { task, requirement, emit } = ctx;

    // 段2a 决策节点激活:按 applies_to 过滤(数据驱动,非领域分支)
    const graph = loadDecisionGraph();
    const activated = graph.nodes.filter((n) => n.applies_to.includes(task.task_type));
    const activatedNodeKeys = activated.map((node) => node.key);
    emit({ phase: 'activate', status: 'done', label: '激活决策节点', detail: `${activated.length} 个 · ${activated.map((n) => n.key).join(' / ')}` });

    // 引导召回:按激活节点的 related_tags 从知识库取方法论,喂给下面两个 LLM 调用作正典依据。
    const guidance = retrieveGuidance(activated);
    const guidanceSources = guidance;
    emit({ phase: 'guidance', status: 'done', label: '召回方法论知识', detail: `${guidanceSources.length} 条方法卡片` });

    // 段2b 决策状态判定:LLM 对激活节点逐一判 6 态,过 schema
    emit({ phase: 'states', status: 'start', label: '判定节点状态' });
    const decisionContext = {
      activated: activatedNodeKeys,
      task,
      ...(requirement ? { requirement } : {}),
      guidance,
    };
    const statesGen = await llm.generateStructured<DecisionStateRec[]>({
      prompt:
        `对以下激活的决策节点逐一判定状态:${activated.map((n) => n.key).join(', ')}\n` +
        `结合 context.guidance 里按节点召回的用研方法论/模型判断每个节点状态与 reason,引用方法论时点名(如 JTBD/5W2H)。`,
      schema: {},
      schemaName: 'decision-states',
      context: decisionContext,
      receipt: {
        stage: 'planning_decision',
        contextManifestHash: hashPrompt('', decisionContext),
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
    const candidateContext = {
      task,
      ...(requirement ? { requirement } : {}),
      skills: activeSkills.map((skill) => ({
        id: skill.id,
        when_to_use: skill.when_to_use,
        required_tools: skill.required_tools,
      })),
      tools: toolCtx,
      guidance,
    };
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
      schema: currentPlanCandidatesSchema,
      schemaName: 'current-plan-candidates',
      context: candidateContext,
      receipt: {
        stage: 'planning',
        contextManifestHash: hashPrompt('', candidateContext),
        expectedModel: this.deps.expectedActualModel ?? llm.identity.requestedModel,
      },
    });
    validator.validateOrThrow('current-plan-candidates', planGen.data);
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

  async planCurrent(
    ctx: PlanContext & { requirement: ResearchTaskV2 },
    evidenceRequirements: EvidenceRequirement[],
  ): Promise<CurrentPlanArtifacts> {
    const { llm, validator, skillLoader, tools } = this.deps;
    if (!tools) throw new Error('Current planning requires ToolRouter capability state');
    const explicitWeights = explicitCompetitiveScoringWeights(ctx.requirement);
    const decisionGraph = loadDecisionGraph();
    const activated = ctx.direct
      ? []
      : decisionGraph.nodes.filter((node) => node.applies_to.includes(ctx.task.task_type));
    const activatedNodeKeys = activated.map((node) => node.key);
    ctx.emit({
      phase: 'activate',
      status: 'done',
      label: '激活决策节点',
      detail: `${activated.length} 个 · ${activatedNodeKeys.join(' / ')}`,
    });
    const guidanceSources = retrieveGuidance(activated);
    ctx.emit({
      phase: 'guidance',
      status: 'done',
      label: '召回方法论知识',
      detail: `${guidanceSources.length} 条方法卡片`,
    });

    let decisionStates: DecisionStateRec[] = [];
    if (!ctx.direct) {
      ctx.emit({ phase: 'states', status: 'start', label: '判定节点状态' });
      const decisionContext = {
        activated: activatedNodeKeys,
        task: ctx.task,
        requirement: ctx.requirement,
        guidance: guidanceSources,
      };
      const statesGen = await llm.generateStructured<DecisionStateRec[]>({
        prompt: `对以下激活的决策节点逐一判定状态:${activatedNodeKeys.join(', ')}`,
        schema: {},
        schemaName: 'decision-states',
        context: decisionContext,
        receipt: {
          stage: 'planning_decision',
          contextManifestHash: hashPrompt('', decisionContext),
          expectedModel: this.deps.expectedActualModel ?? llm.identity.requestedModel,
        },
      });
      const activatedKeys = new Set(activatedNodeKeys);
      decisionStates = statesGen.data.filter((state) => activatedKeys.has(state.node_key));
      for (const state of decisionStates) validator.validateOrThrow('decision-state', state);
      ctx.emit({
        phase: 'states',
        status: 'done',
        label: '判定节点状态',
        detail: `${decisionStates.length} 个节点已判定`,
      });
    }

    const problemGraphResult = await new ProblemGraphPlanner({
      llm,
      validator,
      guidance: guidanceSources,
      evidenceRequirements,
      expectedActualModel: this.deps.expectedActualModel,
    }).build(ctx.requirement);

    const registeredTools = loadToolRegistry().tools;
    const manifests = registeredTools.map((tool) => loadToolManifest(tool.path));
    const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    const toolStates: CapabilityToolState[] = registeredTools.map((tool) => {
      const manifest = manifestById.get(tool.id);
      if (!manifest) {
        return { tool_id: tool.id, health: 'unhealthy', real_adapter_qualified: false };
      }
      const resolution = tools.resolve(manifest);
      return {
        tool_id: tool.id,
        health: resolution ? 'healthy' : 'unhealthy',
        real_adapter_qualified: Boolean(
          resolution
          && resolution.executionMode === 'real'
          && resolution.resolvedAdapterType === resolution.declaredAdapterType,
        ),
      };
    });
    const authorities = new Set(this.deps.approvalAuthorities ?? []);
    const capabilitySkills = skillLoader.listCapabilitySkills();
    const approvalCapabilities: CapabilityApproval[] = [];
    for (const skill of capabilitySkills) {
      if (skill.status !== 'active' || skill.risk_level !== 'high' || !skill.id) continue;
      for (const authority of authorities) {
        approvalCapabilities.push({ capability_type: 'skill', capability_id: skill.id, authority });
      }
    }
    for (const manifest of manifests) {
      if (
        manifest.risk_level === 'high'
        && manifest.approver_rule
        && manifest.approver_rule !== 'none'
        && authorities.has(manifest.approver_rule)
      ) {
        approvalCapabilities.push({
          capability_type: 'tool',
          capability_id: manifest.id,
          authority: manifest.approver_rule,
        });
      }
    }
    const availableInputRoles = ['research_goal', 'business_domain'];
    if (ctx.requirement.target_audience.length > 0) availableInputRoles.push('target_audience');
    if (ctx.requirement.scope.length > 0) availableInputRoles.push('scope');
    if (ctx.requirement.constraints.length > 0) availableInputRoles.push('constraints');
    if (ctx.requirement.success_criteria.length > 0) availableInputRoles.push('success_criteria');
    if (ctx.requirement.expected_deliverables.length > 0) availableInputRoles.push('expected_deliverables');
    const capabilityResolution = new CapabilityResolver().resolve({
      task: ctx.requirement,
      available_input_roles: availableInputRoles,
      skills: capabilitySkills,
      tools: registeredTools,
      tool_states: toolStates,
      tool_manifests: manifests,
      approval_capabilities: approvalCapabilities,
    });
    if (capabilityResolution.eligible.length === 0) {
      throw new Error(`Current planning has no eligible skill for ${ctx.requirement.task_type}`);
    }
    const planningGuidance = await resolvePlannerGuidance({
      rawInput: ctx.originalInput ?? ctx.requirement.research_goal,
      task: ctx.guidanceRequirement ?? ctx.requirement,
      problemGraph: problemGraphResult.graph,
      capabilityResolution,
      ...(ctx.direct ? { directSkillId: ctx.direct.skillName } : {}),
      llm,
      expectedActualModel: this.deps.expectedActualModel,
      ...(this.deps.planningPolicy === undefined
        ? {}
        : { policy: this.deps.planningPolicy }),
    });
    if (planningGuidance.status === 'clarification') {
      throw new Error(`Planning Guidance requires clarification: ${planningGuidance.clarification?.reason_code ?? 'unknown'}`);
    }
    if (planningGuidance.status === 'blocked') {
      throw new Error('Planning Guidance could not establish both baseline candidates');
    }
    if (ctx.direct) {
      const directDecision = capabilityResolution.eligible.find(
        (decision) => decision.skill.id === ctx.direct!.skillName,
      );
      if (!directDecision) {
        const rejected = capabilityResolution.rejected.find(
          (decision) => decision.skill.id === ctx.direct!.skillName,
        );
        const reasons = rejected?.reasons.map((reason) => reason.code).join(', ') ?? 'not registered';
        throw new Error(`Current direct skill ${ctx.direct.skillName} is not eligible: ${reasons}`);
      }
      const questionIds = problemGraphResult.graph.questions.map((question) => question.id);
      const acceptanceCriteria = problemGraphResult.graph.questions.flatMap(
        (question) => question.acceptance_criteria,
      );
      const requiredApprovals = directDecision.required_approvals;
      const requiredToolIds = new Set(directDecision.skill.required_tools);
      const requiredTools = registeredTools.filter((tool) => requiredToolIds.has(tool.id));
      if (requiredTools.length !== requiredToolIds.size) {
        throw new Error(`Current direct skill ${ctx.direct.skillName} has unresolved required tools`);
      }
      const availableOptionalToolIds = new Set(
        directDecision.optional_tool_decisions
          .filter(({ status }) => status === 'available')
          .map(({ tool_id }) => tool_id),
      );
      const optionalTools = registeredTools.filter((tool) => availableOptionalToolIds.has(tool.id));
      if (optionalTools.length !== availableOptionalToolIds.size) {
        throw new Error(`Current direct skill ${ctx.direct.skillName} has unresolved optional tools`);
      }
      const plannedTools = [...requiredTools, ...optionalTools];
      const hasPlannedBrowserCapture = plannedTools.some(
        ({ id }) => id === 'playwright-page-capture',
      );
      const tavilyStepNo = plannedTools.findIndex(({ id }) => id === 'tavily-web-search') + 1;
      const toolSteps: CurrentPlanStep[] = plannedTools.map((tool, index) => {
        const manifest = manifestById.get(tool.id);
        if (!manifest) throw new Error(`Current direct tool ${tool.id} has no manifest`);
        const inputSchema = loadToolInputSchema(manifest.input_schema);
        const input = buildSchemaInput(
          inputSchema as InputSchema,
          inputSchema as InputSchema,
          ctx.requirement,
        );
        const isBrowserCapture = tool.id === 'playwright-page-capture';
        if (tool.id === 'tavily-web-search' && hasPlannedBrowserCapture) {
          input.query = frozenVisualSourceQueries(
            ctx.requirement.research_goal,
            DEFAULT_BROWSER_CAPTURE_COUNT,
          );
          input.max_results = Math.min(
            MAX_BROWSER_FALLBACK_RESULTS,
            DEFAULT_BROWSER_CAPTURE_COUNT * 2,
          );
        }
        if (isBrowserCapture) {
          if (tavilyStepNo < 1 || tavilyStepNo >= index + 1) {
            throw new Error('Playwright capture requires an earlier Tavily step');
          }
          input.pages = [];
        } else {
          validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), input);
        }
        const visualPendingCount = directDecision.pending_inputs.filter(({ kind }) => kind === 'visual').length;
        for (const pending of directDecision.pending_inputs) {
          for (const imageField of manifest.image_input_fields ?? []) {
            if (
              pending.kind === 'visual'
              && (
                visualPendingCount === 1
                || (imageField.role ?? imageField.field) === pending.role
              )
            ) {
              input[imageField.field] = imageField.multiple ? [] : null;
            }
          }
        }
        const approval = requiredApprovals.find((item) => (
          item.capability_type === 'tool' && item.capability_id === tool.id
        ));
        return {
          step_no: index + 1,
          step_name: `调用 ${tool.name}`,
          actor_type: 'tool',
          actor_id: tool.id,
          question_ids: questionIds,
          depends_on: isBrowserCapture ? [tavilyStepNo] : [],
          input,
          input_bindings: isBrowserCapture ? [{
            target_pointer: '/pages',
            source_step_no: tavilyStepNo,
            source_pointer: '/results',
          }] : [],
          expected_outputs: [{
            pointer: tool.id === 'tavily-web-search'
              ? '/results'
              : isBrowserCapture ? '/captures' : '/result',
            description: `${tool.name} result`,
          }],
          acceptance_criteria: acceptanceCriteria,
          requires_approval: Boolean(approval),
          ...(approval ? { approval_role: approval.authority } : {}),
          fallback_actor_ids: [],
        };
      });
      const skillStepNo = toolSteps.length + 1;
      let skillInput: Record<string, unknown> = {
        research_goal: ctx.requirement.research_goal,
        brief: ctx.direct.rest,
        requirement: ctx.requirement,
      };
      if (directDecision.skill.input_schema) {
        const inputSchema = loadToolInputSchema(directDecision.skill.input_schema);
        skillInput = buildSchemaInput(
          inputSchema as InputSchema,
          inputSchema as InputSchema,
          ctx.requirement,
        );
        validator.validateFileOrThrow(
          join(getConfigRoot(), directDecision.skill.input_schema),
          skillInput,
        );
      }
      for (const pending of directDecision.pending_inputs) {
        skillInput[pending.role] = pending.multiple ? [] : null;
      }
      const skillApproval = requiredApprovals.find((item) => (
        item.capability_type === 'skill' && item.capability_id === ctx.direct!.skillName
      ));
      const skillOutputPointers = ['/payload'];
      const skillStep: CurrentPlanStep = {
        step_no: skillStepNo,
        step_name: `直呼 ${ctx.direct.skillName}`,
        actor_type: 'skill',
        actor_id: ctx.direct.skillName,
        question_ids: questionIds,
        depends_on: toolSteps.map((step) => step.step_no),
        input: skillInput,
        input_bindings: [],
        expected_outputs: skillOutputPointers.map((pointer) => ({
          pointer,
          description: `${ctx.direct!.skillName} output ${pointer}`, 
        })), 
        acceptance_criteria: acceptanceCriteria,
        requires_approval: Boolean(skillApproval),
        ...(skillApproval ? { approval_role: skillApproval.authority } : {}),
        fallback_actor_ids: [],
      };
      const reviewerStep: CurrentPlanStep = {
        step_no: skillStepNo + 1,
        step_name: '复核直呼结果',
        actor_type: 'reviewer',
        actor_id: 'research-plan-reviewer',
        question_ids: questionIds,
        depends_on: [skillStepNo],
        input: {},
        input_bindings: [],
        expected_outputs: [{ pointer: '/review', description: '直呼结果复核' }],
        acceptance_criteria: acceptanceCriteria,
        requires_approval: false,
        fallback_actor_ids: [],
      };
      const directSteps = [...toolSteps, skillStep];
      const directCandidates: CurrentPlanCandidateProposal[] = [
        {
          id: 'depth',
          title: `直呼 ${directDecision.skill.name ?? ctx.direct.skillName}（含复核）`,
          rationale: '执行用户指定 Skill，并追加独立质量复核。',
          tradeoffs: '多一步复核，耗时略长。',
          steps: [...structuredClone(directSteps), reviewerStep],
          assumptions: ctx.requirement.assumptions,
          activated_nodes: [],
        },
        {
          id: 'speed',
          title: `直呼 ${directDecision.skill.name ?? ctx.direct.skillName}`,
          rationale: '执行用户指定 Skill，不经过能力排序。',
          tradeoffs: '仅执行指定 Skill，不做独立复核。',
          steps: structuredClone(directSteps),
          assumptions: ctx.requirement.assumptions,
          activated_nodes: [],
        },
      ];
      const candidates = directCandidates.map((candidate): CurrentPlanCandidateProposal => {
        const { activated_nodes, ...proposal } = candidate;
        return {
          ...freezeCompetitiveScoringWeights(
            freezePlaywrightFallbackPools(proposal, ctx.requirement.research_goal),
            ctx.requirement.comparison_dimensions,
            explicitWeights,
          ),
          activated_nodes,
        };
      });
      const proposalEnvelope = {
        candidates: candidates.map(({ activated_nodes: _activatedNodes, ...candidate }) => candidate),
      };
      validator.validateSchemaOrThrow(
        currentPlanProposalSchema,
        proposalEnvelope,
        'current-plan-candidates',
      );
      const recommendedProfileId = planningGuidance.profiles.find(({ recommended }) => recommended)?.id;
      const writtenCandidates = candidates.map((candidate): CurrentPlanCandidateProposal => ({
        ...candidate,
        recommended: candidate.id === recommendedProfileId,
      }));
      ctx.emit({
        phase: 'candidates',
        status: 'done',
        label: '生成候选方案',
        detail: `直呼 ${ctx.direct.skillName}`,
      });
      return {
        activated,
        decisionStates,
        candidates: writtenCandidates,
        planProvenance: ctx.taskProvenance,
        guidanceSources,
        problemGraph: problemGraphResult.graph,
        problemGraphProvenance: problemGraphResult.provenance,
        capabilityResolution,
        planningProvenance: planningGuidance.planning_provenance,
      };
    }

    const eligibleToolIds = new Set(capabilityResolution.eligible.flatMap((decision) => [
      ...decision.skill.required_tools,
      ...decision.optional_tool_decisions
        .filter(({ status }) => status === 'available')
        .map(({ tool_id }) => tool_id),
    ]));
    const candidateTools = registeredTools
      .filter((tool) => eligibleToolIds.has(tool.id))
      .map((tool) => {
        const manifest = manifestById.get(tool.id)!;
        return {
          id: tool.id,
          name: tool.name,
          tier: tool.tier ?? 'optional',
          input_schema: loadToolInputSchema(manifest.input_schema),
        };
      });
    const requestedProfiles = planningGuidance.profiles;
    const requestedProfileIds = requestedProfiles.map(({ id }) => id);
    const proposalSchema = currentPlanProposalSchemaFor(requestedProfileIds);
    const candidateContext = {
      task: ctx.task,
      requirement: ctx.requirement,
      planning_input: ctx.originalInput ?? ctx.requirement.research_goal,
      problem_graph: problemGraphResult.graph,
      capability_resolution: capabilityResolution,
      profile_specs: requestedProfiles,
      skills: capabilityResolution.eligible.map((decision) => ({
        id: decision.skill.id,
        when_to_use: decision.skill.when_to_use,
        inputs: decision.skill.inputs,
        outputs: decision.skill.outputs,
        output_root: '/payload',
        required_tools: decision.skill.required_tools,
        optional_tools: decision.optional_tool_decisions,
        pending_inputs: decision.pending_inputs,
      })),
      tools: candidateTools,
      guidance: guidanceSources,
      evidence_requirements: evidenceRequirements,
    };
    ctx.emit({ phase: 'candidates', status: 'start', label: '生成候选方案' });
    type CandidateEnvelope = {
      candidates: Array<Omit<CurrentPlanCandidateProposal, 'activated_nodes'>>;
    };
    const generateCandidates = (
      profiles: readonly ResolvedProfileSpec[],
      validationFeedback: string[] = [],
      passingProfileIds: readonly string[] = [],
    ) => {
      const context = validationFeedback.length > 0
        ? {
            ...candidateContext,
            profile_specs: profiles,
            passing_profile_ids_preserved: [...passingProfileIds],
            failed_profile_ids_to_replace: profiles.map(({ id }) => id),
            validation_feedback: validationFeedback,
          }
        : candidateContext;
      const profileSummary = profiles.map(({ id, max_steps }) => `${id}(max ${max_steps})`).join(', ');
      return llm.generateStructured<CandidateEnvelope>({
        prompt:
        `基于 finalized ResearchTaskV2、ProblemGraph、Evidence Policy、eligible capability shortlist 与精确 ProfileSpec 填充候选。` +
        `只能按顺序返回 [${profiles.map(({ id }) => id).join(', ')}]，不得新增、删除、重排 Profile，也不得生成 recommended；步骤预算为 ${profileSummary}。` +
        (profiles.length === 2 && profiles[0]?.id === 'depth' && profiles[1]?.id === 'speed'
          ? `depth 总步数不得超过 ${ROUTED_STEP_LIMITS.depth}，speed 总步数不得超过 ${ROUTED_STEP_LIMITS.speed}；`
          : '') +
        `每个 step 必须精确包含 step_no、step_name、actor_type、actor_id、question_ids、depends_on、input、input_bindings、expected_outputs、acceptance_criteria、requires_approval、fallback_actor_ids。` +
        `ProblemGraph 中每个 question.id 必须至少出现在一个 step.question_ids 中；提交前逐项核对，禁止遗留 orphan_required_question。` +
        `input_bindings[].target_pointer 是相对当前 step.input 的 JSON Pointer，目标槽必须预先存在于 step.input；例如 step.input.public_sources 必须写 /public_sources，禁止写 /input/public_sources。` +
        `input_bindings[].source_step_no 只能引用真实且更早的 step_no，必须 >= 1；禁止把 planning_input 虚构成第 0 步。需要 research_goal 时，直接把 context.planning_input 文本写入 step.input.research_goal，不要为它创建 binding。` +
        `LLM step 的唯一运行时输出指针是 /text，reviewer step 的唯一运行时输出指针是 /review；后续绑定必须使用这两个真实指针，不得为它们虚构结构化输出字段。` +
        `fallback_actor_ids 必须为空数组，当前执行器不支持 fallback 调度。` +
        `Skill step 的 expected_outputs 及后续 binding source_pointer 必须位于统一输出根 /payload 下。` +
        `Skill 的 required_tools 必须作为更早的 Tool step；所有引用必须真实存在；不得使用 capability_resolution.rejected 中的 actor。` +
        `available optional Tool 也必须作为更早步骤；playwright-page-capture 必须晚于 tavily-web-search、早于对应 Skill，step.input.pages 预置为空数组，只能通过 {target_pointer:"/pages",source_step_no:<Tavily step>,source_pointer:"/results"} 绑定来源，禁止手写 URL。` +
        `playwright-page-capture 必须显式设置 capture.max_pages 且 capture.unique_hostnames=true；其上游 Tavily step 的 query 会按 research_goal 与 capture.max_pages 冻结为有序、唯一的字符串数组（max_pages=1 时仍为2项，最多6项），max_results 固定为 capture.max_pages 的两倍（当前六页上限下最多12），用于页面失败后的备用候选。` +
        `Registry optional Tool 不得作为 input_bindings 的 source；下游 Skill 只需在 depends_on 中依赖该 Tool，运行时会通过 prior_outputs 提供其输出。` +
        `requirement.comparison_dimensions 存在时，competitive-web-research Skill step 必须在 input.dimensions 中逐项保序，并写入同 key 顺序的 scoring_weights；用户未指定权重时各维等权且总和为 1。comparison_dimensions 不存在时不得自行补造维度或权重。` +
        (validationFeedback.length > 0
          ? `这是唯一一次合并纠错调用，只返回 failed_profile_ids_to_replace，绝不重写 passing_profile_ids_preserved：${validationFeedback.join('；')}。`
          : ''),
        schema: currentPlanProposalSchemaFor(profiles.map(({ id }) => id)),
        schemaName: 'current-plan-candidates',
        context,
        receipt: {
          stage: 'planning',
          contextManifestHash: hashPrompt('', candidateContext),
          expectedModel: this.deps.expectedActualModel ?? llm.identity.requestedModel,
        },
      });
    };
    const freezeEnvelope = (envelope: CandidateEnvelope): CandidateEnvelope => (
      freezeCompetitiveScoringWeightEnvelope({
        ...envelope,
        researchGoal: ctx.requirement.research_goal,
        fallbackDimensions: ctx.requirement.comparison_dimensions,
        explicitWeights,
      })
    );
    const candidateValidationFeedback = (envelope: CandidateEnvelope): string[] => {
      const feedback = routedCandidateValidationFeedback({
        candidates: envelope.candidates,
        profileSpecs: requestedProfiles,
        planningProvenance: planningGuidance.planning_provenance,
        task: ctx.requirement,
        problemGraph: problemGraphResult.graph,
        problemGraphProvenance: problemGraphResult.provenance,
        capabilityResolution,
        evidenceRequirements,
        activatedNodes: activatedNodeKeys,
      });
      if (requestedProfileIds.length > 2) {
        const fingerprints = new Map<string, string>();
        for (const candidate of envelope.candidates) {
          const fingerprint = JSON.stringify(candidate.steps.map((step) => ({
            actor_type: step.actor_type,
            actor_id: step.actor_id,
            question_ids: step.question_ids,
            input: step.input,
            input_bindings: step.input_bindings,
            expected_outputs: step.expected_outputs,
            acceptance_criteria: step.acceptance_criteria,
          })));
          const existing = fingerprints.get(fingerprint);
          if (existing) {
            const duplicateProfiles = [existing, candidate.id];
            for (const profileId of duplicateProfiles) {
              const spec = requestedProfiles.find(({ id }) => id === profileId);
              feedback.push(
                `${profileId}: profile_difference_missing: ${spec?.required_difference_dimensions.join(',') ?? 'unknown'}`,
              );
            }
          } else {
            fingerprints.set(fingerprint, candidate.id);
          }
        }
      }
      return [...new Set(feedback)];
    };

    let planGen = await generateCandidates(requestedProfiles);
    let candidateEnvelope = planGen.data;
    let validationFeedback: string[];
    try {
      validationFeedback = recoverableCandidateSchemaFeedback(validator, proposalSchema, planGen.data);
    } catch (error) {
      if (!(error instanceof SchemaValidationError) || requestedProfileIds.length === 2) throw error;
      validationFeedback = error.errors.map((issue) => `candidate schema: ${issue}`);
    }
    if (validationFeedback.length === 0) {
      candidateEnvelope = freezeEnvelope(planGen.data);
      validator.validateSchemaOrThrow(proposalSchema, candidateEnvelope, 'current-plan-candidates');
      validationFeedback = candidateValidationFeedback(candidateEnvelope);
    }

    if (validationFeedback.length > 0) {
      const failedIds = requestedProfileIds.filter((profileId) => (
        validationFeedback.some((issue) => issue.startsWith(`${profileId}:`))
      ));
      const idsToRepair = failedIds.length > 0 ? failedIds : requestedProfileIds;
      const failedProfiles = requestedProfiles.filter(({ id }) => idsToRepair.includes(id));
      const passingCandidates = candidateEnvelope.candidates.filter(({ id }) => !idsToRepair.includes(id));
      planGen = await generateCandidates(
        failedProfiles,
        validationFeedback,
        passingCandidates.map(({ id }) => id),
      );
      const repairSchema = currentPlanProposalSchemaFor(idsToRepair);
      validator.validateSchemaOrThrow(repairSchema, planGen.data, 'current-plan-candidates');
      const repairedEnvelope = freezeEnvelope(planGen.data);
      validator.validateSchemaOrThrow(repairSchema, repairedEnvelope, 'current-plan-candidates');
      const repairedById = new Map(repairedEnvelope.candidates.map((candidate) => [candidate.id, candidate]));
      candidateEnvelope = {
        candidates: requestedProfileIds.map((profileId) => (
          repairedById.get(profileId)
          ?? passingCandidates.find(({ id }) => id === profileId)
        )).filter((candidate): candidate is Omit<CurrentPlanCandidateProposal, 'activated_nodes'> => candidate !== undefined),
      };
      validationFeedback = candidateValidationFeedback(candidateEnvelope);
    }

    const failingProfileIds = new Set(requestedProfileIds.filter((profileId) => (
      validationFeedback.some((issue) => issue.startsWith(`${profileId}:`))
    )));
    if (failingProfileIds.has('speed') || failingProfileIds.has('depth')) {
      throw new Error(`Current plan candidates failed candidate validation repair: ${validationFeedback.join('; ')}`);
    }
    const droppedSpecialtyIds = requestedProfileIds.filter((profileId) => (
      profileId !== 'speed' && profileId !== 'depth' && failingProfileIds.has(profileId)
    ));
    candidateEnvelope = {
      candidates: candidateEnvelope.candidates.filter(({ id }) => !droppedSpecialtyIds.includes(id)),
    };
    if (candidateEnvelope.candidates.length < 2) {
      throw new Error(`Current plan candidates failed candidate validation repair: ${validationFeedback.join('; ')}`);
    }

    const planningProvenance: PlanningProvenance = structuredClone(planningGuidance.planning_provenance);
    planningProvenance.selected_profile_ids = candidateEnvelope.candidates.map(({ id }) => id);
    for (const profileId of droppedSpecialtyIds) {
      planningProvenance.degradations.push({
        code: 'specialty_candidate_validation_failed',
        profile_id: profileId,
      });
    }
    const resolverRecommendedId = requestedProfiles.find(({ recommended }) => recommended)?.id;
    const recommendedId = candidateEnvelope.candidates.some(({ id }) => id === resolverRecommendedId)
      ? resolverRecommendedId
      : 'depth';
    const candidates: CurrentPlanCandidateProposal[] = candidateEnvelope.candidates.map((candidate) => ({
      ...candidate,
      recommended: candidate.id === recommendedId,
      activated_nodes: activatedNodeKeys,
    }));
    const planProvenance: PlanProvenance = {
      modelName: planGen.modelName,
      modelVersion: planGen.modelVersion,
      promptHash: planGen.promptHash,
      traceId: planGen.traceId,
    };
    ctx.emit({
      phase: 'candidates',
      status: 'done',
      label: '生成候选方案',
      detail: `${candidates.length} 份 · ${candidates.map((candidate) => candidate.id).join(' / ')}`,
    });
    return {
      activated,
      decisionStates,
      candidates,
      planProvenance,
      guidanceSources,
      problemGraph: problemGraphResult.graph,
      problemGraphProvenance: problemGraphResult.provenance,
      capabilityResolution,
      planningProvenance,
    };
  }
}

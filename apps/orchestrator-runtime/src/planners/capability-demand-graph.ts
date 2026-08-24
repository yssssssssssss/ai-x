import type {
  CapabilityDemandGraphV1,
  ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import type {
  EvidenceClass,
  ProblemGraph,
  ResearchQuestion,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';

export type { CapabilityDemand, CapabilityDemandGraphV1, ContributionType } from '../../../../packages/api-contract/plan.ts';

export type CapabilityDemandGraphValidationKind =
  | 'duplicate_demand_id'
  | 'unknown_question'
  | 'unrequested_artifact'
  | 'unsupported_question_evidence'
  | 'required_question_without_demand'
  | 'requested_artifact_without_demand'
  | 'missing_virtual_user_demand'
  | 'quantitative_fact_without_data';

export class CapabilityDemandGraphValidationError extends Error {
  constructor(
    public readonly kind: CapabilityDemandGraphValidationKind,
    public readonly issueIds: string[],
  ) {
    super(`capability demand graph ${kind}: ${[...new Set(issueIds)].join(', ')}`);
    this.name = 'CapabilityDemandGraphValidationError';
    this.issueIds = [...new Set(issueIds)];
  }
}

function demandError(kind: CapabilityDemandGraphValidationKind, issueIds: string[]): never {
  throw new CapabilityDemandGraphValidationError(kind, issueIds);
}

function taskRequestsVirtualUsers(task: ResearchTaskV2): boolean {
  const requirementText = [
    task.research_goal,
    ...task.scope,
    ...task.constraints.map(({ statement }) => statement),
    ...task.success_criteria.map(({ statement }) => statement),
    ...task.expected_deliverables,
  ].join('\n');
  return /(?:虚拟|合成|模拟|AI)用户|synthetic\s+(?:user|participant)|virtual\s+(?:user|participant)/iu.test(requirementText);
}

const QUANTITATIVE_FACT_TYPES = new Set([
  'metrics',
  'funnel',
  'feature_adoption',
  'satisfaction',
]);
const QUANTITATIVE_TERM = /(?:\b(?:gmv|uv|pv|conversion|retention|revenue|ctr|cvr)\b|市场规模|成交额|转化率|留存率|复购率|渗透率|点击率)/iu;
const FACTUAL_QUESTION = /(?:当前|现有|实际|准确|具体|是多少|达到多少|分别为|current|actual|exact|how\s+many|what\s+is)/iu;
const MEASUREMENT_QUESTION = /(?:如何|怎样|定义|口径|测量|监测|验证|估算|计划|方案|hypothesis|estimate|measure|measurement|validate|instrument)/iu;
const DATA_INPUT_ROLE = /(?:data|dataset|analytics|metric|event|telemetry|数据|埋点|日志|指标)/iu;

function isQuantitativeFactQuestion(question: ResearchQuestion): boolean {
  return QUANTITATIVE_TERM.test(question.statement)
    && FACTUAL_QUESTION.test(question.statement)
    && !MEASUREMENT_QUESTION.test(question.statement);
}

function acceptedEvidenceClasses(question: ResearchQuestion): Set<EvidenceClass> {
  return new Set(question.evidence_requirements.flatMap(({ acceptedClasses }) => acceptedClasses));
}

const QUESTION_DEMAND_RULES: ReadonlyArray<{
  type: CapabilityDemandGraphV1['demands'][number]['type'];
  pattern: RegExp;
}> = [
  { type: 'accessibility', pattern: /(?:accessibility|a11y|无障碍|读屏|wcag)/iu },
  { type: 'design_audit', pattern: /(?:heuristic|usability\s+inspection|设计走查|启发式|可用性问题)/iu },
  { type: 'funnel', pattern: /(?:funnel|漏斗|分步转化|流失环节)/iu },
  { type: 'feature_adoption', pattern: /(?:feature\s+adoption|功能采纳|功能留存)/iu },
  { type: 'satisfaction', pattern: /(?:satisfaction|\bnps\b|\bnss\b|满意度)/iu },
  { type: 'metrics', pattern: /(?:metric|measure|\buv\b|\bgmv\b|转化率|留存率|指标|度量)/iu },
  { type: 'persona', pattern: /(?:persona|人物角色|用户画像|用户分层|用户分型)/iu },
  { type: 'jobs_to_be_done', pattern: /(?:\bjtbd\b|jobs?\s+to\s+be\s+done|访问动机|核心动机|雇佣|用户任务)/iu },
  { type: 'journey', pattern: /(?:journey|用户旅程|体验地图|端到端链路|触点)/iu },
  { type: 'voc', pattern: /(?:\bvoc\b|用户之声|差评|用户反馈|工单)/iu },
  { type: 'competitive_analysis', pattern: /(?:competitive|competitor|竞品|竞争对手|对标)/iu },
  { type: 'market_landscape', pattern: /(?:market|市场|赛道|行业格局)/iu },
  { type: 'prioritization', pattern: /(?:priority|prioritization|优先级|先做|排序)/iu },
  { type: 'research_method', pattern: /(?:research\s+plan|method|研究方案|调研方案|研究方法)/iu },
];

function defaultDemandType(task: ResearchTaskV2): CapabilityDemandGraphV1['demands'][number]['type'] {
  if (task.task_type === 'competitive_research') return 'competitive_analysis';
  if (task.task_type === 'design_audit') return 'design_audit';
  if (task.task_type === 'a11y_audit') return 'accessibility';
  if (task.task_type === 'voc_diagnosis') return 'voc';
  if (task.task_type === 'user_research_planning') return 'research_method';
  return 'qualitative_insight';
}

function demandTypeForQuestion(
  task: ResearchTaskV2,
  question: ResearchQuestion,
): CapabilityDemandGraphV1['demands'][number]['type'] {
  const text = [question.statement, question.rationale, ...question.acceptance_criteria].join(' ');
  return QUESTION_DEMAND_RULES.find(({ pattern }) => pattern.test(text))?.type
    ?? defaultDemandType(task);
}

/** Deterministic fallback used until a model-suggested graph passes the same validator. */
export function deriveCapabilityDemandGraph(
  task: ResearchTaskV2,
  problemGraph: ProblemGraph,
): CapabilityDemandGraphV1 {
  const demands: CapabilityDemandGraphV1['demands'] = problemGraph.questions.map((question) => {
    const type = demandTypeForQuestion(task, question);
    const requiredEvidenceClasses = [...acceptedEvidenceClasses(question)];
    return {
      id: `demand:${type}:${question.id}`,
      type,
      questionIds: [question.id],
      requestedArtifactTypes: [],
      requiredEvidenceClasses,
      requiredInputRoles: [
        'research_goal',
        ...(type === 'metrics' && isQuantitativeFactQuestion(question) ? ['analytics_dataset'] : []),
      ],
      priority: question.priority,
    };
  });

  const firstRequired = demands.find(({ priority }) => priority === 'required') ?? demands[0];
  if (firstRequired) firstRequired.requestedArtifactTypes = [...(task.requested_artifacts ?? [])];

  if (taskRequestsVirtualUsers(task)) {
    const targetQuestion = problemGraph.questions.find(({ statement }) => (
      /(?:用户|动机|persona|jtbd|user|motivation)/iu.test(statement)
    )) ?? problemGraph.questions.find(({ priority }) => priority === 'required') ?? problemGraph.questions[0];
    if (targetQuestion) {
      demands.push({
        id: `demand:virtual_user_hypothesis:${targetQuestion.id}`,
        type: 'virtual_user_hypothesis',
        questionIds: [targetQuestion.id],
        requestedArtifactTypes: [],
        requiredEvidenceClasses: ['simulation'],
        requiredInputRoles: ['research_goal'],
        priority: 'required',
      });
    }
  }
  return { version: 'capability-demand-graph-v1', demands };
}

export interface ValidateCapabilityDemandGraphInput {
  task: ResearchTaskV2;
  problemGraph: ProblemGraph;
  graph: CapabilityDemandGraphV1;
  availableInputRoles?: readonly string[];
  validator?: SchemaValidator;
}

/**
 * Validates the planning seam between a finalized ProblemGraph and capability
 * selection. It does not select Skills; it guarantees that a resolver receives
 * a closed, auditable set of obligations.
 */
export function validateCapabilityDemandGraph(input: ValidateCapabilityDemandGraphInput): void {
  (input.validator ?? new SchemaValidator()).validateOrThrow('capability-demand-graph-v1', input.graph);

  const questionsById = new Map(input.problemGraph.questions.map((question) => [question.id, question]));
  const requestedArtifacts = new Set(input.task.requested_artifacts ?? []);
  const demandIds = new Set<string>();

  for (const demand of input.graph.demands) {
    if (demandIds.has(demand.id)) demandError('duplicate_demand_id', [demand.id]);
    demandIds.add(demand.id);

    const referencedQuestions: ResearchQuestion[] = [];
    for (const questionId of demand.questionIds) {
      const question = questionsById.get(questionId);
      if (!question) demandError('unknown_question', [demand.id, questionId]);
      referencedQuestions.push(question);
    }

    for (const artifact of demand.requestedArtifactTypes) {
      if (!requestedArtifacts.has(artifact)) {
        demandError('unrequested_artifact', [demand.id, artifact]);
      }
    }

    for (const evidenceClass of demand.requiredEvidenceClasses) {
      if (!referencedQuestions.some((question) => acceptedEvidenceClasses(question).has(evidenceClass))) {
        demandError('unsupported_question_evidence', [
          demand.id,
          ...demand.questionIds,
          evidenceClass,
        ]);
      }
    }
  }

  for (const question of input.problemGraph.questions) {
    if (
      question.priority === 'required'
      && !input.graph.demands.some((demand) => (
        demand.priority === 'required' && demand.questionIds.includes(question.id)
      ))
    ) {
      demandError('required_question_without_demand', [question.id]);
    }
  }

  for (const artifact of requestedArtifacts) {
    if (!input.graph.demands.some((demand) => (
      demand.priority === 'required' && demand.requestedArtifactTypes.includes(artifact)
    ))) {
      demandError('requested_artifact_without_demand', [artifact]);
    }
  }

  if (
    taskRequestsVirtualUsers(input.task)
    && !input.graph.demands.some(({ type, priority }) => (
      type === 'virtual_user_hypothesis' && priority === 'required'
    ))
  ) {
    demandError('missing_virtual_user_demand', ['virtual_user_hypothesis']);
  }

  if (
    input.availableInputRoles !== undefined
    && !input.availableInputRoles.some((role) => DATA_INPUT_ROLE.test(role))
  ) {
    for (const demand of input.graph.demands) {
      if (!QUANTITATIVE_FACT_TYPES.has(demand.type)) continue;
      const quantitativeQuestion = demand.questionIds
        .map((questionId) => questionsById.get(questionId))
        .find((question): question is ResearchQuestion => Boolean(question && isQuantitativeFactQuestion(question)));
      if (quantitativeQuestion) {
        demandError('quantitative_fact_without_data', [demand.id, quantitativeQuestion.id]);
      }
    }
  }
}

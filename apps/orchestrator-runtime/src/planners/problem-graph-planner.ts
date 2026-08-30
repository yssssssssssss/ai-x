import type {
  EvidenceRequirement,
  ProblemGraph,
  ProblemGraphProvenance,
  ResearchQuestion,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { GuidanceRef, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { LLMClient } from '../runtime/llm-client.ts';
import { hashPrompt } from '../runtime/llm-client.ts';
import { MissingModelReceiptError } from '../runtime/receipt-llm-client.ts';
import { loadSchemaText, resolveSchema } from '../runtime/schema-registry.ts';
import type { SchemaValidator } from '../schema/validator.ts';

export type { ProblemGraph, ProblemGraphProvenance, ResearchQuestion };

export interface ProblemGraphResult {
  graph: ProblemGraph;
  provenance: ProblemGraphProvenance;
}

export type ProblemGraphValidationKind =
  | 'duplicate_question_id'
  | 'unknown_dependency'
  | 'dependency_cycle'
  | 'required_question_without_success_criterion'
  | 'unknown_success_criterion'
  | 'uncovered_success_criterion'
  | 'required_question_without_required_evidence'
  | 'missing_required_evidence';

export class ProblemGraphValidationError extends Error {
  constructor(
    public readonly kind: ProblemGraphValidationKind,
    public readonly issueIds: string[],
  ) {
    super(`problem graph ${kind}: ${issueIds.join(', ')}`);
    this.name = 'ProblemGraphValidationError';
  }
}

function throwGraphError(kind: ProblemGraphValidationKind, issueIds: string[]): never {
  throw new ProblemGraphValidationError(kind, [...new Set(issueIds)]);
}

function validateQuestionIds(graph: ProblemGraph): Map<string, ResearchQuestion> {
  const byId = new Map<string, ResearchQuestion>();
  for (const question of graph.questions) {
    if (byId.has(question.id)) {
      throwGraphError('duplicate_question_id', [question.id]);
    }
    byId.set(question.id, question);
  }
  return byId;
}

function validateDependencies(
  graph: ProblemGraph,
  questionsById: ReadonlyMap<string, ResearchQuestion>,
): void {
  for (const question of graph.questions) {
    for (const dependencyId of question.depends_on) {
      if (!questionsById.has(dependencyId)) {
        throwGraphError('unknown_dependency', [question.id, dependencyId]);
      }
    }
  }

  const complete = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];

  const visit = (questionId: string): void => {
    if (complete.has(questionId)) return;
    const cycleStart = active.get(questionId);
    if (cycleStart !== undefined) {
      throwGraphError('dependency_cycle', path.slice(cycleStart));
    }

    active.set(questionId, path.length);
    path.push(questionId);
    const question = questionsById.get(questionId);
    if (!question) return;
    for (const dependencyId of question.depends_on) visit(dependencyId);
    path.pop();
    active.delete(questionId);
    complete.add(questionId);
  };

  for (const question of graph.questions) visit(question.id);
}

function validateSuccessCriteria(task: ResearchTaskV2, graph: ProblemGraph): void {
  const criterionIds = new Set(task.success_criteria.map((criterion) => criterion.id));
  const covered = new Set<string>();

  for (const question of graph.questions) {
    if (question.priority === 'required' && question.success_criterion_ids.length === 0) {
      throwGraphError('required_question_without_success_criterion', [question.id]);
    }
    for (const criterionId of question.success_criterion_ids) {
      if (!criterionIds.has(criterionId)) {
        throwGraphError('unknown_success_criterion', [question.id, criterionId]);
      }
      if (question.priority === 'required') covered.add(criterionId);
    }
  }

  for (const criterion of task.success_criteria) {
    if (!covered.has(criterion.id)) {
      throwGraphError('uncovered_success_criterion', [criterion.id]);
    }
  }
}

function validateRequiredEvidence(graph: ProblemGraph): void {
  for (const question of graph.questions) {
    if (
      question.priority === 'required'
      && !question.evidence_requirements.some((requirement) => requirement.required)
    ) {
      throwGraphError('required_question_without_required_evidence', [question.id]);
    }
  }
}

function evidenceMatches(actual: EvidenceRequirement, required: EvidenceRequirement): boolean {
  if (
    actual.id !== required.id
    || !actual.required
    || actual.minimumCount < required.minimumCount
    || actual.acceptedClasses.length !== required.acceptedClasses.length
  ) return false;
  const actualClasses = new Set(actual.acceptedClasses);
  return required.acceptedClasses.every((evidenceClass) => actualClasses.has(evidenceClass));
}

export function validateProblemGraphEvidenceCoverage(
  graph: ProblemGraph,
  evidenceRequirements: readonly EvidenceRequirement[],
): void {
  for (const requirement of evidenceRequirements) {
    if (!requirement.required) continue;
    const covered = graph.questions.some((question) => (
      question.priority === 'required'
      && question.evidence_requirements.some((actual) => evidenceMatches(actual, requirement))
    ));
    if (!covered) throwGraphError('missing_required_evidence', [requirement.id]);
  }
}

export function validateProblemGraphCoverage(task: ResearchTaskV2, graph: ProblemGraph): void {
  const questionsById = validateQuestionIds(graph);
  validateDependencies(graph, questionsById);
  validateSuccessCriteria(task, graph);
  validateRequiredEvidence(graph);
}

export interface ProblemGraphPlannerDependencies {
  llm: LLMClient;
  validator: SchemaValidator;
  guidance: GuidanceRef[];
  evidenceRequirements: EvidenceRequirement[];
  expectedActualModel?: string;
}

const schemaText = loadSchemaText(resolveSchema('problem-graph'));
if (!schemaText) throw new Error('problem-graph schema is not registered');
const problemGraphSchema = JSON.parse(schemaText) as object;

const PROBLEM_GRAPH_PROMPT = `Build a ProblemGraph for the finalized research task. Organize the work as questions, not tool calls. Every question must reference only supplied success criteria and dependencies. Required questions must include required evidence from the supplied Evidence Policy. Every required Evidence Policy requirement id must appear on at least one required question with matching accepted classes and minimum count. For task_type=research_synthesis, questions must ask what is true, why it matters, what to do, and what remains provisional; every required acceptance criteria set must demand a direct answer, Evidence or an explicit provisional status, confidence, business implication, and recommended action. Every requested_artifacts value must appear verbatim in the acceptance criteria of at least one required question. Requested artifacts are deliverable constraints, not research subjects: do not create a standalone report-format or packaging question; attach requested_artifacts to relevant business-question acceptance criteria. Do not replace an answer with a proposal for future research.`;
const ANSWER_ARTIFACT_MARKERS: Partial<Record<NonNullable<ResearchTaskV2['requested_artifacts']>[number], readonly string[]>> = {
  strategy_map: ['strategy_map', '策略地图'],
  mind_model: ['mind_model', '心智模型'],
  design_principles: ['design_principles', '设计原则'],
  opportunity_backlog: ['opportunity_backlog', '机会点'],
  prioritized_actions: ['prioritized_actions', '优先行动'],
  channel_strategies: ['channel_strategies', '渠道策略', '场域策略'],
  action_plan: ['action_plan', '行动计划'],
};
const ANSWER_PLANNING_QUESTION_PATTERNS = [
  /如何(?:构建|开展|设计|规划|制定).{0,8}(?:研究|调研)/u,
  /(?:制定|规划|设计|构建).{0,8}(?:研究|调研)(?:方案|框架|方法|计划)/u,
  /(?:研究|调研)(?:方案|框架|方法|计划).{0,8}(?:如何|怎么|怎样)/u,
  /\bhow\s+(?:should\s+we\s+|do\s+we\s+|to\s+)?(?:conduct|run|design|plan|structure)\s+(?:the\s+)?(?:research|study)\b/iu,
  /\b(?:create|design|plan|build)\s+(?:a\s+)?(?:research|study)\s+(?:plan|framework|methodology|protocol)\b/iu,
] as const;

const ANSWER_ACCEPTANCE_MARKERS = [
  ['直接答案', '答案', '回答', '结论', 'direct answer', 'answer', 'response', 'conclusion'],
  ['证据', '依据', '来源', 'evidence', 'source', 'citation', 'support'],
  ['置信度', 'confidence', 'certainty'],
  ['业务含义', '业务影响', '决策含义', 'business implication', 'business impact', 'decision implication'],
  ['行动', 'action', 'next step', 'recommendation'],
] as const;

export function isPlanningQuestionForAnswerTask(statement: string): boolean {
  return ANSWER_PLANNING_QUESTION_PATTERNS.some((pattern) => pattern.test(statement));
}

function normalizeAnswerGraph(task: ResearchTaskV2, graph: ProblemGraph): ProblemGraph {
  if (task.task_type !== 'research_synthesis') return graph;
  const normalized = structuredClone(graph);
  const requiredQuestions = normalized.questions.filter(({ priority }) => priority === 'required');
  for (const question of requiredQuestions) {
    const acceptance = question.acceptance_criteria.join(' ').toLocaleLowerCase('en-US');
    if (ANSWER_ACCEPTANCE_MARKERS.some((markers) => !markers.some((marker) => acceptance.includes(marker.toLocaleLowerCase('en-US'))))) {
      question.acceptance_criteria.push('Direct Answer / 直接答案；Evidence / 证据或provisional状态；Confidence / 置信度；Business Implication / 业务含义；Action / 行动');
    }
  }
  const firstRequired = requiredQuestions[0];
  if (firstRequired) {
    let acceptance = requiredQuestions.flatMap(({ acceptance_criteria }) => acceptance_criteria).join(' ');
    for (const artifact of task.requested_artifacts ?? []) {
      const markers = ANSWER_ARTIFACT_MARKERS[artifact];
      if (markers && !markers.some((marker) => acceptance.includes(marker))) {
        const criterion = `Requested Artifact: ${artifact}`;
        firstRequired.acceptance_criteria.push(criterion);
        acceptance += ` ${criterion}`;
      }
    }
  }
  return normalized;
}

const MAX_GRAPH_REPAIRS = 2;
const REPAIRABLE_GRAPH_ERRORS = new Set<ProblemGraphValidationKind>([
  'uncovered_success_criterion',
  'required_question_without_required_evidence',
  'missing_required_evidence',
]);

function isRepairableGraphError(error: unknown): error is ProblemGraphValidationError {
  return error instanceof ProblemGraphValidationError
    && REPAIRABLE_GRAPH_ERRORS.has(error.kind);
}

export class ProblemGraphPlanner {
  constructor(private readonly dependencies: ProblemGraphPlannerDependencies) {}

  private validateGeneratedGraph(task: ResearchTaskV2, graph: ProblemGraph): void {
    if (task.task_type === 'research_synthesis') {
      for (const question of graph.questions.filter(({ priority }) => priority === 'required')) {
        const acceptance = question.acceptance_criteria.join(' ');
        if (isPlanningQuestionForAnswerTask(question.statement)) {
          throw new ProblemGraphValidationError('uncovered_success_criterion', [question.id, 'answer-oriented wording']);
        }
        for (const markers of ANSWER_ACCEPTANCE_MARKERS) {
          if (!markers.some((marker) => acceptance.toLocaleLowerCase('en-US').includes(marker.toLocaleLowerCase('en-US')))) {
            throw new ProblemGraphValidationError('uncovered_success_criterion', [question.id, markers[0]]);
          }
        }
      }
      const requiredAcceptance = graph.questions
        .filter(({ priority }) => priority === 'required')
        .flatMap(({ acceptance_criteria }) => acceptance_criteria)
        .join(' ');
      for (const artifact of task.requested_artifacts ?? []) {
        const markers = ANSWER_ARTIFACT_MARKERS[artifact];
        if (markers && !markers.some((marker) => requiredAcceptance.includes(marker))) {
          throw new ProblemGraphValidationError('uncovered_success_criterion', [artifact, 'requested artifact']);
        }
      }
    }
    try {
      validateProblemGraphCoverage(task, graph);
    } catch (error) {
      // Coverage omissions can be repaired against the frozen task and policy.
      // Every other structural error remains fail-closed.
      if (!isRepairableGraphError(error)) throw error;
    }
    validateProblemGraphEvidenceCoverage(graph, this.dependencies.evidenceRequirements);
    validateProblemGraphCoverage(task, graph);
  }

  async build(task: ResearchTaskV2): Promise<ProblemGraphResult> {
    const context = {
      task,
      guidance: this.dependencies.guidance,
      evidencePolicy: this.dependencies.evidenceRequirements,
    };
    const generateGraph = (validationFeedback: string[] = []) => this.dependencies.llm.generateStructured<ProblemGraph>({
      prompt: validationFeedback.length > 0
        ? `${PROBLEM_GRAPH_PROMPT} 上一次问题图未满足 ProblemGraph 覆盖约束，必须逐项修复：${validationFeedback.join('；')}`
        : PROBLEM_GRAPH_PROMPT,
      schema: problemGraphSchema,
      schemaName: 'problem-graph',
      context: validationFeedback.length > 0
        ? { ...context, validation_feedback: validationFeedback }
        : context,
      receipt: {
        stage: 'problem_graph',
        contextManifestHash: hashPrompt('', context),
        expectedModel: this.dependencies.expectedActualModel
          ?? this.dependencies.llm.identity.requestedModel,
      },
    });
    let generated = await generateGraph();

    if (!generated.receiptId) {
      throw new MissingModelReceiptError(
        new Error('problem graph generation succeeded without a persisted receipt'),
      );
    }

    generated = { ...generated, data: normalizeAnswerGraph(task, generated.data) };
    this.dependencies.validator.validateSchemaOrThrow(
      problemGraphSchema,
      generated.data,
      'problem-graph',
    );
    for (let attempt = 0; attempt < MAX_GRAPH_REPAIRS; attempt += 1) {
      try {
        this.validateGeneratedGraph(task, generated.data);
        break;
      } catch (error) {
        if (
          !isRepairableGraphError(error)
          || attempt === MAX_GRAPH_REPAIRS - 1
        ) throw error;
        generated = await generateGraph([error.message]);
        if (!generated.receiptId) {
          throw new MissingModelReceiptError(
            new Error('problem graph repair succeeded without a persisted receipt'),
          );
        }
        generated = { ...generated, data: normalizeAnswerGraph(task, generated.data) };
        this.dependencies.validator.validateSchemaOrThrow(
          problemGraphSchema,
          generated.data,
          'problem-graph',
        );
      }
    }

    if (!generated.receiptId) {
      throw new MissingModelReceiptError(
        new Error('problem graph generation finished without a persisted receipt'),
      );
    }
    return {
      graph: generated.data,
      provenance: {
        receiptId: generated.receiptId,
        modelName: generated.modelName,
        modelVersion: generated.modelVersion,
        promptHash: generated.promptHash,
        traceId: generated.traceId,
      },
    };
  }
}

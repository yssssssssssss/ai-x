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

const PROBLEM_GRAPH_PROMPT = `Build a ProblemGraph for the finalized research task. Organize the work as questions, not tool calls. Every question must reference only supplied success criteria and dependencies. Required questions must include required evidence from the supplied Evidence Policy. Every required Evidence Policy requirement id must appear on at least one required question with matching accepted classes and minimum count.`;
const MAX_EVIDENCE_COVERAGE_REPAIRS = 2;
const REPAIRABLE_EVIDENCE_ERRORS = new Set<ProblemGraphValidationKind>([
  'required_question_without_required_evidence',
  'missing_required_evidence',
]);

function isRepairableEvidenceError(error: unknown): error is ProblemGraphValidationError {
  return error instanceof ProblemGraphValidationError
    && REPAIRABLE_EVIDENCE_ERRORS.has(error.kind);
}

export class ProblemGraphPlanner {
  constructor(private readonly dependencies: ProblemGraphPlannerDependencies) {}

  private validateGeneratedGraph(task: ResearchTaskV2, graph: ProblemGraph): void {
    try {
      validateProblemGraphCoverage(task, graph);
    } catch (error) {
      // A graph with no required evidence can still be repaired against the
      // frozen policy. Preserve fail-closed behavior for every other structural
      // error and let the policy check produce the repair feedback.
      if (!isRepairableEvidenceError(error)) throw error;
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
        ? `${PROBLEM_GRAPH_PROMPT} 上一次问题图未满足 ProblemGraph 证据约束，必须逐项修复：${validationFeedback.join('；')}`
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

    this.dependencies.validator.validateSchemaOrThrow(
      problemGraphSchema,
      generated.data,
      'problem-graph',
    );
    for (let attempt = 0; attempt < MAX_EVIDENCE_COVERAGE_REPAIRS; attempt += 1) {
      try {
        this.validateGeneratedGraph(task, generated.data);
        break;
      } catch (error) {
        if (
          !isRepairableEvidenceError(error)
          || attempt === MAX_EVIDENCE_COVERAGE_REPAIRS - 1
        ) throw error;
        generated = await generateGraph([error.message]);
        if (!generated.receiptId) {
          throw new MissingModelReceiptError(
            new Error('problem graph repair succeeded without a persisted receipt'),
          );
        }
        this.dependencies.validator.validateSchemaOrThrow(
          problemGraphSchema,
          generated.data,
          'problem-graph',
        );
      }
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

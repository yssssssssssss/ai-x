import type {
  EvidenceRequirement,
  ProblemGraph,
  ResearchQuestion,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { GuidanceRef, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { LLMClient } from '../runtime/llm-client.ts';
import { hashPrompt } from '../runtime/llm-client.ts';
import { loadSchemaText, resolveSchema } from '../runtime/schema-registry.ts';
import type { SchemaValidator } from '../schema/validator.ts';

export type { ProblemGraph, ResearchQuestion };

export interface ProblemGraphProvenance {
  modelName: string;
  modelVersion: string;
  promptHash: string;
  traceId: string;
}

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
  | 'required_question_without_required_evidence';

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
      covered.add(criterionId);
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

const PROBLEM_GRAPH_PROMPT = `Build a ProblemGraph for the finalized research task. Organize the work as questions, not tool calls. Every question must reference only supplied success criteria and dependencies. Required questions must include required evidence from the supplied Evidence Policy.`;

export class ProblemGraphPlanner {
  constructor(private readonly dependencies: ProblemGraphPlannerDependencies) {}

  async build(task: ResearchTaskV2): Promise<ProblemGraphResult> {
    const context = {
      task,
      guidance: this.dependencies.guidance,
      evidencePolicy: this.dependencies.evidenceRequirements,
    };
    const generated = await this.dependencies.llm.generateStructured<ProblemGraph>({
      prompt: PROBLEM_GRAPH_PROMPT,
      schema: problemGraphSchema,
      schemaName: 'problem-graph',
      context,
      receipt: {
        stage: 'problem_graph',
        contextManifestHash: hashPrompt('', context),
        expectedModel: this.dependencies.expectedActualModel
          ?? this.dependencies.llm.identity.requestedModel,
      },
    });

    this.dependencies.validator.validateSchemaOrThrow(
      problemGraphSchema,
      generated.data,
      'problem-graph',
    );
    validateProblemGraphCoverage(task, generated.data);

    return {
      graph: generated.data,
      provenance: {
        modelName: generated.modelName,
        modelVersion: generated.modelVersion,
        promptHash: generated.promptHash,
        traceId: generated.traceId,
      },
    };
  }
}

import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentCapabilityDecisions,
  CurrentExecutionPlan,
  CurrentPlanStep,
  EvidenceRequirement,
  PendingInput,
  ProblemGraph,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { PlanCandidate, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { CapabilityResolution } from './capability-resolver.ts';
import { validateProblemGraphCoverage } from './problem-graph-planner.ts';
import { SchemaValidator } from '../schema/validator.ts';

export interface CurrentPlanCandidateProposal extends Omit<PlanCandidate, 'steps'> {
  steps: CurrentPlanStep[];
}

export interface PlanCompileInput {
  candidate: CurrentPlanCandidateProposal;
  task: ResearchTaskV2;
  problem_graph: ProblemGraph;
  capability_resolution: CapabilityResolution;
  evidence_requirements: EvidenceRequirement[];
  activated_nodes: string[];
}

export interface CompiledPlan {
  plan: Omit<CurrentExecutionPlan, 'task_id'> & { task_id: '' };
  pending_inputs: PendingInput[];
}

export type PlanCompilerValidationKind =
  | 'candidate_schema_invalid'
  | 'dependency_cycle'
  | 'unknown_dependency'
  | 'late_dependency'
  | 'orphan_required_question'
  | 'unknown_question'
  | 'required_tool_missing'
  | 'required_tool_late'
  | 'future_binding_source'
  | 'unknown_binding_source'
  | 'unknown_binding_pointer'
  | 'unknown_binding_target'
  | 'missing_core_evidence'
  | 'rejected_capability'
  | 'unknown_actor'
  | 'invalid_fallback'
  | 'capability_decisions_invalid';

export class PlanCompilerValidationError extends Error {
  constructor(
    public readonly kind: PlanCompilerValidationKind,
    public readonly issueIds: string[],
  ) {
    super(`plan compiler ${kind}: ${[...new Set(issueIds)].join(', ')}`);
    this.name = 'PlanCompilerValidationError';
  }
}

const CANDIDATE_KEYS = new Set([
  'id',
  'title',
  'rationale',
  'tradeoffs',
  'steps',
  'assumptions',
  'activated_nodes',
]);

const STEP_KEYS = new Set([
  'step_no',
  'step_name',
  'actor_type',
  'actor_id',
  'question_ids',
  'depends_on',
  'input',
  'input_bindings',
  'expected_outputs',
  'acceptance_criteria',
  'requires_approval',
  'approval_role',
  'fallback_actor_ids',
]);

function fail(kind: PlanCompilerValidationKind, ...issueIds: string[]): never {
  throw new PlanCompilerValidationError(kind, issueIds);
}


function validateProposalShape(candidate: CurrentPlanCandidateProposal): void {
  const unknownCandidateKeys = Object.keys(candidate).filter((key) => !CANDIDATE_KEYS.has(key));
  if (unknownCandidateKeys.length > 0) fail('candidate_schema_invalid', ...unknownCandidateKeys);
  if (
    (candidate.id !== 'depth' && candidate.id !== 'speed')
    || typeof candidate.title !== 'string'
    || candidate.title.length === 0
    || typeof candidate.rationale !== 'string'
    || candidate.rationale.length === 0
    || typeof candidate.tradeoffs !== 'string'
    || candidate.tradeoffs.length === 0
    || !Array.isArray(candidate.steps)
    || candidate.steps.length === 0
  ) {
    fail('candidate_schema_invalid', 'candidate');
  }

  for (const [index, rawStep] of candidate.steps.entries()) {
    const unknownStepKeys = Object.keys(rawStep).filter((key) => !STEP_KEYS.has(key));
    if (unknownStepKeys.length > 0) {
      fail('candidate_schema_invalid', `step:${index + 1}`, ...unknownStepKeys);
    }
  }
}

function copySteps(candidate: CurrentPlanCandidateProposal): CurrentPlanStep[] {
  return candidate.steps.map((step, index) => ({
    step_no: index + 1,
    step_name: step.step_name,
    actor_type: step.actor_type,
    actor_id: step.actor_id,
    question_ids: [...step.question_ids],
    depends_on: [...step.depends_on],
    input: structuredClone(step.input),
    input_bindings: step.input_bindings.map((binding) => ({ ...binding })),
    expected_outputs: step.expected_outputs.map((output) => ({ ...output })),
    acceptance_criteria: [...step.acceptance_criteria],
    requires_approval: step.requires_approval,
    ...(step.approval_role ? { approval_role: step.approval_role } : {}),
    fallback_actor_ids: [...step.fallback_actor_ids],
  }));
}

function validateStepDependencies(steps: CurrentPlanStep[]): void {
  const size = steps.length;
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!Number.isInteger(dependency) || dependency < 1 || dependency > size) {
        fail('unknown_dependency', String(step.step_no), String(dependency));
      }
    }
  }

  const complete = new Set<number>();
  const active = new Map<number, number>();
  const path: number[] = [];
  const visit = (stepNo: number): void => {
    if (complete.has(stepNo)) return;
    const cycleStart = active.get(stepNo);
    if (cycleStart !== undefined) {
      fail('dependency_cycle', ...path.slice(cycleStart).map(String));
    }
    active.set(stepNo, path.length);
    path.push(stepNo);
    for (const dependency of steps[stepNo - 1]!.depends_on) visit(dependency);
    path.pop();
    active.delete(stepNo);
    complete.add(stepNo);
  };
  for (const step of steps) visit(step.step_no);

  for (const step of steps) {
    const late = step.depends_on.find((dependency) => dependency >= step.step_no);
    if (late !== undefined) fail('late_dependency', String(step.step_no), String(late));
  }
}

function validateQuestions(steps: CurrentPlanStep[], graph: ProblemGraph): void {
  const questions = new Map(graph.questions.map((question) => [question.id, question]));
  const covered = new Set<string>();
  for (const step of steps) {
    for (const questionId of step.question_ids) {
      if (!questions.has(questionId)) fail('unknown_question', questionId, String(step.step_no));
      covered.add(questionId);
    }
  }
  for (const question of graph.questions) {
    if (question.priority === 'required' && !covered.has(question.id)) {
      fail('orphan_required_question', question.id);
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

function validateEvidencePolicy(
  graph: ProblemGraph,
  evidenceRequirements: EvidenceRequirement[],
): void {
  for (const requirement of evidenceRequirements) {
    if (!requirement.required) continue;
    const covered = graph.questions.some((question) => (
      question.priority === 'required'
      && question.evidence_requirements.some((actual) => evidenceMatches(actual, requirement))
    ));
    if (!covered) fail('missing_core_evidence', requirement.id);
  }
}

function capabilityIds(resolution: CapabilityResolution): {
  eligibleSkills: Map<string, CapabilityResolution['eligible'][number]>;
  rejectedIds: Set<string>;
  eligibleTools: Set<string>;
} {
  const eligibleSkills = new Map<string, CapabilityResolution['eligible'][number]>();
  const rejectedIds = new Set<string>();
  const eligibleTools = new Set<string>();

  for (const decision of resolution.eligible) {
    const skillId = decision.skill.id;
    if (!skillId || eligibleSkills.has(skillId) || rejectedIds.has(skillId)) {
      fail('capability_decisions_invalid', skillId ?? '(no-id)');
    }
    eligibleSkills.set(skillId, decision);
    for (const toolId of decision.skill.required_tools) eligibleTools.add(toolId);
  }
  for (const decision of resolution.rejected) {
    const skillId = decision.skill.id;
    if (!skillId || eligibleSkills.has(skillId) || rejectedIds.has(skillId)) {
      fail('capability_decisions_invalid', skillId ?? '(no-id)');
    }
    rejectedIds.add(skillId);
    for (const reason of decision.reasons) {
      if (reason.related_id && (
        reason.code.startsWith('required_tool_')
        || reason.code === 'core_tool_real_adapter_unavailable'
      )) {
        rejectedIds.add(reason.related_id);
      }
    }
  }
  return { eligibleSkills, rejectedIds, eligibleTools };
}

function validateActors(
  steps: CurrentPlanStep[],
  resolution: CapabilityResolution,
): Map<string, CapabilityResolution['eligible'][number]> {
  const { eligibleSkills, rejectedIds, eligibleTools } = capabilityIds(resolution);
  const allowedFallbacks = new Set([...eligibleSkills.keys(), ...eligibleTools]);

  for (const step of steps) {
    if (rejectedIds.has(step.actor_id)) fail('rejected_capability', step.actor_id);
    if (step.actor_type === 'skill' && !eligibleSkills.has(step.actor_id)) {
      fail('unknown_actor', step.actor_id);
    }
    if (step.actor_type === 'tool' && !eligibleTools.has(step.actor_id)) {
      fail('unknown_actor', step.actor_id);
    }
    for (const fallbackActorId of step.fallback_actor_ids) {
      if (rejectedIds.has(fallbackActorId)) fail('rejected_capability', fallbackActorId);
      if (!allowedFallbacks.has(fallbackActorId)) fail('invalid_fallback', fallbackActorId);
    }
  }
  return eligibleSkills;
}

function validateRequiredTools(
  steps: CurrentPlanStep[],
  eligibleSkills: ReadonlyMap<string, CapabilityResolution['eligible'][number]>,
): void {
  const toolSteps = new Map<string, number[]>();
  for (const step of steps) {
    if (step.actor_type !== 'tool') continue;
    const numbers = toolSteps.get(step.actor_id) ?? [];
    numbers.push(step.step_no);
    toolSteps.set(step.actor_id, numbers);
  }

  for (const step of steps) {
    if (step.actor_type !== 'skill') continue;
    const decision = eligibleSkills.get(step.actor_id)!;
    for (const toolId of decision.skill.required_tools) {
      const positions = toolSteps.get(toolId);
      if (!positions || positions.length === 0) fail('required_tool_missing', step.actor_id, toolId);
      if (!positions.some((position) => position < step.step_no)) {
        fail('required_tool_late', step.actor_id, toolId);
      }
    }
  }
}

function decodePointer(pointer: string): string[] | null {
  if (!pointer.startsWith('/')) return null;
  const parts = pointer.slice(1).split('/');
  if (parts.some((part) => /~(?!0|1)/.test(part))) return null;
  return parts.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointerExists(value: unknown, pointer: string): boolean {
  const parts = decodePointer(pointer);
  if (!parts) return false;
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part) || Number(part) >= current.length) return false;
      current = current[Number(part)];
      continue;
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return false;
    current = Reflect.get(current, part);
  }
  return true;
}

function validateBindings(steps: CurrentPlanStep[]): void {
  for (const step of steps) {
    const outputPointers = new Set<string>();
    for (const output of step.expected_outputs) {
      if (!decodePointer(output.pointer) || outputPointers.has(output.pointer)) {
        fail('unknown_binding_pointer', output.pointer, String(step.step_no));
      }
      outputPointers.add(output.pointer);
    }

    for (const binding of step.input_bindings) {
      if (binding.source_step_no >= step.step_no) {
        fail('future_binding_source', String(step.step_no), String(binding.source_step_no));
      }
      const source = steps[binding.source_step_no - 1];
      if (!source) fail('unknown_binding_source', String(step.step_no), String(binding.source_step_no));
      if (!source.expected_outputs.some((output) => output.pointer === binding.source_pointer)) {
        fail('unknown_binding_pointer', binding.source_pointer, String(binding.source_step_no));
      }
      if (!pointerExists(step.input, binding.target_pointer)) {
        fail('unknown_binding_target', binding.target_pointer, String(step.step_no));
      }
    }
  }
}

function derivePendingInputs(
  steps: CurrentPlanStep[],
  eligibleSkills: ReadonlyMap<string, CapabilityResolution['eligible'][number]>,
): PendingInput[] {
  const pendingByRole = new Map<string, PendingInput>();
  for (const step of steps) {
    if (step.actor_type !== 'skill') continue;
    const decision = eligibleSkills.get(step.actor_id)!;
    for (const pending of decision.pending_inputs) {
      let item = pendingByRole.get(pending.role);
      if (!item) {
        item = {
          role: pending.role,
          label: pending.label,
          multiple: pending.multiple,
          targets: [],
        };
        pendingByRole.set(pending.role, item);
      }
      item.targets.push({
        step_no: step.step_no,
        tool_id: step.actor_id,
        field: pending.role,
        multiple: pending.multiple,
      });
    }
  }
  return [...pendingByRole.values()];
}

export class PlanCompiler {
  constructor(private readonly validator = new SchemaValidator()) {}

  compile(input: PlanCompileInput): CompiledPlan {
    validateProposalShape(input.candidate);
    this.validator.validateOrThrow('current-execution-plan', {
      task_id: '',
      deliverable_type: 'research_plan',
      evidence_requirements: input.evidence_requirements,
      problem_graph: input.problem_graph,
      capability_decisions: input.capability_resolution,
      steps: input.candidate.steps,
      candidate_metadata: {
        title: input.candidate.title,
        rationale: input.candidate.rationale,
        tradeoffs: input.candidate.tradeoffs,
      },
      activated_nodes: input.activated_nodes,
    });
    validateProblemGraphCoverage(input.task, input.problem_graph);
    const steps = copySteps(input.candidate);
    validateStepDependencies(steps);
    validateQuestions(steps, input.problem_graph);
    validateEvidencePolicy(input.problem_graph, input.evidence_requirements);
    const eligibleSkills = validateActors(steps, input.capability_resolution);
    validateRequiredTools(steps, eligibleSkills);
    validateBindings(steps);

    const plan: CompiledPlan['plan'] = {
      task_id: '',
      deliverable_type: 'research_plan',
      evidence_requirements: structuredClone(input.evidence_requirements),
      problem_graph: structuredClone(input.problem_graph),
      capability_decisions: structuredClone(input.capability_resolution) as CurrentCapabilityDecisions,
      steps,
      candidate_metadata: {
        title: input.candidate.title,
        rationale: input.candidate.rationale,

        tradeoffs: input.candidate.tradeoffs,
      },
      activated_nodes: [...input.activated_nodes],
    };
    this.validator.validateOrThrow('current-execution-plan', plan);
    return { plan, pending_inputs: derivePendingInputs(steps, eligibleSkills) };
  }
}
export function validateCurrentPlanRevision(input: {
  plan: unknown;
  task: unknown;
  pending_inputs: unknown;
  task_id: string;
  candidate_id: 'depth' | 'speed';
}, validator = new SchemaValidator()): CurrentExecutionPlan {
  validator.validateOrThrow('research-task-v2', input.task);
  validator.validateOrThrow('current-execution-plan', input.plan);
  const task = input.task as ResearchTaskV2;
  const plan = input.plan as CurrentExecutionPlan;
  if (plan.task_id !== input.task_id) {
    fail('candidate_schema_invalid', 'task_id', plan.task_id, input.task_id);
  }
  const candidate: CurrentPlanCandidateProposal = {
    id: input.candidate_id,
    title: plan.candidate_metadata.title,
    rationale: plan.candidate_metadata.rationale,
    tradeoffs: plan.candidate_metadata.tradeoffs,
    steps: plan.steps,
    assumptions: [],
    activated_nodes: plan.activated_nodes,
  };
  const compiled = new PlanCompiler(validator).compile({
    candidate,
    task,
    problem_graph: plan.problem_graph,
    capability_resolution: plan.capability_decisions as CapabilityResolution,
    evidence_requirements: plan.evidence_requirements,
    activated_nodes: plan.activated_nodes,
  });
  if (!isDeepStrictEqual(compiled.pending_inputs, input.pending_inputs)) {
    fail('candidate_schema_invalid', 'pending_inputs_mismatch');
  }
  const recompiled: CurrentExecutionPlan = { ...compiled.plan, task_id: input.task_id };
  if (!isDeepStrictEqual(recompiled, plan)) {
    fail('candidate_schema_invalid', 'frozen_plan_mismatch');
  }
  return recompiled;
}

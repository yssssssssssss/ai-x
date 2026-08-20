import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentCapabilityApproval,
  CurrentCapabilityDecisions,
  CurrentCapabilityGap,
  CurrentExecutionPlan,
  CurrentPlanStep,
  DeliverableType,
  EvidenceRequirement,
  PendingInput,
  ProblemGraph,
  ProblemGraphProvenance,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { PlanCandidate, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { CapabilityResolution } from './capability-resolver.ts';
import { validateProblemGraphCoverage } from './problem-graph-planner.ts';
import {
  StepInputResolutionError,
  validateStepInputBindings,
} from '../control/step-input-resolver.ts';
import {
  getConfigRoot,
  loadToolManifest,
  loadToolRegistry,
  type ToolRegistryEntry,
} from '../runtime/config-loader.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { resolveCompetitiveScoringWeights } from '../report/competitive-weight-chart.ts';

export interface CurrentPlanCandidateProposal extends Omit<PlanCandidate, 'steps'> {
  steps: CurrentPlanStep[];
}

export interface FrozenDeliverableSelection {
  deliverableId: DeliverableType;
  evidenceRequirements: EvidenceRequirement[];
}

export interface PlanCompileInput {
  candidate: CurrentPlanCandidateProposal;
  task: ResearchTaskV2;
  deliverable_selection?: FrozenDeliverableSelection;
  problem_graph: ProblemGraph;
  problem_graph_provenance: ProblemGraphProvenance;
  capability_resolution: CapabilityResolution;
  evidence_requirements: EvidenceRequirement[];
  activated_nodes: string[];
  requireCompetitiveWeightContract?: boolean;
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
  | 'optional_tool_missing'
  | 'optional_tool_late'
  | 'optional_tool_binding_invalid'
  | 'visual_fallback_contract_invalid'
  | 'future_binding_source'
  | 'unknown_binding_source'
  | 'unknown_binding_pointer'
  | 'unknown_binding_target'
  | 'invalid_binding_target'
  | 'invalid_skill_output_pointer'
  | 'invalid_actor_output_pointer'
  | 'optional_binding_source'
  | 'missing_core_evidence'
  | 'rejected_capability'
  | 'unknown_actor'
  | 'invalid_fallback'
  | 'approval_required'
  | 'approval_role_mismatch'
  | 'pending_input_schema_invalid'
  | 'capability_decisions_invalid'
  | 'competitive_weight_contract_invalid';

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

const MAX_BROWSER_CAPTURE_COUNT = 6;
const MAX_BROWSER_FALLBACK_RESULTS = 20;

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

function freezeCapabilityDecisions(
  resolution: CapabilityResolution | CurrentCapabilityDecisions,
): CurrentCapabilityDecisions {
  const freezeDecision = (
    decision: CapabilityResolution['eligible'][number] | CurrentCapabilityDecisions['eligible'][number],
  ) => ({
    ...structuredClone(decision),
    skill: {
      ...structuredClone(decision.skill),
      optional_tools: [...(decision.skill.optional_tools ?? [])],
    },
    optional_tool_decisions: structuredClone(decision.optional_tool_decisions ?? []),
  });
  return {
    eligible: resolution.eligible.map(freezeDecision),
    rejected: resolution.rejected.map(freezeDecision),
  };
}

export function normalizeCurrentExecutionPlanOptionalFields(
  plan: CurrentExecutionPlan,
): CurrentExecutionPlan {
  return {
    ...structuredClone(plan),
    capability_decisions: freezeCapabilityDecisions(plan.capability_decisions),
    capability_gaps: structuredClone(plan.capability_gaps ?? []),
  };
}

function capabilityGaps(
  resolution: CapabilityResolution,
  toolsById: ReadonlyMap<string, ToolRegistryEntry>,
): CurrentCapabilityGap[] {
  const gaps: CurrentCapabilityGap[] = [];
  const seenTools = new Set<string>();
  for (const [bucket, decisions] of [
    ['eligible', resolution.eligible],
    ['rejected', resolution.rejected],
  ] as const) {
    for (const decision of decisions) {
      const optionalTools = decision.skill.optional_tools ?? [];
      if (
        new Set(optionalTools).size !== optionalTools.length
        || optionalTools.some((toolId) => decision.skill.required_tools.includes(toolId))
      ) {
        fail('capability_decisions_invalid', decision.skill.id ?? '(no-id)', 'optional_tools');
      }
      if (bucket === 'rejected' && decision.optional_tool_decisions.length > 0) {
        fail('capability_decisions_invalid', decision.skill.id ?? '(no-id)', 'rejected_optional_tool');
      }
      const localTools = new Set<string>();
      for (const optionalDecision of decision.optional_tool_decisions) {
        const toolId = optionalDecision.tool_id;
        const tool = toolsById.get(toolId);
        if (
          localTools.has(toolId)
          || seenTools.has(toolId)
          || !optionalTools.includes(toolId)
          || !tool
          || tool.tier !== 'optional'
        ) {
          fail('capability_decisions_invalid', decision.skill.id ?? '(no-id)', toolId);
        }
        localTools.add(toolId);
        seenTools.add(toolId);
        if (optionalDecision.status === 'available') {
          if (optionalDecision.reason_code !== undefined || optionalDecision.message !== undefined) {
            fail('capability_decisions_invalid', toolId, 'available_reason');
          }
          continue;
        }
        if (!optionalDecision.reason_code || !optionalDecision.message?.trim()) {
          fail('capability_decisions_invalid', toolId, 'unavailable_reason');
        }
        gaps.push({
          capability_type: 'tool',
          capability_id: toolId,
          code: optionalDecision.reason_code,
          message: optionalDecision.message,
        });
      }
    }
  }
  return gaps;
}

function capabilityIds(resolution: CapabilityResolution): {
  eligibleSkills: Map<string, CapabilityResolution['eligible'][number]>;
  rejectedIds: Set<string>;
  eligibleTools: Set<string>;
  availableOptionalTools: Set<string>;
} {
  const eligibleSkills = new Map<string, CapabilityResolution['eligible'][number]>();
  const rejectedIds = new Set<string>();
  const eligibleTools = new Set<string>();
  const availableOptionalTools = new Set<string>();

  for (const decision of resolution.eligible) {
    const skillId = decision.skill.id;
    if (!skillId || eligibleSkills.has(skillId) || rejectedIds.has(skillId)) {
      fail('capability_decisions_invalid', skillId ?? '(no-id)');
    }
    eligibleSkills.set(skillId, decision);
    for (const toolId of decision.skill.required_tools) eligibleTools.add(toolId);
    for (const optionalDecision of decision.optional_tool_decisions) {
      if (optionalDecision.status !== 'available') continue;
      eligibleTools.add(optionalDecision.tool_id);
      availableOptionalTools.add(optionalDecision.tool_id);
    }
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
  return { eligibleSkills, rejectedIds, eligibleTools, availableOptionalTools };
}

function validateActors(
  steps: CurrentPlanStep[],
  resolution: CapabilityResolution,
): Map<string, CapabilityResolution['eligible'][number]> {
  const { eligibleSkills, rejectedIds, eligibleTools } = capabilityIds(resolution);

  for (const step of steps) {
    if (rejectedIds.has(step.actor_id)) fail('rejected_capability', step.actor_id);
    if (step.actor_type === 'skill' && !eligibleSkills.has(step.actor_id)) {
      fail('unknown_actor', step.actor_id);
    }
    if (step.actor_type === 'tool' && !eligibleTools.has(step.actor_id)) {
      fail('unknown_actor', step.actor_id);
    }
    if (step.fallback_actor_ids.length > 0) {
      fail('invalid_fallback', ...step.fallback_actor_ids);
    }
  }
  return eligibleSkills;
}

function validateOptionalTools(
  steps: CurrentPlanStep[],
  eligibleSkills: ReadonlyMap<string, CapabilityResolution['eligible'][number]>,
): void {
  const toolSteps = new Map<string, CurrentPlanStep[]>();
  const ownersByTool = new Map<string, string[]>();
  for (const [skillId, decision] of eligibleSkills) {
    for (const optionalDecision of decision.optional_tool_decisions) {
      if (optionalDecision.status !== 'available') continue;
      const owners = ownersByTool.get(optionalDecision.tool_id) ?? [];
      owners.push(skillId);
      ownersByTool.set(optionalDecision.tool_id, owners);
    }
  }
  for (const step of steps) {
    if (step.actor_type !== 'tool') continue;
    const matches = toolSteps.get(step.actor_id) ?? [];
    matches.push(step);
    toolSteps.set(step.actor_id, matches);
  }

  for (const [toolId, matches] of toolSteps) {
    const owners = ownersByTool.get(toolId);
    if (!owners) continue;
    const hasOwningSkill = matches.every((toolStep) => steps.some((skillStep) => (
      skillStep.actor_type === 'skill'
      && owners.includes(skillStep.actor_id)
      && toolStep.step_no < skillStep.step_no
      && skillStep.depends_on.includes(toolStep.step_no)
    )));
    if (!hasOwningSkill) fail('optional_tool_late', toolId, 'owning_skill');
  }

  for (const skillStep of steps) {
    if (skillStep.actor_type !== 'skill') continue;
    const decision = eligibleSkills.get(skillStep.actor_id)!;
    for (const optionalDecision of decision.optional_tool_decisions) {
      if (optionalDecision.status !== 'available') continue;
      const matches = toolSteps.get(optionalDecision.tool_id) ?? [];
      if (matches.length === 0) {
        fail('optional_tool_missing', skillStep.actor_id, optionalDecision.tool_id);
      }
      const earlier = matches.filter((step) => step.step_no < skillStep.step_no);
      if (earlier.length === 0) {
        fail('optional_tool_late', skillStep.actor_id, optionalDecision.tool_id);
      }
      if (!earlier.some((step) => skillStep.depends_on.includes(step.step_no))) {
        fail('optional_tool_late', skillStep.actor_id, optionalDecision.tool_id, 'dependency');
      }
    }
  }

  for (const captureStep of toolSteps.get('playwright-page-capture') ?? []) {
    const binding = captureStep.input_bindings[0];
    const source = binding ? steps[binding.source_step_no - 1] : undefined;
    if (
      captureStep.input_bindings.length !== 1
      || !binding
      || binding.target_pointer !== '/pages'
      || binding.source_pointer !== '/results'
      || !source
      || source.actor_type !== 'tool'
      || source.actor_id !== 'tavily-web-search'
      || !captureStep.depends_on.includes(source.step_no)
      || !Array.isArray(captureStep.input.pages)
      || captureStep.input.pages.length !== 0
    ) {
      fail('optional_tool_binding_invalid', String(captureStep.step_no), captureStep.actor_id);
    }
    const capture = captureStep.input.capture;
    const maxPages = capture !== null && typeof capture === 'object' && !Array.isArray(capture)
      ? Reflect.get(capture, 'max_pages')
      : undefined;
    const uniqueHostnames = capture !== null && typeof capture === 'object' && !Array.isArray(capture)
      ? Reflect.get(capture, 'unique_hostnames')
      : undefined;
    if (
      !Number.isInteger(maxPages)
      || Number(maxPages) < 1
      || Number(maxPages) > MAX_BROWSER_CAPTURE_COUNT
    ) {
      fail(
        'visual_fallback_contract_invalid',
        String(captureStep.step_no),
        'capture.max_pages',
      );
    }
    if (uniqueHostnames !== true) {
      fail(
        'visual_fallback_contract_invalid',
        String(captureStep.step_no),
        'capture.unique_hostnames',
      );
    }
    const expectedResults = Math.min(MAX_BROWSER_FALLBACK_RESULTS, Number(maxPages) * 2);
    if (source.input.max_results !== expectedResults) {
      fail(
        'visual_fallback_contract_invalid',
        String(source.step_no),
        'tavily.max_results',
        String(expectedResults),
      );
    }
  }
}

function frozenApprovalAuthorities(
  resolution: CapabilityResolution,
): Map<string, CurrentCapabilityApproval['authority']> {
  const authorities = new Map<string, CurrentCapabilityApproval['authority']>();
  for (const decision of resolution.eligible) {
    for (const approval of decision.required_approvals) {
      const belongsToDecision = approval.capability_type === 'skill'
        ? approval.capability_id === decision.skill.id
        : decision.skill.required_tools.includes(approval.capability_id);
      if (!belongsToDecision) {
        fail('capability_decisions_invalid', approval.capability_id);
      }
      const key = `${approval.capability_type}:${approval.capability_id}`;
      const existing = authorities.get(key);
      if (existing !== undefined && existing !== approval.authority) {
        fail('capability_decisions_invalid', approval.capability_id);
      }
      authorities.set(key, approval.authority);
    }
  }
  return authorities;
}

function validateApprovals(steps: CurrentPlanStep[], resolution: CapabilityResolution): void {
  const authorities = frozenApprovalAuthorities(resolution);
  for (const step of steps) {
    const authority = step.actor_type === 'skill' || step.actor_type === 'tool'
      ? authorities.get(`${step.actor_type}:${step.actor_id}`)
      : undefined;
    if (authority === undefined) {
      if (step.requires_approval || step.approval_role !== undefined) {
        fail('approval_role_mismatch', step.actor_id);
      }
      continue;
    }
    if (!step.requires_approval) fail('approval_required', step.actor_id);
    if (step.approval_role !== authority) {
      fail('approval_role_mismatch', step.actor_id, authority);
    }
  }
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

function validateCompetitiveWeightContract(
  steps: CurrentPlanStep[],
  task: ResearchTaskV2,
): void {
  const matchingSteps = steps.filter((step) => (
    step.actor_type === 'skill' && step.actor_id === 'competitive-web-research'
  ));
  if (matchingSteps.length === 0) return;
  const step = matchingSteps[0]!;
  const stepDimensions = step.input.dimensions;
  const expectedDimensions = task.comparison_dimensions;
  if (
    expectedDimensions === undefined
    && !Object.hasOwn(step.input, 'dimensions')
    && !Object.hasOwn(step.input, 'scoring_weights')
  ) return;
  const resolution = resolveCompetitiveScoringWeights({ steps });
  if (resolution.status === 'unavailable') {
    fail('competitive_weight_contract_invalid', resolution.code);
  }
  if (expectedDimensions) {
    if (!isDeepStrictEqual(stepDimensions, expectedDimensions)) {
      fail('competitive_weight_contract_invalid', 'dimensions_mismatch');
    }
    if (!isDeepStrictEqual(Object.keys(step.input.scoring_weights as object), expectedDimensions)) {
      fail('competitive_weight_contract_invalid', 'scoring_weight_keys_mismatch');
    }
    return;
  }
  if (stepDimensions === undefined) {
    fail('competitive_weight_contract_invalid', 'dimensions_mismatch');
  }
  if (
    !Array.isArray(stepDimensions)
    || stepDimensions.length < 2
    || stepDimensions.some((dimension) => (
      typeof dimension !== 'string' || !dimension.trim() || dimension !== dimension.trim()
    ))
    || new Set(stepDimensions).size !== stepDimensions.length
    || !isDeepStrictEqual(Object.keys(step.input.scoring_weights as object), stepDimensions)
  ) {
    fail('competitive_weight_contract_invalid', 'dimensions_mismatch');
  }
}

function decodePointer(pointer: string): string[] | null {
  if (!pointer.startsWith('/')) return null;
  const parts = pointer.slice(1).split('/');
  if (parts.some((part) => /~(?!0|1)/.test(part))) return null;
  return parts.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

type TargetPointerStatus = 'valid' | 'missing' | 'array_traversal';

function targetPointerStatus(value: unknown, pointer: string): TargetPointerStatus {
  const parts = decodePointer(pointer);
  if (!parts) return 'missing';
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current)) return 'array_traversal';
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return 'missing';
    }
    current = Reflect.get(current, part);
  }
  return 'valid';
}

export function validateResolverCompatibleTargetPointers(
  step: CurrentPlanStep,
  availableSourceStepNos: readonly number[],
): void {
  try {
    validateStepInputBindings(step, availableSourceStepNos);
  } catch (error) {
    if (!(error instanceof StepInputResolutionError)) throw error;
    fail(
      'invalid_binding_target',
      ...step.input_bindings.map((binding) => binding.target_pointer),
      String(step.step_no),
    );
  }
  for (const binding of step.input_bindings) {
    const status = targetPointerStatus(step.input, binding.target_pointer);
    if (status === 'array_traversal') {
      fail('invalid_binding_target', binding.target_pointer, String(step.step_no));
    }
    if (status === 'missing') {
      const inputRelativePointer = binding.target_pointer.startsWith('/input/')
        ? binding.target_pointer.slice('/input'.length)
        : null;
      if (inputRelativePointer) {
        fail(
          'unknown_binding_target',
          binding.target_pointer,
          String(step.step_no),
          'target_pointer is relative to step.input',
          `declare ${inputRelativePointer} in step.input before binding`,
          `use ${inputRelativePointer} instead of ${binding.target_pointer}`,
        );
      }
      fail('unknown_binding_target', binding.target_pointer, String(step.step_no));
    }
  }
}

function validateBindings(
  steps: CurrentPlanStep[],
  toolsById: ReadonlyMap<string, ToolRegistryEntry>,
): void {
  const stepNos = steps.map((step) => step.step_no);
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
      if (
        source.actor_type === 'tool'
        && (toolsById.get(source.actor_id)?.tier ?? 'optional') === 'optional'
      ) {
        fail('optional_binding_source', source.actor_id, String(source.step_no));
      }
    }
    validateResolverCompatibleTargetPointers(step, stepNos);
  }
}

function validateSkillOutputPointers(steps: CurrentPlanStep[]): void {
  for (const step of steps) {
    if (step.actor_type !== 'skill') continue;
    const invalid = step.expected_outputs.find((output) => (
      output.pointer !== '/payload' && !output.pointer.startsWith('/payload/')
    ));
    if (invalid) fail('invalid_skill_output_pointer', String(step.step_no), invalid.pointer);
  }
}

function validateFixedActorOutputPointers(steps: CurrentPlanStep[]): void {
  for (const step of steps) {
    const expectedPointer = step.actor_type === 'llm'
      ? '/text'
      : step.actor_type === 'reviewer'
        ? '/review'
        : null;
    if (expectedPointer === null) continue;
    if (step.expected_outputs.length !== 1 || step.expected_outputs[0]?.pointer !== expectedPointer) {
      fail(
        'invalid_actor_output_pointer',
        String(step.step_no),
        step.actor_type,
        ...step.expected_outputs.map((output) => output.pointer),
        expectedPointer,
      );
    }
  }
}

function validatePendingInputSchemas(
  eligibleSkills: ReadonlyMap<string, CapabilityResolution['eligible'][number]>,
): void {
  for (const [skillId, decision] of eligibleSkills) {
    const schemaPath = decision.skill.input_schema;
    if (!schemaPath || decision.pending_inputs.length === 0) continue;
    let schema: unknown;
    try {
      schema = JSON.parse(readFileSync(join(getConfigRoot(), schemaPath), 'utf8'));
    } catch {
      fail('pending_input_schema_invalid', skillId, schemaPath);
    }
    const properties = schema !== null && typeof schema === 'object' && !Array.isArray(schema)
      ? Reflect.get(schema, 'properties')
      : undefined;
    for (const pending of decision.pending_inputs) {
      if (
        properties === null
        || typeof properties !== 'object'
        || Array.isArray(properties)
        || !Object.hasOwn(properties, pending.role)
      ) {
        fail('pending_input_schema_invalid', skillId, pending.role);
      }
    }
  }
}

function derivePendingInputs(
  steps: CurrentPlanStep[],
  eligibleSkills: ReadonlyMap<string, CapabilityResolution['eligible'][number]>,
  toolsById: ReadonlyMap<string, ToolRegistryEntry>,
): PendingInput[] {
  const pendingByRole = new Map<string, PendingInput>();
  const targetKeysByRole = new Map<string, Set<string>>();
  for (const step of steps) {
    if (step.actor_type !== 'skill') continue;
    const decision = eligibleSkills.get(step.actor_id)!;
    for (const pending of decision.pending_inputs) {
      if (!Object.hasOwn(step.input, pending.role)) {
        fail('pending_input_schema_invalid', step.actor_id, pending.role, String(step.step_no));
      }
      let item = pendingByRole.get(pending.role);
      if (!item) {
        item = {
          kind: pending.kind,
          role: pending.role,
          label: pending.label,
          multiple: pending.multiple,
          targets: [],
        };
        pendingByRole.set(pending.role, item);
        targetKeysByRole.set(pending.role, new Set());
      } else if (item.multiple !== pending.multiple || item.kind !== pending.kind) {
        fail('pending_input_schema_invalid', pending.role, 'multiple-or-kind');
      }
      const addTarget = (target: PendingInput['targets'][number]): void => {
        const targetKey = `${target.step_no}\u0000${target.field}`;
        const targetKeys = targetKeysByRole.get(pending.role)!;
        if (targetKeys.has(targetKey)) return;
        targetKeys.add(targetKey);
        item!.targets.push(target);
      };
      addTarget({
          step_no: step.step_no,
          tool_id: step.actor_id,
          field: pending.role,
          multiple: pending.multiple,
        });

      for (const toolStep of steps) {
        if (
          toolStep.actor_type !== 'tool'
          || toolStep.step_no >= step.step_no
          || !decision.skill.required_tools.includes(toolStep.actor_id)
        ) continue;
        const tool = toolsById.get(toolStep.actor_id);
        if (!tool) fail('pending_input_schema_invalid', toolStep.actor_id, pending.role);
        let manifest;
        try {
          manifest = loadToolManifest(tool.path);
        } catch {
          fail('pending_input_schema_invalid', toolStep.actor_id, pending.role);
        }
        const visualPendingCount = decision.pending_inputs.filter(({ kind }) => kind === 'visual').length;
        for (const imageField of manifest.image_input_fields ?? []) {
          if (
            pending.kind !== 'visual'
            || (
              visualPendingCount !== 1
              && (imageField.role ?? imageField.field) !== pending.role
            )
          ) continue;
          if (!Object.hasOwn(toolStep.input, imageField.field)) {
            fail('pending_input_schema_invalid', toolStep.actor_id, imageField.field, String(toolStep.step_no));
          }
          addTarget({
            step_no: toolStep.step_no,
            tool_id: toolStep.actor_id,
            field: imageField.field,
            multiple: imageField.multiple === true,
          });
        }
      }
    }
  }
  return [...pendingByRole.values()];
}

export class PlanCompiler {
  constructor(private readonly validator = new SchemaValidator()) {}

  compile(input: PlanCompileInput): CompiledPlan {
    const deliverableSelection: FrozenDeliverableSelection = input.deliverable_selection
      ? {
        deliverableId: input.deliverable_selection.deliverableId,
        evidenceRequirements: structuredClone(input.deliverable_selection.evidenceRequirements),
      }
      : {
        deliverableId: 'research_plan',
        evidenceRequirements: structuredClone(input.evidence_requirements),
      };
    if (
      input.deliverable_selection
      && !isDeepStrictEqual(input.evidence_requirements, deliverableSelection.evidenceRequirements)
    ) {
      throw new Error(
        `Evidence requirements do not match frozen deliverable selection ${deliverableSelection.deliverableId}`,
      );
    }
    const toolsById = new Map(loadToolRegistry().tools.map((tool) => [tool.id, tool]));
    const frozenCapabilityDecisions = freezeCapabilityDecisions(input.capability_resolution);
    const capabilityResolution = frozenCapabilityDecisions as CapabilityResolution;
    const frozenCapabilityGaps = capabilityGaps(capabilityResolution, toolsById);
    validateProposalShape(input.candidate);
    this.validator.validateOrThrow('current-execution-plan', {
      task_id: '',
      deliverable_type: deliverableSelection.deliverableId,
      evidence_requirements: deliverableSelection.evidenceRequirements,
      problem_graph: input.problem_graph,
      capability_decisions: frozenCapabilityDecisions,
      capability_gaps: frozenCapabilityGaps,
      steps: input.candidate.steps,
      candidate_metadata: {
        title: input.candidate.title,
        rationale: input.candidate.rationale,
        tradeoffs: input.candidate.tradeoffs,
      },
      problem_graph_provenance: input.problem_graph_provenance,
      activated_nodes: input.activated_nodes,
    });
    validateProblemGraphCoverage(input.task, input.problem_graph);
    const steps = copySteps(input.candidate);
    validateStepDependencies(steps);
    validateQuestions(steps, input.problem_graph);
    validateEvidencePolicy(input.problem_graph, deliverableSelection.evidenceRequirements);
    const eligibleSkills = validateActors(steps, capabilityResolution);
    validateApprovals(steps, capabilityResolution);
    validateRequiredTools(steps, eligibleSkills);
    validateOptionalTools(steps, eligibleSkills);
    validatePendingInputSchemas(eligibleSkills);
    validateSkillOutputPointers(steps);
    validateFixedActorOutputPointers(steps);
    validateBindings(steps, toolsById);
    if (input.requireCompetitiveWeightContract) validateCompetitiveWeightContract(steps, input.task);

    const plan: CompiledPlan['plan'] = {
      task_id: '',
      deliverable_type: deliverableSelection.deliverableId,
      evidence_requirements: structuredClone(deliverableSelection.evidenceRequirements),
      problem_graph: structuredClone(input.problem_graph),
      problem_graph_provenance: structuredClone(input.problem_graph_provenance),
      capability_decisions: frozenCapabilityDecisions,
      capability_gaps: frozenCapabilityGaps,
      steps,
      candidate_metadata: {
        title: input.candidate.title,
        rationale: input.candidate.rationale,

        tradeoffs: input.candidate.tradeoffs,
      },
      activated_nodes: [...input.activated_nodes],
    };
    this.validator.validateOrThrow('current-execution-plan', plan);
    return { plan, pending_inputs: derivePendingInputs(steps, eligibleSkills, toolsById) };
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
  const plan = normalizeCurrentExecutionPlanOptionalFields(input.plan as CurrentExecutionPlan);
  validator.validateOrThrow('current-execution-plan', plan);
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
    deliverable_selection: {
      deliverableId: plan.deliverable_type,
      evidenceRequirements: plan.evidence_requirements,
    },
    problem_graph: plan.problem_graph,
    problem_graph_provenance: plan.problem_graph_provenance,
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

import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentExecutionPlanV3,
  CurrentSkillInvocationV3,
  PlanContributionRequirement,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { planShareFingerprint } from '../skills/portfolio-skill-plan-compiler.ts';
import { SchemaValidator } from '../schema/validator.ts';

export type CurrentExecutionPlanV3ValidationKind =
  | 'duplicate_invocation_id'
  | 'synthesizer_count'
  | 'duplicate_contribution_requirement'
  | 'unknown_demand_requirement'
  | 'unknown_invocation_demand'
  | 'required_demand_without_owner'
  | 'incomplete_demand_ownership'
  | 'multiple_demand_owners'
  | 'unknown_owner_invocation'
  | 'contribution_owner_not_contributor'
  | 'unknown_corroborator_invocation'
  | 'demand_coverage_mismatch'
  | 'owner_scope_mismatch'
  | 'multiple_primary_owners'
  | 'required_owner_may_gap'
  | 'synthesizer_may_gap'
  | 'unknown_invocation_question'
  | 'unknown_invocation_dependency'
  | 'invocation_dependency_cycle'
  | 'invalid_invocation_step'
  | 'invalid_step_topology'
  | 'invalid_binding_dependency'
  | 'unauthorized_cross_invocation_binding'
  | 'missing_required_contributor_dependency'
  | 'invalid_shared_stage'
  | 'invalid_output_contract'
  | 'portfolio_summary_mismatch';

export class CurrentExecutionPlanV3ValidationError extends Error {
  constructor(
    public readonly kind: CurrentExecutionPlanV3ValidationKind,
    public readonly issueIds: string[],
  ) {
    const uniqueIssueIds = [...new Set(issueIds)];
    super(`current execution plan v3 ${kind}: ${uniqueIssueIds.join(', ')}`);
    this.name = 'CurrentExecutionPlanV3ValidationError';
    this.issueIds = uniqueIssueIds;
  }
}

function planError(kind: CurrentExecutionPlanV3ValidationKind, issueIds: string[]): never {
  throw new CurrentExecutionPlanV3ValidationError(kind, issueIds);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && isDeepStrictEqual([...left].sort(), [...right].sort());
}

function requirementMatchesDemand(
  requirement: PlanContributionRequirement,
  demand: CurrentExecutionPlanV3['capability_demand_graph']['demands'][number],
): boolean {
  return requirement.demand_type === demand.type
    && requirement.required === (demand.priority === 'required')
    && sameMembers(requirement.question_ids, demand.questionIds)
    && sameMembers(requirement.requested_artifact_types, demand.requestedArtifactTypes);
}

function invocationCoversRequirement(
  invocation: CurrentSkillInvocationV3,
  requirement: PlanContributionRequirement,
): boolean {
  return invocation.contribution_types.includes(requirement.demand_type)
    && requirement.question_ids.every((questionId) => invocation.question_ids.includes(questionId))
    && requirement.requested_artifact_types.every((artifact) => (
      invocation.requested_artifact_types.includes(artifact)
  ));
}

function invocationCoversDemand(
  invocation: CurrentSkillInvocationV3,
  demand: CurrentExecutionPlanV3['capability_demand_graph']['demands'][number],
): boolean {
  return invocation.contribution_types.includes(demand.type)
    && demand.questionIds.every((questionId) => invocation.question_ids.includes(questionId))
    && demand.requestedArtifactTypes.every((artifact) => (
      invocation.requested_artifact_types.includes(artifact)
    ));
}

function hasDependencyPath(
  targetStepNo: number,
  sourceStepNo: number,
  allowedStepNos: ReadonlySet<number>,
  stepsByNo: ReadonlyMap<number, CurrentExecutionPlanV3['steps'][number]>,
): boolean {
  const visited = new Set<number>();
  const visit = (stepNo: number): boolean => {
    if (stepNo === sourceStepNo) return true;
    if (visited.has(stepNo) || !allowedStepNos.has(stepNo)) return false;
    visited.add(stepNo);
    return stepsByNo.get(stepNo)?.depends_on.some((dependency) => visit(dependency)) === true;
  };
  return visit(targetStepNo);
}

/**
 * Enforces Plan v3 cross-reference and ownership invariants that JSON Schema
 * cannot express. Compilation and execution must call this at their seams.
 */
export function validateCurrentExecutionPlanV3(
  plan: CurrentExecutionPlanV3,
  validator = new SchemaValidator(),
): void {
  validator.validateOrThrow('current-execution-plan-v3', plan);

  const invocationsById = new Map<string, CurrentSkillInvocationV3>();
  for (const invocation of plan.skill_invocations) {
    if (invocationsById.has(invocation.invocation_id)) {
      planError('duplicate_invocation_id', [invocation.invocation_id]);
    }
    invocationsById.set(invocation.invocation_id, invocation);
  }

  const synthesizers = plan.skill_invocations.filter(({ role }) => role === 'synthesizer');
  if (synthesizers.length !== 1) {
    planError('synthesizer_count', synthesizers.map(({ invocation_id }) => invocation_id));
  }

  const summaryByInvocation = new Map(
    plan.portfolio_summary.selected.map((item) => [item.invocation_id, item]),
  );
  if (
    summaryByInvocation.size !== plan.skill_invocations.length
    || plan.portfolio_summary.selected.length !== plan.skill_invocations.length
    || plan.skill_invocations.some((invocation) => {
      const summary = summaryByInvocation.get(invocation.invocation_id);
      return !summary || summary.skill_id !== invocation.skill_id || summary.role !== invocation.role;
    })
    || plan.portfolio_summary.estimated_budget.selected_skill_count !== plan.skill_invocations.length
    || plan.portfolio_summary.estimated_budget.selected_contributor_count
      !== plan.skill_invocations.filter(({ role }) => role === 'contributor').length
    || plan.portfolio_summary.estimated_budget.expanded_step_count !== plan.steps.length
    || plan.portfolio_summary.estimated_budget.expanded_step_count
      > plan.portfolio_summary.estimated_budget.expanded_step_limit
  ) planError('portfolio_summary_mismatch', plan.skill_invocations.map(({ invocation_id }) => invocation_id));

  for (const invocation of plan.skill_invocations) {
    for (const dependencyId of invocation.depends_on_invocation_ids) {
      if (dependencyId === invocation.invocation_id || !invocationsById.has(dependencyId)) {
        planError('unknown_invocation_dependency', [invocation.invocation_id, dependencyId]);
      }
    }
    if (invocation.role === 'contributor' && invocation.output_contract !== 'research-contribution-v1') {
      planError('invalid_output_contract', [invocation.invocation_id, invocation.output_contract]);
    }
  }
  const completeInvocations = new Set<string>();
  const activeInvocations = new Set<string>();
  const visitInvocation = (invocationId: string): void => {
    if (completeInvocations.has(invocationId)) return;
    if (activeInvocations.has(invocationId)) {
      planError('invocation_dependency_cycle', [...activeInvocations, invocationId]);
    }
    activeInvocations.add(invocationId);
    const invocation = invocationsById.get(invocationId)!;
    for (const dependencyId of invocation.depends_on_invocation_ids) visitInvocation(dependencyId);
    activeInvocations.delete(invocationId);
    completeInvocations.add(invocationId);
  };
  for (const invocationId of invocationsById.keys()) visitInvocation(invocationId);

  const synthesizer = synthesizers[0]!;
  const requiredContributorIds = plan.skill_invocations
    .filter(({ role, required }) => role === 'contributor' && required)
    .map(({ invocation_id }) => invocation_id);
  const missingRequiredDependency = requiredContributorIds.find((invocationId) => (
    !synthesizer.depends_on_invocation_ids.includes(invocationId)
  ));
  if (missingRequiredDependency) {
    planError('missing_required_contributor_dependency', [
      synthesizer.invocation_id,
      missingRequiredDependency,
    ]);
  }

  const stepByNo = new Map(plan.steps.map((step) => [step.step_no, step]));
  const sharedSummaryKeys = new Set<string>();
  for (const prerequisite of plan.portfolio_summary.shared_prerequisites) {
    const sharedStageKey = `shared:${prerequisite.capability_type}:${prerequisite.capability_id}`;
    const matchingStages = plan.steps.filter((step) => step.shared_stage_key === sharedStageKey);
    if (
      sharedSummaryKeys.has(sharedStageKey)
      || matchingStages.length !== 1
      || matchingStages[0]!.actor_type !== prerequisite.capability_type
      || matchingStages[0]!.actor_id !== prerequisite.capability_id
    ) {
      planError('invalid_shared_stage', [sharedStageKey]);
    }
    const expectedConsumerInvocationIds = prerequisite.consumer_skill_ids.map((skillId) => {
      const matchingInvocations = plan.skill_invocations.filter((invocation) => (
        invocation.skill_id === skillId
      ));
      if (matchingInvocations.length !== 1) {
        planError('invalid_shared_stage', [sharedStageKey, skillId]);
      }
      return matchingInvocations[0]!.invocation_id;
    });
    if (!sameMembers(
      matchingStages[0]!.shared_by_invocation_ids ?? [],
      expectedConsumerInvocationIds,
    )) {
      planError('invalid_shared_stage', [
        sharedStageKey,
        ...expectedConsumerInvocationIds,
        ...(matchingStages[0]!.shared_by_invocation_ids ?? []),
      ]);
    }
    sharedSummaryKeys.add(sharedStageKey);
  }
  const unlistedSharedStage = plan.steps.find((step) => (
    step.shared_stage_key && !sharedSummaryKeys.has(step.shared_stage_key)
  ));
  if (unlistedSharedStage?.shared_stage_key) {
    planError('invalid_shared_stage', [
      unlistedSharedStage.shared_stage_key,
      String(unlistedSharedStage.step_no),
    ]);
  }
  for (const [index, step] of plan.steps.entries()) {
    if (step.step_no !== index + 1 || step.depends_on.some((dependency) => dependency >= step.step_no)) {
      planError('invalid_step_topology', [String(step.step_no)]);
    }
    if (step.skill_invocation_id && !invocationsById.has(step.skill_invocation_id)) {
      planError('invalid_invocation_step', [step.skill_invocation_id, String(step.step_no)]);
    }
    if (step.shared_stage_key) {
      const consumers = step.shared_by_invocation_ids ?? [];
      if (
        consumers.length < 2
        || consumers.some((invocationId) => !invocationsById.has(invocationId))
        || step.share_fingerprint !== planShareFingerprint(step)
      ) {
        planError('invalid_shared_stage', [step.shared_stage_key, String(step.step_no)]);
      }
      for (const invocationId of consumers) {
        const invocation = invocationsById.get(invocationId)!;
        if (!invocation.step_nos.includes(step.step_no)) {
          planError('invalid_shared_stage', [step.shared_stage_key, invocationId]);
        }
        const outputSteps = invocation.step_nos
          .map((stepNo) => stepByNo.get(stepNo))
          .filter((consumerStep): consumerStep is CurrentExecutionPlanV3['steps'][number] => (
            consumerStep?.skill_invocation_id === invocationId
            && consumerStep.actor_type === 'skill'
            && consumerStep.actor_id === invocation.skill_id
          ));
        if (outputSteps.length !== 1) {
          planError('invalid_shared_stage', [step.shared_stage_key, invocationId]);
        }
        const outputStep = outputSteps[0]!;
        if (invocation.execution_mode === 'legacy_single_call') {
          if (!outputStep.depends_on.includes(step.step_no)) {
            planError('invalid_shared_stage', [step.shared_stage_key, invocationId]);
          }
        } else {
          const invocationStepNos = new Set(invocation.step_nos);
          if (!hasDependencyPath(outputStep.step_no, step.step_no, invocationStepNos, stepByNo)) {
            planError('invalid_shared_stage', [step.shared_stage_key, invocationId]);
          }
        }
      }
    }
    for (const binding of step.input_bindings) {
      if (!step.depends_on.includes(binding.source_step_no)) {
        planError('invalid_binding_dependency', [String(step.step_no), String(binding.source_step_no)]);
      }
      const source = stepByNo.get(binding.source_step_no);
      if (!source) planError('invalid_binding_dependency', [String(binding.source_step_no)]);
      const targetInvocationId = step.skill_invocation_id;
      if (targetInvocationId) {
        const target = invocationsById.get(targetInvocationId)!;
        const sharedConsumers = source.shared_by_invocation_ids;
        const unauthorized = sharedConsumers
          ? (sharedConsumers.includes(targetInvocationId) ? undefined : sharedConsumers[0])
          : source.skill_invocation_id
            && source.skill_invocation_id !== targetInvocationId
            && !target.depends_on_invocation_ids.includes(source.skill_invocation_id)
            ? source.skill_invocation_id
            : undefined;
        if (unauthorized) {
          planError('unauthorized_cross_invocation_binding', [
            targetInvocationId,
            unauthorized,
            String(step.step_no),
          ]);
        }
      }
    }
  }
  for (const invocation of plan.skill_invocations) {
    for (const stepNo of invocation.step_nos) {
      const step = stepByNo.get(stepNo);
      if (!step) planError('invalid_invocation_step', [invocation.invocation_id, String(stepNo)]);
      const sharedOwner = step.shared_by_invocation_ids?.includes(invocation.invocation_id) === true;
      if (step.skill_invocation_id !== invocation.invocation_id && !sharedOwner) {
        planError('invalid_invocation_step', [invocation.invocation_id, String(stepNo)]);
      }
    }
  }

  const questionIds = new Set(plan.problem_graph.questions.map(({ id }) => id));
  for (const invocation of plan.skill_invocations) {
    const unknownQuestion = invocation.question_ids.find((questionId) => !questionIds.has(questionId));
    if (unknownQuestion) {
      planError('unknown_invocation_question', [invocation.invocation_id, unknownQuestion]);
    }
  }

  const demandsById = new Map(plan.capability_demand_graph.demands.map((demand) => [demand.id, demand]));
  const hasFrozenDemandOwnership = plan.skill_invocations.some(({ demand_ids }) => (
    demand_ids !== undefined
  ));
  if (
    hasFrozenDemandOwnership
    && plan.skill_invocations.some(({ demand_ids }) => demand_ids === undefined)
  ) {
    planError('incomplete_demand_ownership', plan.skill_invocations
      .filter(({ demand_ids }) => demand_ids === undefined)
      .map(({ invocation_id }) => invocation_id));
  }
  const ownerByDemand = new Map<string, CurrentSkillInvocationV3>();
  if (hasFrozenDemandOwnership) {
    for (const invocation of plan.skill_invocations) {
      for (const demandId of invocation.demand_ids ?? []) {
        const demand = demandsById.get(demandId);
        if (!demand) planError('unknown_invocation_demand', [invocation.invocation_id, demandId]);
        const existing = ownerByDemand.get(demandId);
        if (existing && existing.invocation_id !== invocation.invocation_id) {
          planError('multiple_demand_owners', [
            demandId,
            existing.invocation_id,
            invocation.invocation_id,
          ]);
        }
        if (!invocationCoversDemand(invocation, demand)) {
          planError('owner_scope_mismatch', [demandId, invocation.invocation_id]);
        }
        ownerByDemand.set(demandId, invocation);
      }
    }
  }
  const requirementsByDemand = new Map<string, PlanContributionRequirement>();
  for (const requirement of plan.contribution_requirements) {
    if (requirementsByDemand.has(requirement.id)) {
      planError('duplicate_contribution_requirement', [requirement.id]);
    }
    const demand = demandsById.get(requirement.id);
    if (!demand) planError('unknown_demand_requirement', [requirement.id]);
    if (!requirementMatchesDemand(requirement, demand)) {
      planError('demand_coverage_mismatch', [requirement.id]);
    }
    if (!invocationsById.has(requirement.owner_invocation_id)) {
      planError('unknown_owner_invocation', [requirement.id, requirement.owner_invocation_id]);
    }
    requirementsByDemand.set(requirement.id, requirement);
  }

  const primaryOwnersByQuestionType = new Map<string, string>();
  for (const requirement of plan.contribution_requirements) {
    for (const questionId of requirement.question_ids) {
      const ownershipKey = `${questionId}:${requirement.demand_type}`;
      const existingOwner = primaryOwnersByQuestionType.get(ownershipKey);
      if (existingOwner && existingOwner !== requirement.owner_invocation_id) {
        planError('multiple_primary_owners', [
          questionId,
          existingOwner,
          requirement.owner_invocation_id,
        ]);
      }
      primaryOwnersByQuestionType.set(ownershipKey, requirement.owner_invocation_id);
    }
  }
  if (hasFrozenDemandOwnership) {
    for (const demand of plan.capability_demand_graph.demands) {
      const owner = ownerByDemand.get(demand.id);
      if (!owner) continue;
      for (const questionId of demand.questionIds) {
        const ownershipKey = `${questionId}:${demand.type}`;
        const existingOwner = primaryOwnersByQuestionType.get(ownershipKey);
        if (existingOwner && existingOwner !== owner.invocation_id) {
          planError('multiple_primary_owners', [questionId, existingOwner, owner.invocation_id]);
        }
        primaryOwnersByQuestionType.set(ownershipKey, owner.invocation_id);
      }
    }
  }

  for (const requirement of plan.contribution_requirements) {
    const owner = invocationsById.get(requirement.owner_invocation_id)!;
    if (owner.role !== 'contributor') {
      planError('contribution_owner_not_contributor', [requirement.id, owner.invocation_id]);
    }
    if (
      hasFrozenDemandOwnership
      && ownerByDemand.get(requirement.id)?.invocation_id !== owner.invocation_id
    ) {
      planError('owner_scope_mismatch', [requirement.id, owner.invocation_id]);
    }
    for (const corroboratorId of requirement.corroborator_invocation_ids) {
      if (!invocationsById.has(corroboratorId)) {
        planError('unknown_corroborator_invocation', [requirement.id, corroboratorId]);
      }
    }
    if (!invocationCoversRequirement(owner, requirement)) {
      planError('owner_scope_mismatch', [requirement.id, owner.invocation_id]);
    }
    if (requirement.required && (!owner.required || owner.failure_policy !== 'block')) {
      planError('required_owner_may_gap', [owner.invocation_id, requirement.id]);
    }
  }

  for (const demand of plan.capability_demand_graph.demands) {
    if (!hasFrozenDemandOwnership) {
      if (demand.priority === 'required' && !requirementsByDemand.has(demand.id)) {
        planError('required_demand_without_owner', [demand.id]);
      }
      continue;
    }
    const owner = ownerByDemand.get(demand.id);
    if (demand.priority === 'required' && !owner) {
      planError('required_demand_without_owner', [demand.id]);
    }
    if (!owner) continue;
    const requirement = requirementsByDemand.get(demand.id);
    if (owner.role === 'contributor' && !requirement) {
      planError('required_demand_without_owner', [demand.id, owner.invocation_id]);
    }
    if (owner.role === 'synthesizer' && requirement) {
      planError('contribution_owner_not_contributor', [demand.id, owner.invocation_id]);
    }
  }

  if (!synthesizer.required || synthesizer.failure_policy !== 'block') {
    planError('synthesizer_may_gap', [synthesizer.invocation_id]);
  }
}

import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentExecutionPlanV3,
  CurrentSkillInvocationV3,
  PlanContributionRequirement,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';

export type CurrentExecutionPlanV3ValidationKind =
  | 'duplicate_invocation_id'
  | 'synthesizer_count'
  | 'duplicate_contribution_requirement'
  | 'unknown_demand_requirement'
  | 'required_demand_without_owner'
  | 'unknown_owner_invocation'
  | 'unknown_corroborator_invocation'
  | 'demand_coverage_mismatch'
  | 'owner_scope_mismatch'
  | 'multiple_primary_owners'
  | 'required_owner_may_gap'
  | 'synthesizer_may_gap'
  | 'unknown_invocation_question';

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

  const questionIds = new Set(plan.problem_graph.questions.map(({ id }) => id));
  for (const invocation of plan.skill_invocations) {
    const unknownQuestion = invocation.question_ids.find((questionId) => !questionIds.has(questionId));
    if (unknownQuestion) {
      planError('unknown_invocation_question', [invocation.invocation_id, unknownQuestion]);
    }
  }

  const demandsById = new Map(plan.capability_demand_graph.demands.map((demand) => [demand.id, demand]));
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
    requirementsByDemand.set(requirement.id, requirement);
  }

  for (const demand of plan.capability_demand_graph.demands) {
    if (demand.priority === 'required' && !requirementsByDemand.has(demand.id)) {
      planError('required_demand_without_owner', [demand.id]);
    }
  }

  const primaryOwnersByQuestion = new Map<string, string>();
  for (const requirement of plan.contribution_requirements) {
    for (const questionId of requirement.question_ids) {
      const existingOwner = primaryOwnersByQuestion.get(questionId);
      if (existingOwner && existingOwner !== requirement.owner_invocation_id) {
        planError('multiple_primary_owners', [
          questionId,
          existingOwner,
          requirement.owner_invocation_id,
        ]);
      }
      primaryOwnersByQuestion.set(questionId, requirement.owner_invocation_id);
    }
  }

  for (const requirement of plan.contribution_requirements) {
    const owner = invocationsById.get(requirement.owner_invocation_id);
    if (!owner) {
      planError('unknown_owner_invocation', [requirement.id, requirement.owner_invocation_id]);
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

  const synthesizer = synthesizers[0]!;
  if (!synthesizer.required || synthesizer.failure_policy !== 'block') {
    planError('synthesizer_may_gap', [synthesizer.invocation_id]);
  }
}

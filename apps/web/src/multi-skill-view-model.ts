import type { FinalizedPlan } from '../../../packages/api-contract/http.ts';
import type {
  CurrentSkillInvocationV3,
  PlanPortfolioSummary,
} from '../../../packages/api-contract/research-deliverable.ts';

export interface MultiSkillPlanViewModel {
  contributorCount: number;
  synthesizer: CurrentSkillInvocationV3;
  requiredDemandCount: number;
  coveredRequiredDemandCount: number;
  uncoveredRequiredDemandIds: string[];
  synthetic: boolean;
  budget: PlanPortfolioSummary['estimated_budget'];
  selections: PlanPortfolioSummary['selected'];
  rejected: PlanPortfolioSummary['rejected'];
  sharedPrerequisites: PlanPortfolioSummary['shared_prerequisites'];
  capabilityGaps: NonNullable<FinalizedPlan['capability_gaps']>;
  invocations: CurrentSkillInvocationV3[];
}

export function multiSkillPlanViewModel(plan: FinalizedPlan): MultiSkillPlanViewModel | null {
  if (
    plan.execution_contract_version !== 'current-execution-plan-v3'
    || !plan.capability_demand_graph
    || !plan.portfolio_summary
    || !plan.contribution_requirements
    || !plan.skill_invocations
  ) return null;
  const invocations = plan.skill_invocations.filter((invocation): invocation is CurrentSkillInvocationV3 => (
    'role' in invocation
  ));
  const synthesizers = invocations.filter(({ role }) => role === 'synthesizer');
  if (synthesizers.length !== 1) return null;
  const requiredDemands = plan.capability_demand_graph.demands.filter(({ priority }) => priority === 'required');
  const covered = new Set(plan.contribution_requirements.filter(({ required }) => required).map(({ id }) => id));
  return {
    contributorCount: invocations.filter(({ role }) => role === 'contributor').length,
    synthesizer: synthesizers[0]!,
    requiredDemandCount: requiredDemands.length,
    coveredRequiredDemandCount: requiredDemands.filter(({ id }) => covered.has(id)).length,
    uncoveredRequiredDemandIds: requiredDemands.filter(({ id }) => !covered.has(id)).map(({ id }) => id),
    synthetic: requiredDemands.some(({ type }) => type === 'virtual_user_hypothesis'),
    budget: plan.portfolio_summary.estimated_budget,
    selections: plan.portfolio_summary.selected,
    rejected: plan.portfolio_summary.rejected,
    sharedPrerequisites: plan.portfolio_summary.shared_prerequisites,
    capabilityGaps: plan.capability_gaps ?? [],
    invocations,
  };
}

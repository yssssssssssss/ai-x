import type {
  CapabilityDemand,
  CapabilityDemandGraphV1,
  CandidateProfile,
  ContributionType,
  ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import type { RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type {
  CurrentPlanStep,
  ProblemGraph,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  DeliverableCompositionPolicy,
} from '../report/deliverable-registry.ts';
import { resolveSkillComposition } from '../runtime/config-loader.ts';
import type {
  CapabilityResolution,
  EligibleCapabilityDecision,
} from './capability-resolver.ts';

export type CapabilityPortfolioResolutionKind =
  | 'deliverable_not_portfolio'
  | 'synthesizer_unavailable'
  | 'required_demand_uncovered'
  | 'multiple_primary_owners'
  | 'profile_budget_exceeded';

export class CapabilityPortfolioResolutionError extends Error {
  constructor(
    public readonly kind: CapabilityPortfolioResolutionKind,
    public readonly issueIds: string[],
    public readonly requiredCoverageSteps?: number,
  ) {
    const uniqueIssueIds = [...new Set(issueIds)];
    super(`capability portfolio ${kind}: ${uniqueIssueIds.join(', ')}`);
    this.name = 'CapabilityPortfolioResolutionError';
    this.issueIds = uniqueIssueIds;
  }
}

function portfolioError(
  kind: CapabilityPortfolioResolutionKind,
  issueIds: string[],
  requiredCoverageSteps?: number,
): never {
  throw new CapabilityPortfolioResolutionError(kind, issueIds, requiredCoverageSteps);
}

export interface PortfolioInvocationDecision {
  invocationId: string;
  skillId: string;
  role: 'contributor' | 'synthesizer';
  demandIds: string[];
  contributionTypes: ContributionType[];
  questionIds: string[];
  requestedArtifactTypes: RequestedArtifact[];
  required: boolean;
  failurePolicy: 'block' | 'gap';
  estimatedSteps: number;
  reasonCodes: string[];
}

export interface DemandCoverageDecision {
  demandId: string;
  demandType: ContributionType;
  ownerSkillId: string;
  corroboratorSkillIds: string[];
  questionIds: string[];
  requestedArtifactTypes: RequestedArtifact[];
  required: boolean;
}

export interface PortfolioRejectionDecision {
  skillId: string;
  reasonCode:
    | 'hard_filter_rejected'
    | 'pending_required_input'
    | 'composition_incompatible'
    | 'overlap_not_selected'
    | 'optional_budget_exceeded';
  relatedIds: string[];
}

export interface SharedPrerequisiteDecision {
  capabilityType: 'tool' | 'knowledge';
  capabilityId: string;
  consumerSkillIds: string[];
}

export interface PortfolioBudgetEstimate {
  profileId: CandidateProfile;
  maxSteps: number;
  estimatedSteps: number;
  selectedContributorCount: number;
  selectedSkillCount: number;
  requiredDemandCount: number;
  optionalDemandCount: number;
}

export interface SkillPortfolioDecision {
  invocations: PortfolioInvocationDecision[];
  demandCoverage: DemandCoverageDecision[];
  rejected: PortfolioRejectionDecision[];
  sharedPrerequisites: SharedPrerequisiteDecision[];
  estimatedBudget: PortfolioBudgetEstimate;
}

export interface CapabilityPortfolioResolveInput {
  task: ResearchTaskV2;
  problemGraph: ProblemGraph;
  capabilityDemandGraph: CapabilityDemandGraphV1;
  deliverableId: string;
  compositionPolicy: DeliverableCompositionPolicy;
  capabilityResolution: CapabilityResolution;
  profile: { id: CandidateProfile; max_steps: number };
  availableInputRoles: readonly string[];
  stepEstimates?: Readonly<Record<string, number>>;
  shareableKnowledgeBySkill?: Readonly<Record<string, readonly string[]>>;
}

const TYPE_TERMS: Readonly<Partial<Record<ContributionType, readonly string[]>>> = {
  market_landscape: ['market', 'landscape', '市场', '赛道', '竞品'],
  competitive_analysis: ['competitive', 'competitor', '竞品', '竞争'],
  persona: ['persona', '用户画像', '人物角色', '分型'],
  jobs_to_be_done: ['jtbd', 'job', '动机', '任务', '需求'],
  journey: ['journey', '旅程', '链路', '触点'],
  qualitative_insight: ['qualitative', 'insight', '定性', '洞察'],
  voc: ['voc', 'feedback', '反馈', '评论', '用户之声'],
  satisfaction: ['satisfaction', 'nps', 'nss', '满意度'],
  metrics: ['metric', 'measure', '指标', '度量'],
  funnel: ['funnel', 'conversion', '漏斗', '转化'],
  feature_adoption: ['adoption', '采纳', '留存'],
  design_audit: ['heuristic', 'design audit', '走查', '启发式'],
  accessibility: ['accessibility', 'a11y', '无障碍'],
  research_method: ['method', 'research plan', '方法', '研究方案'],
  prioritization: ['priority', 'prioritization', '优先级', '排序'],
  strategy: ['strategy', '策略'],
  action_plan: ['action', 'roadmap', '行动', '路线图'],
  virtual_user_hypothesis: ['virtual user', 'synthetic user', '虚拟用户', '模拟用户'],
};

function outcome(task: ResearchTaskV2): 'plan' | 'answer' {
  return task.outcome_mode ?? (task.task_type === 'user_research_planning' ? 'plan' : 'answer');
}

function stepEstimate(input: CapabilityPortfolioResolveInput, skillId: string): number {
  const estimate = input.stepEstimates?.[skillId] ?? 1;
  if (!Number.isInteger(estimate) || estimate < 1) {
    throw new Error(`Portfolio step estimate for ${skillId} must be a positive integer`);
  }
  return estimate;
}

function semanticTokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase('en-US');
  const tokens = new Set(normalized.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length >= 2));
  for (const segment of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.add(segment.slice(index, index + 2));
    }
  }
  return tokens;
}

function semanticScore(
  decision: EligibleCapabilityDecision,
  demands: readonly CapabilityDemand[],
  task: ResearchTaskV2,
  problemGraph: ProblemGraph,
): number {
  const skillText = [
    decision.skill.id,
    decision.skill.name ?? '',
    decision.skill.when_to_use ?? '',
  ].join(' ').toLocaleLowerCase('en-US');
  const questionsById = new Map(problemGraph.questions.map((question) => [question.id, question]));
  const demandText = demands.flatMap(({ questionIds, requestedArtifactTypes }) => [
    ...questionIds.map((id) => questionsById.get(id)?.statement ?? ''),
    ...requestedArtifactTypes,
  ]).join(' ');
  const queryTokens = semanticTokens([
    demandText,
    task.business_domain,
    task.research_goal,
  ].join(' '));
  const skillTokens = semanticTokens(skillText);
  let score = [...queryTokens].filter((token) => skillTokens.has(token)).length;
  const domain = task.business_domain.trim().toLocaleLowerCase('en-US');
  if (domain && skillText.includes(domain)) score += 2;
  for (const demand of demands) {
    for (const term of TYPE_TERMS[demand.type] ?? [demand.type]) {
      if (skillText.includes(term.toLocaleLowerCase('en-US'))) score += 2;
    }
    for (const artifact of demand.requestedArtifactTypes) {
      if (skillText.includes(artifact.replaceAll('_', ' '))) score += 1;
    }
  }
  return score;
}

interface ContributorCandidate {
  decision: EligibleCapabilityDecision;
  demandIds: string[];
  score: number;
  estimatedSteps: number;
}

function eligibleContributorCandidates(
  input: CapabilityPortfolioResolveInput,
  demands: readonly CapabilityDemand[],
  rejected: PortfolioRejectionDecision[],
): ContributorCandidate[] {
  const acceptedTypes = input.compositionPolicy.mode === 'portfolio'
    ? new Set(input.compositionPolicy.accepted_contribution_types)
    : new Set<ContributionType>();
  const availableInputs = new Set(input.availableInputRoles);
  const candidates: ContributorCandidate[] = [];
  for (const decision of input.capabilityResolution.eligible) {
    const skillId = decision.skill.id;
    const composition = resolveSkillComposition(decision.skill);
    const missingInputRoles = composition.required_input_roles.filter((role) => !availableInputs.has(role));
    if (decision.pending_inputs.length > 0 || missingInputRoles.length > 0) {
      rejected.push({
        skillId,
        reasonCode: 'pending_required_input',
        relatedIds: [...new Set([
          ...decision.pending_inputs.map(({ role }) => role),
          ...missingInputRoles,
        ])],
      });
      continue;
    }
    if (
      !composition.modes.includes('contributor')
      || !composition.contribution_adapter
      || !composition.supported_outcomes.includes(outcome(input.task))
      || !composition.compatible_deliverables.includes(input.deliverableId)
    ) {
      if (skillId !== (input.compositionPolicy.mode === 'portfolio'
        ? input.compositionPolicy.synthesizer_skill_id
        : '')) {
        rejected.push({
          skillId,
          reasonCode: 'composition_incompatible',
          relatedIds: [input.deliverableId],
        });
      }
      continue;
    }
    const contributionTypes = new Set(composition.contribution_types ?? []);
    const covered = demands.filter((demand) => (
      acceptedTypes.has(demand.type) && contributionTypes.has(demand.type)
    ));
    if (covered.length === 0) {
      rejected.push({
        skillId,
        reasonCode: 'composition_incompatible',
        relatedIds: demands.map(({ id }) => id),
      });
      continue;
    }
    candidates.push({
      decision,
      demandIds: covered.map(({ id }) => id),
      score: semanticScore(decision, covered, input.task, input.problemGraph),
      estimatedSteps: stepEstimate(input, skillId),
    });
  }
  return candidates;
}

function selectSynthesizer(
  input: CapabilityPortfolioResolveInput,
): EligibleCapabilityDecision {
  const policy = input.compositionPolicy;
  if (policy.mode !== 'portfolio') {
    portfolioError('deliverable_not_portfolio', [input.deliverableId]);
  }
  const decision = input.capabilityResolution.eligible.find(({ skill }) => (
    skill.id === policy.synthesizer_skill_id
  ));
  if (!decision || decision.pending_inputs.length > 0) {
    portfolioError('synthesizer_unavailable', [policy.synthesizer_skill_id]);
  }
  const composition = resolveSkillComposition(decision.skill);
  if (
    !composition.modes.includes('synthesizer')
    || !composition.supported_outcomes.includes(outcome(input.task))
    || !composition.compatible_deliverables.includes(input.deliverableId)
    || composition.contribution_schema !== policy.contribution_schema
  ) {
    portfolioError('synthesizer_unavailable', [decision.skill.id]);
  }
  return decision;
}

function compareCandidates(
  left: ContributorCandidate,
  right: ContributorCandidate,
  uncovered: ReadonlySet<string>,
): number {
  const leftCoverage = left.demandIds.filter((id) => uncovered.has(id)).length;
  const rightCoverage = right.demandIds.filter((id) => uncovered.has(id)).length;
  if (leftCoverage !== rightCoverage) return rightCoverage - leftCoverage;
  if (left.score !== right.score) return right.score - left.score;
  if (left.estimatedSteps !== right.estimatedSteps) return left.estimatedSteps - right.estimatedSteps;
  return left.decision.skill.id.localeCompare(right.decision.skill.id);
}

function betterSelection(
  left: readonly ContributorCandidate[],
  right: readonly ContributorCandidate[] | undefined,
): boolean {
  if (!right) return true;
  if (left.length !== right.length) return left.length < right.length;
  const leftScore = left.reduce((sum, candidate) => sum + candidate.score, 0);
  const rightScore = right.reduce((sum, candidate) => sum + candidate.score, 0);
  if (leftScore !== rightScore) return leftScore > rightScore;
  const leftSteps = left.reduce((sum, candidate) => sum + candidate.estimatedSteps, 0);
  const rightSteps = right.reduce((sum, candidate) => sum + candidate.estimatedSteps, 0);
  if (leftSteps !== rightSteps) return leftSteps < rightSteps;
  const leftIds = left.map(({ decision }) => decision.skill.id).sort().join('\u0000');
  const rightIds = right.map(({ decision }) => decision.skill.id).sort().join('\u0000');
  return leftIds < rightIds;
}

function selectMinimumRequiredCoverage(
  candidates: readonly ContributorCandidate[],
  requiredDemands: readonly CapabilityDemand[],
): ContributorCandidate[] {
  const demandIndex = new Map(requiredDemands.map((demand, index) => [demand.id, index]));
  const fullMask = (1n << BigInt(requiredDemands.length)) - 1n;
  const orderedCandidates = [...candidates].sort((left, right) => (
    left.decision.skill.id.localeCompare(right.decision.skill.id)
  ));
  let states = new Map<bigint, ContributorCandidate[]>([[0n, []]]);
  for (const candidate of orderedCandidates) {
    let candidateMask = 0n;
    for (const demandId of candidate.demandIds) {
      const index = demandIndex.get(demandId);
      if (index !== undefined) candidateMask |= 1n << BigInt(index);
    }
    if (candidateMask === 0n) continue;
    const next = new Map(states);
    for (const [mask, selection] of states) {
      const combinedMask = mask | candidateMask;
      const combined = [...selection, candidate];
      if (betterSelection(combined, next.get(combinedMask))) next.set(combinedMask, combined);
    }
    states = next;
  }
  const selected = states.get(fullMask);
  if (!selected) {
    const coverable = new Set(candidates.flatMap(({ demandIds }) => demandIds));
    portfolioError(
      'required_demand_uncovered',
      requiredDemands.filter(({ id }) => !coverable.has(id)).map(({ id }) => id),
    );
  }
  return selected;
}

function selectedSharedPrerequisites(
  selected: readonly ContributorCandidate[],
  shareableKnowledgeBySkill: Readonly<Record<string, readonly string[]>> = {},
): SharedPrerequisiteDecision[] {
  const consumersByCapability = new Map<string, { capabilityType: 'tool' | 'knowledge'; consumers: string[] }>();
  const append = (capabilityType: 'tool' | 'knowledge', capabilityId: string, skillId: string): void => {
    const key = `${capabilityType}:${capabilityId}`;
    const entry = consumersByCapability.get(key) ?? { capabilityType, consumers: [] };
    entry.consumers.push(skillId);
    consumersByCapability.set(key, entry);
  };
  for (const candidate of selected) {
    const skillId = candidate.decision.skill.id;
    const shareable = new Set(
      resolveSkillComposition(candidate.decision.skill).shareable_prerequisites ?? [],
    );
    for (const toolId of candidate.decision.skill.required_tools) {
      if (shareable.has(toolId)) append('tool', toolId, skillId);
    }
    for (const knowledgeId of shareableKnowledgeBySkill[skillId] ?? []) {
      append('knowledge', knowledgeId, skillId);
    }
  }
  return [...consumersByCapability]
    .filter(([, { consumers }]) => consumers.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, { capabilityType, consumers }]) => ({
      capabilityType,
      capabilityId: key.slice(key.indexOf(':') + 1),
      consumerSkillIds: [...consumers].sort((left, right) => left.localeCompare(right)),
    }));
}

function estimatedSelectionSteps(
  selected: readonly ContributorCandidate[],
  shareableKnowledgeBySkill: Readonly<Record<string, readonly string[]>> = {},
): number {
  const total = selected.reduce((sum, candidate) => sum + candidate.estimatedSteps, 0);
  const sharedSavings = selectedSharedPrerequisites(selected, shareableKnowledgeBySkill)
    .filter(({ capabilityType }) => capabilityType === 'tool')
    .reduce((sum, prerequisite) => sum + Math.max(0, prerequisite.consumerSkillIds.length - 1), 0);
  return total - sharedSavings;
}

export function portfolioActorValidationIssues(
  steps: readonly CurrentPlanStep[],
  portfolio: SkillPortfolioDecision,
): string[] {
  const selectedSkillIds = new Set(portfolio.invocations.map(({ skillId }) => skillId));
  const candidateSkillIds = steps
    .filter(({ actor_type }) => actor_type === 'skill')
    .map(({ actor_id }) => actor_id);
  const unknown = candidateSkillIds.filter((skillId) => !selectedSkillIds.has(skillId));
  const missing = [...selectedSkillIds].filter((skillId) => !candidateSkillIds.includes(skillId));
  const duplicate = candidateSkillIds.filter((skillId, index) => candidateSkillIds.indexOf(skillId) !== index);
  const issues: string[] = [];
  if (unknown.length > 0) issues.push(`unknown=${[...new Set(unknown)].join(',')}`);
  if (missing.length > 0) issues.push(`missing=${missing.join(',')}`);
  if (duplicate.length > 0) issues.push(`duplicate=${[...new Set(duplicate)].join(',')}`);

  const synthesizer = portfolio.invocations.find(({ role }) => role === 'synthesizer');
  if (synthesizer) {
    const synthesizerIndex = candidateSkillIds.indexOf(synthesizer.skillId);
    const lastContributorIndex = Math.max(
      -1,
      ...portfolio.invocations
        .filter(({ role }) => role === 'contributor')
        .map(({ skillId }) => candidateSkillIds.indexOf(skillId)),
    );
    if (synthesizerIndex >= 0 && synthesizerIndex < lastContributorIndex) {
      issues.push(`synthesizer_order=${synthesizer.skillId}`);
    }
  }
  return issues;
}

export function portfolioCompilerOwnedWiringIssues(
  steps: readonly CurrentPlanStep[],
): string[] {
  const stepByNo = new Map(steps.map((step) => [step.step_no, step]));
  const issues: string[] = [];
  for (const step of steps) {
    if (step.skill_invocation_id !== undefined || step.skill_stage_id !== undefined) {
      issues.push(`compiler_owned_skill_metadata=${step.step_no}`);
    }
    if (
      Reflect.get(step, 'shared_stage_key') !== undefined
      || Reflect.get(step, 'shared_by_invocation_ids') !== undefined
      || Reflect.get(step, 'share_fingerprint') !== undefined
    ) {
      issues.push(`compiler_owned_shared_metadata=${step.step_no}`);
    }
    for (const dependency of step.depends_on) {
      if (stepByNo.get(dependency)?.actor_type === 'skill') {
        issues.push(`compiler_owned_skill_dependency=${dependency}->${step.step_no}`);
      }
    }
    for (const binding of step.input_bindings) {
      if (stepByNo.get(binding.source_step_no)?.actor_type === 'skill') {
        issues.push(`compiler_owned_skill_binding=${binding.source_step_no}->${step.step_no}`);
      }
      if (/^\/(?:prior_contributions|contribution_bundle|contribution_order)(?:\/|$)/u.test(
        binding.target_pointer,
      )) {
        issues.push(`compiler_owned_contribution_binding=${step.step_no}:${binding.target_pointer}`);
      }
    }
    for (const field of ['prior_contributions', 'contribution_bundle', 'contribution_order']) {
      if (Object.hasOwn(step.input, field)) {
        issues.push(`compiler_owned_contribution_input=${step.step_no}:/${field}`);
      }
    }
  }
  return [...new Set(issues)];
}

export class CapabilityPortfolioResolver {
  resolve(input: CapabilityPortfolioResolveInput): SkillPortfolioDecision {
    const synthesizer = selectSynthesizer(input);
    const demandsById = new Map(input.capabilityDemandGraph.demands.map((demand) => [demand.id, demand]));
    const requiredDemands = input.capabilityDemandGraph.demands.filter(({ priority }) => priority === 'required');
    const optionalDemands = input.capabilityDemandGraph.demands.filter(({ priority }) => priority === 'optional');
    const rejected: PortfolioRejectionDecision[] = input.capabilityResolution.rejected.map((decision) => ({
      skillId: decision.skill.id ?? '(no-id)',
      reasonCode: 'hard_filter_rejected',
      relatedIds: decision.reasons.map(({ related_id, code }) => related_id ?? code),
    }));
    const candidates = eligibleContributorCandidates(
      input,
      input.capabilityDemandGraph.demands,
      rejected,
    ).filter(({ decision }) => decision.skill.id !== synthesizer.skill.id);
    const synthesizerComposition = resolveSkillComposition(synthesizer.skill);
    const synthesizerTypes = new Set(synthesizerComposition.contribution_types ?? []);
    const contributorCoverableDemandIds = new Set(candidates.flatMap(({ demandIds }) => demandIds));
    const synthesizerOwnedDemands = requiredDemands.filter((demand) => (
      !contributorCoverableDemandIds.has(demand.id) && synthesizerTypes.has(demand.type)
    ));
    const requiredContributorDemands = requiredDemands.filter((demand) => (
      !synthesizerOwnedDemands.some(({ id }) => id === demand.id)
    ));
    const selected = selectMinimumRequiredCoverage(candidates, requiredContributorDemands);

    const ownerByDemand = new Map<string, ContributorCandidate>();
    const synthesizerCoverage: ContributorCandidate = {
      decision: synthesizer,
      demandIds: synthesizerOwnedDemands.map(({ id }) => id),
      score: Number.MAX_SAFE_INTEGER,
      estimatedSteps: stepEstimate(input, synthesizer.skill.id),
    };
    for (const demand of synthesizerOwnedDemands) ownerByDemand.set(demand.id, synthesizerCoverage);
    for (const demand of requiredContributorDemands) {
      const owner = selected
        .filter(({ demandIds }) => demandIds.includes(demand.id))
        .sort((left, right) => compareCandidates(left, right, new Set([demand.id])))[0];
      if (!owner) portfolioError('required_demand_uncovered', [demand.id]);
      ownerByDemand.set(demand.id, owner);
    }

    const ownerByQuestionType = new Map<string, string>();
    for (const demand of requiredDemands) {
      const ownerId = ownerByDemand.get(demand.id)!.decision.skill.id;
      for (const questionId of demand.questionIds) {
        const ownershipKey = `${questionId}:${demand.type}`;
        const existing = ownerByQuestionType.get(ownershipKey);
        if (existing && existing !== ownerId) {
          portfolioError('multiple_primary_owners', [questionId, existing, ownerId]);
        }
        ownerByQuestionType.set(ownershipKey, ownerId);
      }
    }

    let estimatedSteps = estimatedSelectionSteps(
      [...selected, synthesizerCoverage],
      input.shareableKnowledgeBySkill,
    );
    if (estimatedSteps > input.profile.max_steps) {
      portfolioError('profile_budget_exceeded', [
        input.profile.id,
        String(estimatedSteps),
        String(input.profile.max_steps),
      ], estimatedSteps);
    }

    for (const demand of optionalDemands) {
      const optionalCandidate = candidates
        .filter(({ demandIds, decision }) => (
          demandIds.includes(demand.id)
          && !selected.some((item) => item.decision.skill.id === decision.skill.id)
        ))
        .sort((left, right) => compareCandidates(left, right, new Set([demand.id])))[0];
      if (!optionalCandidate) continue;
      const tentativeSteps = estimatedSelectionSteps(
        [...selected, optionalCandidate, synthesizerCoverage],
        input.shareableKnowledgeBySkill,
      );
      if (tentativeSteps > input.profile.max_steps) {
        rejected.push({
          skillId: optionalCandidate.decision.skill.id,
          reasonCode: 'optional_budget_exceeded',
          relatedIds: [demand.id, input.profile.id],
        });
        continue;
      }
      selected.push(optionalCandidate);
      ownerByDemand.set(demand.id, optionalCandidate);
      estimatedSteps = tentativeSteps;
    }

    const selectedIds = new Set(selected.map(({ decision }) => decision.skill.id));
    for (const candidate of candidates) {
      if (selectedIds.has(candidate.decision.skill.id)) continue;
      if (rejected.some(({ skillId }) => skillId === candidate.decision.skill.id)) continue;
      rejected.push({
        skillId: candidate.decision.skill.id,
        reasonCode: 'overlap_not_selected',
        relatedIds: candidate.demandIds,
      });
    }

    const demandCoverage = input.capabilityDemandGraph.demands.flatMap((demand): DemandCoverageDecision[] => {
      const owner = ownerByDemand.get(demand.id);
      if (!owner) return [];
      return [{
        demandId: demand.id,
        demandType: demand.type,
        ownerSkillId: owner.decision.skill.id,
        corroboratorSkillIds: [],
        questionIds: [...demand.questionIds],
        requestedArtifactTypes: [...demand.requestedArtifactTypes],
        required: demand.priority === 'required',
      }];
    });

    const demandOrder = new Map(
      input.capabilityDemandGraph.demands.map((demand, index) => [demand.id, index]),
    );
    const selectedForOutput = [...selected].sort((left, right) => {
      const leftIndex = Math.min(...left.demandIds.map((id) => demandOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
      const rightIndex = Math.min(...right.demandIds.map((id) => demandOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
      return leftIndex - rightIndex || left.decision.skill.id.localeCompare(right.decision.skill.id);
    });
    const invocations: PortfolioInvocationDecision[] = selectedForOutput.map((candidate) => {
      const ownedDemands = demandCoverage
        .filter(({ ownerSkillId }) => ownerSkillId === candidate.decision.skill.id)
        .map(({ demandId }) => demandsById.get(demandId)!)
        .filter(Boolean);
      return {
        invocationId: `invocation:${candidate.decision.skill.id}`,
        skillId: candidate.decision.skill.id,
        role: 'contributor',
        demandIds: ownedDemands.map(({ id }) => id),
        contributionTypes: [...new Set(ownedDemands.map(({ type }) => type))],
        questionIds: [...new Set(ownedDemands.flatMap(({ questionIds }) => questionIds))],
        requestedArtifactTypes: [...new Set(ownedDemands.flatMap(({ requestedArtifactTypes }) => requestedArtifactTypes))],
        required: ownedDemands.some(({ priority }) => priority === 'required'),
        failurePolicy: ownedDemands.some(({ priority }) => priority === 'required') ? 'block' : 'gap',
        estimatedSteps: candidate.estimatedSteps,
        reasonCodes: ['required_demand_coverage', 'semantic_recall'],
      };
    });
    invocations.push({
      invocationId: `invocation:${synthesizer.skill.id}`,
      skillId: synthesizer.skill.id,
      role: 'synthesizer',
      demandIds: synthesizerOwnedDemands.map(({ id }) => id),
      contributionTypes: [...(synthesizerComposition.contribution_types ?? [])],
      questionIds: [...new Set(input.capabilityDemandGraph.demands.flatMap(({ questionIds }) => questionIds))],
      requestedArtifactTypes: [...new Set(input.capabilityDemandGraph.demands.flatMap(({ requestedArtifactTypes }) => requestedArtifactTypes))],
      required: true,
      failurePolicy: 'block',
      estimatedSteps: synthesizerCoverage.estimatedSteps,
      reasonCodes: synthesizerOwnedDemands.length > 0
        ? ['deliverable_policy_owner', 'single_skill_demand_coverage']
        : ['deliverable_policy_owner'],
    });

    return {
      invocations,
      demandCoverage,
      rejected,
      sharedPrerequisites: selectedSharedPrerequisites(
        [...selected, synthesizerCoverage],
        input.shareableKnowledgeBySkill,
      ),
      estimatedBudget: {
        profileId: input.profile.id,
        maxSteps: input.profile.max_steps,
        estimatedSteps,
        selectedContributorCount: selected.length,
        selectedSkillCount: selected.length + 1,
        requiredDemandCount: requiredDemands.length,
        optionalDemandCount: optionalDemands.length,
      },
    };
  }
}

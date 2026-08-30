import type { RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type { ResearchStrategyContentBlockDraftV2 } from '../../../../packages/api-contract/research-deliverable.ts';

export type ResearchStrategyContentBlockKind = ResearchStrategyContentBlockDraftV2['kind'];

const KIND_BY_ARTIFACT: Partial<Record<RequestedArtifact, readonly ResearchStrategyContentBlockKind[]>> = {
  strategy_map: ['strategy_map'],
  mind_model: ['mind_model'],
  design_principles: ['design_principles'],
  opportunity_backlog: ['opportunity_backlog'],
  prioritized_actions: ['prioritized_actions'],
  channel_strategies: ['channel_strategies'],
  action_plan: ['action_plan'],
};

export function contentBlockMatchesRequestedArtifact(
  artifact: RequestedArtifact,
  blockKind: ResearchStrategyContentBlockKind,
): boolean {
  if (artifact === 'research_report') return true;
  return KIND_BY_ARTIFACT[artifact]?.includes(blockKind) ?? false;
}

export function requestedArtifactHasContentBlock(
  artifact: RequestedArtifact,
  blocks: readonly { kind: ResearchStrategyContentBlockKind }[],
): boolean {
  return blocks.some(({ kind }) => contentBlockMatchesRequestedArtifact(artifact, kind));
}

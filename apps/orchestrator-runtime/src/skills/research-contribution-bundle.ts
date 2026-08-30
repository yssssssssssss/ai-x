import type {
  ResearchContributionBundleV1,
  ResearchContributionV1,
} from '../../../../packages/api-contract/research-deliverable.ts';

import { SchemaValidator } from '../schema/validator.ts';

export interface ContributionBundleInvocationPolicy {
  invocationId: string;
  skillId: string;
  role: 'contributor' | 'synthesizer';
  required: boolean;
  failurePolicy: 'block' | 'gap';
  dependsOnInvocationIds: string[];
}

export class ResearchContributionBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchContributionBundleError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildResearchContributionBundle(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  orderedInvocationIds: readonly string[];
  valuesByInvocationId: Readonly<Record<string, unknown>>;
  policiesByInvocationId: ReadonlyMap<string, ContributionBundleInvocationPolicy>;
  synthesizerInvocationId: string;
  validator?: SchemaValidator;
}): ResearchContributionBundleV1 {
  const synthesizer = input.policiesByInvocationId.get(input.synthesizerInvocationId);
  if (!synthesizer || synthesizer.role !== 'synthesizer') {
    throw new ResearchContributionBundleError('Synthesizer invocation policy is missing');
  }
  if (new Set(input.orderedInvocationIds).size !== input.orderedInvocationIds.length) {
    throw new ResearchContributionBundleError('Contribution order contains duplicate invocations');
  }
  const entries: ResearchContributionBundleV1['entries'] = [];
  const gaps: ResearchContributionBundleV1['gaps'] = [];
  for (const invocationId of input.orderedInvocationIds) {
    const policy = input.policiesByInvocationId.get(invocationId);
    if (
      !policy
      || policy.role !== 'contributor'
      || !synthesizer.dependsOnInvocationIds.includes(invocationId)
    ) throw new ResearchContributionBundleError(`Contribution ${invocationId} is not an authorized dependency`);
    const value = input.valuesByInvocationId[invocationId];
    if (value === null || value === undefined) {
      if (policy.required || policy.failurePolicy !== 'gap') {
        throw new ResearchContributionBundleError(`Required Contribution ${invocationId} is missing`);
      }
      gaps.push({
        invocationId,
        skillId: policy.skillId,
        reason: 'Optional Contributor produced no sealed Contribution Artifact.',
      });
      continue;
    }
    if (
      !isRecord(value)
      || typeof value.artifactId !== 'string'
      || typeof value.artifactContentSha256 !== 'string'
      || !isRecord(value.contribution)
    ) throw new ResearchContributionBundleError(`Contribution ${invocationId} binding is malformed`);
    const contribution = value.contribution as unknown as ResearchContributionV1;
    if (
      contribution.version !== 'research-contribution-v1'
      || contribution.taskId !== input.taskId
      || contribution.planVersionId !== input.planVersionId
      || contribution.attemptId !== input.attemptId
      || contribution.invocationId !== invocationId
      || contribution.skillId !== policy.skillId
    ) throw new ResearchContributionBundleError(`Contribution ${invocationId} identity is invalid`);
    entries.push({
      invocationId,
      skillId: policy.skillId,
      artifactId: value.artifactId,
      artifactContentSha256: value.artifactContentSha256,
      contribution,
    });
  }
  const bundle: ResearchContributionBundleV1 = {
    version: 'research-contribution-bundle-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    orderedInvocationIds: [...input.orderedInvocationIds],
    entries,
    gaps,
  };
  (input.validator ?? new SchemaValidator()).validateOrThrow(
    'research-contribution-bundle-v1',
    bundle,
  );
  return bundle;
}

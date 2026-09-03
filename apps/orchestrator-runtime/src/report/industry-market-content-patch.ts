import type {
  IndustryMarketAnalysisPayloadV1,
  IndustryMarketContentDraftV1,
  IndustryMarketContentPatchV1,
  IndustryMarketPatchableTextField,
  IndustryMarketSupportV1,
} from '../../../../packages/api-contract/research-deliverable.ts';

export class IndustryMarketContentPatchError extends Error {
  constructor(message: string) {
    super(`Industry Market content Patch is invalid: ${message}`);
    this.name = 'IndustryMarketContentPatchError';
  }
}

interface PatchTarget {
  value: Record<string, unknown>;
  textFields: ReadonlySet<IndustryMarketPatchableTextField>;
  support: boolean;
}

const TEXT_FIELDS = {
  root: ['title'],
  validatedFindings: ['statement'],
  gapMatrix: ['userNeed', 'jdState', 'competitorSupply'],
  opportunities: ['title', 'statement'],
  strategyChains: [
    'title', 'goal', 'currentProblem', 'competitorReference', 'designAction',
    'ownerType', 'measurement', 'validationMethod',
  ],
  categoryAssets: ['name', 'rationale', 'platformInheritance', 'categoryDelta'],
  measurementPlan: ['name', 'definition', 'baseline', 'target', 'validationMethod'],
  dataGaps: ['statement', 'impact', 'resolutionPath'],
} as const satisfies Record<string, readonly IndustryMarketPatchableTextField[]>;

function fail(message: string): never {
  throw new IndustryMarketContentPatchError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function targets(draft: IndustryMarketContentDraftV1): Map<string, PatchTarget> {
  const result = new Map<string, PatchTarget>();
  result.set('root', {
    value: draft as unknown as Record<string, unknown>,
    textFields: new Set(TEXT_FIELDS.root),
    support: false,
  });
  for (const [collection, fields] of Object.entries(TEXT_FIELDS)) {
    if (collection === 'root') continue;
    const values = (draft as unknown as Record<string, unknown>)[collection];
    if (!Array.isArray(values)) return fail(`${collection} is not an array`);
    for (const candidate of values) {
      const value = object(candidate, `${collection} item`);
      const id = value.id;
      if (typeof id !== 'string' || !id.trim()) return fail(`${collection} item has no id`);
      if (result.has(id)) return fail(`duplicate patch target ${id}`);
      result.set(id, {
        value,
        textFields: new Set(fields),
        support: collection !== 'dataGaps',
      });
    }
  }
  return result;
}

function assertAuthorized(
  operation: IndustryMarketContentPatchV1['operations'][number],
  allowedReviewIssueTargets: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const allowed = allowedReviewIssueTargets.get(operation.reviewIssueId);
  if (!allowed) return fail(`operation references unknown Review issue ${operation.reviewIssueId}`);
  if (!allowed.has(operation.targetNodeId)) {
    return fail(`Review issue ${operation.reviewIssueId} does not authorize ${operation.targetNodeId}`);
  }
}

function cleanText(value: string, label: string): string {
  if (!value.trim()) return fail(`${label} must not be empty`);
  return value.trim();
}

function supportRank(status: IndustryMarketSupportV1['status']): number {
  return status === 'supported' ? 2 : status === 'provisional' ? 1 : 0;
}

function assertSupportDoesNotUpgrade(
  current: IndustryMarketSupportV1,
  replacement: IndustryMarketSupportV1,
  targetNodeId: string,
): void {
  if (
    JSON.stringify(current.questionIds) !== JSON.stringify(replacement.questionIds)
    || JSON.stringify(current.evidenceIds) !== JSON.stringify(replacement.evidenceIds)
    || JSON.stringify(current.sourceContributionUnitIds ?? [])
      !== JSON.stringify(replacement.sourceContributionUnitIds ?? [])
  ) return fail(`${targetNodeId} support Patch cannot replace question or Evidence bindings`);
  if (
    supportRank(replacement.status) > supportRank(current.status)
    || replacement.confidence > current.confidence
  ) return fail(`${targetNodeId} support Patch cannot increase certainty`);
}

export function industryMarketDraftFromPayload(
  payload: IndustryMarketAnalysisPayloadV1,
): IndustryMarketContentDraftV1 {
  const { schemaVersion: _schemaVersion, ...content } = structuredClone(payload);
  return { ...content, schemaVersion: 'industry-market-content-draft-v1' };
}

export function applyIndustryMarketContentPatch(input: {
  source: IndustryMarketContentDraftV1;
  patch: IndustryMarketContentPatchV1;
  allowedReviewIssueTargets: ReadonlyMap<string, ReadonlySet<string>>;
}): { draft: IndustryMarketContentDraftV1; operations: string[] } {
  if (input.patch.version !== 'industry-market-content-patch-v1') return fail('version is invalid');
  if (!Array.isArray(input.patch.operations) || input.patch.operations.length === 0) {
    return fail('at least one operation is required');
  }
  const draft = structuredClone(input.source);
  const byId = targets(draft);
  const seen = new Set<string>();
  const operations: string[] = [];
  for (const operation of input.patch.operations) {
    assertAuthorized(operation, input.allowedReviewIssueTargets);
    const target = byId.get(operation.targetNodeId);
    if (!target) return fail(`unknown patch target ${operation.targetNodeId}`);
    const key = `${operation.op}:${operation.targetNodeId}:${operation.op === 'replace_text' ? operation.field : 'support'}`;
    if (seen.has(key)) return fail(`duplicate operation ${key}`);
    seen.add(key);
    if (operation.op === 'replace_text') {
      if (!target.textFields.has(operation.field)) {
        return fail(`${operation.field} is not patchable on ${operation.targetNodeId}`);
      }
      target.value[operation.field] = cleanText(operation.value, `${operation.targetNodeId}.${operation.field}`);
      operations.push(key);
      continue;
    }
    if (operation.op === 'replace_support') {
      if (!target.support || !('support' in target.value)) {
        return fail(`${operation.targetNodeId} has no patchable support`);
      }
      const currentSupport = object(target.value.support, `${operation.targetNodeId}.support`) as unknown as IndustryMarketSupportV1;
      assertSupportDoesNotUpgrade(currentSupport, operation.value, operation.targetNodeId);
      target.value.support = structuredClone(operation.value) as IndustryMarketSupportV1;
      operations.push(key);
      continue;
    }
    return fail('operation type is unsupported');
  }
  return { draft, operations };
}

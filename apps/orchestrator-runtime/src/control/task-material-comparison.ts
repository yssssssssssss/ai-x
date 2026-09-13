import type {
  TaskMaterialBinding,
  TaskMaterialComparison,
} from '../../../../packages/api-contract/control-workflow.ts';

export interface MaterialComparisonRequest {
  id: string;
  role: string;
  multiple: boolean;
}

export interface MaterialComparisonPairReference {
  pairId: string;
  label: string;
  side: 'primary' | 'comparison';
  sequence: number;
}

export class TaskMaterialComparisonError extends Error {
  readonly code = 'task_material_comparison_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'TaskMaterialComparisonError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function materialIdsByRequest(bindings: readonly TaskMaterialBinding[]): Map<string, string[]> {
  return new Map(bindings.map((binding) => [binding.requestId, [...binding.materialIds]]));
}

function sameSet(actual: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}

export function normalizeTaskMaterialComparison(input: {
  value: unknown;
  requests: readonly MaterialComparisonRequest[];
  bindings: readonly TaskMaterialBinding[];
}): TaskMaterialComparison | undefined {
  if (input.value === undefined) return undefined;
  const value = record(input.value);
  if (
    !value
    || Object.keys(value).some((key) => ![
      'mode', 'primaryRequestId', 'comparisonRequestId', 'pairs',
    ].includes(key))
  ) {
    throw new TaskMaterialComparisonError('图片对比配置格式无效');
  }
  const mode = value.mode;
  const primaryRequestId = nonEmptyString(value.primaryRequestId);
  const comparisonRequestId = nonEmptyString(value.comparisonRequestId);
  if (
    (mode !== 'grouped' && mode !== 'paired')
    || !primaryRequestId
    || !comparisonRequestId
    || primaryRequestId === comparisonRequestId
    || !Array.isArray(value.pairs)
  ) {
    throw new TaskMaterialComparisonError('图片对比模式或材料入口无效');
  }
  const requests = new Map(input.requests.map((request) => [request.id, request]));
  const primaryRequest = requests.get(primaryRequestId);
  const comparisonRequest = requests.get(comparisonRequestId);
  if (!primaryRequest || !comparisonRequest || !primaryRequest.multiple || !comparisonRequest.multiple) {
    throw new TaskMaterialComparisonError('图片对比必须引用两个支持多图的材料入口');
  }
  const selected = materialIdsByRequest(input.bindings);
  const expectedPrimary = new Set(selected.get(primaryRequestId) ?? []);
  const expectedComparison = new Set(selected.get(comparisonRequestId) ?? []);
  if (mode === 'grouped') {
    if (expectedPrimary.size === 0 && expectedComparison.size === 0) {
      throw new TaskMaterialComparisonError('分组对比至少需要一张已选图片');
    }
    if (value.pairs.length !== 0) {
      throw new TaskMaterialComparisonError('分组对比不能携带一一配对关系');
    }
    return {
      mode,
      primaryRequestId,
      comparisonRequestId,
      pairs: [],
    };
  }

  if (expectedPrimary.size === 0 || expectedComparison.size === 0) {
    throw new TaskMaterialComparisonError('一一配对的两侧都必须提供材料');
  }
  const pairs = value.pairs.map((candidate, index) => {
    const pair = record(candidate);
    if (
      !pair
      || Object.keys(pair).some((key) => ![
        'label', 'primaryMaterialId', 'comparisonMaterialId',
      ].includes(key))
    ) {
      throw new TaskMaterialComparisonError(`第 ${index + 1} 个图片对比项格式无效`);
    }
    const label = nonEmptyString(pair.label);
    const primaryMaterialId = nonEmptyString(pair.primaryMaterialId);
    const comparisonMaterialId = nonEmptyString(pair.comparisonMaterialId);
    if (!label || !primaryMaterialId || !comparisonMaterialId || label.length > 120) {
      throw new TaskMaterialComparisonError(`第 ${index + 1} 个图片对比项不完整`);
    }
    return { label, primaryMaterialId, comparisonMaterialId };
  });
  const pairedPrimary = new Set(pairs.map(({ primaryMaterialId }) => primaryMaterialId));
  const pairedComparison = new Set(pairs.map(({ comparisonMaterialId }) => comparisonMaterialId));
  if (
    pairs.length === 0
    || pairedPrimary.size !== pairs.length
    || pairedComparison.size !== pairs.length
    || !sameSet(pairedPrimary, expectedPrimary)
    || !sameSet(pairedComparison, expectedComparison)
  ) {
    throw new TaskMaterialComparisonError('一一配对必须完整且不重复地覆盖两侧全部已选图片');
  }
  return {
    mode,
    primaryRequestId,
    comparisonRequestId,
    pairs,
  };
}

export function storedTaskMaterialComparison(value: unknown): TaskMaterialComparison | undefined {
  const clarification = record(value);
  const comparison = record(clarification?.materialComparison);
  if (!comparison) return undefined;
  const mode = comparison.mode;
  const primaryRequestId = nonEmptyString(comparison.primaryRequestId);
  const comparisonRequestId = nonEmptyString(comparison.comparisonRequestId);
  if (
    (mode !== 'grouped' && mode !== 'paired')
    || !primaryRequestId
    || !comparisonRequestId
    || !Array.isArray(comparison.pairs)
  ) return undefined;
  const pairs = comparison.pairs.flatMap((candidate): TaskMaterialComparison['pairs'] => {
    const pair = record(candidate);
    const label = nonEmptyString(pair?.label);
    const primaryMaterialId = nonEmptyString(pair?.primaryMaterialId);
    const comparisonMaterialId = nonEmptyString(pair?.comparisonMaterialId);
    return label && primaryMaterialId && comparisonMaterialId
      ? [{ label, primaryMaterialId, comparisonMaterialId }]
      : [];
  });
  if (pairs.length !== comparison.pairs.length) return undefined;
  return { mode, primaryRequestId, comparisonRequestId, pairs };
}

export function materialComparisonReferences(
  comparison: TaskMaterialComparison | undefined,
): Map<string, MaterialComparisonPairReference> {
  if (!comparison || comparison.mode !== 'paired') return new Map();
  const references = new Map<string, MaterialComparisonPairReference>();
  comparison.pairs.forEach((pair, index) => {
    const sequence = index + 1;
    const pairId = `PAIR-${String(sequence).padStart(3, '0')}`;
    references.set(pair.primaryMaterialId, {
      pairId,
      label: pair.label,
      side: 'primary',
      sequence,
    });
    references.set(pair.comparisonMaterialId, {
      pairId,
      label: pair.label,
      side: 'comparison',
      sequence,
    });
  });
  return references;
}

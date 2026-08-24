import { createHash } from 'node:crypto';

import type {
  ResearchStrategyContentBlockDraftV2,
  ResearchStrategyContentDraftV2,
} from '../../../../packages/api-contract/research-deliverable.ts';

export type ResearchStrategyContentUnitKind =
  | 'root_field'
  | 'direct_answer'
  | 'evidence_finding'
  | 'content_block'
  | 'block_item'
  | 'matrix_cell'
  | 'mind_node'
  | 'mind_edge'
  | 'limitation'
  | 'open_question';

export interface ResearchStrategyContentUnitFingerprint {
  sourceKey: string;
  kind: ResearchStrategyContentUnitKind;
  semanticHash: string;
  parentKey?: string;
}

export interface ResearchStrategyContentFidelityResult {
  sourceUnitCount: number;
  candidateUnitCount: number;
  preservedUnitCount: number;
  addedUnitKeys: string[];
  removedUnitKeys: string[];
  changedSemanticUnitKeys: string[];
  reorderedUnitKeys: string[];
}

export class ResearchStrategyContentFidelityError extends Error {
  constructor(
    message: string,
    readonly result: ResearchStrategyContentFidelityResult,
  ) {
    super(`Research strategy content fidelity failed: ${message}`);
    this.name = 'ResearchStrategyContentFidelityError';
  }
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function unit(
  sourceKey: string,
  kind: ResearchStrategyContentUnitKind,
  semanticValue: unknown,
  parentKey?: string,
): ResearchStrategyContentUnitFingerprint {
  return {
    sourceKey,
    kind,
    semanticHash: hash(semanticValue),
    ...(parentKey ? { parentKey } : {}),
  };
}

function blockUnits(block: ResearchStrategyContentBlockDraftV2): ResearchStrategyContentUnitFingerprint[] {
  const parentKey = `content-block:${block.key}`;
  if (block.kind === 'narrative') {
    return [
      unit(parentKey, 'content_block', { kind: block.kind, title: block.title }),
      unit(`${parentKey}:content`, 'block_item', { content: block.content }, parentKey),
    ];
  }
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    return [
      unit(parentKey, 'content_block', {
        kind: block.kind,
        title: block.title,
        rows: block.rows,
        columns: block.columns,
      }),
      ...block.cells.map((cell) => unit(
        `${parentKey}:cell:${cell.key}`,
        'matrix_cell',
        { row: cell.row, column: cell.column, statement: cell.statement },
        parentKey,
      )),
    ];
  }
  if (block.kind === 'mind_model') {
    return [
      unit(parentKey, 'content_block', { kind: block.kind, title: block.title }),
      ...block.nodes.map((node) => unit(
        `${parentKey}:node:${node.key}`,
        'mind_node',
        { label: node.label, description: node.description },
        parentKey,
      )),
      ...block.edges.map((edge, index) => unit(
        `${parentKey}:edge:${String(index + 1).padStart(3, '0')}`,
        'mind_edge',
        edge,
        parentKey,
      )),
    ];
  }
  if (block.kind === 'design_principles') {
    return [
      unit(parentKey, 'content_block', { kind: block.kind, title: block.title }),
      ...block.items.map((item) => unit(
        `${parentKey}:item:${item.key}`,
        'block_item',
        { title: item.title, statement: item.statement },
        parentKey,
      )),
    ];
  }
  if (block.kind === 'opportunity_backlog') {
    return [
      unit(parentKey, 'content_block', { kind: block.kind, title: block.title }),
      ...block.items.map((item) => unit(
        `${parentKey}:item:${item.key}`,
        'block_item',
        { title: item.title, statement: item.statement, impact: item.impact },
        parentKey,
      )),
    ];
  }
  if (block.kind === 'prioritized_actions' || block.kind === 'action_plan') {
    return [
      unit(parentKey, 'content_block', { kind: block.kind, title: block.title }),
      ...block.items.map((item) => unit(
        `${parentKey}:item:${item.key}`,
        'block_item',
        {
          priority: item.priority,
          action: item.action,
          ownerType: item.ownerType,
          rationale: item.rationale,
          validationMethod: item.validationMethod,
        },
        parentKey,
      )),
    ];
  }
  if (block.kind === 'channel_strategies') {
    return [
      unit(parentKey, 'content_block', { kind: block.kind, title: block.title }),
      ...block.items.map((item) => unit(
        `${parentKey}:item:${item.key}`,
        'block_item',
        { channel: item.channel, role: item.role, strategies: item.strategies },
        parentKey,
      )),
    ];
  }
  throw new Error(`Unsupported research strategy content Block ${(block as { kind?: unknown }).kind as string}`);
}

function assertUniqueKeys(units: readonly ResearchStrategyContentUnitFingerprint[]): void {
  const seen = new Set<string>();
  for (const candidate of units) {
    if (seen.has(candidate.sourceKey)) {
      throw new ResearchStrategyContentFidelityError(`duplicate content unit ${candidate.sourceKey}`, {
        sourceUnitCount: units.length,
        candidateUnitCount: units.length,
        preservedUnitCount: 0,
        addedUnitKeys: [],
        removedUnitKeys: [],
        changedSemanticUnitKeys: [],
        reorderedUnitKeys: [],
      });
    }
    seen.add(candidate.sourceKey);
  }
}

export function inventoryResearchStrategyContent(
  draft: ResearchStrategyContentDraftV2,
): ResearchStrategyContentUnitFingerprint[] {
  const units: ResearchStrategyContentUnitFingerprint[] = [
    unit('root:title', 'root_field', draft.title),
    unit('root:decisionContext', 'root_field', draft.decisionContext),
    unit('root:executiveAnswer', 'root_field', draft.executiveAnswer),
    unit('root:methodSummary', 'root_field', draft.methodSummary),
    ...draft.directAnswers.map((answer, index) => unit(
      `direct-answer:${String(index + 1).padStart(3, '0')}`,
      'direct_answer',
      {
        question: answer.question,
        answer: answer.answer,
        businessImplication: answer.businessImplication,
        recommendedAction: answer.recommendedAction,
      },
    )),
    ...draft.evidenceFindings.map((finding) => unit(
      `evidence-finding:${finding.key}`,
      'evidence_finding',
      { statement: finding.statement },
    )),
    ...draft.contentBlocks.flatMap(blockUnits),
    ...draft.limitations.map((value, index) => unit(
      `limitation:${String(index + 1).padStart(3, '0')}`,
      'limitation',
      value,
    )),
    ...draft.openQuestions.map((value, index) => unit(
      `open-question:${String(index + 1).padStart(3, '0')}`,
      'open_question',
      value,
    )),
  ];
  assertUniqueKeys(units);
  return units;
}

export function compareResearchStrategyContentFidelity(
  source: ResearchStrategyContentDraftV2,
  candidate: ResearchStrategyContentDraftV2,
): ResearchStrategyContentFidelityResult {
  const sourceUnits = inventoryResearchStrategyContent(source);
  const candidateUnits = inventoryResearchStrategyContent(candidate);
  const sourceByKey = new Map(sourceUnits.map((candidateUnit) => [candidateUnit.sourceKey, candidateUnit]));
  const candidateByKey = new Map(candidateUnits.map((candidateUnit) => [candidateUnit.sourceKey, candidateUnit]));
  const removedUnitKeys = sourceUnits
    .filter(({ sourceKey }) => !candidateByKey.has(sourceKey))
    .map(({ sourceKey }) => sourceKey);
  const addedUnitKeys = candidateUnits
    .filter(({ sourceKey }) => !sourceByKey.has(sourceKey))
    .map(({ sourceKey }) => sourceKey);
  const changedSemanticUnitKeys = sourceUnits.flatMap((sourceUnit) => {
    const candidateUnit = candidateByKey.get(sourceUnit.sourceKey);
    return candidateUnit && candidateUnit.semanticHash !== sourceUnit.semanticHash
      ? [sourceUnit.sourceKey]
      : [];
  });
  const sourceOrder = sourceUnits.map(({ sourceKey }) => sourceKey);
  const candidateOrderForSourceUnits = candidateUnits
    .map(({ sourceKey }) => sourceKey)
    .filter((sourceKey) => sourceByKey.has(sourceKey));
  const reorderedUnitKeys = sourceOrder.filter((sourceKey, index) => (
    candidateOrderForSourceUnits[index] !== sourceKey
  ));
  return {
    sourceUnitCount: sourceUnits.length,
    candidateUnitCount: candidateUnits.length,
    preservedUnitCount: sourceUnits.length - removedUnitKeys.length - changedSemanticUnitKeys.length,
    addedUnitKeys,
    removedUnitKeys,
    changedSemanticUnitKeys,
    reorderedUnitKeys,
  };
}

export function assertStructuralRepairFidelity(
  source: ResearchStrategyContentDraftV2,
  candidate: ResearchStrategyContentDraftV2,
): ResearchStrategyContentFidelityResult {
  const result = compareResearchStrategyContentFidelity(source, candidate);
  if (result.removedUnitKeys.length > 0) {
    throw new ResearchStrategyContentFidelityError(
      `structural repair removed ${result.removedUnitKeys.join(', ')}`,
      result,
    );
  }
  if (result.changedSemanticUnitKeys.length > 0) {
    throw new ResearchStrategyContentFidelityError(
      `structural repair changed ${result.changedSemanticUnitKeys.join(', ')}`,
      result,
    );
  }
  if (result.reorderedUnitKeys.length > 0) {
    throw new ResearchStrategyContentFidelityError(
      `structural repair reordered ${result.reorderedUnitKeys.join(', ')}`,
      result,
    );
  }
  return result;
}

export function assertSemanticRevisionFidelity(
  source: ResearchStrategyContentDraftV2,
  candidate: ResearchStrategyContentDraftV2,
  allowedChangedUnitKeys: ReadonlySet<string>,
): ResearchStrategyContentFidelityResult {
  const result = compareResearchStrategyContentFidelity(source, candidate);
  const unauthorizedChanges = result.changedSemanticUnitKeys.filter((key) => !allowedChangedUnitKeys.has(key));
  if (result.removedUnitKeys.length > 0) {
    throw new ResearchStrategyContentFidelityError(
      `semantic revision removed ${result.removedUnitKeys.join(', ')}`,
      result,
    );
  }
  if (unauthorizedChanges.length > 0) {
    throw new ResearchStrategyContentFidelityError(
      `semantic revision changed unauthorized units ${unauthorizedChanges.join(', ')}`,
      result,
    );
  }
  if (result.reorderedUnitKeys.length > 0) {
    throw new ResearchStrategyContentFidelityError(
      `semantic revision reordered ${result.reorderedUnitKeys.join(', ')}`,
      result,
    );
  }
  return result;
}

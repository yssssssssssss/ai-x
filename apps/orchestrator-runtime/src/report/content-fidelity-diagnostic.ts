import type { ResearchStrategyContentFidelityResult } from './research-strategy-content-fidelity.ts';

export interface ContentFidelityDiagnosticV1 extends ResearchStrategyContentFidelityResult {
  version: 'content-fidelity-diagnostic-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  round: number;
  mode: 'none' | 'structural_repair' | 'semantic_revision';
  normalizationOperations: string[];
  repairOperations: string[];
}

export function createContentFidelityDiagnostic(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  round: number;
  mode: ContentFidelityDiagnosticV1['mode'];
  result: ResearchStrategyContentFidelityResult;
  normalizationOperations?: readonly string[];
  repairOperations?: readonly string[];
}): ContentFidelityDiagnosticV1 {
  return {
    version: 'content-fidelity-diagnostic-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    round: input.round,
    mode: input.mode,
    ...input.result,
    normalizationOperations: [...new Set(input.normalizationOperations ?? [])],
    repairOperations: [...new Set(input.repairOperations ?? [])],
  };
}

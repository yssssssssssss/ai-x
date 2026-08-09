import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EvidenceGraphValidationError,
  EvidenceService,
  type EvidenceManifest,
  type FindingGraph,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';

const service = new EvidenceService();

function manifest(): EvidenceManifest {
  return service.createManifest({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    collectedAt: '2026-08-09T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      artifactHash: 'sha256:tool-output',
      jsonPointer: '/results/0',
      sourceUrl: 'https://example.test/product',
      stepNo: 1,
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        outputHash: 'sha256:tool-output',
      },
      sensitivity: 'public',
      redaction: 'masked',
    }],
  });
}

test('builds a manifest and validates an evidence-rooted finding graph', () => {
  const evidence = manifest();
  const graph: FindingGraph = {
    findings: [{
      id: 'F1',
      kind: 'fact',
      evidenceIds: ['E1'],
      statement: '产品页公开列出了实时互动能力',
    }],
    analyses: [{
      id: 'A1',
      findingIds: ['F1'],
      statement: '实时互动是竞品共同能力',
    }],
    subQuestionSummaries: [{
      id: 'S1',
      findingIds: ['F1'],
      analysisIds: ['A1'],
      summary: '公开资料支持实时互动结论',
    }],
    overallConclusions: [{
      id: 'C1',
      summaryIds: ['S1'],
      statement: '实时互动应作为基础能力比较项',
    }],
  };

  assert.doesNotThrow(() => service.validateFindingGraph({ manifest: evidence, graph }));
});

test('rejects fake Tool evidence presented as an external competitor fact', () => {
  const evidence = manifest();
  evidence.entries[0] = {
    ...evidence.entries[0],
    toolProof: {
      implementationId: 'fake-o2',
      executionMode: 'fake',
      outputHash: 'sha256:tool-output',
    },
  };

  assert.throws(
    () => service.validateFindingGraph({
      manifest: evidence,
      graph: {
        findings: [{ id: 'F1', kind: 'fact', evidenceIds: ['E1'], statement: '伪造事实' }],
        analyses: [],
        subQuestionSummaries: [],
        overallConclusions: [],
      },
    }),
    EvidenceGraphValidationError,
  );
});

test('rejects evidence whose JSON pointer cannot resolve in its Tool output', () => {
  const evidence = manifest();
  evidence.entries[0] = { ...evidence.entries[0], jsonPointer: '/results/9' };
  const outputByHash = new Map<string, unknown>([[
    'sha256:tool-output',
    { results: [{ title: 'source' }] },
  ]]);
  assert.throws(
    () => service.validateManifest(evidence, {
      resolveOutput: (hash) => outputByHash.get(hash) ?? null,
    }),
    EvidenceGraphValidationError,
  );
});

test('rejects missing pointers, unrooted conclusions, and inference cycles', () => {
  const badManifest = manifest();
  badManifest.entries[0] = { ...badManifest.entries[0], jsonPointer: 'results/0' };
  assert.throws(() => service.validateManifest(badManifest), EvidenceGraphValidationError);

  assert.throws(
    () => service.validateFindingGraph({
      manifest: manifest(),
      graph: {
        findings: [{ id: 'F1', kind: 'inference', findingIds: ['F2'], statement: '无根推断' }, { id: 'F2', kind: 'inference', findingIds: ['F1'], statement: '循环推断' }],
        analyses: [],
        subQuestionSummaries: [],
        overallConclusions: [{ id: 'C1', summaryIds: [], statement: '无根结论' }],
      },
    }),
    EvidenceGraphValidationError,
  );
});

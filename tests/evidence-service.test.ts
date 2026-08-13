import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EvidenceGraphValidationError,
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceEntry,
  type EvidenceManifest,
  type FindingGraph,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type { EvidenceClass as SharedEvidenceClass } from '../packages/api-contract/research-deliverable.ts';

const service = new EvidenceService();
const fixtureArtifactId = 'artifact-fixture-1';
const fixtureArtifactContentSha256 = `sha256:${'a'.repeat(64)}`;
const fixtureSourceUrl = 'https://example.test/product';
const fixtureOutput = { results: [{ title: 'source', url: fixtureSourceUrl }] };
const fixtureRedactedOutputHash = `sha256:${createHash('sha256').update(JSON.stringify(fixtureOutput)).digest('hex')}`;
const fixtureResolver: EvidenceArtifactResolver = {
  resolveArtifact: (artifactId) => artifactId === fixtureArtifactId
    ? {
        artifact: { id: fixtureArtifactId, contentSha256: fixtureArtifactContentSha256 },
        value: {
          output: fixtureOutput,
          redactedOutputHash: fixtureRedactedOutputHash,
        },
      }
    : null,
};

function manifest(entryOverrides: Partial<EvidenceEntry> = {}): EvidenceManifest {
  return service.createManifest({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    collectedAt: '2026-08-09T00:00:00.000Z',
    entries: [{
      id: 'E1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      artifactId: fixtureArtifactId,
      artifactContentSha256: fixtureArtifactContentSha256,
      jsonPointer: '/output/results/0',
      sourceUrl: fixtureSourceUrl,
      stepNo: 1,
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash: fixtureRedactedOutputHash,
      },
      sensitivity: 'public',
      redaction: 'masked',
      ...entryOverrides,
    }],
  }, fixtureResolver);
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

  assert.doesNotThrow(() => service.validateFindingGraph({ manifest: evidence, graph, resolver: fixtureResolver }));
});

test('accepts dataset evidence as factual support in a manifest and finding graph', () => {
  const datasetArtifactId = 'artifact-dataset-1';
  const datasetArtifactContentSha256 = `sha256:${'d'.repeat(64)}`;
  const datasetEvidenceClass: SharedEvidenceClass = 'dataset';
  const datasetResolver: EvidenceArtifactResolver = {
    resolveArtifact: (artifactId) => artifactId === datasetArtifactId
      ? {
          artifact: { id: datasetArtifactId, contentSha256: datasetArtifactContentSha256 },
          value: { rows: [{ id: 'row-1', value: 'verified dataset fact' }] },
        }
      : null,
  };

  assert.doesNotThrow(() => {
    const evidence = service.createManifest({
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      collectedAt: '2026-08-11T00:00:00.000Z',
      entries: [{
        id: 'E-dataset-1',
        kind: 'knowledge_excerpt',
        evidenceClass: datasetEvidenceClass as unknown as EvidenceEntry['evidenceClass'],
        artifactId: datasetArtifactId,
        artifactContentSha256: datasetArtifactContentSha256,
        jsonPointer: '/rows/0',
        sensitivity: 'internal',
        redaction: 'none',
      }],
    }, datasetResolver);
    service.validateFindingGraph({
      manifest: evidence,
      resolver: datasetResolver,
      graph: {
        findings: [{ id: 'F-dataset-1', kind: 'fact', evidenceIds: ['E-dataset-1'], statement: '数据集支持该事实' }],
        analyses: [],
        subQuestionSummaries: [],
        overallConclusions: [],
      },
    });
  });
});

test('rejects fake Tool evidence presented as an external competitor fact', () => {
  assert.throws(
    () => manifest({
      toolProof: {
        implementationId: 'fake-o2',
        executionMode: 'fake',
        redactedOutputHash: fixtureRedactedOutputHash,
      } as unknown as EvidenceEntry['toolProof'],
    }),
    EvidenceGraphValidationError,
  );
});

test('rejects evidence whose JSON pointer cannot resolve in its Tool output', () => {
  assert.throws(
    () => manifest({ jsonPointer: '/output/results/9' }),
    EvidenceGraphValidationError,
  );
});

test('rejects missing pointers, unrooted conclusions, and inference cycles', () => {
  assert.throws(
    () => manifest({ jsonPointer: 'output/results/0' }),
    EvidenceGraphValidationError,
  );

  assert.throws(
    () => service.validateFindingGraph({
      manifest: manifest(),
      resolver: fixtureResolver,
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

test('rejects a manifest whose contents drift from its manifest hash', () => {
  const evidence = manifest();
  evidence.taskId = 'task-drifted';
  assert.throws(
    () => service.validateManifest(evidence, fixtureResolver),
    EvidenceGraphValidationError,
  );
});

const sealedArtifactId = 'artifact-tool-output-1';
const sealedArtifactContentSha256 = `sha256:${'1'.repeat(64)}`;
const sealedSourceUrl = 'https://example.test/product';
const sealedOutput = {
  results: [
    { title: 'other source', url: 'https://example.test/other' },
    { oss_url: sealedSourceUrl, title: 'bound source' },
  ],
};
const sealedRedactedOutputHash = `sha256:${createHash('sha256').update(JSON.stringify(sealedOutput)).digest('hex')}`;

function sealedArtifactManifest(
  entryOverrides: Partial<EvidenceEntry> = {},
  resolver: EvidenceArtifactResolver = sealedArtifactResolver,
): EvidenceManifest {
  return service.createManifest({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    collectedAt: '2026-08-11T00:00:00.000Z',
    entries: [{
      id: 'E-sealed-1',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      artifactId: sealedArtifactId,
      artifactContentSha256: sealedArtifactContentSha256,
      jsonPointer: '/output/results/1',
      sourceUrl: sealedSourceUrl,
      stepNo: 1,
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash: sealedRedactedOutputHash,
      },
      sensitivity: 'public',
      redaction: 'masked',
      ...entryOverrides,
    }],
  }, resolver);
}

const sealedArtifactResolver: EvidenceArtifactResolver = {
  resolveArtifact: (artifactId) => artifactId === sealedArtifactId
    ? {
        artifact: {
          id: sealedArtifactId,
          contentSha256: sealedArtifactContentSha256,
        },
        value: {
          output: sealedOutput,
          redactedOutputHash: sealedRedactedOutputHash,
        },
      }
    : null,
};

test('accepts public evidence bound to a matching sealed Artifact oss_url result', () => {
  assert.doesNotThrow(() => service.validateManifest(
    sealedArtifactManifest(),
    sealedArtifactResolver,
  ));
});

test('rejects evidence whose content hash differs from its sealed Artifact', () => {
  assert.throws(
    () => service.validateManifest(
      sealedArtifactManifest({ artifactContentSha256: `sha256:${'f'.repeat(64)}` }),
      sealedArtifactResolver,
    ),
    EvidenceGraphValidationError,
  );
});

test('rejects evidence whose pointer does not resolve in its sealed Artifact value', () => {
  assert.throws(
    () => service.validateManifest(
      sealedArtifactManifest({ jsonPointer: '/output/results/9' }),
      sealedArtifactResolver,
    ),
    EvidenceGraphValidationError,
  );
});

test('rejects public evidence whose source URL differs from the resolved result URL', () => {
  assert.throws(
    () => service.validateManifest(
      sealedArtifactManifest({ sourceUrl: 'https://example.test/different-product' }),
      sealedArtifactResolver,
    ),
    EvidenceGraphValidationError,
  );
});

test('rejects public evidence whose proof hash differs from its sealed Artifact', () => {
  assert.throws(
    () => sealedArtifactManifest({
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash: `sha256:${'f'.repeat(64)}`,
      },
    }),
    EvidenceGraphValidationError,
  );
});

test('rejects matching proof metadata when the sealed output hash was not recomputed', () => {
  const forgedHash = `sha256:${'e'.repeat(64)}`;
  const forgedResolver: EvidenceArtifactResolver = {
    resolveArtifact: (artifactId) => artifactId === sealedArtifactId
      ? {
          artifact: {
            id: sealedArtifactId,
            contentSha256: sealedArtifactContentSha256,
          },
          value: {
            output: sealedOutput,
            redactedOutputHash: forgedHash,
          },
        }
      : null,
  };

  assert.throws(
    () => sealedArtifactManifest({
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash: forgedHash,
      },
    }, forgedResolver),
    EvidenceGraphValidationError,
  );
});
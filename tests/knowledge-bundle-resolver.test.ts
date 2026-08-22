import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntimeKnowledgeIndex } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import {
  KnowledgeBundleResolver,
  RequiredKnowledgeUnavailableError,
  type FrozenKnowledgeReference,
} from '../apps/orchestrator-runtime/src/knowledge/knowledge-bundle-resolver.ts';

function reference(id: string, overrides: Partial<FrozenKnowledgeReference> = {}): FrozenKnowledgeReference {
  const item = loadRuntimeKnowledgeIndex().find((candidate) => candidate.id === id);
  assert.ok(item, `fixture knowledge ${id} must exist`);
  assert.ok(item.status === 'approved' || item.status === 'draft');
  return {
    resourceId: item.id,
    sourcePath: item.source_path,
    status: item.status,
    contentHash: item.content_hash,
    required: true,
    failurePolicy: 'block',
    ...overrides,
  };
}

const binding = {
  taskId: 'task-knowledge-1',
  planVersionId: 'plan-knowledge-1',
  attemptId: 'attempt-knowledge-1',
  stepNo: 1,
  contractHash: `sha256:${'a'.repeat(64)}`,
};

test('resolves frozen knowledge IDs to a bound schema-valid bundle', () => {
  const result = new KnowledgeBundleResolver().resolve({
    ...binding,
    references: [
      reference('standard_requirement_elicitation'),
      reference('standard_research_project_workflow'),
      reference('standard_sampling'),
    ],
  });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.bundle.resources.map(({ id }) => id), [
    'standard_requirement_elicitation',
    'standard_research_project_workflow',
    'standard_sampling',
  ]);
  assert.ok(result.bundle.resources.every(({ content }) => content.length > 100));
});

test('required knowledge hash drift fails closed', () => {
  assert.throws(() => new KnowledgeBundleResolver().resolve({
    ...binding,
    references: [reference('standard_sampling', { contentHash: `sha256:${'b'.repeat(64)}` })],
  }), RequiredKnowledgeUnavailableError);
});

test('optional knowledge drift becomes one deterministic gap', () => {
  const result = new KnowledgeBundleResolver().resolve({
    ...binding,
    references: [reference('standard_sampling', {
      contentHash: `sha256:${'b'.repeat(64)}`,
      required: false,
      failurePolicy: 'gap',
    })],
  });
  assert.equal(result.bundle.resources.length, 0);
  assert.deepEqual(result.gaps.map(({ key }) => key), ['knowledge:standard_sampling:unavailable']);
});

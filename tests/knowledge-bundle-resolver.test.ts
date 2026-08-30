import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { failureFrom } from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import { contentHash } from '../apps/orchestrator-runtime/src/knowledge/normalizer.ts';
import {
  loadRuntimeKnowledgeIndex,
  resolveKnowledgeSourcePath,
} from '../apps/orchestrator-runtime/src/knowledge/index.ts';
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
    resourceType: item.type,
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

test('required knowledge path and hash drift fail closed', () => {
  assert.throws(() => new KnowledgeBundleResolver().resolve({
    ...binding,
    references: [reference('standard_sampling', { sourcePath: 'methods/other.md' })],
  }), (error: unknown) => (
    error instanceof RequiredKnowledgeUnavailableError && error.code === 'path_drift'
  ));
  assert.throws(() => new KnowledgeBundleResolver().resolve({
    ...binding,
    references: [reference('standard_sampling', { contentHash: `sha256:${'b'.repeat(64)}` })],
  }), RequiredKnowledgeUnavailableError);
});

test('required missing and non-runtime status Knowledge fail with explicit codes', () => {
  const missingReference: FrozenKnowledgeReference = {
    resourceId: 'missing-resource', resourceType: 'method', sourcePath: 'methods/missing.md', status: 'approved',
    contentHash: `sha256:${'c'.repeat(64)}`, required: true, failurePolicy: 'block',
  };
  assert.throws(() => new KnowledgeBundleResolver().resolve({
    ...binding,
    references: [missingReference],
  }), (error: unknown) => (
    error instanceof RequiredKnowledgeUnavailableError && error.code === 'missing'
  ));

  const deprecated = {
    id: 'deprecated-resource', source: 'fixture', source_path: 'methods/deprecated.md',
    content_hash: `sha256:${'d'.repeat(64)}`, status: 'deprecated', title: 'Deprecated', summary: '',
    type: 'method', domain: [], tags: [], guide_tags: [], guide_stage: [],
  };
  const resolver = new KnowledgeBundleResolver(undefined, { loadIndex: () => [deprecated] as never });
  assert.throws(() => resolver.resolve({
    ...binding,
    references: [{
      resourceId: deprecated.id, resourceType: deprecated.type, sourcePath: deprecated.source_path, status: 'approved',
      contentHash: deprecated.content_hash, required: true, failurePolicy: 'block',
    }],
  }), (error: unknown) => (
    error instanceof RequiredKnowledgeUnavailableError && error.code === 'status_drift'
  ));
});

test('rejects traversal, symlink, and physical source hash drift with distinct drift codes', () => {
  const knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-containment-'));
  mkdirSync(join(knowledgeRoot, 'methods'), { recursive: true });
  const outside = join(knowledgeRoot, '..', 'outside.md');
  writeFileSync(outside, 'outside', 'utf8');
  symlinkSync(outside, join(knowledgeRoot, 'methods/link.md'));

  assert.throws(
    () => resolveKnowledgeSourcePath('../outside.md', knowledgeRoot),
    /normalized relative path|escapes/u,
  );
  assert.throws(
    () => resolveKnowledgeSourcePath('methods/missing.md', knowledgeRoot),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'missing',
  );
  assert.throws(
    () => resolveKnowledgeSourcePath('methods/link.md', knowledgeRoot),
    /symlink/u,
  );

  const sourcePath = 'methods/safe.md';
  const originalContent = '# Safe\n\nOriginal body';
  const originalHash = contentHash(originalContent);
  const item = {
    id: 'method_safe', source: 'fixture', source_path: sourcePath, content_hash: originalHash,
    status: 'approved', title: 'Safe', summary: 'Safe', type: 'method', domain: ['general'],
    tags: [], guide_tags: [], guide_stage: [],
  };
  const resolver = new KnowledgeBundleResolver(undefined, {
    loadIndex: () => [item] as never,
    getEntry: () => ({ frontmatter: {}, content: '# Safe\n\nTampered body' }),
  });
  assert.throws(() => resolver.resolve({
    ...binding,
    references: [{
      resourceId: item.id,
      resourceType: item.type,
      sourcePath,
      status: 'approved',
      contentHash: originalHash,
      required: true,
      failurePolicy: 'block',
    }],
  }), (error: unknown) => (
    error instanceof RequiredKnowledgeUnavailableError && error.code === 'content_drift'
  ));
});

test('missing Knowledge permits retry while frozen drift requires replan', () => {
  assert.deepEqual(failureFrom(new RequiredKnowledgeUnavailableError('missing', 'missing', 'not found')), {
    kind: 'required_knowledge_unavailable',
    retryable: true,
    resourceId: 'missing',
    knowledgeFailureCode: 'missing',
    requiresReplan: false,
    allowedActions: ['retry', 'abort'],
    message: 'required knowledge missing is unavailable: not found',
  });
  assert.deepEqual(failureFrom(new RequiredKnowledgeUnavailableError('drifted', 'content_drift', 'changed')), {
    kind: 'knowledge_configuration_drift',
    retryable: false,
    resourceId: 'drifted',
    knowledgeFailureCode: 'content_drift',
    requiresReplan: true,
    allowedActions: ['replan', 'abort'],
    message: 'required knowledge drifted is unavailable: changed',
  });
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

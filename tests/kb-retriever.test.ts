import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadGoldKnowledgeContext,
  loadLiveKnowledgeContext,
  type KnowledgeRetrievalResult,
} from '../evaluations/skills/kb/retriever.ts';
import type {
  GoldSourceSelection,
  KnowledgeIndexItem,
  KnowledgeSnapshot,
  SkillKnowledgeMapping,
} from '../evaluations/skills/kb/types.ts';

function rule(path: string, role: 'standard' | 'method' | 'model' | 'asset' | 'template' | 'one_of' = 'method') {
  return { path, role, status: 'draft' };
}

function mapping(overrides: Partial<SkillKnowledgeMapping> = {}): SkillKnowledgeMapping {
  return {
    skill_id: 'alpha-skill',
    kb_mode: 'required',
    required_sources: [rule('methods/required.md')],
    conditional_sources: [rule('methods/conditional.md')],
    optional_sources: [rule('methods/optional.md')],
    retrieval_tags: ['alpha', 'research'],
    source_status_policy: 'draft_allowed_with_warning',
    unresolved_items: [],
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join('/tmp', 'kb-retriever-'));
  const kb = join(root, 'knowledge-base');
  mkdirSync(join(kb, 'methods'), { recursive: true });
  writeFileSync(join(kb, 'methods', 'required.md'), 'required body');
  writeFileSync(join(kb, 'methods', 'conditional.md'), 'conditional body');
  writeFileSync(join(kb, 'methods', 'optional.md'), 'optional body');
  writeFileSync(join(kb, 'methods', 'deprecated.md'), 'deprecated body');
  const sourceFiles = [
    { path: 'methods/required.md', content_hash: 'sha256:req', status: 'reviewed' },
    { path: 'methods/conditional.md', content_hash: 'sha256:cond', status: 'draft' },
    { path: 'methods/optional.md', content_hash: 'sha256:opt', status: 'reviewed' },
    { path: 'methods/deprecated.md', content_hash: 'sha256:dep', status: 'deprecated' },
  ];
  const indexItems: KnowledgeIndexItem[] = [
    { id: 'required_id', title: 'Required', source_path: 'methods/required.md', content_hash: 'sha256:req', status: 'reviewed' },
    { id: 'conditional_id', title: 'Conditional', source_path: 'methods/conditional.md', content_hash: 'sha256:cond', status: 'draft' },
    { id: 'optional_id', title: 'Optional', source_path: 'methods/optional.md', content_hash: 'sha256:opt', status: 'reviewed' },
    { id: 'deprecated_id', title: 'Deprecated', source_path: 'methods/deprecated.md', content_hash: 'sha256:dep', status: 'deprecated' },
  ];
  const snapshot: KnowledgeSnapshot = {
    snapshot_id: 'sha256:snapshot',
    index_path: join(root, 'knowledge.json'),
    index_hash: 'sha256:index',
    built_at: '2026-08-05T00:00:00.000Z',
    source_files: sourceFiles,
  };
  return { kb, snapshot, index: new Map(indexItems.map((item) => [item.id, item])) };
}

function assertNoFailure(result: KnowledgeRetrievalResult) {
  assert.deepEqual(result.failures, []);
}

test('gold mode loads exactly selected fixed sources and never calls search', () => {
  const data = fixture();
  const selection: GoldSourceSelection = {
    skill_id: 'alpha-skill',
    mode: 'gold',
    selected_source_ids: ['required_id', 'conditional_id'],
    unresolved_items: [],
  };
  const result = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping(), selection, { sourceRoot: data.kb });

  assertNoFailure(result);
  assert.equal(result.context.mode, 'gold');
  assert.deepEqual(result.context.selected_source_ids, ['required_id', 'conditional_id']);
  assert.deepEqual(result.context.items.map((item) => item.content), ['required body', 'conditional body']);
  assert.deepEqual(result.context.items.map((item) => item.role), ['required', 'conditional']);
  assert.deepEqual(result.record.candidate_source_ids, ['required_id', 'conditional_id']);
  assert.deepEqual(result.warnings, ['draft source: methods/conditional.md']);
});

test('live mode calls injected search with tags/query and then get for deterministic candidates', () => {
  const data = fixture();
  const searchCalls: unknown[] = [];
  const getCalls: string[] = [];
  const search = (opts: unknown) => {
    searchCalls.push(opts);
    return [data.index.get('optional_id')!, data.index.get('required_id')!, data.index.get('conditional_id')!, data.index.get('optional_id')!];
  };
  const get = (id: string) => {
    getCalls.push(id);
    return { frontmatter: {}, content: `${id} body` };
  };

  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping(), {
    query: 'case task',
    search,
    get,
  });

  assertNoFailure(result);
  assert.deepEqual(searchCalls, [{ guide_tags: ['alpha', 'research'], query: 'case task' }]);
  assert.deepEqual(getCalls, ['optional_id', 'required_id', 'conditional_id']);
  assert.deepEqual(result.record.candidate_source_ids, ['optional_id', 'required_id', 'conditional_id']);
  assert.deepEqual(result.record.selected_source_ids, ['required_id', 'conditional_id']);
  assert.deepEqual(result.context.items.map((item) => item.source_id), ['required_id', 'conditional_id']);
});

test('live mode uses explicit mapping paths when guide tags are empty', () => {
  const data = fixture();
  const searchCalls: unknown[] = [];
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping({ retrieval_tags: [] }), {
    search: (opts: unknown) => {
      searchCalls.push(opts);
      return [];
    },
    get: (id: string) => ({ frontmatter: {}, content: `${id} body` }),
  });

  assertNoFailure(result);
  assert.deepEqual(searchCalls, []);
  assert.deepEqual(result.record.candidate_source_ids, ['required_id', 'conditional_id', 'optional_id']);
  assert.deepEqual(result.record.selected_source_ids, ['required_id', 'conditional_id']);
});

test('missing source body yields retrieval failure provenance without invented content', () => {
  const data = fixture();
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping(), {
    search: () => [data.index.get('required_id')!],
    get: () => null,
  });

  assert.deepEqual(result.context.items, []);
  assert.deepEqual(result.record.selected_source_ids, ['required_id']);
  assert.deepEqual(result.record.missing_required_source_ids, ['required_id']);
  assert.deepEqual(result.record.unresolved_items, ['missing body: required_id']);
  assert.deepEqual(result.failures, ['missing body: required_id']);
});

test('live mode records missing bodies for non-selected candidates deterministically', () => {
  const data = fixture();
  const getCalls: string[] = [];
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping(), {
    search: () => [data.index.get('optional_id')!, data.index.get('required_id')!],
    get: (id: string) => {
      getCalls.push(id);
      return id === 'optional_id' ? null : { frontmatter: {}, content: `${id} body` };
    },
  });

  assert.deepEqual(getCalls, ['optional_id', 'required_id']);
  assert.deepEqual(result.context.items.map((item) => item.source_id), ['required_id']);
  assert.deepEqual(result.record.candidate_source_ids, ['optional_id', 'required_id']);
  assert.deepEqual(result.record.unresolved_items, ['missing body: optional_id']);
  assert.deepEqual(result.failures, ['missing body: optional_id']);
});

test('deprecated source cannot satisfy a required source', () => {
  const data = fixture();
  const deprecatedMapping = mapping({ required_sources: [rule('methods/deprecated.md')] });
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, deprecatedMapping, {
    search: () => [data.index.get('deprecated_id')!],
    get: () => ({ frontmatter: {}, content: 'deprecated body' }),
  });

  assert.deepEqual(result.context.items, []);
  assert.deepEqual(result.record.candidate_source_ids, []);
  assert.deepEqual(result.record.selected_source_ids, []);
  assert.deepEqual(result.record.missing_required_source_ids, ['deprecated_id']);
  assert.deepEqual(result.failures, ['deprecated required source: deprecated_id']);
});

test('draft source is returned with draft status and warning', () => {
  const data = fixture();
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping({ required_sources: [rule('methods/conditional.md')], conditional_sources: [] }), {
    search: () => [data.index.get('conditional_id')!],
    get: () => ({ frontmatter: {}, content: 'draft body' }),
  });

  assertNoFailure(result);
  assert.equal(result.context.items[0]?.status, 'draft');
  assert.deepEqual(result.warnings, ['draft source: methods/conditional.md']);
});

test('required_source_recall reflects selected required over available required sources', () => {
  const data = fixture();
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping({
    required_sources: [rule('methods/required.md'), rule('methods/deprecated.md')],
    conditional_sources: [],
  }), {
    search: () => [data.index.get('required_id')!, data.index.get('deprecated_id')!],
    get: () => ({ frontmatter: {}, content: 'body' }),
  });
  assert.equal(result.record.required_source_recall, 1);

  const noRequired = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping({ required_sources: [], conditional_sources: [] }), {
    search: () => [],
    get: () => null,
  });
  assert.equal(noRequired.record.required_source_recall, null);
});

test('gold mode does not count a selected required source as recalled when its body is missing', () => {
  const data = fixture();
  const selection: GoldSourceSelection = {
    skill_id: 'alpha-skill',
    mode: 'gold',
    selected_source_ids: ['required_id'],
    unresolved_items: [],
  };
  const result = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping(), selection, { sourceRoot: join(data.kb, 'missing-root') });

  assert.deepEqual(result.context.items, []);
  assert.deepEqual(result.record.selected_source_ids, ['required_id']);
  assert.equal(result.record.required_source_recall, 0);
  assert.deepEqual(result.record.missing_required_source_ids, ['required_id']);
  assert.deepEqual(result.record.unresolved_items, ['missing body: required_id']);
  assert.deepEqual(result.failures, ['missing body: required_id']);
});

test('native not_applicable mapping returns empty context and no KB failure', () => {
  const data = fixture();
  const nativeMapping = mapping({ kb_mode: 'not_applicable', required_sources: [], conditional_sources: [], optional_sources: [], retrieval_tags: [], source_status_policy: 'not_applicable' });
  const selection: GoldSourceSelection = { skill_id: 'alpha-skill', mode: 'not_applicable', selected_source_ids: [], unresolved_items: [] };

  const result = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, nativeMapping, selection, { sourceRoot: data.kb });

  assert.deepEqual(result.context.items, []);
  assert.deepEqual(result.context.required_source_ids, []);
  assert.deepEqual(result.context.selected_source_ids, []);
  assert.deepEqual(result.record.unresolved_items, []);
  assert.deepEqual(result.failures, []);
});

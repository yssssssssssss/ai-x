import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  loadGoldKnowledgeContext,
  loadLiveKnowledgeContext,
  type KnowledgeRetrievalResult,
} from '../evaluations/skills/kb/retriever.ts';
import { filterKnowledge } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import type { KnowledgeIndexItem as RuntimeKnowledgeIndexItem } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';
import { parseFrontmatter } from '../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { assessKnowledgeUsage } from '../evaluations/skills/kb/assessment.ts';
import { buildKnowledgeSnapshot } from '../evaluations/skills/kb/snapshot.ts';
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

test('live mode keeps a short Chinese sentence as provenance but searches by tags only', () => {
  const data = fixture();
  const researchGoal = '分析结算体验。';
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
    query: researchGoal,
    search,
    get,
  });

  assertNoFailure(result);
  assert.deepEqual(searchCalls, [{ guide_tags: ['alpha', 'research'] }]);
  assert.equal(result.record.query, researchGoal);
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


interface RealSourceFixture {
  id: string;
  path: string;
  content: string;
  title?: string;
  guideTags?: string[];
}

function realSnapshotFixture(sources: RealSourceFixture[]) {
  const root = mkdtempSync(join('/tmp', 'kb-retriever-real-'));
  const kb = join(root, 'knowledge-base');
  const indexPath = join(root, 'knowledge.json');
  const indexItems: RuntimeKnowledgeIndexItem[] = sources.map((source) => {
    const sourcePath = join(kb, source.path);
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source.content);
    return {
      id: source.id,
      type: 'method',
      title: source.title ?? source.id,
      domain: ['research'],
      tags: ['knowledge'],
      guide_tags: source.guideTags ?? [],
      guide_stage: ['analysis'],
      summary: 'A tagged canonical source',
      source_path: source.path,
      content_hash: 'sha256:index-placeholder',
      status: 'approved',
    };
  });
  writeFileSync(indexPath, JSON.stringify(indexItems));
  return {
    root,
    kb,
    indexItems,
    sourcePaths: new Map(sources.map((source) => [source.id, join(kb, source.path)])),
    ...buildKnowledgeSnapshot(indexPath, kb),
  };
}

test('one-of required sources count the selected alternative once in gold and live citation semantics', () => {
  const data = realSnapshotFixture([
    { id: 'mandatory_id', path: 'methods/mandatory.md', content: 'mandatory body' },
    { id: 'lens_a_id', path: 'models/lens-a.md', content: 'lens A body' },
    { id: 'lens_b_id', path: 'models/lens-b.md', content: 'lens B body' },
  ]);
  const oneOfMapping = mapping({
    required_sources: [
      rule('methods/mandatory.md'),
      rule('models/lens-a.md', 'one_of'),
      rule('models/lens-b.md', 'one_of'),
    ],
    conditional_sources: [],
    optional_sources: [],
    retrieval_tags: ['one-of'],
  });
  const selectedIds = ['mandatory_id', 'lens_b_id'];
  const gold = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, oneOfMapping, {
    skill_id: 'alpha-skill',
    mode: 'gold',
    selected_source_ids: selectedIds,
    unresolved_items: [],
  }, { sourceRoot: data.kb });
  const live = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, oneOfMapping, {
    search: () => [data.index.get('mandatory_id')!, data.index.get('lens_b_id')!],
    get: (id) => ({ frontmatter: {}, content: readFileSync(data.sourcePaths.get(id)!, 'utf8') }),
  });

  for (const result of [gold, live]) {
    assertNoFailure(result);
    assert.deepEqual(result.context.required_source_ids, selectedIds);
    assert.deepEqual(result.context.selected_source_ids, selectedIds);
    assert.deepEqual(result.context.items.map((item) => item.role), ['required', 'required']);
    assert.equal(result.record.required_source_recall, 1);
    assert.deepEqual(result.record.missing_required_source_ids, []);
    const assessment = assessKnowledgeUsage(
      'alpha-skill',
      result.context,
      result.record,
      { citations: selectedIds.map((source_id) => ({ source_id })) },
    );
    assert.equal(assessment.kb_grounding_verdict, 'pass');
    assert.deepEqual(assessment.cited_source_ids, selectedIds);
  }
});

test('one-of does not fall back to unselected A when selected B fails frozen-body validation', () => {
  const data = realSnapshotFixture([
    { id: 'mandatory_id', path: 'methods/mandatory.md', content: 'mandatory body' },
    { id: 'lens_a_id', path: 'models/lens-a.md', content: 'lens A body' },
    { id: 'lens_b_id', path: 'models/lens-b.md', content: 'lens B frozen body' },
  ]);
  const oneOfMapping = mapping({
    required_sources: [
      rule('methods/mandatory.md'),
      rule('models/lens-a.md', 'one_of'),
      rule('models/lens-b.md', 'one_of'),
    ],
    conditional_sources: [],
    optional_sources: [],
    retrieval_tags: ['one-of'],
  });
  writeFileSync(data.sourcePaths.get('lens_b_id')!, 'lens B changed after snapshot');
  const selectedIds = ['mandatory_id', 'lens_b_id'];
  const gold = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, oneOfMapping, {
    skill_id: 'alpha-skill',
    mode: 'gold',
    selected_source_ids: selectedIds,
    unresolved_items: [],
  }, { sourceRoot: data.kb });
  const live = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, oneOfMapping, {
    search: () => [data.index.get('mandatory_id')!, data.index.get('lens_b_id')!],
    get: (id) => ({ frontmatter: {}, content: readFileSync(data.sourcePaths.get(id)!, 'utf8') }),
  });

  for (const result of [gold, live]) {
    assert.deepEqual(result.context.required_source_ids, selectedIds);
    assert.deepEqual(result.context.selected_source_ids, selectedIds);
    assert.deepEqual(result.context.items.map((item) => item.source_id), ['mandatory_id']);
    assert.deepEqual(result.record.missing_required_source_ids, ['lens_b_id']);
    assert.ok(result.failures.length > 0);
    assert.ok(!result.record.candidate_source_ids.includes('lens_a_id'));
  }
});

test('live retrieval preserves a full Chinese research goal without hard-filtering a tag-matched required source', () => {
  const researchGoal = '理解谨慎型消费者如何判断建议可信、在哪些时刻放弃以及需要什么证据。';
  const data = realSnapshotFixture([{
    id: 'tagged_required_id',
    path: 'methods/tagged-required.md',
    content: 'tagged required body',
    title: '访谈提纲设计',
    guideTags: ['interview'],
  }]);
  const taggedMapping = mapping({
    required_sources: [rule('methods/tagged-required.md')],
    conditional_sources: [],
    optional_sources: [],
    retrieval_tags: ['interview'],
  });
  const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, taggedMapping, {
    query: researchGoal,
    search: (opts) => filterKnowledge(data.indexItems, opts),
    get: (id) => ({ frontmatter: {}, content: readFileSync(data.sourcePaths.get(id)!, 'utf8') }),
  });

  assertNoFailure(result);
  assert.equal(result.record.query, researchGoal);
  assert.deepEqual(result.record.candidate_source_ids, ['tagged_required_id']);
  assert.deepEqual(result.context.required_source_ids, ['tagged_required_id']);
  assert.deepEqual(result.context.selected_source_ids, ['tagged_required_id']);
  assert.deepEqual(result.context.items.map((item) => item.content), ['tagged required body']);
  assert.equal(result.record.required_source_recall, 1);
  assert.deepEqual(result.record.missing_required_source_ids, []);
});

function tamperedSnapshotFixture(tamper: 'rewrite' | 'symlink') {
  const originalContent = 'snapshot-pinned body';
  const data = realSnapshotFixture([{
    id: 'pinned_id',
    path: 'methods/pinned.md',
    content: originalContent,
  }]);
  const sourcePath = data.sourcePaths.get('pinned_id')!;
  if (tamper === 'rewrite') {
    writeFileSync(sourcePath, 'body changed after snapshot');
  } else {
    const replacement = join(data.root, 'replacement.md');
    writeFileSync(replacement, originalContent);
    unlinkSync(sourcePath);
    symlinkSync(replacement, sourcePath);
  }
  return { ...data, sourcePath };
}

test('gold retrieval fails closed when snapshotted bytes change or the source path becomes a symlink', () => {
  for (const tamper of ['rewrite', 'symlink'] as const) {
    const data = tamperedSnapshotFixture(tamper);
    const result = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping({
      required_sources: [rule('methods/pinned.md')],
      conditional_sources: [],
      optional_sources: [],
    }), {
      skill_id: 'alpha-skill',
      mode: 'gold',
      selected_source_ids: ['pinned_id'],
      unresolved_items: [],
    }, { sourceRoot: data.kb });

    assert.deepEqual(result.context.items, [], tamper);
    assert.deepEqual(result.record.missing_required_source_ids, ['pinned_id'], tamper);
    assert.ok(result.failures.length > 0, tamper);
  }
});

test('live retrieval fails closed instead of labeling changed or symlinked bytes with the old snapshot hash', () => {
  for (const tamper of ['rewrite', 'symlink'] as const) {
    const data = tamperedSnapshotFixture(tamper);
    const result = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, mapping({
      required_sources: [rule('methods/pinned.md')],
      conditional_sources: [],
      optional_sources: [],
      retrieval_tags: [],
    }), {
      get: () => ({ frontmatter: {}, content: readFileSync(data.sourcePath, 'utf8') }),
    });

    assert.deepEqual(result.context.items, [], tamper);
    assert.deepEqual(result.record.missing_required_source_ids, ['pinned_id'], tamper);
    assert.ok(result.failures.length > 0, tamper);
  }
});

test('gold and live expose the same parsed body for a frozen source with frontmatter', () => {
  const rawSource = `---\nid: frozen_id\ntype: method\nstatus: reviewed\n---\n\nFrozen canonical body.\n`;
  const data = realSnapshotFixture([{
    id: 'frozen_id',
    path: 'methods/frozen.md',
    content: rawSource,
  }]);
  const frozenMapping = mapping({
    required_sources: [rule('methods/frozen.md')],
    conditional_sources: [],
    optional_sources: [],
    retrieval_tags: [],
  });
  const gold = loadGoldKnowledgeContext('alpha-skill', data.snapshot, data.index, frozenMapping, {
    skill_id: 'alpha-skill',
    mode: 'gold',
    selected_source_ids: ['frozen_id'],
    unresolved_items: [],
  }, { sourceRoot: data.kb });
  const live = loadLiveKnowledgeContext('alpha-skill', data.snapshot, data.index, frozenMapping, {
    get: () => parseFrontmatter(readFileSync(data.sourcePaths.get('frozen_id')!, 'utf8')),
  });

  assertNoFailure(gold);
  assertNoFailure(live);
  assert.equal(gold.context.items[0]?.content, 'Frozen canonical body.');
  assert.equal(live.context.items[0]?.content, 'Frozen canonical body.');
  assert.equal(gold.context.items[0]?.content, live.context.items[0]?.content);
});
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessKnowledgeUsage } from '../evaluations/skills/kb/assessment.ts';
import type {
  KnowledgeContext,
  KnowledgeContextItem,
  RetrievalRecord,
} from '../evaluations/skills/kb/types.ts';

function item(
  source_id: string,
  source_path: string,
  status = 'reviewed',
): KnowledgeContextItem {
  return {
    source_id,
    title: source_id,
    source_path,
    content_hash: `sha256:${source_id}`,
    status,
    role: 'required',
    content: `${source_id} body`,
  };
}

function context(overrides: Partial<KnowledgeContext> = {}): KnowledgeContext {
  const items = [item('required_id', 'methods/required.md')];
  return {
    mode: 'gold',
    snapshot_id: 'sha256:snapshot',
    required_source_ids: ['required_id'],
    selected_source_ids: ['required_id'],
    items,
    ...overrides,
  };
}

function retrieval(overrides: Partial<RetrievalRecord> = {}): RetrievalRecord {
  return {
    mode: 'gold',
    snapshot_id: 'sha256:snapshot',
    guide_tags: ['alpha'],
    candidate_source_ids: ['required_id'],
    selected_source_ids: ['required_id'],
    required_source_recall: 1,
    missing_required_source_ids: [],
    unresolved_items: [],
    ...overrides,
  };
}

test('passes when every required source is selected and explicitly cited by source_id', () => {
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    context(),
    retrieval(),
    { conclusion: 'Use the required method. [source: required_id]' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'pass');
  assert.equal(assessment.required_sources_available, true);
  assert.deepEqual(assessment.required_source_ids, ['required_id']);
  assert.deepEqual(assessment.selected_source_ids, ['required_id']);
  assert.deepEqual(assessment.cited_source_ids, ['required_id']);
  assert.equal(assessment.retrieval_recall, 1);
});

test('passes but warns when a draft source is explicitly used', () => {
  const draftContext = context({
    items: [item('required_id', 'methods/required.md', 'draft')],
  });

  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    draftContext,
    retrieval(),
    { conclusion: 'Draft-backed method. source_id: required_id' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'pass');
  assert.deepEqual(assessment.draft_sources_used, ['required_id']);
  assert.ok(assessment.status_warnings.some((warning) => warning.includes('draft')));
});

test('fails when retrieval reports a missing required source', () => {
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    context({ selected_source_ids: [], items: [] }),
    retrieval({
      selected_source_ids: [],
      required_source_recall: 0,
      missing_required_source_ids: ['required_id'],
    }),
    { conclusion: 'No usable source.' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'fail');
  assert.equal(assessment.required_sources_available, false);
  assert.deepEqual(assessment.missing_required_source_ids, ['required_id']);
});

test('needs review for unresolved mapping metadata even when cited sources are present', () => {
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    context(),
    retrieval({ unresolved_items: ['unresolved mapping: models/ghost.md'] }),
    { conclusion: 'Grounded but mapping is unresolved. [source: required_id]' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'needs_review');
  assert.ok(assessment.review_notes.some((note) => note.includes('unresolved')));
});

test('needs review when required sources exist but output has no explicit citations', () => {
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    context(),
    retrieval(),
    { conclusion: 'Uses the method without a source marker.' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'needs_review');
  assert.deepEqual(assessment.cited_source_ids, []);
});

test('fails when output cites a source id that is absent from the provided context', () => {
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    context(),
    retrieval(),
    { conclusion: 'Unsupported citation. [source: ghost_id]' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'fail');
  assert.deepEqual(assessment.unsupported_canonical_claims, ['ghost_id']);
});

test('recognizes explicit source_path citations and maps them to source ids', () => {
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    context(),
    retrieval(),
    { conclusion: 'Path citation. source_path: methods/required.md' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'pass');
  assert.deepEqual(assessment.cited_source_ids, ['required_id']);
});

test('extracts every source_id from structured citation objects', () => {
  const twoSourceContext = context({
    required_source_ids: ['required_id', 'draft_id'],
    selected_source_ids: ['required_id', 'draft_id'],
    items: [
      item('required_id', 'methods/required.md'),
      item('draft_id', 'methods/draft.md', 'draft'),
    ],
  });
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    twoSourceContext,
    retrieval({
      candidate_source_ids: ['required_id', 'draft_id'],
      selected_source_ids: ['required_id', 'draft_id'],
    }),
    {
      conclusion: 'Structured citations are explicit.',
      citations: [{ source_id: 'required_id' }, { source_id: 'draft_id' }],
    },
  );

  assert.equal(assessment.kb_grounding_verdict, 'pass');
  assert.deepEqual(assessment.cited_source_ids, ['required_id', 'draft_id']);
  assert.deepEqual(assessment.draft_sources_used, ['draft_id']);
});

test('extracts every source id from structured sources arrays', () => {
  const twoSourceContext = context({
    required_source_ids: ['required_id', 'draft_id'],
    selected_source_ids: ['required_id', 'draft_id'],
    items: [
      item('required_id', 'methods/required.md'),
      item('draft_id', 'methods/draft.md', 'draft'),
    ],
  });
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    twoSourceContext,
    retrieval({
      candidate_source_ids: ['required_id', 'draft_id'],
      selected_source_ids: ['required_id', 'draft_id'],
    }),
    { conclusion: 'Structured source list.', sources: ['required_id', 'draft_id'] },
  );

  assert.equal(assessment.kb_grounding_verdict, 'pass');
  assert.deepEqual(assessment.cited_source_ids, ['required_id', 'draft_id']);
  assert.deepEqual(assessment.draft_sources_used, ['draft_id']);
});

test('extracts nested source_path fields from structured output', () => {
  const twoSourceContext = context({
    required_source_ids: ['required_id', 'draft_id'],
    selected_source_ids: ['required_id', 'draft_id'],
    items: [
      item('required_id', 'methods/required.md'),
      item('draft_id', 'methods/draft.md', 'draft'),
    ],
  });
  const assessment = assessKnowledgeUsage(
    'alpha-skill',
    twoSourceContext,
    retrieval({
      candidate_source_ids: ['required_id', 'draft_id'],
      selected_source_ids: ['required_id', 'draft_id'],
    }),
    {
      sections: [
        { claim: 'required', evidence: { source_path: 'methods/required.md' } },
        { claim: 'draft', evidence: { source_path: 'methods/draft.md' } },
      ],
    },
  );

  assert.equal(assessment.kb_grounding_verdict, 'pass');
  assert.deepEqual(assessment.cited_source_ids, ['required_id', 'draft_id']);
  assert.deepEqual(assessment.draft_sources_used, ['draft_id']);
});

test('returns not_applicable for native Skills with empty KB context and retrieval', () => {
  const assessment = assessKnowledgeUsage(
    'native-skill',
    context({ required_source_ids: [], selected_source_ids: [], items: [] }),
    retrieval({
      candidate_source_ids: [],
      selected_source_ids: [],
      required_source_recall: null,
    }),
    { answer: 'native output' },
  );

  assert.equal(assessment.kb_grounding_verdict, 'not_applicable');
  assert.equal(assessment.required_sources_available, true);
});

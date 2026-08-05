import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  buildKnowledgeSnapshot,
  loadKnowledgeSnapshot,
} from '../evaluations/skills/kb/snapshot.ts';

function fixture(status = 'draft') {
  const root = mkdtempSync(join('/tmp', 'kb-snapshot-'));
  const kb = join(root, 'knowledge-base');
  mkdirSync(join(kb, 'models'), { recursive: true });
  const source = join(kb, 'models', 'sample.md');
  writeFileSync(source, `---\nid: model_sample\ntype: model\nstatus: ${status}\n---\ncontent\n`);
  const index = join(kb, 'knowledge.json');
  writeFileSync(index, JSON.stringify([{ id: 'model_sample', source_path: 'models/sample.md', content_hash: 'sha256:fixture', status }]));
  return { root, kb, index, source };
}

test('same index and source bytes produce the same content-addressed snapshot ID', () => {
  const first = fixture();
  const second = fixture();
  const a = buildKnowledgeSnapshot(first.index, first.kb);
  const b = buildKnowledgeSnapshot(second.index, second.kb);
  assert.equal(a.snapshot.snapshot_id, b.snapshot.snapshot_id);
  assert.match(a.snapshot.snapshot_id, /^sha256:/);
});

test('changing one source byte changes the snapshot hash', () => {
  const data = fixture();
  const before = buildKnowledgeSnapshot(data.index, data.kb).snapshot.snapshot_id;
  writeFileSync(data.source, readFileSync(data.source, 'utf8') + 'changed');
  const after = buildKnowledgeSnapshot(data.index, data.kb).snapshot.snapshot_id;
  assert.notEqual(before, after);
});

test('missing source is recorded as an error instead of silently replaced', () => {
  const data = fixture();
  writeFileSync(data.index, JSON.stringify([{ id: 'missing', source_path: 'models/nope.md', content_hash: 'sha256:x', status: 'draft' }]));
  assert.throws(() => buildKnowledgeSnapshot(data.index, data.kb), /missing source/);
});

test('deprecated required source is rejected while draft required source is loadable with warning', () => {
  const deprecated = fixture('deprecated');
  assert.throws(() => buildKnowledgeSnapshot(deprecated.index, deprecated.kb), /deprecated.*required|deprecated source/);
  const draft = fixture('draft');
  const result = buildKnowledgeSnapshot(draft.index, draft.kb);
  assert.equal(result.snapshot.source_files[0]?.status, 'draft');
  assert.ok(result.warnings.some((warning) => warning.includes('draft')));
});

test('loads an existing snapshot and index map deterministically', () => {
  const data = fixture();
  const result = loadKnowledgeSnapshot(data.index, data.kb);
  assert.equal(result.index.get('model_sample')?.source_path, 'models/sample.md');
  assert.equal(result.snapshot.index_path, data.index);
});

test('catalogs non-indexed assets with canonical path source IDs', () => {
  const result = buildKnowledgeSnapshot();
  assert.equal(result.index.get('path:assets/scales/standardized-ux-scales.md')?.source_path, 'assets/scales/standardized-ux-scales.md');
});

test('rejects duplicate index IDs, source paths, and path traversal outside the KB root', () => {
  const data = fixture();
  writeFileSync(data.index, JSON.stringify([
    { id: 'model_sample', source_path: 'models/sample.md', content_hash: 'sha256:x', status: 'draft' },
    { id: 'model_sample', source_path: 'models/other.md', content_hash: 'sha256:y', status: 'draft' },
  ]));
  assert.throws(() => buildKnowledgeSnapshot(data.index, data.kb), /duplicate knowledge index id/);
  writeFileSync(data.index, JSON.stringify([
    { id: 'first', source_path: 'models/sample.md', content_hash: 'sha256:x', status: 'draft' },
    { id: 'second', source_path: 'models/sample.md', content_hash: 'sha256:y', status: 'draft' },
  ]));
  assert.throws(() => buildKnowledgeSnapshot(data.index, data.kb), /duplicate knowledge source path/);
  writeFileSync(data.index, JSON.stringify([{ id: 'escape', source_path: '../outside.md', content_hash: 'sha256:x', status: 'draft' }]));
  assert.throws(() => buildKnowledgeSnapshot(data.index, data.kb), /escapes KB root/);
});

test('rejects source symlinks that resolve outside the KB root', () => {
  const data = fixture();
  const outside = join(data.root, 'outside.md');
  writeFileSync(outside, 'outside');
  const link = join(data.kb, 'models', 'linked.md');
  symlinkSync(outside, link);
  writeFileSync(data.index, JSON.stringify([{ id: 'linked', source_path: 'models/linked.md', content_hash: 'sha256:x', status: 'draft' }]));
  assert.throws(() => buildKnowledgeSnapshot(data.index, data.kb), /escapes KB root via symlink/);
});

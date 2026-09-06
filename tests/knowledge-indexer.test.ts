import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';

const model = [
  '---',
  'id: model_jtbd',
  'type: model',
  'title: JTBD',
  'domain: general',
  'tags: [需求框架, 用户目标]',
  'guide_tags: [framework]',
  'research_type: [定性]',
  'guide_stage: [need-discovery]',
  'summary: 需求框架',
  'source_path: models/jtbd.md',
  'content_hash: sha256:x',
  'status: approved',
  '---',
  '',
  '# JTBD',
].join('\n');

test('knowledge index keeps knowledge metadata and excludes assets and Skills', () => {
  const items = buildIndex([
    { relPath: 'models/jtbd.md', md: model },
    { relPath: 'assets/logo.md', md: model.replace('type: model', 'type: asset') },
    { relPath: 'skills/example/SKILL.md', md: model.replace('type: model', 'type: skill') },
  ]);
  assert.deepEqual(items, [{
    id: 'model_jtbd',
    type: 'model',
    title: 'JTBD',
    domain: ['general'],
    tags: ['需求框架', '用户目标'],
    guide_tags: ['framework'],
    research_type: ['定性'],
    guide_stage: ['need-discovery'],
    summary: '需求框架',
    source_path: 'models/jtbd.md',
    content_hash: 'sha256:x',
    status: 'approved',
  }]);
});

test('knowledge index rejects missing and unknown statuses', () => {
  assert.throws(() => buildIndex([{ relPath: 'models/jtbd.md', md: model.replace('status: approved', '') }]), /invalid or missing status/u);
  assert.throws(() => buildIndex([{ relPath: 'models/jtbd.md', md: model.replace('status: approved', 'status: typo') }]), /invalid or missing status/u);
});

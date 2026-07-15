import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintEntry } from '../harness/linters/knowledge-linter.ts';

const GOOD = [
  '---',
  'id: model_jtbd',
  'type: model',
  'title: JTBD',
  'domain: general',
  'tags: [用户画像, 需求框架]',           // wiki 原生自由中文 tags(不校验)
  'guide_tags: [persona]',                 // 受控引导标签(校验)
  'guide_stage: [need-discovery]',
  'source: xingyun_wiki',
  'source_path: models/jtbd.md',
  'content_hash: PLACEHOLDER',
  'status: approved',
  'updated_at: 2026-07-15',
  '---',
  '',
  '# JTBD',
  '',
  '正文',
].join('\n');

test('合法条目无 issue', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.deepEqual(issues, []);
});

test('wiki 自由中文 tags 不报越界', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.ok(!issues.some((i) => i.message.includes('tag')), 'wiki 中文 tags 不应报越界');
});

test('越界 guide_tag 报错', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('guide_tags: [persona]', 'guide_tags: [not_a_real_tag]')
                 .replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.ok(issues.some((i) => i.message.includes('guide_tag')), '应报越界 guide_tag');
});

test('id 重复报错', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const seen = new Set(['model_jtbd']);
  const issues = lintEntry('models/jtbd.md', md, seen);
  assert.ok(issues.some((i) => i.message.includes('id')), '应报 id 重复');
});

test('缺必填字段报错', async () => {
  const { contentHash } = await import('../apps/orchestrator-runtime/src/knowledge/normalizer.ts');
  const md = GOOD.replace('title: JTBD\n', '')
                 .replace('PLACEHOLDER', contentHash('# JTBD\n\n正文'));
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.ok(issues.some((i) => i.message.includes('必填')), '应报缺必填字段');
});

test('hash 不匹配报错', () => {
  const md = GOOD.replace('PLACEHOLDER', 'sha256:deadbeef');
  const issues = lintEntry('models/jtbd.md', md, new Set());
  assert.ok(issues.some((i) => i.message.includes('hash')), '应报 hash 不匹配');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTypeDomain, contentHash, normalizeEntry } from '../apps/orchestrator-runtime/src/knowledge/normalizer.ts';
import { parseFrontmatter } from '../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';

test('路径推断 type/domain', () => {
  assert.deepEqual(inferTypeDomain('models/jtbd.md'), { type: 'model', domain: 'general' });
  assert.deepEqual(inferTypeDomain('methods/toolbox/analysis/rfm.md'), { type: 'toolbox-analysis', domain: 'general' });
  assert.deepEqual(inferTypeDomain('methods/toolbox/collection/interviews.md'), { type: 'toolbox-collection', domain: 'general' });
  assert.deepEqual(inferTypeDomain('methods/standards/sampling.md'), { type: 'standard', domain: 'general' });
  assert.equal(inferTypeDomain('models/index.md'), null, '导航文件返回 null');
  assert.equal(inferTypeDomain('README.md'), null);
});

test('skills 下只有 SKILL.md 是条目, skeleton 返回 null', () => {
  assert.deepEqual(inferTypeDomain('skills/competitive-analysis/SKILL.md'), { type: 'skill', domain: 'general' });
  assert.equal(inferTypeDomain('skills/competitive-analysis/references/competitive-analysis-skeleton.md'), null);
});

test('scenarios 从二级目录推断 domain', () => {
  assert.deepEqual(
    inferTypeDomain('methods/scenarios/category-consumption/cross-category/churn-user-research.md'),
    { type: 'scenario', domain: 'category-consumption' },
  );
});

test('normalizeEntry 补机械 frontmatter', () => {
  const { md } = normalizeEntry('models/jtbd.md', '# JTBD (Jobs To Be Done)\n\n核心概念…');
  const { frontmatter } = parseFrontmatter(md);
  assert.equal(frontmatter.type, 'model');
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.equal(frontmatter.title, 'JTBD (Jobs To Be Done)');
  assert.equal(frontmatter.source_path, 'models/jtbd.md');
  assert.match(String(frontmatter.content_hash), /^sha256:/);
  assert.equal(frontmatter.status, 'approved');
});

test('幂等: content_hash 未变则 changed=false', () => {
  const first = normalizeEntry('models/jtbd.md', '# JTBD\n\n正文');
  const second = normalizeEntry('models/jtbd.md', first.md);
  assert.equal(second.changed, false, '已归一的文档再跑不应变更');
});

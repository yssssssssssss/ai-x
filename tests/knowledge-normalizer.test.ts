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

test('normalizeEntry 补机械 frontmatter(无 frontmatter 兜底)', () => {
  const { md } = normalizeEntry('models/jtbd.md', '# JTBD (Jobs To Be Done)\n\n核心概念…');
  const { frontmatter } = parseFrontmatter(md);
  assert.equal(frontmatter.type, 'model');
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.equal(frontmatter.title, 'JTBD (Jobs To Be Done)');
  assert.equal(frontmatter.source_path, 'models/jtbd.md');
  assert.match(String(frontmatter.content_hash), /^sha256:/);
  assert.ok(Array.isArray(frontmatter.guide_tags), 'guide_tags 应被补为数组');
});

test('保留 wiki 原生 frontmatter 全量 + 增量补 guide_tags', () => {
  const wiki = [
    '---',
    'title: RFM 模型用户分群',
    'type: analysis',
    'domain: [通用]',
    'research_type: [定量, 度量, 评估]',
    'tags: [RFM, 用户分群, 客户价值]',
    'status: draft',
    'owner: 李笑欣',
    'related:',
    '  - models/user-personas-segmentation.md',
    '---',
    '',
    '# RFM 模型用户分群',
    '',
    '正文',
  ].join('\n');
  const { md, changed } = normalizeEntry('methods/toolbox/analysis/rfm.md', wiki);
  const { frontmatter: fm } = parseFrontmatter(md);
  // wiki 原生字段全部保留
  assert.deepEqual(fm.tags, ['RFM', '用户分群', '客户价值'], 'wiki 中文 tags 不被动');
  assert.deepEqual(fm.research_type, ['定量', '度量', '评估'], 'research_type 保留');
  assert.equal(fm.owner, '李笑欣', 'owner 保留');
  assert.deepEqual(fm.related, ['models/user-personas-segmentation.md'], 'related 保留');
  assert.equal(fm.type, 'analysis', '原生 type 不被 td.type 覆盖');
  assert.equal(fm.status, 'draft', '原生 status 保留');
  // 增量补齐机械/受控字段
  assert.equal(fm.id, 'toolbox_analysis_rfm');
  assert.equal(fm.source_path, 'methods/toolbox/analysis/rfm.md');
  assert.match(String(fm.content_hash), /^sha256:/);
  assert.ok(Array.isArray(fm.guide_tags), 'guide_tags 应被补');
  assert.equal(changed, true);
});

test('幂等: content_hash 未变则 changed=false', () => {
  const first = normalizeEntry('models/jtbd.md', '# JTBD\n\n正文');
  const second = normalizeEntry('models/jtbd.md', first.md);
  assert.equal(second.changed, false, '已归一的文档再跑不应变更');
});

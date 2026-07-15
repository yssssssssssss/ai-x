import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, serializeFrontmatter } from '../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';

test('解析带 frontmatter 的 md', () => {
  const md = '---\nid: model_jtbd\ntags: [persona]\n---\n\n# JTBD\n\n正文';
  const { frontmatter, content } = parseFrontmatter(md);
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.deepEqual(frontmatter.tags, ['persona']);
  assert.equal(content, '# JTBD\n\n正文');
});

test('无 frontmatter 的 md 返回空 frontmatter + 原文', () => {
  const md = '# 标题\n\n正文';
  const { frontmatter, content } = parseFrontmatter(md);
  assert.deepEqual(frontmatter, {});
  assert.equal(content, '# 标题\n\n正文');
});

test('round-trip: 序列化后再解析不丢字段', () => {
  const fm = { id: 'model_jtbd', type: 'model', tags: ['persona', 'framework'] };
  const content = '# JTBD\n\n正文';
  const { frontmatter } = parseFrontmatter(serializeFrontmatter(fm, content));
  assert.equal(frontmatter.id, 'model_jtbd');
  assert.deepEqual(frontmatter.tags, ['persona', 'framework']);
});

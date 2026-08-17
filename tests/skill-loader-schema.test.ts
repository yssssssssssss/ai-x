import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

// 所有 active Skill 使用统一结果信封；领域 payload schema 在执行期内联。

const sl = new SkillLoader();

test('loadSkillSchemas:KB Skill 无 input schema 但有统一输出合同', () => {
  const s = sl.loadSkillSchemas('competitive-analysis');
  assert.equal(s.input, undefined, 'KB skill 无 input_schema → undefined');
  assert.equal(typeof s.output, 'object');
});

test('loadSkillBody:KB skill 读 entry(SKILL.md)而非 path(目录),不崩', () => {
  // KB skill path 是目录,entry 才是 SKILL.md;loadSkillBody 须解析到 SKILL.md。
  const b = sl.loadSkillBody('competitive-analysis');
  assert.ok(b.body.length > 0, '应读到 SKILL.md 正文');
  assert.ok(b.hash.startsWith('sha256:'), '应有 manifest hash');
  assert.ok(b.path.endsWith('SKILL.md'), 'path 应指向 SKILL.md 文件');
});

test('loadSkillSchemas:原生 Skill 保留 input 与领域 payload schema', () => {
  const s = sl.loadSkillSchemas('digital-human-competitive-analysis');
  assert.equal(typeof s.input, 'object', '原生 skill input schema 应为对象');
  assert.equal(typeof s.output, 'object', '原生 skill effective output schema 应为对象');
  assert.ok(s.input !== null && s.output !== null);
  const payload = (s.output as { properties?: { payload?: { required?: string[] } } }).properties?.payload;
  assert.ok(payload?.required?.includes('comparison_matrix'));
});

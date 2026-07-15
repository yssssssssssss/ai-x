import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

// Task A 单测:executePhase 容忍无 JSON schema 的 KB 派生 skill。
// KB skill(registry path=目录、entry=SKILL.md、无 input_schema/output_schema)执行期加载不应崩。

const sl = new SkillLoader();

test('loadSkillSchemas:无 schema 的 KB skill 返回 undefined,不抛', () => {
  // competitive-analysis 是 active KB 派生 skill,registry 无 input_schema/output_schema 字段。
  const s = sl.loadSkillSchemas('competitive-analysis');
  assert.equal(s.input, undefined, 'KB skill 无 input_schema → undefined');
  assert.equal(s.output, undefined, 'KB skill 无 output_schema → undefined');
});

test('loadSkillBody:KB skill 读 entry(SKILL.md)而非 path(目录),不崩', () => {
  // KB skill path 是目录,entry 才是 SKILL.md;loadSkillBody 须解析到 SKILL.md。
  const b = sl.loadSkillBody('competitive-analysis');
  assert.ok(b.body.length > 0, '应读到 SKILL.md 正文');
  assert.ok(b.hash.startsWith('sha256:'), '应有 manifest hash');
  assert.ok(b.path.endsWith('SKILL.md'), 'path 应指向 SKILL.md 文件');
});

test('loadSkillSchemas:原生带 schema 的 skill 仍返回 schema 对象(不回归)', () => {
  // digital-human-competitive-analysis 是原生 skill,带 input/output schema。
  const s = sl.loadSkillSchemas('digital-human-competitive-analysis');
  assert.equal(typeof s.input, 'object', '原生 skill input schema 应为对象');
  assert.equal(typeof s.output, 'object', '原生 skill output schema 应为对象');
  assert.ok(s.input !== null && s.output !== null);
});

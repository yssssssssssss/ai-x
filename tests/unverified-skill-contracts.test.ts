import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { getConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const skillIds = [
  'competitive-app-analysis',
  'analyze-satisfaction',
  'conversion-funnel-analysis',
  'feature-adoption-analysis',
  'structure-interview-transcript',
  'synthesize-qualitative-insights',
];

test('六个历史未执行 Skill 均有领域 payload Schema 和受控结构化执行结果', async () => {
  const loader = new SkillLoader();
  const validator = new SchemaValidator();
  const llm = new MockLLMClient();

  for (const id of skillIds) {
    const entry = loader.getSkill(id);
    assert.ok(entry, `${id} 应为 active skill`);
    assert.ok(entry.payload_schema, `${id} 应声明领域 payload_schema`);
    assert.ok(loader.loadSkillBody(id).body.length > 0, `${id} 应能读取 SKILL.md`);
    const schemas = loader.loadSkillSchemas(id);
    assert.ok(schemas.output && schemas.payload, `${id} 应能加载结果信封和领域 payload schema`);

    const result = await llm.generateStructured<Record<string, unknown>>({
      prompt: `受控夹具执行 ${id}`,
      schema: schemas.output!,
      schemaName: `skill:${id}`,
      context: { research_goal: '契约验证', tool_outputs: [] },
    });
    validator.validateFileOrThrow(join(getConfigRoot(), entry.output_schema!), result.data);
    validator.validateFileOrThrow(join(getConfigRoot(), entry.payload_schema!), result.data.payload);
    assert.equal(result.data.status === 'succeeded' || result.data.status === 'degraded', true, `${id} 应返回可解释状态`);
    assert.equal(typeof result.data.summary, 'string', `${id} 应返回非空摘要`);
  }
});

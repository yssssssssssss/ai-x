import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getConfigRoot,
  SKILL_RESULT_ENVELOPE_SCHEMA,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const envelope = (payload: Record<string, unknown> = {}) => ({
  version: 'skill-output-v2',
  status: 'succeeded',
  summary: '完成受控分析。',
  findings: [{ id: 'finding-1', statement: '形成一条分析发现。', confidence: 0.8 }],
  assumptions: [],
  limitations: [],
  recommendations: ['继续验证。'],
  payload,
});

const payloadFixtures: Record<string, Record<string, unknown>> = {
  'competitive-app-analysis': {
    screen_comparisons: [{
      competitor: '竞品 A',
      scene: '首页',
      summary: '主行动入口更集中。',
      metrics: { attention_focus: 0.82 },
    }],
    recommendations: ['减少首屏视觉竞争。'],
  },
  'analyze-satisfaction': {
    analysis_status: 'complete',
    data_requests: [],
    driver_priorities: [{ attribute: '稳定性', rationale: '满意度的主要驱动。' }],
    ipa_priorities: ['优先提升稳定性'],
  },
  'conversion-funnel-analysis': {
    analysis_status: 'complete',
    data_requests: [],
    stages: [{ stage: '提交订单', observation: '该阶段流失最高。' }],
    drop_off_hypotheses: ['反馈不足'],
  },
  'feature-adoption-analysis': {
    analysis_status: 'complete',
    data_requests: [],
    segments: [{ segment: '新用户', observation: '采纳率偏低。' }],
    adoption_barriers: ['入口不可见'],
  },
  'structure-interview-transcript': {
    transcript_status: 'complete',
    transcript_summary: '受访者关注操作效率。',
    turns: [{ turn_no: 1, speaker: 'participant', text: '希望步骤更少。' }],
    open_questions: [],
  },
  'synthesize-qualitative-insights': {
    themes: [{ id: 'theme-1', label: '效率', summary: '多位受访者希望减少步骤。' }],
    insights: ['效率阻碍核心任务完成。'],
    open_questions: [],
  },
};

test('Skill result envelope excludes a second evidence ledger and failed terminal state', () => {
  const schemaPath = join(getConfigRoot(), SKILL_RESULT_ENVELOPE_SCHEMA);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    properties: Record<string, unknown>;
  };
  const validator = new SchemaValidator();
  assert.doesNotThrow(() => validator.validateFileOrThrow(schemaPath, envelope()));
  assert.equal(Object.hasOwn(schema.properties, 'evidence'), false);
  assert.equal(Object.hasOwn(schema.properties, 'evidence_refs'), false);
  assert.throws(() => validator.validateFileOrThrow(schemaPath, {
    ...envelope(),
    evidence_refs: ['E1'],
  }));
  assert.throws(() => validator.validateFileOrThrow(schemaPath, { ...envelope(), status: 'failed' }));
  assert.throws(() => validator.validateFileOrThrow(schemaPath, { ...envelope(), unexpected: true }));
  const missing = envelope() as Record<string, unknown>;
  delete missing.summary;
  assert.throws(() => validator.validateFileOrThrow(schemaPath, missing));
});

test('every active Skill loads the unified effective output contract', () => {
  const loader = new SkillLoader();
  const active = loader.listActiveSkills();
  assert.ok(active.length > 0);
  for (const skill of active) {
    assert.equal(skill.output_schema, SKILL_RESULT_ENVELOPE_SCHEMA, skill.id);
    assert.doesNotThrow(() => loader.loadSkillSchemas(skill.id), skill.id);
  }
});

test('six Skill payload schemas are inlined and reject missing or extra fields', () => {
  const loader = new SkillLoader();
  const validator = new SchemaValidator();
  for (const [skillId, payload] of Object.entries(payloadFixtures)) {
    const skill = loader.getSkill(skillId);
    assert.ok(skill?.payload_schema, skillId);
    const effectiveSchema = loader.loadSkillSchemas(skillId).output;
    assert.doesNotThrow(() => validator.validateSchemaOrThrow(
      effectiveSchema,
      envelope(payload),
      `skill:${skillId}`,
    ));
    const [requiredField] = Object.keys(payload);
    assert.ok(requiredField);
    const missing = structuredClone(payload);
    delete missing[requiredField];
    assert.throws(() => validator.validateSchemaOrThrow(
      effectiveSchema,
      envelope(missing),
      `skill:${skillId}`,
    ));
    assert.throws(() => validator.validateSchemaOrThrow(
      effectiveSchema,
      envelope({ ...payload, unexpected: true }),
      `skill:${skillId}`,
    ));
  }
});

test('competitive app payload cannot create an unbound evidence reference', () => {
  const loader = new SkillLoader();
  const validator = new SchemaValidator();
  const payload = structuredClone(payloadFixtures['competitive-app-analysis']);
  assert.ok(payload);
  const comparisons = payload.screen_comparisons as Array<Record<string, unknown>>;
  comparisons[0]!.evidence_refs = ['artifact://unbound'];
  assert.throws(() => validator.validateSchemaOrThrow(
    loader.loadSkillSchemas('competitive-app-analysis').output,
    envelope(payload),
    'skill:competitive-app-analysis',
  ));
});

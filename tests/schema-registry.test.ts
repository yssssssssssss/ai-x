import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  resolveSchema,
  loadSchemaText,
} from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { hashPrompt } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

// issue #5:schemaName 命名空间收敛到 registry。测试锁定三类语义 + hashPrompt 溯源。

const FIDELITY_PLAN_VERSION = 'editorial-fidelity-plan-v1';
const COPY_EDIT_PLAN_VERSION = 'editorial-copy-edit-plan-v1';

function materialUnitId(index = 10): string {
  return `emu_${index.toString(16).padStart(64, '0')}`;
}

function fidelityCheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    copyPointer: '/sections/0/blocks/0/summary',
    materialUnitIds: [materialUnitId()],
    verdict: 'faithful',
    ...overrides,
  };
}

function fidelityPlan(checks: unknown[] = [fidelityCheck()]): Record<string, unknown> {
  return { version: FIDELITY_PLAN_VERSION, checks };
}

function compileFidelitySchema() {
  const text = loadSchemaText(resolveSchema('editorial-report-fidelity'));
  assert.ok(text, '应读到 Fidelity Review Plan schema');
  return new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(text));
}

function compileCopyEditSchema() {
  const text = loadSchemaText(resolveSchema('editorial-report-copy-edits'));
  assert.ok(text, '应读到 Copy Edit Plan schema');
  return new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(text));
}

test('resolveSchema:项目 schema 名映射到 schemas/ 文件', () => {
  const spec = resolveSchema('research-task');
  assert.equal(spec.id, 'research-task');
  assert.equal(spec.file, 'research-task.schema.json');
  assert.ok(!spec.isArrayEnvelope);
});

test('resolveSchema:editorial Copy Edit 使用固定 Registry key', () => {
  const spec = resolveSchema('editorial-report-copy-edits');
  assert.equal(spec.id, 'editorial-report-copy-edits');
  assert.equal(spec.file, 'editorial-report-copy-edits.schema.json');
  assert.ok(!spec.isArrayEnvelope);
});

test('resolveSchema:editorial Fidelity 使用固定 Registry key', () => {
  const spec = resolveSchema('editorial-report-fidelity');
  assert.equal(spec.id, 'editorial-report-fidelity');
  assert.equal(spec.file, 'editorial-report-fidelity.schema.json');
  assert.ok(!spec.isArrayEnvelope);
});

test('resolveSchema:decision-states 是数组 envelope,项 schema 为 decision-state', () => {
  const spec = resolveSchema('decision-states');
  assert.equal(spec.isArrayEnvelope, true);
  assert.equal(spec.arrayItemFile, 'decision-state.schema.json');
});

test('resolveSchema:skill:* 动态名识别,不映射到 schemas/ 文件', () => {
  const spec = resolveSchema('skill:digital-human-competitive-analysis');
  assert.equal(spec.id, 'skill:digital-human-competitive-analysis');
  assert.equal(spec.file, undefined);
  assert.ok(!spec.isArrayEnvelope);
});

test('resolveSchema:未知名回退为无文件 spec,不抛错', () => {
  const spec = resolveSchema('execution-plan-candidates');
  assert.equal(spec.id, 'execution-plan-candidates');
  // 无独立 schema 文件时 file 为 undefined,调用方降级为通用提示
  assert.equal(spec.file, undefined);
});

test('loadSchemaText:读到项目 schema 文本且带缓存(同引用)', () => {
  const spec = resolveSchema('research-task');
  const a = loadSchemaText(spec);
  const b = loadSchemaText(spec);
  assert.ok(a && a.length > 0, '应读到 schema 文本');
  assert.equal(a, b, '缓存命中应返回同一文本');
});

test('loadSchemaText:decision-states 加载数组项 schema 文本', () => {
  const spec = resolveSchema('decision-states');
  const text = loadSchemaText(spec);
  assert.ok(text && text.includes('node_key'), '应读到 decision-state 项 schema');
});

test('editorial Copy Edit schema accepts only one to six compact edits', () => {
  const validate = compileCopyEditSchema();
  const edit = (index: number) => ({
    copyPointer: `/sections/0/blocks/0/paragraphs/${index}`,
    materialUnitId: materialUnitId(index),
    text: `改写 ${index}`,
  });
  assert.equal(validate({ version: COPY_EDIT_PLAN_VERSION, edits: [edit(1)] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ version: COPY_EDIT_PLAN_VERSION, edits: [] }), false);
  assert.equal(validate({ version: COPY_EDIT_PLAN_VERSION, edits: Array.from({ length: 7 }, (_, index) => edit(index)) }), false);
  assert.equal(validate({ version: COPY_EDIT_PLAN_VERSION, edits: [edit(1)], sections: [] }), false);
  assert.equal(validate({ version: 'editorial-blueprint-plan-v1', edits: [edit(1)] }), false);
});

test('editorial Copy Edit schema bounds pointers, Unit IDs, text, and nested fields', () => {
  const validate = compileCopyEditSchema();
  const valid = {
    version: COPY_EDIT_PLAN_VERSION,
    edits: [{
      copyPointer: '/sections/0/blocks/0/paragraphs/0',
      materialUnitId: materialUnitId(),
      text: '清晰的编辑文案',
    }],
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  for (const edit of [
    { ...valid.edits[0], copyPointer: 'sections/0' },
    { ...valid.edits[0], copyPointer: '/非-ASCII' },
    { ...valid.edits[0], materialUnitId: 'unit-1' },
    { ...valid.edits[0], text: '' },
    { ...valid.edits[0], text: 'x'.repeat(601) },
    { ...valid.edits[0], text: '改写后的\u202e文案' },
    { ...valid.edits[0], text: '安全链接 https\u200d://example.com' },
    { ...valid.edits[0], text: '改写后的\ufe0f文案' },
    { ...valid.edits[0], text: '改写后的\u034f文案' },
    { ...valid.edits[0], text: '改写后的\u{e0061}文案' },
    { ...valid.edits[0], text: '改写后的\ufff9文案' },
    { ...valid.edits[0], text: '改写后的\ufffa文案' },
    { ...valid.edits[0], text: '改写后的\ufffb文案' },
    { ...valid.edits[0], text: '改写后的\u0600文案' },
    { ...valid.edits[0], text: '改写后的\u2800文案' },
    { ...valid.edits[0], mode: 'paraphrase' },
  ]) {
    assert.equal(validate({ ...valid, edits: [edit] }), false, JSON.stringify(edit));
  }

  for (const text of ['普通中文', '改写后\n文案', '改写后\t文案', '普通非 BMP 字符：𠀀']) {
    assert.equal(
      validate({ ...valid, edits: [{ ...valid.edits[0], text }] }),
      true,
      `${JSON.stringify(text)}: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test('editorial Fidelity schema 接受最小 Review Plan', () => {
  const validate = compileFidelitySchema();
  assert.equal(validate(fidelityPlan()), true, JSON.stringify(validate.errors));
});

test('editorial Fidelity schema 拒绝 Pipeline 控制字段和未知 check 字段', () => {
  const validate = compileFidelitySchema();
  const plan = fidelityPlan();
  for (const [field, value] of [
    ['materialHash', `sha256:${'b'.repeat(64)}`],
    ['blueprintHash', `sha256:${'c'.repeat(64)}`],
    ['verdict', 'pass'],
  ] as const) {
    assert.equal(validate({ ...plan, [field]: value }), false, field);
  }
  assert.equal(validate(fidelityPlan([
    fidelityCheck({ message: 'model-authored prose is forbidden' }),
  ])), false, 'check unknown field');
});

test('editorial Fidelity schema 要求完整的 Plan 和 check 字段', () => {
  const validate = compileFidelitySchema();
  const check = fidelityCheck();
  assert.equal(validate({ checks: [check] }), false, 'version is required');
  assert.equal(validate({ version: FIDELITY_PLAN_VERSION }), false, 'checks is required');
  for (const field of Object.keys(check)) {
    const incomplete = { ...check } as Record<string, unknown>;
    delete incomplete[field];
    assert.equal(validate(fidelityPlan([incomplete])), false, field);
  }
});

test('editorial Fidelity schema 固定版本并限制 verdict 词表', () => {
  const validate = compileFidelitySchema();
  const makePlan = (verdict: unknown, version = FIDELITY_PLAN_VERSION) => ({
    version,
    checks: [fidelityCheck({ verdict })],
  });
  for (const verdict of [
    'faithful',
    'narrower',
    'unsupported',
    'certainty_upgraded',
    'numeric_drift',
    'qualification_lost',
  ]) {
    assert.equal(validate(makePlan(verdict)), true, verdict);
  }
  assert.equal(validate(makePlan('pass')), false, 'pass is Pipeline-owned, not a check verdict');
  assert.equal(validate(makePlan('faithful', 'editorial-fidelity-v1')), false, 'final review version');
});

test('editorial Fidelity schema 将 Review Plan 限制为 1 到 240 个 check', () => {
  const validate = compileFidelitySchema();
  const makeChecks = (count: number) => Array.from(
    { length: count },
    (_, index) => fidelityCheck({ copyPointer: `/sections/0/blocks/${index}/summary` }),
  );
  assert.equal(validate(fidelityPlan([])), false);
  assert.equal(validate(fidelityPlan(makeChecks(240))), true, JSON.stringify(validate.errors));
  assert.equal(validate(fidelityPlan(makeChecks(241))), false);
});

test('editorial Fidelity schema 只接受最多 256 字符的 ASCII JSON Pointer', () => {
  const validate = compileFidelitySchema();
  const makePlan = (copyPointer: unknown) => fidelityPlan([fidelityCheck({ copyPointer })]);
  for (const pointer of [
    '/sections/0/blocks/0/summary',
    '/escaped~0tilde/~1slash',
    `/${'a'.repeat(255)}`,
  ]) {
    assert.equal(validate(makePlan(pointer)), true, pointer);
  }
  for (const pointer of [
    '',
    'sections/0/blocks/0/summary',
    '/bad~2escape',
    '/非-ASCII',
    `/${'a'.repeat(256)}`,
  ]) {
    assert.equal(validate(makePlan(pointer)), false, pointer || '(empty)');
  }
});

test('editorial Fidelity schema 只接受 1 到 16 个唯一 Material Unit ID', () => {
  const validate = compileFidelitySchema();
  const makePlan = (materialUnitIds: unknown) => fidelityPlan([
    fidelityCheck({ materialUnitIds }),
  ]);
  assert.equal(validate(makePlan([materialUnitId(0)])), true, JSON.stringify(validate.errors));
  assert.equal(validate(makePlan(Array.from({ length: 16 }, (_, index) => materialUnitId(index)))), true);
  for (const materialUnitIds of [
    [],
    Array.from({ length: 17 }, (_, index) => materialUnitId(index)),
    [materialUnitId(0), materialUnitId(0)],
    ['unit-1'],
    [`emu_${'A'.repeat(64)}`],
    [`emu_${'a'.repeat(63)}`],
  ]) {
    assert.equal(validate(makePlan(materialUnitIds)), false, JSON.stringify(materialUnitIds));
  }
});

test('loadSchemaText:无文件 spec(skill:*)返回 null', () => {
  const spec = resolveSchema('skill:x');
  assert.equal(loadSchemaText(spec), null);
});

test('hashPrompt:纳入 schemaId 后不同 schema 产生不同 hash(解溯源冲撞)', () => {
  const p = '同一段 prompt';
  const h1 = hashPrompt(p, undefined, 'research-task');
  const h2 = hashPrompt(p, undefined, 'research-report');
  assert.notEqual(h1, h2, '同 prompt 不同 schemaId 应 hash 不同');
});

test('hashPrompt:向后兼容,不传 schemaId 仍确定性可复现', () => {
  const p = 'x';
  assert.equal(hashPrompt(p), hashPrompt(p));
});

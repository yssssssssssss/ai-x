import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSchema,
  loadSchemaText,
} from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { hashPrompt } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

// issue #5:schemaName 命名空间收敛到 registry。测试锁定三类语义 + hashPrompt 溯源。

test('resolveSchema:项目 schema 名映射到 schemas/ 文件', () => {
  const spec = resolveSchema('research-task');
  assert.equal(spec.id, 'research-task');
  assert.equal(spec.file, 'research-task.schema.json');
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

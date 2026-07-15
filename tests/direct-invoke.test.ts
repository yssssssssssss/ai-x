import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectInvoke } from '../apps/orchestrator-runtime/src/runtime/direct-invoke.ts';

// $<skill-name> [args] 纯函数解析:命中返回 {skillName, rest},否则 null。

test('parseDirectInvoke:带参数 → 拆出 skillName 与 rest', () => {
  assert.deepEqual(parseDirectInvoke('$competitive-analysis 对比拼多多直播'), {
    skillName: 'competitive-analysis',
    rest: '对比拼多多直播',
  });
});

test('parseDirectInvoke:无参数 → rest 为空串', () => {
  assert.deepEqual(parseDirectInvoke('$generate-research-plan'), {
    skillName: 'generate-research-plan',
    rest: '',
  });
});

test('parseDirectInvoke:无 $ 前缀 → null', () => {
  assert.equal(parseDirectInvoke('我要做竞品研究'), null);
});

test('parseDirectInvoke:前导空格容错', () => {
  assert.deepEqual(parseDirectInvoke('  $journey-map  '), {
    skillName: 'journey-map',
    rest: '',
  });
});

test('parseDirectInvoke:$ 后中文名(非字母开头)→ null', () => {
  assert.equal(parseDirectInvoke('$不合法中文名'), null);
});

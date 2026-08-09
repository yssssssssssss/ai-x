import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSkillRegistry, loadToolRegistry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

test('P0 public search uses active core Tavily while O2 remains draft optional', () => {
  const tools = loadToolRegistry().tools;
  const tavily = tools.find((tool) => tool.id === 'tavily-web-search');
  const o2 = tools.find((tool) => tool.id === 'o2-web-search');

  assert.deepEqual(
    tavily && { status: tavily.status, tier: tavily.tier, adapterType: tavily.adapter_type },
    { status: 'active', tier: 'core', adapterType: 'tavily' },
  );
  assert.deepEqual(
    o2 && { status: o2.status, tier: o2.tier, adapterType: o2.adapter_type },
    { status: 'draft', tier: 'optional', adapterType: 'o2' },
  );
});

test('active competitive public-search skills require Tavily and never draft O2', () => {
  const skills = loadSkillRegistry().skills.filter((skill) =>
    skill.status === 'active'
    && skill.task_types?.includes('competitive_research')
    && skill.required_tools?.some((toolId) => toolId === 'o2-web-search' || toolId === 'tavily-web-search'),
  );

  assert.ok(skills.length > 0);
  for (const skill of skills) {
    assert.ok(skill.required_tools?.includes('tavily-web-search'), `${skill.id} must require Tavily`);
    assert.ok(!skill.required_tools?.includes('o2-web-search'), `${skill.id} must not require draft O2`);
  }
});

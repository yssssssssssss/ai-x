import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSkillExecutionContract } from '../apps/orchestrator-runtime/src/skills/skill-execution-contract.ts';

test('research strategy Skill defines one frozen answer-oriented DAG while activation remains gated', () => {
  const loaded = loadSkillExecutionContract(
    'orchestrator/skill-executions/research-strategy-synthesis.yaml',
    'research-strategy-synthesis',
  );
  assert.match(loaded.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.contract.stages.map(({ actor_type }) => actor_type), ['knowledge', 'tool', 'skill', 'reviewer']);
  assert.deepEqual(loaded.contract.stages.map(({ stage_id }) => stage_id), ['load-evidence-standards', 'collect-public-evidence', 'synthesize-direct-answers', 'challenge-answers']);
});

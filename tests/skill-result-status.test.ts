import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateSkillOutputStatus,
  SkillDegradedPolicyError,
} from '../apps/orchestrator-runtime/src/skills/skill-result-status.ts';

const degraded = {
  version: 'skill-output-v2',
  status: 'degraded',
  summary: 'partial result',
  limitations: ['required source unavailable'],
};

test('shared Skill status policy allows a visible gap and blocks when the contract requires it', () => {
  assert.deepEqual(evaluateSkillOutputStatus(degraded, 'gap'), {
    status: 'degraded',
    summary: 'partial result',
    limitations: ['required source unavailable'],
  });
  assert.throws(
    () => evaluateSkillOutputStatus(degraded, 'block'),
    SkillDegradedPolicyError,
  );
});

test('shared Skill status policy preserves succeeded and ignores legacy envelopes', () => {
  assert.deepEqual(evaluateSkillOutputStatus({
    ...degraded,
    status: 'succeeded',
    limitations: [],
  }, 'block'), {
    status: 'succeeded',
    summary: 'partial result',
    limitations: [],
  });
  assert.equal(evaluateSkillOutputStatus({ status: 'degraded' }, 'block'), null);
});

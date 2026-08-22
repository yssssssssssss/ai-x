import type { SkillExecutionContract } from './skill-execution-contract.ts';

export interface SkillOutputOutcome {
  status: 'succeeded' | 'degraded';
  limitations: string[];
  summary: string;
}

export class SkillDegradedPolicyError extends Error {
  constructor(readonly outcome: SkillOutputOutcome) {
    super(`Skill returned degraded status while degraded_policy is block: ${outcome.limitations[0] ?? outcome.summary}`);
    this.name = 'SkillDegradedPolicyError';
  }
}

export function evaluateSkillOutputStatus(
  value: unknown,
  degradedPolicy: SkillExecutionContract['degraded_policy'] = 'gap',
): SkillOutputOutcome | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 'skill-output-v2') return null;
  if (record.status !== 'succeeded' && record.status !== 'degraded') return null;
  const outcome: SkillOutputOutcome = {
    status: record.status,
    summary: typeof record.summary === 'string' ? record.summary : '',
    limitations: Array.isArray(record.limitations)
      ? record.limitations.filter((item): item is string => typeof item === 'string')
      : [],
  };
  if (outcome.status === 'degraded' && degradedPolicy === 'block') {
    throw new SkillDegradedPolicyError(outcome);
  }
  return outcome;
}

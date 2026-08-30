import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  invocationFailureCanBecomeGap,
  parseExecutionPlan,
  rebindReusableArtifactValue,
} from '../apps/orchestrator-runtime/src/control/lease-execution-engine.ts';
import { ExecutionScheduler } from '../apps/orchestrator-runtime/src/control/execution-scheduler.ts';
import { resolveDeliverableContractById } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import {
  buildResearchContributionBundle,
  ResearchContributionBundleError,
} from '../apps/orchestrator-runtime/src/skills/research-contribution-bundle.ts';

function runtimePlan(): Record<string, unknown> {
  const baseSkill = (id: string) => ({
    id,
    status: 'active',
    task_types: ['research_synthesis'],
    inputs: ['research_goal'],
    outputs: ['contribution'],
    required_tools: [],
    composition: {
      modes: id === 'synthesizer' ? ['synthesizer'] : ['contributor'],
      supported_outcomes: ['answer'],
      compatible_deliverables: ['research_strategy_report'],
      contribution_types: id === 'synthesizer' ? ['strategy'] : ['persona'],
      contribution_schema: 'schemas/research-contribution-v1.schema.json',
      ...(id === 'synthesizer' ? {} : { contribution_adapter: 'skill-envelope-provisional-v1' }),
      required_input_roles: ['research_goal'],
      optional_input_roles: [],
    },
  });
  return {
    task_id: 'task-1',
    execution_contract_version: 'current-execution-plan-v3',
    deliverable_type: 'research_strategy_report',
    evidence_requirements: [{
      id: 'research-strategy-report',
      acceptedClasses: ['public_source'],
      minimumCount: 1,
      required: true,
    }],
    capability_decisions: {
      eligible: [
        { skill: baseSkill('optional-contributor'), required_approvals: [], reasons: [{ code: 'eligible', message: 'ok' }], pending_inputs: [] },
        { skill: baseSkill('synthesizer'), required_approvals: [], reasons: [{ code: 'eligible', message: 'ok' }], pending_inputs: [] },
      ],
      rejected: [],
    },
    capability_gaps: [],
    skill_invocations: [
      {
        invocation_id: 'invocation:optional',
        skill_id: 'optional-contributor',
        role: 'contributor',
        contribution_types: ['persona'],
        question_ids: ['question-1'],
        requested_artifact_types: [],
        depends_on_invocation_ids: [],
        output_contract: 'research-contribution-v1',
        required: false,
        failure_policy: 'gap',
        execution_mode: 'legacy_single_call',
        step_nos: [1],
      },
      {
        invocation_id: 'invocation:synthesis',
        skill_id: 'synthesizer',
        role: 'synthesizer',
        contribution_types: ['strategy'],
        question_ids: ['question-1'],
        requested_artifact_types: [],
        depends_on_invocation_ids: ['invocation:optional'],
        output_contract: 'reviewed-synthesis-draft-v1',
        required: true,
        failure_policy: 'block',
        execution_mode: 'legacy_single_call',
        step_nos: [2],
      },
    ],
    steps: [
      {
        step_no: 1,
        step_name: 'optional contributor',
        actor_type: 'skill',
        actor_id: 'optional-contributor',
        question_ids: ['question-1'],
        depends_on: [],
        input: {},
        input_bindings: [],
        expected_outputs: [{ pointer: '/payload', description: 'contribution' }],
        acceptance_criteria: ['valid contribution'],
        requires_approval: false,
        fallback_actor_ids: [],
        skill_invocation_id: 'invocation:optional',
        skill_stage_id: 'legacy-call',
      },
      {
        step_no: 2,
        step_name: 'synthesis',
        actor_type: 'skill',
        actor_id: 'synthesizer',
        question_ids: ['question-1'],
        depends_on: [1],
        input: {
          contribution_bundle: { 'invocation:optional': null },
          contribution_order: ['invocation:optional'],
        },
        input_bindings: [{
          target_pointer: '/contribution_bundle/invocation:optional',
          source_step_no: 1,
          source_pointer: '/payload',
          optional: true,
        }],
        expected_outputs: [{ pointer: '/payload', description: 'synthesis' }],
        acceptance_criteria: ['complete'],
        requires_approval: false,
        fallback_actor_ids: [],
        skill_invocation_id: 'invocation:synthesis',
        skill_stage_id: 'legacy-call',
      },
    ],
  };
}

test('runtime parser preserves optional Contributor policy without weakening Synthesizer policy', () => {
  const parsed = parseExecutionPlan(
    'task-1',
    runtimePlan(),
    resolveDeliverableContractById('research_strategy_report'),
  );
  assert.deepEqual(parsed.invocationPoliciesByStep.get(1)?.map(({ invocationId, role, required, failurePolicy }) => ({
    invocationId, role, required, failurePolicy,
  })), [{
    invocationId: 'invocation:optional',
    role: 'contributor',
    required: false,
    failurePolicy: 'gap',
  }]);
  assert.equal(parsed.optionalInvocationStepNos.has(1), true);
  assert.equal(parsed.optionalInvocationStepNos.has(2), false);
});

test('Contribution Bundle preserves frozen order, Artifact identity, and optional gaps', () => {
  const policies = new Map([
    ['invocation:required', {
      invocationId: 'invocation:required', skillId: 'market', role: 'contributor' as const,
      required: true, failurePolicy: 'block' as const, dependsOnInvocationIds: [],
    }],
    ['invocation:optional', {
      invocationId: 'invocation:optional', skillId: 'persona', role: 'contributor' as const,
      required: false, failurePolicy: 'gap' as const, dependsOnInvocationIds: [],
    }],
    ['invocation:synthesis', {
      invocationId: 'invocation:synthesis', skillId: 'synth', role: 'synthesizer' as const,
      required: true, failurePolicy: 'block' as const,
      dependsOnInvocationIds: ['invocation:required', 'invocation:optional'],
    }],
  ]);
  const contribution = {
    version: 'research-contribution-v1' as const,
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    invocationId: 'invocation:required', skillId: 'market',
    contributionTypes: ['market_landscape' as const],
    units: [{
      key: 'u1', kind: 'finding' as const, title: 'Finding', statement: 'Statement',
      requestedArtifactTypes: [],
      support: {
        questionIds: ['question-1'], evidenceIds: [], status: 'provisional' as const,
        confidence: 0.5, validationNeeded: 'Validate.',
      },
    }],
    limitations: [], openQuestions: [],
  };
  const bundle = buildResearchContributionBundle({
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    orderedInvocationIds: ['invocation:required', 'invocation:optional'],
    valuesByInvocationId: {
      'invocation:required': {
        artifactId: 'artifact-required', artifactContentSha256: `sha256:${'a'.repeat(64)}`, contribution,
      },
      'invocation:optional': null,
    },
    policiesByInvocationId: policies,
    synthesizerInvocationId: 'invocation:synthesis',
  });
  assert.deepEqual(bundle.entries.map(({ invocationId, artifactId }) => ({ invocationId, artifactId })), [{
    invocationId: 'invocation:required', artifactId: 'artifact-required',
  }]);
  assert.deepEqual(bundle.gaps.map(({ invocationId }) => invocationId), ['invocation:optional']);

  assert.throws(() => buildResearchContributionBundle({
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    orderedInvocationIds: ['invocation:required'],
    valuesByInvocationId: { 'invocation:required': null },
    policiesByInvocationId: policies,
    synthesizerInvocationId: 'invocation:synthesis',
  }), ResearchContributionBundleError);
});

test('retry rebinding preserves immutable Contribution source identity and updates attempt identity', () => {
  const value = {
    version: 'research-contribution-artifact-v1',
    contribution: {
      version: 'research-contribution-v1',
      taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-old',
      invocationId: 'invocation:market', skillId: 'market', contributionTypes: ['market_landscape'],
      units: [], limitations: [], openQuestions: [],
    },
    source: {
      artifactId: 'source-old', artifactContentSha256: `sha256:${'a'.repeat(64)}`,
      schemaVersion: 'skill-output-v2', adapterId: 'skill-envelope-provisional-v1',
      adapterVersion: '1.0.0', adapterHash: `sha256:${'b'.repeat(64)}`,
      unitMappings: [], diagnosticFields: [],
    },
  };
  const rebound = rebindReusableArtifactValue('research_contribution', value, {
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-new',
  }) as typeof value;
  assert.equal(rebound.contribution.attemptId, 'attempt-new');
  assert.equal(rebound.source.artifactId, 'source-old');
  assert.equal(value.contribution.attemptId, 'attempt-old');
});

test('optional Contributor failures become gaps except safety, integrity, or lease loss', () => {
  assert.equal(invocationFailureCanBecomeGap({
    optionalInvocationStep: true,
    failureKind: 'provider',
    artifactCleanupFailed: false,
    integrityFailure: false,
  }), true);
  for (const input of [
    { optionalInvocationStep: false, failureKind: 'provider', artifactCleanupFailed: false, integrityFailure: false },
    { optionalInvocationStep: true, failureKind: 'safety', artifactCleanupFailed: false, integrityFailure: false },
    { optionalInvocationStep: true, failureKind: 'lease_lost', artifactCleanupFailed: false, integrityFailure: false },
    { optionalInvocationStep: true, failureKind: 'provider', artifactCleanupFailed: true, integrityFailure: false },
    { optionalInvocationStep: true, failureKind: 'provider', artifactCleanupFailed: false, integrityFailure: true },
  ]) assert.equal(invocationFailureCanBecomeGap(input), false);
});

test('scheduler runs independent Contributors in parallel and Synthesizer afterward', async () => {
  const scheduler = new ExecutionScheduler({
    async execute(step) { return step.key; },
  });
  const result = await scheduler.schedule({
    steps: [
      { key: 'shared', dependsOn: [] },
      { key: 'market', dependsOn: ['shared'] },
      { key: 'persona', dependsOn: ['shared'], tier: 'optional' },
      { key: 'synthesis', dependsOn: ['market', 'persona'] },
    ],
  }, {});
  assert.deepEqual(result.waves, [
    ['shared'],
    ['market', 'persona'],
    ['synthesis'],
  ]);
});

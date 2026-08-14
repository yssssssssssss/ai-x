import { createHash, randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentPlanStep } from '../packages/api-contract/research-deliverable.ts';
import {
  ArtifactIntegrityError,
  ControlArtifactStore,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  StepInputResolutionError,
  resolveStepInput,
  type SealedStepOutput,
  type VerifiedArtifactReader,
} from '../apps/orchestrator-runtime/src/control/step-input-resolver.ts';
import {
  ArtifactNotSealedError,
  type ControlArtifact,
} from '../database/control-plane.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function step(overrides: Partial<CurrentPlanStep> = {}): CurrentPlanStep {
  return {
    step_no: 2,
    step_name: 'consume sealed output',
    actor_type: 'skill',
    actor_id: 'test-skill',
    question_ids: ['q1'],
    depends_on: [1],
    input: { nested: { 'a/b': null }, source: null },
    input_bindings: [{
      target_pointer: '/source',
      source_step_no: 1,
      source_pointer: '/result',
    }],
    expected_outputs: [{ pointer: '/analysis', description: 'analysis' }],
    acceptance_criteria: ['uses sealed source'],
    requires_approval: false,
    fallback_actor_ids: [],
    ...overrides,
  };
}

function artifact(
  id: string,
  overrides: Partial<ControlArtifact> = {},
): ControlArtifact {
  return {
    id,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    kind: 'skill_output',
    state: 'SEALED',
    storageUri: `/tmp/${id}.json`,
    contentSha256: 'sha256:sealed',
    byteSize: 10,
    schemaVersion: 'skill-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    ...overrides,
  };
}

function sealedOutput(
  stepNo = 1,
  overrides: Partial<SealedStepOutput> = {},
): SealedStepOutput {
  const id = `artifact-${stepNo}`;
  return {
    stepNo,
    actorId: `actor-${stepNo}`,
    kind: 'skill_output',
    state: 'succeeded',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    artifact: {
      id,
      state: 'SEALED',
      contentSha256: 'sha256:sealed',
    },
    ...overrides,
  };
}

class MemoryArtifactReader implements VerifiedArtifactReader {
  readonly reads: string[] = [];

  constructor(
    private readonly values: Map<string, { artifact: ControlArtifact; value: unknown }>,
  ) {}

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    this.reads.push(artifactId);
    const found = this.values.get(artifactId);
    if (!found) throw new Error(`missing artifact ${artifactId}`);
    return found as { artifact: ControlArtifact; value: T };
  }
}

function reader(value: unknown, metadata: Partial<ControlArtifact> = {}): MemoryArtifactReader {
  return new MemoryArtifactReader(new Map([
    ['artifact-1', { artifact: artifact('artifact-1', metadata), value }],
  ]));
}

async function expectCode(
  operation: () => Promise<unknown>,
  code: StepInputResolutionError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof StepInputResolutionError);
    assert.equal(error.code, code);
    return true;
  });
}

test('clones compiler input and applies RFC6901 escaped bindings from verified artifacts', async () => {
  const original = step({
    input_bindings: [{
      target_pointer: '/nested/a~1b',
      source_step_no: 1,
      source_pointer: '/a~1b/~0key',
    }],
  });
  const artifacts = reader({ 'a/b': { '~key': { value: 42 } } });

  const resolved = await resolveStepInput(original, [sealedOutput()], artifacts);

  assert.deepEqual(resolved, { nested: { 'a/b': { value: 42 } }, source: null });
  assert.deepEqual(original.input, { nested: { 'a/b': null }, source: null });
  assert.notEqual(resolved, original.input);
  assert.deepEqual(artifacts.reads, ['artifact-1']);
});

test('reads array elements from the source without allowing target array mutation', async () => {
  const artifacts = reader({ results: [{ title: 'sealed title' }] });
  const resolved = await resolveStepInput(step({
    input_bindings: [{
      target_pointer: '/source',
      source_step_no: 1,
      source_pointer: '/results/0/title',
    }],
  }), [sealedOutput()], artifacts);
  assert.deepEqual(resolved, { nested: { 'a/b': null }, source: 'sealed title' });

  await expectCode(
    () => resolveStepInput(step({
      input: { sources: [] },
      input_bindings: [{
        target_pointer: '/sources/0',
        source_step_no: 1,
        source_pointer: '/results/0',
      }],
    }), [sealedOutput()], artifacts),
    'target_not_object',
  );
});

test('unwraps the persisted Tool output envelope before resolving source pointers', async () => {
  const toolOutput = sealedOutput(1, { kind: 'tool_output' });
  const toolArtifact = artifact('artifact-1', { kind: 'tool_output', schemaVersion: 'tool-output-v1' });
  const artifacts = new MemoryArtifactReader(new Map([
    ['artifact-1', {
      artifact: toolArtifact,
      value: { output: { results: [{ title: 'verified result' }] }, outputHash: 'sha256:original' },
    }],
  ]));

  const resolved = await resolveStepInput(step({
    input_bindings: [{
      target_pointer: '/source',
      source_step_no: 1,
      source_pointer: '/results/0',
    }],
  }), [toolOutput], artifacts);

  assert.deepEqual(resolved.source, { title: 'verified result' });
});

test('rejects unknown, future, duplicate, and non-succeeded source steps', async () => {
  const artifacts = reader({ result: 'sealed' });
  await expectCode(() => resolveStepInput(step(), [], artifacts), 'unknown_source');
  await expectCode(
    () => resolveStepInput(step({
      input_bindings: [{ target_pointer: '/source', source_step_no: 2, source_pointer: '/result' }],
    }), [sealedOutput(2)], artifacts),
    'future_source',
  );
  await expectCode(
    () => resolveStepInput(step(), [sealedOutput(), sealedOutput()], artifacts),
    'duplicate_source',
  );
  await expectCode(
    () => resolveStepInput(step(), [sealedOutput(1, { state: 'failed' })], artifacts),
    'source_not_succeeded',
  );
  assert.deepEqual(artifacts.reads, []);
});

test('rejects dangling source pointers and malformed pointer escapes', async () => {
  const artifacts = reader({ result: 'sealed' });
  await expectCode(
    () => resolveStepInput(step({
      input_bindings: [{ target_pointer: '/source', source_step_no: 1, source_pointer: '/missing' }],
    }), [sealedOutput()], artifacts),
    'source_pointer_missing',
  );
  await expectCode(
    () => resolveStepInput(step({
      input_bindings: [{ target_pointer: '/source', source_step_no: 1, source_pointer: '/bad~2escape' }],
    }), [sealedOutput()], artifacts),
    'invalid_pointer',
  );
});

test('rejects duplicate decoded targets and prototype pollution paths', async () => {
  const artifacts = reader({ result: 'sealed' });
  await expectCode(
    () => resolveStepInput(step({
      input: { 'a/b': null },
      input_bindings: [
        { target_pointer: '/a~1b', source_step_no: 1, source_pointer: '/result' },
        { target_pointer: '/a~1b', source_step_no: 1, source_pointer: '/result' },
      ],
    }), [sealedOutput()], artifacts),
    'duplicate_target',
  );

  for (const target of ['/__proto__/polluted', '/safe/prototype/value', '/constructor/value']) {
    await expectCode(
      () => resolveStepInput(step({
        input: { safe: {} },
        input_bindings: [{ target_pointer: target, source_step_no: 1, source_pointer: '/result' }],
      }), [sealedOutput()], artifacts),
      'unsafe_target',
    );
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('rejects unsealed references and verified artifacts bound to another execution scope', async () => {
  const artifacts = reader({ result: 'sealed' });
  await expectCode(
    () => resolveStepInput(step(), [sealedOutput(1, {
      artifact: { id: 'artifact-1', state: 'STAGING', contentSha256: null },
    })], artifacts),
    'source_artifact_not_sealed',
  );
  await expectCode(
    () => resolveStepInput(step(), [sealedOutput()], reader({ result: 'sealed' }, { attemptId: 'attempt-2' })),
    'source_artifact_mismatch',
  );
  await expectCode(
    () => resolveStepInput(step(), [sealedOutput()], reader({ result: 'sealed' }, { contentSha256: 'sha256:other' })),
    'source_artifact_mismatch',
  );
});

class MemoryArtifactRegistry {
  readonly artifacts = new Map<string, ControlArtifact>();

  async createStagingArtifact(input: {
    taskId: string;
    planVersionId: string;
    attemptId?: string;
    kind: string;
    storageUri: string;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
  }): Promise<ControlArtifact> {
    const created = artifact(randomUUID(), {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId ?? null,
      kind: input.kind,
      state: 'STAGING',
      storageUri: input.storageUri,
      contentSha256: null,
      byteSize: null,
      schemaVersion: input.schemaVersion,
      sensitivity: input.sensitivity,
      redactionPolicyVersion: input.redactionPolicyVersion,
    });
    this.artifacts.set(created.id, created);
    return created;
  }

  async sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  }): Promise<ControlArtifact> {
    const current = this.artifacts.get(input.artifactId);
    if (!current) throw new Error('missing staging artifact');
    const sealed = { ...current, state: 'SEALED' as const, contentSha256: input.contentSha256, byteSize: input.byteSize };
    this.artifacts.set(sealed.id, sealed);
    return sealed;
  }

  async failArtifact(artifactId: string, failureReason: string): Promise<void> {
    const current = this.artifacts.get(artifactId);
    if (!current) throw new Error('missing artifact');
    const failed = { ...current, state: 'FAILED' as const, failureReason };
    this.artifacts.set(failed.id, failed);
  }

  async invalidateArtifactPublication(artifactId: string, failureReason: string): Promise<void> {
    await this.failArtifact(artifactId, failureReason);
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async listStagingArtifacts(): Promise<ControlArtifact[]> {
    return [...this.artifacts.values()].filter((value) => value.state === 'STAGING');
  }

  async requireSealedArtifact(artifactId: string): Promise<ControlArtifact> {
    const current = this.artifacts.get(artifactId);
    if (!current || current.state !== 'SEALED') throw new ArtifactNotSealedError(artifactId);
    return current;
  }

  async requireSealedArtifactBinding(artifactId: string): Promise<ControlArtifact> {
    return this.requireSealedArtifact(artifactId);
  }
}

test('consumes a real sealed ControlArtifactStore value and rejects tampered bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step-bindings-artifacts-'));
  tempDirs.push(root);
  const registry = new MemoryArtifactRegistry();
  const store = new ControlArtifactStore({ root, registry });
  const written = await store.writeJson({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    kind: 'skill_output',
    relativePath: 'steps/1-skill-output.json',
    value: { result: { trusted: true } },
  });
  const source = sealedOutput(1, {
    artifact: { id: written.id, state: 'SEALED', contentSha256: written.contentSha256 },
  });

  const resolved = await resolveStepInput(step(), [source], store);
  assert.deepEqual(resolved.source, { trusted: true });

  writeFileSync(written.storageUri, `${readFileSync(written.storageUri, 'utf8')}\n`);
  await assert.rejects(
    () => resolveStepInput(step(), [source], store),
    ArtifactIntegrityError,
  );
});

test('never reads a STAGING ControlArtifactStore value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step-bindings-staging-'));
  tempDirs.push(root);
  const registry = new MemoryArtifactRegistry();
  const store = new ControlArtifactStore({ root, registry });
  const storageUri = join(root, 'staging.json');
  const staging = await registry.createStagingArtifact({
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    kind: 'skill_output',
    storageUri,
    schemaVersion: 'skill-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  const bytes = JSON.stringify({ result: 'must not be read' });
  writeFileSync(storageUri, bytes);
  const contentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const source = sealedOutput(1, {
    artifact: { id: staging.id, state: 'SEALED', contentSha256 },
  });

  await assert.rejects(
    () => resolveStepInput(step(), [source], store),
    ArtifactNotSealedError,
  );
});

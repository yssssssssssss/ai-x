import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ControlArtifact } from '../database/control-plane.ts';
import type { EvidenceEntry } from '../packages/api-contract/research-deliverable.ts';
import {
  SynthesisMaterializer,
  type MaterializeInput,
  type SynthesisMaterial,
} from '../apps/orchestrator-runtime/src/report/synthesis-materializer.ts';

const taskId = 'task-materializer-1';
const planVersionId = 'plan-materializer-1';
const attemptId = 'attempt-materializer-1';
const hash = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

class Reader {
  readonly reads: string[] = [];
  values: Map<string, { artifact: ControlArtifact; value: unknown }>;
  constructor(values: Map<string, { artifact: ControlArtifact; value: unknown }>) {
    this.values = values;
  }
  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    this.reads.push(artifactId);
    const value = this.values.get(artifactId);
    if (!value) throw new Error(`missing artifact ${artifactId}`);
    return value as { artifact: ControlArtifact; value: T };
  }
}

class Validator {
  readonly calls: Array<{ schemaVersion: string; value: unknown }> = [];
  validateArtifact(value: unknown, artifact: ControlArtifact): void {
    this.calls.push({ schemaVersion: artifact.schemaVersion, value });
  }
}

function artifact(id: string, kind: string, value: unknown, overrides: Partial<ControlArtifact> = {}): { artifact: ControlArtifact; value: unknown } {
  return {
    artifact: {
      id,
      taskId,
      planVersionId,
      attemptId,
      kind,
      state: 'SEALED',
      storageUri: `/tmp/${id}.json`,
      contentSha256: hash(value),
      byteSize: JSON.stringify(value).length,
      schemaVersion: `${kind.replace('_output', '-output')}-v1`,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
      ...overrides,
    },
    value,
  };
}

function evidenceFor(id: string, contentSha256: string): EvidenceEntry {
  return {
    id: `E-${id}`,
    kind: 'tool_output',
    evidenceClass: 'public_source',
    artifactId: id,
    artifactContentSha256: contentSha256,
    jsonPointer: '/output/results/0',
    sourceUrl: 'https://source.example/item',
    stepNo: 1,
    toolProof: {
      implementationId: 'tavily',
      executionMode: 'real',
      redactedOutputHash: hash({ title: 'fact' }),
    },
    sensitivity: 'public',
    redaction: 'masked',
  };
}

function input(reader: Reader, overrides: Partial<MaterializeInput> = {}): MaterializeInput {
  const toolValue = { output: { results: [{ title: 'fact' }] }, redactedOutputHash: hash({ title: 'fact' }) };
  const tool = artifact('artifact-tool', 'tool_output', toolValue);
  const skill = artifact('artifact-skill', 'skill_output', {
    conclusion: '分析结论',
    email: 'person@example.test',
    prompt: 'FULL_PROMPT_MUST_NOT_REACH_CONTEXT',
  });
  const llm = artifact('artifact-llm', 'llm_output', {
    text: '推断结果',
    token: 'secret-token',
  });
  const reviewer = artifact('artifact-reviewer', 'review_output', {
    review: '复核意见',
    phone: '13800138000',
  });
  reader.values = new Map([
    [tool.artifact.id, tool],
    [skill.artifact.id, skill],
    [llm.artifact.id, llm],
    [reviewer.artifact.id, reviewer],
  ]);
  const outputs = [
    { stepNo: 1, actorType: 'tool' as const, actorId: 'tavily', questionIds: ['q1'], kind: 'tool_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: tool.artifact.id, contentSha256: tool.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 2, actorType: 'skill' as const, actorId: 'analyst', questionIds: ['q1'], kind: 'skill_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: skill.artifact.id, contentSha256: skill.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 3, actorType: 'llm' as const, actorId: 'summarizer', questionIds: ['q2'], kind: 'llm_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: llm.artifact.id, contentSha256: llm.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 4, actorType: 'reviewer' as const, actorId: 'review', questionIds: ['q1', 'q2'], kind: 'review_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: reviewer.artifact.id, contentSha256: reviewer.artifact.contentSha256, state: 'SEALED' as const } },
  ];
  return {
    taskId,
    planVersionId,
    attemptId,
    outputs,
    evidenceEntries: [evidenceFor(tool.artifact.id, tool.artifact.contentSha256!)],
    validator: new Validator(),
    ...overrides,
  };
}

test('materializes all actor roles from verified sealed JSON and preserves bindings', async () => {
  const reader = new Reader(new Map());
  const materials = await new SynthesisMaterializer(reader).materialize(input(reader));
  assert.deepEqual(materials.map((item) => item.semanticRole), ['fact_source', 'analysis', 'inference', 'review']);
  assert.deepEqual(materials.map((item) => item.artifactId), ['artifact-tool', 'artifact-skill', 'artifact-llm', 'artifact-reviewer']);
  assert.equal(materials[0]?.artifactContentSha256, hash({ output: { results: [{ title: 'fact' }] }, redactedOutputHash: hash({ title: 'fact' }) }));
  const toolValue = materials[0]?.value;
  assert.ok(toolValue && typeof toolValue === 'object' && !Array.isArray(toolValue));
  const outputValue = (toolValue as Record<string, unknown>).output;
  assert.deepEqual(outputValue, { results: [{ title: 'fact' }] });
  assert.equal(reader.reads.length, 4);
});

test('rejects tampered, foreign, unsealed, and sensitive artifacts before materialization', async () => {
  const cases: Array<{ name: string; patch: Partial<ControlArtifact> }> = [
    { name: 'tampered hash', patch: { contentSha256: hash('different') } },
    { name: 'foreign attempt', patch: { attemptId: 'other-attempt' } },
    { name: 'unsealed', patch: { state: 'STAGING' } },
    { name: 'blocked sensitivity', patch: { sensitivity: 'sensitive' } },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => new SynthesisMaterializer(new Reader(new Map())).materialize(input(new Reader(new Map()), {
        outputs: input(new Reader(new Map())).outputs.map((output, index) => index === 1
          ? { ...output, artifact: { ...output.artifact, ...item.patch } }
          : output),
      })),
      /material|artifact|sensitivity|sealed|scope|hash/i,
      item.name,
    );
  }
});

test('redacts prompts, credentials, and PII without mutating verified values', async () => {
  const reader = new Reader(new Map());
  const source = input(reader);
  const original = structuredClone((reader as unknown as { values: Map<string, { value: unknown }> }).values);
  const materials = await new SynthesisMaterializer(reader).materialize(source);
  const text = JSON.stringify(materials);
  assert.equal(text.includes('FULL_PROMPT_MUST_NOT_REACH_CONTEXT'), false);
  assert.equal(text.includes('secret-token'), false);
  assert.equal(text.includes('person@example.test'), false);
  assert.equal(text.includes('13800138000'), false);
  assert.match(text, /REDACTED/);
  assert.deepEqual((reader as unknown as { values: Map<string, { value: unknown }> }).values, original);
});

test('does not classify an unproven Tool as a fact source', async () => {
  const reader = new Reader(new Map());
  const source = input(reader, { evidenceEntries: [] });
  const materials = await new SynthesisMaterializer(reader).materialize(source);
  assert.equal(materials.some((item) => item.semanticRole === 'fact_source'), false);
});

test('consumes material content, not only artifact metadata', async () => {
  const reader = new Reader(new Map());
  const source = input(reader);
  const first = await new SynthesisMaterializer(reader).materialize(source);
  const skillOutput = reader.values.get('artifact-skill');
  assert.ok(skillOutput);
  skillOutput.value = { conclusion: 'different analysis' };
  skillOutput.artifact.contentSha256 = hash(skillOutput.value);
  const skillStep = source.outputs[1];
  assert.ok(skillStep);
  skillStep.artifact.contentSha256 = skillOutput.artifact.contentSha256;
  const second = await new SynthesisMaterializer(reader).materialize(source);
  assert.notDeepEqual(first, second);
  assert.equal((second.find((item) => item.actorType === 'skill')?.value as { conclusion: string }).conclusion, 'different analysis');
});

void ({} as SynthesisMaterial[]);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ControlArtifact } from '../database/control-plane.ts';
import type { EvidenceEntry } from '../packages/api-contract/research-deliverable.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  SynthesisMaterializer,
  type MaterializeInput,
  type SynthesisMaterial,
} from '../apps/orchestrator-runtime/src/report/synthesis-materializer.ts';

const taskId = 'task-materializer-1';
const planVersionId = 'plan-materializer-1';
const attemptId = 'attempt-materializer-1';
const hash = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const defaultToolResult = { title: 'fact', url: 'https://source.example/item' };
const defaultToolOutput = { results: [defaultToolResult] };

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
    sourceUrl: defaultToolResult.url,
    stepNo: 2,
    toolProof: {
      implementationId: 'tavily',
      executionMode: 'real',
      redactedOutputHash: hash(defaultToolOutput),
    },
    sensitivity: 'public',
    redaction: 'masked',
  };
}

function input(reader: Reader, overrides: Partial<MaterializeInput> = {}): MaterializeInput {
  const toolValue = { output: defaultToolOutput, redactedOutputHash: hash(defaultToolOutput) };
  const knowledge = artifact('artifact-knowledge', 'knowledge_output', { resources: [{ id: 'standard-1' }] }, { schemaVersion: 'knowledge-bundle-v1' });
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
    [knowledge.artifact.id, knowledge],
    [tool.artifact.id, tool],
    [skill.artifact.id, skill],
    [llm.artifact.id, llm],
    [reviewer.artifact.id, reviewer],
  ]);
  const outputs = [
    { stepNo: 1, actorType: 'knowledge' as const, actorId: 'knowledge.index', questionIds: ['q1'], kind: 'knowledge_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: knowledge.artifact.id, contentSha256: knowledge.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 2, actorType: 'tool' as const, actorId: 'tavily', questionIds: ['q1'], kind: 'tool_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: tool.artifact.id, contentSha256: tool.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 3, actorType: 'skill' as const, actorId: 'analyst', questionIds: ['q1'], kind: 'skill_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: skill.artifact.id, contentSha256: skill.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 4, actorType: 'llm' as const, actorId: 'summarizer', questionIds: ['q2'], kind: 'llm_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: llm.artifact.id, contentSha256: llm.artifact.contentSha256, state: 'SEALED' as const } },
    { stepNo: 5, actorType: 'reviewer' as const, actorId: 'review', questionIds: ['q1', 'q2'], kind: 'review_output' as const, state: 'succeeded' as const, taskId, planVersionId, attemptId, artifact: { id: reviewer.artifact.id, contentSha256: reviewer.artifact.contentSha256, state: 'SEALED' as const } },
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

interface PublicToolValue {
  output: {
    results: Array<{ title: string; url: string }>;
  };
  redactedOutputHash: string;
  answer?: string;
}

function realEvidenceEntries(
  artifactId: string,
  artifactContentSha256: string,
  value: PublicToolValue,
  bindings: ReadonlyArray<{ evidenceId: string; resultIndex: number }>,
): EvidenceEntry[] {
  const resolver: EvidenceArtifactResolver = {
    resolveArtifact: (candidateId) => candidateId === artifactId
      ? {
          artifact: { id: artifactId, contentSha256: artifactContentSha256 },
          value,
        }
      : null,
  };
  return new EvidenceService().createManifest({
    taskId,
    planVersionId,
    attemptId,
    collectedAt: '2026-08-14T00:00:00.000Z',
    entries: bindings.map(({ evidenceId, resultIndex }) => {
      const selected = value.output.results[resultIndex];
      assert.ok(selected, `missing fixture result ${resultIndex}`);
      return {
        id: evidenceId,
        kind: 'tool_output',
        evidenceClass: 'public_source',
        artifactId,
        artifactContentSha256,
        jsonPointer: `/output/results/${resultIndex}`,
        sourceUrl: selected.url,
        stepNo: 2,
        toolProof: {
          implementationId: 'tavily',
          executionMode: 'real',
          redactedOutputHash: value.redactedOutputHash,
        },
        sensitivity: 'public',
        redaction: 'masked',
      };
    }),
  }, resolver).entries;
}

function toolOnlyInput(
  reader: Reader,
  tool: { artifact: ControlArtifact; value: unknown },
  evidenceEntries: readonly EvidenceEntry[],
): MaterializeInput {
  const source = input(reader);
  const toolOutput = source.outputs.find(({ actorType }) => actorType === 'tool');
  assert.ok(toolOutput);
  reader.values = new Map([[tool.artifact.id, tool]]);
  return {
    ...source,
    outputs: [{
      ...toolOutput,
      artifact: {
        id: tool.artifact.id,
        contentSha256: tool.artifact.contentSha256,
        state: 'SEALED',
      },
    }],
    evidenceEntries,
  };
}

test('materializes all actor roles from verified sealed JSON and preserves bindings', async () => {
  const reader = new Reader(new Map());
  const materials = await new SynthesisMaterializer(reader).materialize(input(reader));
  assert.deepEqual(materials.map((item) => item.semanticRole), ['knowledge', 'fact_source', 'analysis', 'inference', 'review']);
  assert.deepEqual(materials.map((item) => item.artifactId), ['artifact-knowledge', 'artifact-tool', 'artifact-skill', 'artifact-llm', 'artifact-reviewer']);
  assert.equal(materials[1]?.artifactContentSha256, hash({ output: defaultToolOutput, redactedOutputHash: hash(defaultToolOutput) }));
  assert.deepEqual(materials[1]?.value, {
    evidence: [{
      evidenceId: 'E-artifact-tool',
      jsonPointer: '/output/results/0',
      sourceUrl: defaultToolResult.url,
      value: defaultToolResult,
    }],
  });
  assert.equal(reader.reads.length, 5);
});

test('accepts legacy and current Skill output artifacts but rejects unknown schema versions', async () => {
  for (const schemaVersion of ['skill-output-v1', 'skill-output-v2']) {
    const reader = new Reader(new Map());
    const source = input(reader);
    const skill = reader.values.get('artifact-skill');
    assert.ok(skill);
    skill.artifact.schemaVersion = schemaVersion;
    await assert.doesNotReject(() => new SynthesisMaterializer(reader).materialize(source));
  }

  const reader = new Reader(new Map());
  const source = input(reader);
  const skill = reader.values.get('artifact-skill');
  assert.ok(skill);
  skill.artifact.schemaVersion = 'skill-output-v3';
  await assert.rejects(
    () => new SynthesisMaterializer(reader).materialize(source),
    /unexpected schema/,
  );
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

test('never classifies simulation Tool Evidence as a factual source', async () => {
  const output = { reviews: [{ profileId: 'virtual-1', isSimulated: true }] };
  const value = { output, redactedOutputHash: hash(output) };
  const tool = artifact('artifact-virtual-user', 'tool_output', value);
  const reader = new Reader(new Map());
  const materials = await new SynthesisMaterializer(reader).materialize(toolOnlyInput(reader, tool, [{
    id: 'SIM1-1',
    kind: 'tool_output',
    evidenceClass: 'simulation',
    toolId: 'virtual-user-lab',
    toolTier: 'optional',
    artifactId: tool.artifact.id,
    artifactContentSha256: tool.artifact.contentSha256!,
    jsonPointer: '/output/reviews/0',
    stepNo: 1,
    toolProof: {
      implementationId: 'virtual-user-real',
      executionMode: 'real',
      redactedOutputHash: value.redactedOutputHash,
    },
    sensitivity: 'internal',
    redaction: 'none',
  }]));
  assert.deepEqual(materials, []);
});

test('consumes material content, not only artifact metadata', async () => {
  const reader = new Reader(new Map());
  const source = input(reader);
  const first = await new SynthesisMaterializer(reader).materialize(source);
  const skillOutput = reader.values.get('artifact-skill');
  assert.ok(skillOutput);
  skillOutput.value = { conclusion: 'different analysis' };
  skillOutput.artifact.contentSha256 = hash(skillOutput.value);
  const skillStep = source.outputs.find(({ actorType }) => actorType === 'skill');
  assert.ok(skillStep);
  skillStep.artifact.contentSha256 = skillOutput.artifact.contentSha256;
  const second = await new SynthesisMaterializer(reader).materialize(source);
  assert.notDeepEqual(first, second);
  assert.equal((second.find((item) => item.actorType === 'skill')?.value as { conclusion: string }).conclusion, 'different analysis');
});

test('scopes a proven Tool fact source to an ordered collection of EvidenceService bindings', async () => {
  const firstSelected = { title: 'selected first', url: 'https://source.example/selected-first' };
  const unreferencedSibling = { title: 'UNREFERENCED_SIBLING_MUST_NOT_REACH_CONTEXT', url: 'https://source.example/unreferenced' };
  const secondSelected = { title: 'selected second', url: 'https://source.example/selected-second' };
  const output = { results: [firstSelected, unreferencedSibling, secondSelected] };
  const value: PublicToolValue = {
    output,
    redactedOutputHash: hash(output),
    answer: 'UNREFERENCED_TOP_LEVEL_ANSWER_MUST_NOT_REACH_CONTEXT',
  };
  const tool = artifact('artifact-tool-scoped', 'tool_output', value);
  const entries = realEvidenceEntries(tool.artifact.id, tool.artifact.contentSha256!, value, [
    { evidenceId: 'E-selected-second', resultIndex: 2 },
    { evidenceId: 'E-selected-first', resultIndex: 0 },
  ]);
  const reader = new Reader(new Map());

  const materials = await new SynthesisMaterializer(reader).materialize(toolOnlyInput(reader, tool, entries));

  assert.equal(materials.length, 1);
  assert.equal(materials[0]?.semanticRole, 'fact_source');
  const materialText = JSON.stringify(materials[0]?.value);
  assert.equal(materialText.includes(unreferencedSibling.title), false);
  assert.equal(materialText.includes(value.answer!), false);
  assert.deepEqual(materials[0]?.value, {
    evidence: [
      {
        evidenceId: 'E-selected-second',
        jsonPointer: '/output/results/2',
        sourceUrl: secondSelected.url,
        value: secondSelected,
      },
      {
        evidenceId: 'E-selected-first',
        jsonPointer: '/output/results/0',
        sourceUrl: firstSelected.url,
        value: firstSelected,
      },
    ],
  });
});

test('does not materialize a Tool fact source for stale hash or foreign Artifact evidence', async () => {
  const currentOutput = { results: [{ title: 'current value', url: 'https://source.example/current' }] };
  const currentValue: PublicToolValue = {
    output: currentOutput,
    redactedOutputHash: hash(currentOutput),
  };
  const currentTool = artifact('artifact-tool-current', 'tool_output', currentValue);
  const foreignTool = artifact('artifact-tool-foreign', 'tool_output', currentValue);
  const staleOutput = { results: [{ title: 'stale value', url: 'https://source.example/stale' }] };
  const staleValue: PublicToolValue = {
    output: staleOutput,
    redactedOutputHash: hash(staleOutput),
  };
  const staleTool = artifact(currentTool.artifact.id, 'tool_output', staleValue);
  const cases = [
    {
      name: 'foreign Artifact identity',
      entries: realEvidenceEntries(foreignTool.artifact.id, foreignTool.artifact.contentSha256!, currentValue, [
        { evidenceId: 'E-foreign', resultIndex: 0 },
      ]),
    },
    {
      name: 'stale Artifact content hash',
      entries: realEvidenceEntries(staleTool.artifact.id, staleTool.artifact.contentSha256!, staleValue, [
        { evidenceId: 'E-stale', resultIndex: 0 },
      ]),
    },
  ];

  for (const item of cases) {
    const reader = new Reader(new Map());
    const materials = await new SynthesisMaterializer(reader).materialize(
      toolOnlyInput(reader, currentTool, item.entries),
    );
    assert.deepEqual(materials, [], item.name);
    assert.deepEqual(reader.reads, [], item.name);
  }
});

void ({} as SynthesisMaterial[]);

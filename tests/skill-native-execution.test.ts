import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type {
  ExecutionPlan,
  SkillNativeExecutionState,
  TaskArtifact,
} from '../packages/api-contract/skill-native.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  parseSkillExternalReadMounts,
  SkillNativeCapabilityBroker,
  type SkillNativeToolPort,
} from '../apps/orchestrator-runtime/src/skill-native/capability-broker.ts';
import {
  SkillNativeExecutionEngine,
  type AgentTurn,
} from '../apps/orchestrator-runtime/src/skill-native/execution.ts';
import { renderMarkdownHtml } from '../apps/orchestrator-runtime/src/skill-native/html-renderer.ts';
import { SkillPackageStore } from '../apps/orchestrator-runtime/src/skill-native/package-store.ts';
import type { SkillSandbox } from '../apps/orchestrator-runtime/src/skill-native/sandbox-executor.ts';
import type {
  SkillNativeArtifactInput,
  SkillNativeArtifactRecord,
} from '../apps/orchestrator-runtime/src/skill-native/store.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryArtifacts {
  readonly records = new Map<string, SkillNativeArtifactRecord>();

  async writeArtifact(input: SkillNativeArtifactInput): Promise<void> {
    this.records.set(input.id, { ...structuredClone(input), bytes: Buffer.from(input.bytes), createdAt: new Date() });
  }

  async getArtifactOwned(input: { artifactId: string; taskId: string; ownerUserId: string; projectId: string }) {
    const artifact = this.records.get(input.artifactId);
    return artifact
      && artifact.taskId === input.taskId
      && artifact.ownerUserId === input.ownerUserId
      && artifact.projectId === input.projectId
      ? structuredClone(artifact)
      : null;
  }

  async listArtifacts(input: { taskId: string; ownerUserId: string; projectId: string }): Promise<TaskArtifact[]> {
    return [...this.records.values()].filter((artifact) => (
      artifact.taskId === input.taskId
      && artifact.ownerUserId === input.ownerUserId
      && artifact.projectId === input.projectId
    )).map((artifact) => ({
      id: artifact.id,
      ...(artifact.invocationId ? { invocationId: artifact.invocationId } : {}),
      relativePath: artifact.relativePath,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      role: artifact.role,
      byteSize: artifact.bytes.byteLength,
      contentSha256: artifact.contentSha256,
      sourceArtifactIds: [...artifact.sourceArtifactIds],
    }));
  }
}

class NoTools implements SkillNativeToolPort {
  list() { return []; }
  async invoke(): Promise<never> { throw new Error('no registered tools'); }
}

type TurnFactory = AgentTurn | ((options: StructuredLLMCallOptions) => AgentTurn);

class SequenceLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'mock', endpointHost: 'local', requestedModel: 'mock', mode: 'mock', eligibleAsReal: false,
  };
  readonly structuredCalls: StructuredLLMCallOptions[] = [];
  readonly textCalls: TextLLMCallOptions[] = [];

  constructor(private readonly turns: TurnFactory[], private readonly text = '# Default report\n\nComplete.') {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.structuredCalls.push(options);
    const item = this.turns.shift();
    if (!item) throw new Error('missing AgentTurn fixture');
    const data = typeof item === 'function' ? item(options) : item;
    return {
      data: structuredClone(data) as T,
      promptHash: 'sha256:test', modelName: 'mock', modelVersion: 'v1', traceId: 'trace',
    };
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    this.textCalls.push(options);
    return { text: this.text, promptHash: 'sha256:text', modelName: 'mock', modelVersion: 'v1', traceId: 'trace-text' };
  }
}

function rejectWhenAborted(signal: AbortSignal, started: () => void, label: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(new Error(`${label} aborted`));
    signal.addEventListener('abort', abort, { once: true });
    started();
    if (signal.aborted) abort();
  });
}

async function runtimeFixture(options: {
  multi?: boolean;
  llm: LLMClient;
  sandbox?: SkillSandbox;
  tools?: SkillNativeToolPort;
  skillBody?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'skill-agent-'));
  roots.push(root);
  const sourceRoot = join(root, 'skill-packages');
  const ids = options.multi ? ['first-skill', 'second-skill'] : ['test-skill'];
  for (const id of ids) {
    mkdirSync(join(sourceRoot, id, 'references'), { recursive: true });
    mkdirSync(join(sourceRoot, id, 'scripts'), { recursive: true });
    writeFileSync(
      join(sourceRoot, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: Test ${id}\n---\n\n${options.skillBody ?? 'Read references/method.md.'}\n`,
    );
    writeFileSync(join(sourceRoot, id, 'references', 'method.md'), `Method for ${id}`);
    writeFileSync(join(sourceRoot, id, 'scripts', 'render.py'), 'print("render")\n');
  }
  const packages = new SkillPackageStore({ sourceRoot, snapshotRoot: join(root, 'snapshots') });
  const descriptors = packages.discover().packages;
  const snapshots = descriptors.map((descriptor) => packages.snapshot('task-1', descriptor));
  const invocations = snapshots.map((snapshot, index) => ({
    id: `invocation-${index + 1}`,
    package: snapshot,
    dependsOn: index === 0 ? [] : [`invocation-${index}`],
  }));
  const plan: ExecutionPlan = {
    version: 'skill-native-plan-v2',
    taskId: 'task-1',
    candidateId: 'candidate-1',
    title: 'Test plan',
    rationale: 'Test',
    tradeoffs: 'None',
    mode: options.multi ? 'multi_skill' : 'single_skill',
    requirement: {
      version: 'requirement-context-v2',
      goal: 'Run the test',
      desiredOutputs: [],
      scope: [],
      constraints: [],
      materials: [],
      assumptions: [],
      openQuestions: [],
    },
    invocations,
    finalReport: options.multi
      ? { kind: 'platform_default' }
      : { kind: 'skill', invocationId: invocations[0]!.id },
  };
  const artifacts = new MemoryArtifacts();
  const broker = new SkillNativeCapabilityBroker({
    packages,
    artifacts,
    tools: options.tools ?? new NoTools(),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
  });
  return {
    plan,
    artifacts,
    broker,
    engine: new SkillNativeExecutionEngine({ llm: options.llm, broker }),
  };
}

const runContext = {
  attemptId: 'attempt-1',
  ownerUserId: 'owner-1',
  projectId: 'project-1',
};

test('Agent Loop reads package references over multiple turns and returns a generic report Artifact', async () => {
  const llm = new SequenceLLM([
    { action: 'tool', stateSummary: 'Need method', tool: { name: 'package.read', arguments: { path: 'references/method.md' } } },
    (options) => {
      assert.match(options.prompt, /已在完整交付中如实披露的数据限制不算执行缺口/u);
      assert.match(options.prompt, /artifact\.write 返回的 Artifact UUID/u);
      assert.match(options.prompt, /目录列举不等于读取文件/u);
      assert.match(JSON.stringify(options.context), /Method for test-skill/u);
      return {
        action: 'finish',
        stateSummary: 'Done',
        finish: {
          status: 'complete', summary: 'Completed from the reference', gaps: [], missingCapabilities: [],
          disposition: { kind: 'final_text', content: '# Native result\n\nUsed the method.' },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ llm });

  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed');
  assert.equal(result.execution.steps[0]?.turn, 2);
  assert.ok(result.outcome?.primaryArtifactId);
  assert.equal(fixture.artifacts.records.get(result.outcome!.primaryArtifactId!)?.bytes.toString(), '# Native result\n\nUsed the method.');
});

test('Agent Loop receives the complete SKILL.md when its instructions exceed 64 KiB', async () => {
  const marker = 'COMPLETE-SKILL-INSTRUCTIONS-END';
  const skillBody = `${'method detail\n'.repeat(6_000)}${marker}`;
  assert.ok(Buffer.byteLength(skillBody) > 64 * 1024);
  const llm = new SequenceLLM([(options) => {
    const instructions = (options.context as { skillInstructions: string }).skillInstructions;
    assert.ok(Buffer.byteLength(instructions) > 64 * 1024);
    assert.ok(instructions.endsWith(`${marker}\n`));
    return {
      action: 'finish', stateSummary: 'Read all instructions',
      finish: {
        status: 'complete', summary: 'Complete', gaps: [], missingCapabilities: [],
        disposition: { kind: 'final_text', content: '# Complete' },
      },
    };
  }]);
  const fixture = await runtimeFixture({ llm, skillBody });

  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed');
});

test('ask_user releases execution and resumes from the same checkpoint with answers', async () => {
  const llm = new SequenceLLM([
    {
      action: 'ask_user',
      stateSummary: 'Need audience',
      questions: [{ id: 'audience', prompt: 'Who is the audience?', required: true, answerType: 'text' }],
    },
    (options) => {
      assert.deepEqual((options.context as { userAnswers: object }).userAnswers, { audience: 'Executives' });
      return {
        action: 'finish', stateSummary: 'Done',
        finish: {
          status: 'complete', summary: 'Answered', gaps: [], missingCapabilities: [],
          disposition: { kind: 'final_text', content: '# Executive report' },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ llm });
  const waiting = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(waiting.state, 'waiting_for_user');
  assert.equal(waiting.execution.checkpoint?.turn, 1);
  assert.equal(waiting.execution.checkpoint?.pendingQuestions[0]?.id, 'audience');

  const completed = await fixture.engine.execute({
    plan: fixture.plan,
    ...runContext,
    execution: waiting.execution,
    answers: { audience: 'Executives' },
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.execution.steps[0]?.turn, 2);
});

test('a Skill-authored HTML Artifact is delivered without calling the default writer', async () => {
  const llm = new SequenceLLM([
    {
      action: 'tool', stateSummary: 'Writing template output',
      tool: {
        name: 'artifact.write',
        arguments: {
          path: 'outputs/custom.html', mediaType: 'text/html', encoding: 'utf8', role: 'report',
          content: '<!doctype html><html><head><title>Native</title></head><body>Native style</body></html>',
        },
      },
    },
    (options) => {
      const artifact = (options.context as { artifacts: TaskArtifact[] }).artifacts[0]!;
      return {
        action: 'finish', stateSummary: 'Done',
        finish: {
          status: 'complete', summary: 'Native HTML', gaps: [], missingCapabilities: [],
          disposition: { kind: 'primary_artifact', artifactId: artifact.id },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ llm });
  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed');
  assert.equal(llm.textCalls.length, 0);
  assert.equal(fixture.artifacts.records.get(result.outcome!.primaryArtifactId!)?.mediaType, 'text/html');
});

test('serial Multi uses one Agent Loop and the platform default free-structure writer', async () => {
  const llm = new SequenceLLM([
    (options) => {
      assert.match(options.prompt, /不得执行、索要或模拟其他 Skill/u);
      assert.match(options.prompt, /不要重复读取/u);
      assert.deepEqual((options.context as { runtimeBudget: object }).runtimeBudget, {
        turnsUsed: 0,
        turnsRemaining: 32,
        toolCallsUsed: 0,
        toolCallsRemaining: 64,
      });
      return {
        action: 'finish', stateSummary: 'First complete',
        finish: {
          status: 'complete', summary: 'First', gaps: [], missingCapabilities: [],
          disposition: { kind: 'final_text', content: '# First evidence' },
        },
      };
    },
    (options) => {
      assert.equal((options.context as { upstreamArtifacts: TaskArtifact[] }).upstreamArtifacts.length, 1);
      return {
        action: 'finish', stateSummary: 'Second complete',
        finish: {
          status: 'complete', summary: 'Second', gaps: [], missingCapabilities: [],
          disposition: { kind: 'final_text', content: '# Second evidence' },
        },
      };
    },
  ], '# Combined\n\n| Skill | Result |\n| --- | --- |\n| First | Done |');
  const fixture = await runtimeFixture({ multi: true, llm });
  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed');
  assert.equal(result.execution.steps.length, 2);
  assert.equal(llm.textCalls.length, 1);
  assert.match(llm.textCalls[0]!.prompt, /不套用固定目录/u);
  assert.equal(fixture.artifacts.records.get(result.outcome!.primaryArtifactId!)?.role, 'report');
});

test('a later Skill cannot claim an upstream Artifact and receives recoverable feedback', async () => {
  const llm = new SequenceLLM([
    {
      action: 'finish', stateSummary: 'First complete',
      finish: {
        status: 'complete', summary: 'First', gaps: [], missingCapabilities: [],
        disposition: { kind: 'final_text', content: '# First evidence' },
      },
    },
    (options) => {
      const upstream = (options.context as { upstreamArtifacts: TaskArtifact[] }).upstreamArtifacts[0]!;
      return {
        action: 'finish', stateSummary: 'Claim upstream',
        finish: {
          status: 'complete', summary: 'Second', gaps: [], missingCapabilities: [],
          disposition: { kind: 'primary_artifact', artifactId: upstream.id },
        },
      };
    },
    (options) => {
      assert.match(JSON.stringify((options.context as { recentResult: object }).recentResult), /was not created by this Skill invocation/u);
      return {
        action: 'finish', stateSummary: 'Recovered',
        finish: {
          status: 'complete', summary: 'Second', gaps: [], missingCapabilities: [],
          disposition: { kind: 'final_text', content: '# Second evidence' },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ multi: true, llm });

  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed');
  assert.equal(result.execution.steps[1]?.turn, 2);
  assert.notEqual(result.outcome?.primaryArtifactId, result.execution.steps[0]?.outcome?.primaryArtifactId);
});

test('artifact.write rejects sourceArtifactIds owned by another task', async () => {
  const llm = new SequenceLLM([
    {
      action: 'tool', stateSummary: 'Write derived output',
      tool: {
        name: 'artifact.write',
        arguments: {
          path: 'outputs/derived.md', mediaType: 'text/markdown', content: '# Derived',
          role: 'report', sourceArtifactIds: ['foreign-artifact'],
        },
      },
    },
    (options) => {
      assert.match(JSON.stringify((options.context as { recentResult: unknown }).recentResult), /does not belong to this task/u);
      return {
        action: 'finish', stateSummary: 'Rejected foreign source',
        finish: {
          status: 'partial', summary: 'Foreign source rejected', gaps: ['Source unavailable'], missingCapabilities: [],
          disposition: { kind: 'final_text', content: '# Safe result' },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ llm });
  const bytes = Buffer.from('foreign');
  fixture.artifacts.records.set('foreign-artifact', {
    id: 'foreign-artifact', taskId: 'other-task', ownerUserId: 'owner-1', projectId: 'project-1',
    invocationId: 'other-invocation', relativePath: 'outputs/foreign.md', fileName: 'foreign.md',
    mediaType: 'text/markdown', role: 'output', bytes,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sourceArtifactIds: [], createdAt: new Date(),
  });

  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed_with_gaps');
  assert.equal([...fixture.artifacts.records.values()].some(({ sourceArtifactIds }) => (
    sourceArtifactIds.includes('foreign-artifact')
  )), false);
});

test('an unavailable capability is returned to the Agent and can end as explicit incompatibility', async () => {
  const llm = new SequenceLLM([
    { action: 'tool', stateSummary: 'Need script', tool: { name: 'script.run', arguments: { path: 'scripts/run.py' } } },
    (options) => {
      assert.match(JSON.stringify(options.context), /script\.run is unavailable/u);
      return {
        action: 'finish', stateSummary: 'Cannot continue',
        finish: {
          status: 'incompatible', summary: 'Python sandbox is unavailable', gaps: [],
          missingCapabilities: ['script.run'], disposition: { kind: 'final_text', content: 'Unable to execute.' },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ llm });
  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.outcome?.missingCapabilities, ['script.run']);
});

test('script.run publishes declared sandbox outputs as Skill Artifacts', async () => {
  const sandbox: SkillSandbox = {
    status: () => ({ available: true }),
    async execute(input) {
      assert.equal(input.runtime, 'python');
      assert.equal(input.scriptPath, 'scripts/render.py');
      assert.ok(input.packageRoot.endsWith('test-skill-' + input.packageRoot.split('test-skill-').at(-1)));
      assert.deepEqual(input.outputs, ['report.html']);
      return {
        stdout: 'rendered',
        stderr: '',
        outputs: [{ path: 'report.html', bytes: Buffer.from('<!doctype html><h1>Native</h1>') }],
      };
    },
  };
  const llm = new SequenceLLM([
    {
      action: 'tool', stateSummary: 'Render report',
      tool: {
        name: 'script.run',
        arguments: {
          runtime: 'python', scriptPath: 'scripts/render.py', arguments: ['/outputs/report.html'],
          outputs: [{ path: 'report.html', mediaType: 'text/html', role: 'report' }],
        },
      },
    },
    (options) => {
      const artifact = (options.context as { artifacts: TaskArtifact[] }).artifacts[0]!;
      return {
        action: 'finish', stateSummary: 'Done',
        finish: {
          status: 'complete', summary: 'Rendered', gaps: [], missingCapabilities: [],
          disposition: { kind: 'primary_artifact', artifactId: artifact.id },
        },
      };
    },
  ]);
  const fixture = await runtimeFixture({ llm, sandbox });
  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  const artifact = fixture.artifacts.records.get(result.outcome!.primaryArtifactId!)!;
  assert.equal(result.state, 'completed');
  assert.equal(artifact.mediaType, 'text/html');
  assert.equal(artifact.bytes.toString(), '<!doctype html><h1>Native</h1>');
  assert.equal(llm.textCalls.length, 0);
});

test('cancelling execution aborts an in-flight LLM call', async () => {
  let receivedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const llm: LLMClient = {
    identity: {
      provider: 'mock', endpointHost: 'local', requestedModel: 'mock', mode: 'mock', eligibleAsReal: false,
    },
    async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
      assert.ok(options.signal);
      receivedSignal = options.signal;
      return rejectWhenAborted(options.signal, markStarted, 'LLM');
    },
    async generateText(): Promise<TextLLMResult> { throw new Error('unexpected text call'); },
  };
  const fixture = await runtimeFixture({ llm });
  const controller = new AbortController();
  const execution = fixture.engine.execute({ plan: fixture.plan, ...runContext, signal: controller.signal });
  await started;

  controller.abort('test cancellation');

  await assert.rejects(execution, /LLM aborted/u);
  assert.equal(receivedSignal?.aborted, true);
});

test('cancelling execution aborts an in-flight Tool call', async () => {
  let receivedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const tools: SkillNativeToolPort = {
    list: () => [{ id: 'slow-tool', name: 'Slow tool' }],
    async invoke(input) {
      receivedSignal = input.signal;
      return rejectWhenAborted(input.signal, markStarted, 'Tool');
    },
  };
  const llm = new SequenceLLM([{
    action: 'tool', stateSummary: 'Waiting for tool',
    tool: { name: 'tool.invoke', arguments: { toolId: 'slow-tool', input: {} } },
  }]);
  const fixture = await runtimeFixture({ llm, tools });
  const controller = new AbortController();
  const execution = fixture.engine.execute({ plan: fixture.plan, ...runContext, signal: controller.signal });
  await started;

  controller.abort('test cancellation');

  await assert.rejects(execution, /skill-native execution cancelled/u);
  assert.equal(receivedSignal?.aborted, true);
});

test('cancelling execution aborts an in-flight Sandbox call', async () => {
  let receivedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const sandbox: SkillSandbox = {
    status: () => ({ available: true }),
    async execute(input) {
      receivedSignal = input.signal;
      return rejectWhenAborted(input.signal, markStarted, 'Sandbox');
    },
  };
  const llm = new SequenceLLM([{
    action: 'tool', stateSummary: 'Waiting for script',
    tool: {
      name: 'script.run',
      arguments: {
        runtime: 'python', scriptPath: 'scripts/render.py', arguments: [],
        outputs: [{ path: 'report.html', mediaType: 'text/html', role: 'report' }],
      },
    },
  }]);
  const fixture = await runtimeFixture({ llm, sandbox });
  const controller = new AbortController();
  const execution = fixture.engine.execute({ plan: fixture.plan, ...runContext, signal: controller.signal });
  await started;

  controller.abort('test cancellation');

  await assert.rejects(execution, /skill-native execution cancelled/u);
  assert.equal(receivedSignal?.aborted, true);
});

test('Markdown preview escapes raw HTML and blocks unsafe links and images', () => {
  const html = renderMarkdownHtml(
    '# Title\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![remote](https://evil.example/a.png)\n',
    'Safe',
  );
  assert.doesNotMatch(html, /<script>/u);
  assert.doesNotMatch(html, /javascript:/u);
  assert.doesNotMatch(html, /evil\.example/u);
  assert.match(html, /Content-Security-Policy/u);
});

test('Artifact hashes reflect the bytes written by the Agent', async () => {
  const content = '# Hash me';
  const llm = new SequenceLLM([{
    action: 'finish', stateSummary: 'Done',
    finish: {
      status: 'complete', summary: 'Done', gaps: [], missingCapabilities: [],
      disposition: { kind: 'final_text', content },
    },
  }]);
  const fixture = await runtimeFixture({ llm });
  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });
  const artifact = fixture.artifacts.records.get(result.outcome!.primaryArtifactId!)!;
  assert.equal(artifact.contentSha256, `sha256:${createHash('sha256').update(content).digest('hex')}`);
});

test('external knowledge is frozen on first access and read in bounded chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-external-'));
  roots.push(root);
  const sourceRoot = join(root, 'skill-packages');
  const externalRoot = join(root, 'research-wiki');
  mkdirSync(join(sourceRoot, 'test-skill'), { recursive: true });
  mkdirSync(join(externalRoot, 'methods'), { recursive: true });
  writeFileSync(join(sourceRoot, 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n');
  writeFileSync(join(externalRoot, 'methods', 'guide.md'), 'version-one');
  const packages = new SkillPackageStore({ sourceRoot, snapshotRoot: join(root, 'snapshots') });
  const snapshot = packages.snapshot('task-1', packages.discover().packages[0]!);
  const externalKnowledge: SkillNativeExecutionState['externalKnowledge'] = [];
  const broker = new SkillNativeCapabilityBroker({
    packages,
    artifacts: new MemoryArtifacts(),
    tools: new NoTools(),
    externalMounts: parseSkillExternalReadMounts(JSON.stringify([{
      id: 'research-wiki', logicalPath: '/knowledge/research-wiki', hostPath: externalRoot,
    }])),
  });
  const context = {
    snapshot,
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    taskId: 'task-1',
    ownerUserId: 'owner-1',
    projectId: 'project-1',
    planKey: 'a'.repeat(16),
    externalKnowledge,
    onExternalSnapshot(value: SkillNativeExecutionState['externalKnowledge'][number]) {
      externalKnowledge.push(value);
    },
    signal: new AbortController().signal,
  };

  const first = await broker.execute('external.read', {
    path: '/knowledge/research-wiki/methods/guide.md', offset: 0, limit: 7,
  }, context) as { content: string; nextOffset: number | null };
  assert.equal(first.content, 'version');
  assert.equal(first.nextOffset, 7);
  assert.equal(externalKnowledge.length, 1);

  writeFileSync(join(externalRoot, 'methods', 'guide.md'), 'version-two');
  const frozen = await broker.execute('external.read', {
    path: '/knowledge/research-wiki/methods/guide.md', offset: 8, limit: 16,
  }, context) as { content: string; nextOffset: number | null };
  assert.equal(frozen.content, 'one');
  assert.equal(frozen.nextOffset, null);
});

test('Multi outcome retains failed Skill gaps and missing capabilities', async () => {
  const llm = new SequenceLLM([
    {
      action: 'finish', stateSummary: 'Unavailable',
      finish: {
        status: 'incompatible', summary: 'Missing source', gaps: ['Source was not mounted'],
        missingCapabilities: ['external.read'], disposition: { kind: 'final_text', content: 'Partial evidence.' },
      },
    },
    {
      action: 'finish', stateSummary: 'Second complete',
      finish: {
        status: 'complete', summary: 'Second', gaps: [], missingCapabilities: [],
        disposition: { kind: 'final_text', content: '# Second evidence' },
      },
    },
  ], '# Combined');
  const fixture = await runtimeFixture({ multi: true, llm });
  const result = await fixture.engine.execute({ plan: fixture.plan, ...runContext });

  assert.equal(result.state, 'completed_with_gaps');
  assert.equal(result.outcome?.status, 'partial');
  assert.ok(result.outcome?.gaps.includes('Missing source'));
  assert.ok(result.outcome?.gaps.includes('Source was not mounted'));
  assert.deepEqual(result.outcome?.missingCapabilities, ['external.read']);
});

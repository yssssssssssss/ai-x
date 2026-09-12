import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { ToolInvocationError, ToolRouter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import {
  O2JoyspaceReadAdapter,
  type O2CommandRunner,
} from '../apps/orchestrator-runtime/src/runtime/o2-joyspace-read-adapter.ts';

const manifest: ToolManifest = {
  id: 'joyspace-read',
  name: 'Joyspace Read',
  adapter_type: 'o2',
  entrypoint: 'webcli joyspace',
  auth_required: true,
  risk_level: 'low',
  approver_rule: 'none',
  timeout_seconds: 30,
  retry_policy: { max_attempts: 2, backoff_seconds: 1 },
  input_schema: 'tools/joyspace-read/input.schema.json',
  output_schema: 'tools/joyspace-read/output.schema.json',
  redaction_policy: { pii: 'mask', sensitive_business_data: 'block' },
};

function context(): { signal: AbortSignal; deadlineAt: number } {
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 };
}

function runner(results: Array<{ stdout?: string; stderr?: string; error?: unknown }>) {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const run: O2CommandRunner = async (file, args, options) => {
    calls.push({ file, args: [...args], timeoutMs: options.timeoutMs });
    const result = results.shift();
    if (!result) throw new Error('unexpected command');
    if (result.error) throw result.error;
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { run, calls };
}

const versions = { o2: '0.0.8', webcli: '1.1.3' };

test('real Runtime registers the read-only O2 Joyspace adapter', () => {
  const priorTool = process.env.TOOL_ADAPTER;
  const priorLlm = process.env.LLM_PROVIDER;
  try {
    process.env.TOOL_ADAPTER = 'real';
    process.env.LLM_PROVIDER = 'mock';
    const runtime = buildRuntime();
    assert.ok(runtime.deps.toolAdapter instanceof ToolRouter);
    const resolution = runtime.deps.toolAdapter.resolve(manifest);
    assert.deepEqual(resolution, {
      declaredAdapterType: 'o2', resolvedAdapterType: 'o2',
      implementationId: 'o2-joyspace-read', executionMode: 'real', endpointHost: 'joyspace.jd.com',
    });
  } finally {
    if (priorTool === undefined) delete process.env.TOOL_ADAPTER;
    else process.env.TOOL_ADAPTER = priorTool;
    if (priorLlm === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = priorLlm;
  }
});

test('Joyspace search uses an argv-only o2 invocation and normalizes safe results', async () => {
  const fake = runner([{ stdout: JSON.stringify([{
    title: 'AI Decision Lab', author: 'Research Team',
    url: 'https://joyspace.jd.com/pages/abc123', preview: '摘要',
    updated_at: '2026-09-02T17:34:20.000+08:00',
  }]) }]);
  const adapter = new O2JoyspaceReadAdapter({ binaryPath: '/trusted/o2', runner: fake.run, versions });
  const result = await adapter.invoke({
    toolId: 'joyspace-read', manifest, context: context(),
    input: { operation: 'search', target: '宠物食品 行业研究', limit: 3, scope: 'auto' },
  });

  assert.deepEqual(fake.calls[0]?.file, '/trusted/o2');
  assert.deepEqual(fake.calls[0]?.args, [
    'launch', 'webcli', 'joyspace', 'search', '宠物食品 行业研究', '--limit', '3', '--scope', 'auto', '-f', 'json',
  ]);
  assert.ok((fake.calls[0]?.timeoutMs ?? 0) > 0 && (fake.calls[0]?.timeoutMs ?? 0) <= 30_000);
  assert.deepEqual(result.output, {
    version: 'joyspace-read-output-v1',
    operation: 'search',
    status: 'available',
    documents: [{
      title: 'AI Decision Lab', author: 'Research Team',
      url: 'https://joyspace.jd.com/pages/abc123', preview: '摘要',
      updatedAt: '2026-09-02T17:34:20.000+08:00',
    }],
    runtime: versions,
  });
  assert.deepEqual(result.receipt.runtimeVersions, versions);
  assert.equal(result.receipt.endpointHost, 'joyspace.jd.com');
  new SchemaValidator().validateFileOrThrow('tools/joyspace-read/output.schema.json', result.output);
});

test('Joyspace search can immediately view the first result for a frozen Knowledge Snapshot', async () => {
  const body = '已审核的内部行业方法。';
  const fake = runner([{ stdout: JSON.stringify([{
    title: '行业方法', author: 'Research Team', url: 'https://joyspace.jd.com/pages/method-1',
    preview: '摘要', updated_at: '2026-09-03T10:00:00.000+08:00',
  }]) }, { stdout: JSON.stringify([
    { field: 'title', value: '行业方法' }, { field: 'body', value: body },
    { field: 'author', value: 'Research Team' },
    { field: 'url', value: 'https://joyspace.jd.com/pages/method-1' },
  ]) }]);
  const adapter = new O2JoyspaceReadAdapter({ binaryPath: '/trusted/o2', runner: fake.run, versions });
  const result = await adapter.invoke({
    toolId: 'joyspace-read', manifest, context: context(),
    input: { operation: 'search', target: '行业方法', viewTopResult: true },
  });

  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1]?.args, [
    'launch', 'webcli', 'joyspace', 'view', 'https://joyspace.jd.com/pages/method-1', '-f', 'json',
  ]);
  assert.equal((result.output as { viewedDocument?: { body?: string } }).viewedDocument?.body, body);
  assert.equal(result.knowledgeAttachments?.[0]?.updatedAt, '2026-09-03T10:00:00.000+08:00');
  new SchemaValidator().validateFileOrThrow('tools/joyspace-read/output.schema.json', result.output);
});

test('Joyspace view returns a hash-bound Knowledge attachment', async () => {
  const body = '# 标题\n\n内部知识正文';
  const fake = runner([{ stdout: JSON.stringify([
    { field: 'title', value: 'AI Decision Lab' },
    { field: 'body', value: body },
    { field: 'author', value: 'Research Team' },
    { field: 'url', value: 'https://joyspace.jd.com/pages/abc123' },
  ]) }]);
  const adapter = new O2JoyspaceReadAdapter({ binaryPath: '/trusted/o2', runner: fake.run, versions });
  const result = await adapter.invoke({
    toolId: 'joyspace-read', manifest, context: context(),
    input: { operation: 'view', target: 'https://joyspace.jd.com/pages/abc123' },
  });

  const contentSha256 = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  assert.deepEqual(fake.calls[0]?.args, [
    'launch', 'webcli', 'joyspace', 'view', 'https://joyspace.jd.com/pages/abc123', '-f', 'json',
  ]);
  assert.deepEqual(result.output, {
    version: 'joyspace-read-output-v1', operation: 'view', status: 'available',
    document: {
      title: 'AI Decision Lab', body, author: 'Research Team',
      url: 'https://joyspace.jd.com/pages/abc123', contentSha256,
    },
    runtime: versions,
  });
  assert.deepEqual(result.knowledgeAttachments, [{
    attachmentId: 'joyspace-document', title: 'AI Decision Lab', body,
    sourceUrl: 'https://joyspace.jd.com/pages/abc123', author: 'Research Team',
    updatedAt: null, contentSha256, sensitivity: 'internal',
  }]);
  new SchemaValidator().validateFileOrThrow('tools/joyspace-read/output.schema.json', result.output);
});

test('Joyspace adapter rejects write operations without invoking o2', async () => {
  const fake = runner([]);
  const adapter = new O2JoyspaceReadAdapter({ binaryPath: '/trusted/o2', runner: fake.run, versions });
  await assert.rejects(() => adapter.invoke({
    toolId: 'joyspace-read', manifest, context: context(), input: { operation: 'edit', target: 'abc123' },
  }), (error: unknown) => {
    assert.ok(error instanceof ToolInvocationError);
    assert.equal(error.kind, 'safety');
    return true;
  });
  assert.deepEqual(fake.calls, []);
});

test('Joyspace adapter classifies authentication, Browser Bridge, permission, timeout, and empty search', async () => {
  const cases = [
    ['authentication', '请先登录 JoySpace'],
    ['browser_bridge', 'Chrome Browser Bridge extension is not connected'],
    ['permission', '无权限访问该文档'],
    ['network', 'connect ECONNREFUSED 127.0.0.1'],
  ] as const;
  for (const [kind, stderr] of cases) {
    const failure = Object.assign(new Error('command failed'), { stderr });
    const fake = runner([{ error: failure }]);
    const adapter = new O2JoyspaceReadAdapter({ binaryPath: '/trusted/o2', runner: fake.run, versions });
    await assert.rejects(() => adapter.invoke({
      toolId: 'joyspace-read', manifest, context: context(), input: { operation: 'search', target: 'test' },
    }), (error: unknown) => {
      assert.ok(error instanceof ToolInvocationError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /cookie=/iu);
      return true;
    });
  }

  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const timed = runner([{ error: timeout }]);
  await assert.rejects(() => new O2JoyspaceReadAdapter({
    binaryPath: '/trusted/o2', runner: timed.run, versions,
  }).invoke({ toolId: 'joyspace-read', manifest, context: context(), input: { operation: 'search', target: 'test' } }),
  (error: unknown) => error instanceof ToolInvocationError && error.kind === 'timeout' && error.retryable);

  const empty = runner([{ stdout: '[]' }]);
  const result = await new O2JoyspaceReadAdapter({
    binaryPath: '/trusted/o2', runner: empty.run, versions,
  }).invoke({ toolId: 'joyspace-read', manifest, context: context(), input: { operation: 'search', target: 'not found' } });
  assert.deepEqual(result.output, {
    version: 'joyspace-read-output-v1', operation: 'search', status: 'empty', documents: [], runtime: versions,
  });
});

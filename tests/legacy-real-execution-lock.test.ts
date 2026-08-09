import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { buildOrchestrator, LegacyRealExecutionBlockedError } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import {
  FakeO2Adapter,
  ToolRouter,
  type ToolAdapter,
  type ToolInvokeResult,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import {
  MockLLMClient,
  type LLMProviderIdentity,
  type LLMResult,
  type LegacyStructuredLLMCallOptions,
  type LegacyTextLLMCallOptions,
  type TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { createConversation, createUser } from '../database/repository.ts';

class ForbiddenRealAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;
  readonly implementationId = 'forbidden-real-adapter';
  readonly executionMode = 'real' as const;
  calls = 0;

  endpointHost(): string {
    return 'external.test';
  }

  async invoke(options: { manifest: ToolManifest }): Promise<ToolInvokeResult> {
    this.calls += 1;
    return {
      output: { results: [] },
      latencyMs: 1,
      receipt: {
        declaredAdapterType: options.manifest.adapter_type,
        resolvedAdapterType: this.adapterType,
        implementationId: this.implementationId,
        executionMode: this.executionMode,
        endpointHost: this.endpointHost(),
        status: 'ok',
        latencyMs: 1,
      },
    };
  }
}

class ForbiddenRealLLM extends MockLLMClient {
  calls = 0;

  override get identity(): LLMProviderIdentity {
    return {
      provider: 'gateway-test-double',
      endpointHost: 'llm.test',
      requestedModel: 'pinned-model',
      mode: 'real',
      eligibleAsReal: true,
    };
  }

  override async generateStructured<T>(options: LegacyStructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls += 1;
    return super.generateStructured<T>(options);
  }

  override async generateText(options: LegacyTextLLMCallOptions): Promise<TextLLMResult> {
    this.calls += 1;
    return super.generateText(options);
  }
}

test('legacy Orchestrator blocks real Tool execution before external side effects', async () => {
  const adapter = new ForbiddenRealAdapter();
  const router = new ToolRouter().register(adapter);
  const orchestrator = buildOrchestrator({ llm: new MockLLMClient(), toolAdapter: router });
  const user = await createUser({
    email: `legacy-real-lock-${Date.now()}@test.local`,
    displayName: 'legacy real lock',
    passwordHash: 'x',
  });
  const conversation = await createConversation({ ownerUserId: user.id, title: 'legacy real lock' });
  const planned = await orchestrator.planPhase({
    originalInput: '直播数字人竞品研究',
    conversationId: conversation.id,
    ownerUserId: user.id,
  });
  try {
    await orchestrator.selectPlan({ taskId: planned.taskId, candidateId: 'depth' });
    await assert.rejects(
      () => orchestrator.executePhase({ taskId: planned.taskId, conversationId: conversation.id }),
      LegacyRealExecutionBlockedError,
    );
    assert.equal(adapter.calls, 0);
  } finally {
    rmSync(planned.workspaceUri, { recursive: true, force: true });
  }
});

test('legacy Orchestrator blocks real LLM execution even with fake Tools', async () => {
  const llm = new ForbiddenRealLLM();
  const orchestrator = buildOrchestrator({ llm, toolAdapter: new FakeO2Adapter() });
  const user = await createUser({
    email: `legacy-real-llm-lock-${Date.now()}@test.local`,
    displayName: 'legacy real llm lock',
    passwordHash: 'x',
  });
  const conversation = await createConversation({ ownerUserId: user.id, title: 'legacy real llm lock' });
  const planned = await orchestrator.planPhase({
    originalInput: '直播数字人竞品研究',
    conversationId: conversation.id,
    ownerUserId: user.id,
  });
  try {
    await orchestrator.selectPlan({ taskId: planned.taskId, candidateId: 'depth' });
    llm.calls = 0;
    await assert.rejects(
      () => orchestrator.executePhase({ taskId: planned.taskId, conversationId: conversation.id }),
      LegacyRealExecutionBlockedError,
    );
    assert.equal(llm.calls, 0);
  } finally {
    rmSync(planned.workspaceUri, { recursive: true, force: true });
  }
});

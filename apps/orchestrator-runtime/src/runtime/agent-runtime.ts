import { type LLMClient, MockLLMClient, type ModelCallRecorder } from './llm-client.ts';
import { GatewayLLMClient } from './gateway-llm-client.ts';
import { type ToolAdapter, FakeO2Adapter, HttpApiAdapter, RestJsonAdapter, TavilyAdapter, ToolRouter } from './tool-adapter.ts';
import { SkillLoader } from './skill-loader.ts';
import { CheckpointStore } from './checkpoint-store.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { ReceiptLLMClient } from './receipt-llm-client.ts';

// Agent Runtime:封装 Claude/OpenAI/Pi/内部网关差异的薄壳。
// 只做装配,不含业务判断(判断在 skill + 配置 + LLM)。
// 业务代码依赖此处组装出的 llm/toolAdapter/skillLoader/checkpointStore/validator,不认 SDK。

export interface RuntimeDeps {
  llm: LLMClient;
  modelCallRecorder?: ModelCallRecorder;
  toolAdapter: ToolAdapter;
  skillLoader: SkillLoader;
  checkpointStore: CheckpointStore;
  validator: SchemaValidator;
}

export class AgentRuntime {
  constructor(public readonly deps: RuntimeDeps) {}
}

// 按 env 组装 V0 实现。切 provider 只改这里,不动 orchestrator / skill / DB。
export function buildRuntime(overrides: Partial<RuntimeDeps> = {}): AgentRuntime {
  const provider = process.env.LLM_PROVIDER ?? 'mock';
  const toolChannel = process.env.TOOL_ADAPTER ?? 'fake';

  const baseLlm = overrides.llm ?? buildLLM(provider);
  const llm = overrides.modelCallRecorder
    ? new ReceiptLLMClient(baseLlm, overrides.modelCallRecorder)
    : baseLlm;
  const toolAdapter = overrides.toolAdapter ?? buildToolAdapter(toolChannel);

  return new AgentRuntime({
    llm,
    toolAdapter,
    skillLoader: overrides.skillLoader ?? new SkillLoader(),
    checkpointStore: overrides.checkpointStore ?? new CheckpointStore(),
    validator: overrides.validator ?? new SchemaValidator(),
  });
}

function buildLLM(provider: string): LLMClient {
  switch (provider) {
    case 'mock':
      return new MockLLMClient();
    case 'gateway':
      return new GatewayLLMClient();
    // 二期:case 'openai': return new OpenAIAgentLLMClient(...)
    default:
      throw new Error(`未知 LLM_PROVIDER=${provider}(支持 mock | gateway)`);
  }
}

function buildToolAdapter(channel: string): ToolAdapter {
  // ToolRouter 按 tool manifest 的 adapter_type 分发,fake / o2 / internal_api / tavily 共存。
  // fake 与 o2 映射到 FakeO2Adapter; TOOL_ADAPTER=fake 时 tavily 也走 fake,避免离线测试打真实网络。
  const fake = new FakeO2Adapter();
  const router = new ToolRouter();
  router.registerAs('fake', fake);
  router.registerAs('o2', fake);
  router.registerAs('internal_api', new HttpApiAdapter());
  router.registerAs('rest_json', new RestJsonAdapter());
  router.registerAs('tavily', channel === 'fake' ? fake : new TavilyAdapter());
  return router;
}

import { pool } from '../../../database/db.ts';
import { SkillNativeCapabilityBroker, parseSkillExternalReadMounts, RegistryToolPort } from '../../orchestrator-runtime/src/skill-native/capability-broker.ts';
import { SkillNativeCatalog } from '../../orchestrator-runtime/src/skill-native/catalog.ts';
import { SkillNativeExecutionEngine } from '../../orchestrator-runtime/src/skill-native/execution.ts';
import { SkillPackageStore } from '../../orchestrator-runtime/src/skill-native/package-store.ts';
import { RequirementPlanner } from '../../orchestrator-runtime/src/skill-native/requirement-planner.ts';
import { DockerSandboxExecutor, type SkillSandbox } from '../../orchestrator-runtime/src/skill-native/sandbox-executor.ts';
import {
  SkillNativeTaskService,
  type SkillNativeReportPublisher,
} from '../../orchestrator-runtime/src/skill-native/service.ts';
import {
  PostgresSkillNativeTaskStore,
  type SkillNativeTaskStore,
} from '../../orchestrator-runtime/src/skill-native/store.ts';
import { GatewayLLMClient } from '../../orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import { type LLMClient, MockLLMClient } from '../../orchestrator-runtime/src/runtime/llm-client.ts';
import { O2JoyspaceReadAdapter } from '../../orchestrator-runtime/src/runtime/o2-joyspace-read-adapter.ts';
import { ReceiptLLMClient } from '../../orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { SchemaValidator } from '../../orchestrator-runtime/src/schema/validator.ts';
import {
  FakeO2Adapter,
  HttpApiAdapter,
  RestJsonAdapter,
  TavilyAdapter,
  ToolRouter,
  type ToolAdapter,
} from '../../orchestrator-runtime/src/runtime/tool-adapter.ts';
import { LocalZeroMcpClient } from './integrations/zero/zero-mcp-client.ts';
import {
  SkillNativeZeroPublisher,
  type SkillNativeZeroMcp,
} from './integrations/zero/skill-native-zero-publisher.ts';

export interface SkillNativeRuntime {
  tasks: SkillNativeTaskService;
}

export interface SkillNativeRuntimeOverrides {
  store?: SkillNativeTaskStore;
  llm?: LLMClient;
  tools?: ToolAdapter;
  validator?: SchemaValidator;
  packages?: SkillPackageStore;
  sandbox?: SkillSandbox;
  zeroMcp?: SkillNativeZeroMcp;
  publisher?: SkillNativeReportPublisher;
  tasks?: SkillNativeTaskService;
}

function buildLlm(): LLMClient {
  const provider = process.env.LLM_PROVIDER ?? 'mock';
  if (provider === 'mock') return new MockLLMClient();
  if (provider === 'gateway') return new GatewayLLMClient();
  throw new Error(`未知 LLM_PROVIDER=${provider}（支持 mock | gateway）`);
}

function buildTools(): ToolRouter {
  const channel = process.env.TOOL_ADAPTER ?? 'fake';
  const fake = new FakeO2Adapter();
  const router = new ToolRouter();
  router.registerAs('fake', fake);
  router.registerAs('o2', channel === 'fake' ? fake : new O2JoyspaceReadAdapter());
  router.registerAs('internal_api', new HttpApiAdapter());
  router.registerAs('rest_json', new RestJsonAdapter());
  router.registerAs('tavily', channel === 'fake' ? fake : new TavilyAdapter());
  return router;
}

export function buildSkillNativeRuntime(
  overrides: SkillNativeRuntimeOverrides = {},
): SkillNativeRuntime {
  if (overrides.tasks) return { tasks: overrides.tasks };

  const store = overrides.store ?? new PostgresSkillNativeTaskStore(pool);
  const llm = overrides.llm ?? buildLlm();
  const tools = overrides.tools ?? buildTools();
  const validator = overrides.validator ?? new SchemaValidator();
  const packages = overrides.packages ?? new SkillPackageStore();
  const publisher = overrides.publisher ?? (
    process.env.ZERO_PUBLICATION_ENABLED === 'true'
      ? new SkillNativeZeroPublisher(overrides.zeroMcp ?? new LocalZeroMcpClient({
          url: process.env.ZERO_MCP_URL?.trim() || 'http://127.0.0.1:27618/mcp',
        }))
      : undefined
  );
  const broker = new SkillNativeCapabilityBroker({
    packages,
    artifacts: store,
    tools: new RegistryToolPort(tools, validator, store),
    externalMounts: parseSkillExternalReadMounts(),
    sandbox: overrides.sandbox ?? new DockerSandboxExecutor(),
  });
  const executionLlm = new ReceiptLLMClient(llm, store);
  return {
    tasks: new SkillNativeTaskService({
      store,
      catalog: new SkillNativeCatalog(packages),
      planner: new RequirementPlanner({ llm, packages }),
      execution: new SkillNativeExecutionEngine({
        llm: executionLlm,
        broker,
      }),
      ...(publisher ? { zeroPublisher: publisher } : {}),
    }),
  };
}

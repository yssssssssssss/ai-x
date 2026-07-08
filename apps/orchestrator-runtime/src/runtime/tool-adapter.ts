import { type ToolManifest } from './config-loader.ts';

// tool 调用统一接口。业务/skill 只经此调用 tool,不直接 shell out / import SDK。
// V0 实现 = FakeO2Adapter;二期加 O2Adapter(真实 o2)/ InternalApiAdapter / McpAdapter / ScriptAdapter。

export interface ToolInvokeResult {
  output: object;
  latencyMs: number;
}

export interface ToolAdapter {
  readonly adapterType: ToolManifest['adapter_type'];
  invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult>;
}

export class ToolInvocationError extends Error {
  constructor(public readonly toolId: string, message: string) {
    super(`tool "${toolId}" 调用失败: ${message}`);
    this.name = 'ToolInvocationError';
  }
}

// Fake o2 adapter:返回预置检索结果。
// failOnToolIds 里的 tool 会抛错——用于验证失败回放(execution_log.status=failed + failures.jsonl)。
export class FakeO2Adapter implements ToolAdapter {
  readonly adapterType = 'fake' as const;

  constructor(private readonly opts: { failOnToolIds?: string[] } = {}) {}

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    if (this.opts.failOnToolIds?.includes(opts.toolId)) {
      throw new ToolInvocationError(opts.toolId, '模拟失败(FakeO2Adapter.failOnToolIds)');
    }
    // 与 o2-web-search/output.schema.json 对齐的预置结果
    const output = {
      results: [
        { title: '竞品A数字人产品页', url: 'https://example.com/a', snippet: '支持实时语音互动与形象定制' },
        { title: '行业评测:直播AI横评', url: 'https://example.com/review', snippet: '对比交互延迟与内容质量' },
        { title: '应用商店榜单', url: 'https://example.com/rank', snippet: '数字人直播产品下载榜' },
      ],
    };
    return { output, latencyMs: Math.round(performance.now() - start) };
  }
}

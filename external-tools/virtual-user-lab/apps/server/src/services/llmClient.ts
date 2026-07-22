// 工具内轻量网关客户端(OpenAI 兼容)。候选模型按主项目顺序切换；所有候选失败才由调用方降级。
// 独立服务,不依赖主项目代码;配置从工具自己的环境变量读。
import { env } from '../config/env.js';

export const isLLMEnabled = (): boolean => !!(env.llm.baseUrl && env.llm.apiKey && env.llm.models.length);

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

type RetryableError = Error & { retryable?: boolean };

function retryableError(message: string): RetryableError {
  const error = new Error(message) as RetryableError;
  error.retryable = true;
  return error;
}

function shouldFallback(error: unknown): boolean {
  if ((error as RetryableError)?.retryable) return true;
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /timed?\s*out|fetch failed|network/i.test(error.message);
}

async function callOnce(model: string, messages: object[]): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), env.llm.timeoutMs);
  try {
    const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.llm.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: ac.signal,
    });
    const body = !res.ok ? (await res.text()).slice(0, 300) : '';
    if (res.status === 429 || res.status >= 500) throw retryableError(`网关返回 HTTP ${res.status}: ${body}`);
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}: ${body}`);
    const resp = (await res.json()) as ChatResponse;
    if (resp.error) throw new Error(`网关错误: ${resp.error.message}`);
    const content = resp.choices?.[0]?.message?.content;
    if (content == null) throw new Error('网关响应缺少 choices[0].message.content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// 返回解析后的 JSON 对象;仅可恢复故障才切换候选。所有候选失败后由调用方显式降级。
export async function chatJSON<T = unknown>(messages: object[]): Promise<T> {
  let lastError: unknown;
  for (const model of env.llm.models) {
    try {
      const content = await callOnce(model, messages);
      return JSON.parse(content) as T;
    } catch (err) {
      lastError = err;
      if (!shouldFallback(err)) throw err;
    }
  }
  throw new Error(`所有 LLM 模型均失败(${env.llm.models.length} 次): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

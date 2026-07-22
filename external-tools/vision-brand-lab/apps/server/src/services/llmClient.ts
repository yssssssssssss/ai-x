import { env } from '../config/env.js';

export interface VisionCallResult<T> {
  data: T;
  model: string;
  attempts: number;
  latencyMs: number;
}

export const isLLMEnabled = (): boolean => !!(env.llm.baseUrl && env.llm.apiKey && env.llm.models.length);
export const configuredModelCount = (): number => env.llm.models.length;

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

async function callOnce(model: string, messages: object[], jsonMode: boolean): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), env.llm.timeoutMs);
  try {
    const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.llm.apiKey}` },
      body: JSON.stringify({ model, messages, stream: false, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
      signal: ac.signal,
    });
    const body = !res.ok ? (await res.text()).slice(0, 300) : '';
    if (res.status === 429 || res.status >= 500) throw retryableError(`网关返回 HTTP ${res.status}: ${body}`);
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}: ${body}`);
    const resp = (await res.json()) as ChatResponse;
    // 部分网关以 HTTP 200 返回错误载荷；视为可恢复失败并切换候选模型。
    if (resp.error) throw retryableError(`网关错误: ${resp.error.message}`);
    const content = resp.choices?.[0]?.message?.content;
    if (content == null) throw new Error('网关响应缺少 choices[0].message.content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export function safeParseJson<T = unknown>(text: string): T {
  let value = text.trim().replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) value = fence[1].trim();
  try { return JSON.parse(value) as T; }
  catch {
    const block = value.match(/[[{][\s\S]*[\]}]/);
    if (block) return JSON.parse(block[0]) as T;
    throw new Error(`无法从模型输出抽取 JSON: ${text.slice(0, 200)}`);
  }
}

export async function chatVisionJSON<T = unknown>(messages: object[], opts: { jsonMode?: boolean; onAttempt?: (model: string) => void } = {}): Promise<VisionCallResult<T>> {
  let lastError: unknown;
  const startedAt = Date.now();
  for (let index = 0; index < env.llm.models.length; index += 1) {
    const model = env.llm.models[index];
    opts.onAttempt?.(model);
    try {
      const content = await callOnce(model, messages, opts.jsonMode ?? false);
      let data: T;
      try {
        data = safeParseJson<T>(content);
      } catch (error) {
        throw retryableError(`模型返回无法解析的 JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { data, model, attempts: index + 1, latencyMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      if (!shouldFallback(err)) throw err;
    }
  }
  throw new Error(`所有 VLM 模型均失败(${env.llm.models.length} 次): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

// 工具内轻量网关客户端(OpenAI 兼容)。复刻主项目 gateway-llm-client 核心:
// POST {base}/chat/completions + Bearer + response_format:json_object,超时 + 429 退避一次。
// 独立服务,不依赖主项目代码;配置从工具自己的环境变量读。
import { env } from '../config/env.js';

export const isLLMEnabled = (): boolean => !!(env.llm.baseUrl && env.llm.apiKey && env.llm.model);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function callOnce(messages: object[]): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), env.llm.timeoutMs);
  try {
    const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.llm.apiKey}` },
      body: JSON.stringify({
        model: env.llm.model,
        messages,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: ac.signal,
    });
    if (res.status === 429) {
      const err = new Error('rate_limited') as Error & { rateLimited?: boolean };
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const resp = (await res.json()) as ChatResponse;
    if (resp.error) throw new Error(`网关错误: ${resp.error.message}`);
    const content = resp.choices?.[0]?.message?.content;
    if (content == null) throw new Error('网关响应缺少 choices[0].message.content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// 返回解析后的 JSON 对象;失败抛错(由调用方降级到规则)。429 退避重试一次。
export async function chatJSON<T = unknown>(messages: object[]): Promise<T> {
  let content: string;
  try {
    content = await callOnce(messages);
  } catch (err) {
    if ((err as { rateLimited?: boolean }).rateLimited) {
      await sleep(4000);
      content = await callOnce(messages);
    } else {
      throw err;
    }
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`网关返回非法 JSON: ${content.slice(0, 200)}`);
  }
}

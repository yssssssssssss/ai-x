// 工具内轻量网关客户端(OpenAI 兼容,支持多模态)。复刻 virtual-user 版并增强:
// - messages 里可含 image_url content part(设计图 data URL 直接塞),透传给视觉模型;
// - 默认不强制 response_format:json_object(视觉模型靠 prompt 约束 + safeParseJson 抽 JSON);
// - 超时 + 429 退避一次。独立服务,配置从工具环境变量读(经 start-labs 注入根 .env)。
import { env } from '../config/env.js';

export const isLLMEnabled = (): boolean => !!(env.llm.baseUrl && env.llm.apiKey && env.llm.model);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function callOnce(messages: object[], jsonMode: boolean): Promise<string> {
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
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
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

// 从模型文本输出里稳健抽取 JSON:去 ```json 围栏 / <think> 标签,再取第一个 {...} 或 [...] 块解析。
export function safeParseJson<T = unknown>(text: string): T {
  let s = text.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    const block = s.match(/[[{][\s\S]*[\]}]/);
    if (block) return JSON.parse(block[0]) as T;
    throw new Error(`无法从模型输出抽取 JSON: ${text.slice(0, 200)}`);
  }
}

// 多模态对话:messages 可含 { role, content: [{type:'text'...},{type:'image_url', image_url:{url}}] }。
// 返回解析后的 JSON;失败抛错(由调用方降级到启发式)。429 退避重试一次。
export async function chatVisionJSON<T = unknown>(messages: object[], opts: { jsonMode?: boolean } = {}): Promise<T> {
  const jsonMode = opts.jsonMode ?? false;
  let content: string;
  try {
    content = await callOnce(messages, jsonMode);
  } catch (err) {
    if ((err as { rateLimited?: boolean }).rateLimited) {
      await sleep(4000);
      content = await callOnce(messages, jsonMode);
    } else {
      throw err;
    }
  }
  return safeParseJson<T>(content);
}

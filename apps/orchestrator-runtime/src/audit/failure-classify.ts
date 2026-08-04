// 失败分类(纯函数)。CONTEXT「基础设施失败」:与研究能力无关的运行环境故障,
// 留痕后可重试、不占批次名额;其余错误按能力失败处理(计入批次)。
// gold:run 据此决定重试还是计样本。只认错误文本特征,不碰 IO。

// 网关/网络/检索 HTTP 层故障的可辨识特征。命中即 infra。
const INFRA_PATTERNS: RegExp[] = [
  /网关返回 HTTP 5\d\d/, // gateway 5xx
  /网关错误/, // gateway 返回 error 体
  /网关响应缺少/, // 网关坏响应
  /HTTP 5\d\d/, // Tavily/其它 adapter 5xx
  /HTTP 429/, // 限流耗尽
  /ETIMEDOUT| timeout|超时|The operation was aborted|aborted/i,
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i,
  /配额|quota|rate limit/i,
];

export function isInfraFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return INFRA_PATTERNS.some((re) => re.test(msg));
}

export function classifyError(err: unknown): { kind: 'infra_failed' | 'capability_failed'; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { kind: isInfraFailure(err) ? 'infra_failed' : 'capability_failed', message };
}

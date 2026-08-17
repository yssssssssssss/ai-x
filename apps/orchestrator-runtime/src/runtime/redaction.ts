export interface RedactionPolicy {
  pii?: string;
  [key: string]: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function redactString(value: string, maskPii = true): string {
  const withoutData = value.startsWith('data:') && value.includes(';base64,')
    ? '[REDACTED_DATA]'
    : value;
  const withoutLabeledCredentials = withoutData.replace(
    /\b(?:authorization|token)\s*[:=]\s*(?:bearer|basic|digest|negotiate|aws4-hmac-sha256)\s+[^\r\n]+/gi,
    '[REDACTED]',
  );
  const withoutCredentials = withoutLabeledCredentials.replace(
    /\bBearer\s+[^\s,;]+/g,
    '[REDACTED]',
  );
  const withoutSecrets = withoutCredentials.replace(
    /\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
    (_match, label: string) => `${label}=[REDACTED]`,
  );
  if (!maskPii) return withoutSecrets;
  return withoutSecrets
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b1[3-9]\d{9}\b/g, '[REDACTED_PHONE]')
    .replace(/\b\d{17}[\dXx]\b/g, '[REDACTED_ID]')
    .replace(/(?:0\d{2,3}-)?\d{7,8}/g, '[REDACTED_LANDLINE]')
    .replace(/[\u4e00-\u9fa5]{2,}(?:省|市|区|县|路|街|号)[\u4e00-\u9fa5\d-]{0,24}/g, '[REDACTED_ADDRESS]');
}

export function redactSensitiveValue(
  value: unknown,
  policy: RedactionPolicy = { pii: 'mask' },
  key = '',
): unknown {
  const maskPii = policy.pii === 'mask';
  if (/^(authorization|api[_-]?key|token|secret|password|dataurl|base64)$/i.test(key)) return '[REDACTED]';
  if (maskPii && /^(name|full_name|contact_name|email|phone|mobile)$/i.test(key)) return '[REDACTED_PII]';
  if (typeof value === 'string') {
    const isUrlField = /^(url|oss_url|sourceUrl)$/i.test(key);
    return redactString(value, isUrlField ? false : maskPii);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, policy));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactSensitiveValue(child, policy, childKey),
    ]),
  );
}

export function redactToolOutput(value: unknown, policy: RedactionPolicy): unknown {
  return redactSensitiveValue(value, policy);
}

export function containsBlockedSensitiveData(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\b(confidential|internal[-_ ]only|business[-_ ]secret)\b|商业机密|敏感业务/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsBlockedSensitiveData);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    // 脱敏策略配置元数据(如 { sensitive_business_data: 'block' })不是敏感内容,跳过整棵子树避免误判。
    if (/^redaction_?policy$/i.test(key)) return false;
    return (
      /^(confidential|internal_only|business_secret|sensitive_business_data)$/i.test(key)
      || containsBlockedSensitiveData(child)
    );
  });
}

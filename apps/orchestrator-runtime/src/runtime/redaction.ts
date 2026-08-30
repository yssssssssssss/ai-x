export interface RedactionPolicy {
  pii?: string;
  [key: string]: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CANONICAL_SHA256 = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_UUID_REFERENCE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?::[A-Za-z0-9][A-Za-z0-9._/-]*)?$/i;
const STRUCTURED_CHINESE_ADDRESS = /(?:(?:[\u4e00-\u9fa5]{2,}(?:省|自治区))?[\u4e00-\u9fa5]{2,}(?:市|自治州))?[\u4e00-\u9fa5]{2,}(?:区|县)[\u4e00-\u9fa5]{2,}(?:路|街|大道|道|巷)\d+(?:号)?/g;
const STANDALONE_LANDLINE = /(?<![A-Za-z0-9_/-])(?:0\d{2,3}-)?\d{7,8}(?![A-Za-z0-9_/-])/g;
const URL_FIELD = /^(?:url|urls|oss_urls?|source_?urls?|requested_?urls?|final_?urls?)$/i;

export function isMachineReferenceField(key: string): boolean {
  return key === 'id'
    || key === 'ids'
    || /(?:Id|Ids)$/u.test(key)
    || /_(?:id|ids)$/iu.test(key);
}

function machineReferenceSnapshot(
  value: unknown,
  field = '',
  path = '$',
  entries: string[] = [],
): string[] {
  if (isMachineReferenceField(field)) {
    entries.push(`${path}\u0000${String(JSON.stringify(value))}`);
    return entries;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => machineReferenceSnapshot(item, field, `${path}[${index}]`, entries));
    return entries;
  }
  if (!isRecord(value)) return entries;
  for (const [key, child] of Object.entries(value)) {
    machineReferenceSnapshot(child, key, `${path}.${key}`, entries);
  }
  return entries;
}

export function machineReferencesPreserved(before: unknown, after: unknown): boolean {
  return JSON.stringify(machineReferenceSnapshot(before))
    === JSON.stringify(machineReferenceSnapshot(after));
}

export function redactString(value: string, maskPii = true): string {
  if (CANONICAL_SHA256.test(value) || CANONICAL_UUID_REFERENCE.test(value)) return value;
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
    .replace(STANDALONE_LANDLINE, '[REDACTED_LANDLINE]')
    .replace(STRUCTURED_CHINESE_ADDRESS, '[REDACTED_ADDRESS]');
}

export function redactSensitiveValue(
  value: unknown,
  policy: RedactionPolicy = { pii: 'mask' },
  key = '',
): unknown {
  const maskPii = policy.pii === 'mask';
  if (/^(authorization|api[_-]?key|token|secret|password|dataurl|base64)$/i.test(key)) return '[REDACTED]';
  if (maskPii && /^(full_name|contact_name|email|phone|mobile)$/i.test(key)) return '[REDACTED_PII]';
  if (typeof value === 'string') {
    return redactString(value, URL_FIELD.test(key) ? false : maskPii);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, policy, key));
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

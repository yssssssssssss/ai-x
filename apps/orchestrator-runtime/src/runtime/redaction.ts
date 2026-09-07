export interface RedactionPolicy {
  pii?: string;
  [key: string]: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


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

export function redactString(value: string, _maskPii = true): string {
  const withoutLabeledCredentials = value.replace(
    /\b(?:authorization|token)\s*[:=]\s*(?:bearer|basic|digest|negotiate|aws4-hmac-sha256)\s+[^\r\n]+/gi,
    '[REDACTED]',
  );
  const withoutCredentials = withoutLabeledCredentials.replace(
    /\bBearer\s+[^\s,;]+/g,
    '[REDACTED]',
  );
  return withoutCredentials.replace(
    /\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
    (_match, label: string) => `${label}=[REDACTED]`,
  );
}

export function redactSensitiveValue(
  value: unknown,
  _policy: RedactionPolicy = {},
  key = '',
): unknown {
  if (/^(authorization|api[_-]?key|token|secret|password)$/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value, false);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, {}, key));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactSensitiveValue(child, {}, childKey),
    ]),
  );
}

export function redactToolOutput(value: unknown, _policy: RedactionPolicy): unknown {
  return redactSensitiveValue(value);
}

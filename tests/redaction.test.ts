import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  machineReferencesPreserved,
  redactSensitiveValue,
  redactString,
  redactToolOutput,
} from '../apps/orchestrator-runtime/src/runtime/redaction.ts';

test('passes business content and PII through unchanged', () => {
  const value = {
    customerId: '13800138000',
    userId: 'person@example.test',
    snippet: '联系人 13800138000，身份证 110101199001011234，地址北京市朝阳区建国路88号。',
    dataurl: 'data:text/plain;base64,SGVsbG8=',
    source_urls: [
      'https://example.test/reports/12345678',
      'https://example.test/profiles/13800138000',
    ],
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), value);
});

test('masks only credential fields and labeled credentials', () => {
  const value = {
    apiKey: 'secret-api-key',
    password: 'secret-password',
    nested: { token: 'secret-token' },
    summary: 'authorization: Bearer secret-bearer',
    phone: '13800138000',
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), {
    apiKey: '[REDACTED]',
    password: '[REDACTED]',
    nested: { token: '[REDACTED]' },
    summary: '[REDACTED]',
    phone: '13800138000',
  });
  assert.equal(redactString('Bearer secret-token'), '[REDACTED]');
});

test('tool output keeps business content while protecting credentials', () => {
  const value = {
    email: 'person@example.test',
    phone: '13800138000',
    internal_only: '业务内容直接输出',
    authorization: 'Bearer secret-token',
  };

  assert.deepEqual(redactToolOutput(value, { pii: 'mask', sensitive_business_data: 'block' }), {
    email: 'person@example.test',
    phone: '13800138000',
    internal_only: '业务内容直接输出',
    authorization: '[REDACTED]',
  });
});

test('still detects credential protection changing a machine reference', () => {
  const original = {
    sourceContributionUnitIds: ['token=secret-value'],
    summary: 'contact person@example.test',
  };
  const protectedValue = redactSensitiveValue(original, { pii: 'mask' });

  assert.equal(machineReferencesPreserved(original, protectedValue), false);
  assert.equal(machineReferencesPreserved(
    { summary: 'contact person@example.test' },
    { summary: 'contact person@example.test' },
  ), true);
});

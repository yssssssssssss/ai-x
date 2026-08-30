import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  machineReferencesPreserved,
  redactSensitiveValue,
} from '../apps/orchestrator-runtime/src/runtime/redaction.ts';

test('preserves numeric identifiers inside explicit URL fields', () => {
  const value = {
    url: 'https://www.jd.com/phb/123456789012345.html',
    oss_url: 'https://www.petslib.cn/news/123456789012345678.html',
    sourceUrl: 'https://example.test/13800138000',
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), value);
});

test('preserves UUID-backed contribution identities', () => {
  const attemptId = '2cc632e5-dddf-4a1e-963a-eef764702717';
  const sourceContributionUnitId = '41c1a424-dcf2-46b3-aef5-dbb22470122a:F1';
  const numericSourceContributionUnitId = '41c1a424-dcf2-46b3-aef5-dbb22470122a:12345678';
  const value = {
    attemptId,
    sourceContributionUnitIds: [sourceContributionUnitId, numericSourceContributionUnitId],
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), value);
});

test('does not exempt arbitrary ID fields from PII masking', () => {
  const value = {
    customerId: '13800138000',
    userId: 'person@example.test',
    snippet: '电话:12345678',
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), {
    customerId: '[REDACTED_PHONE]',
    userId: '[REDACTED_EMAIL]',
    snippet: '电话:[REDACTED_LANDLINE]',
  });
});

test('detects a sanitizer mutation inside a machine reference', () => {
  const original = {
    sourceContributionUnitIds: ['token=secret-value'],
    summary: 'contact person@example.test',
  };
  const sanitized = redactSensitiveValue(original, { pii: 'mask' });

  assert.equal(machineReferencesPreserved(original, sanitized), false);
  assert.equal(machineReferencesPreserved(
    { summary: 'contact person@example.test' },
    { summary: 'contact [REDACTED_EMAIL]' },
  ), true);
});

test('preserves numeric identifiers in source URL arrays', () => {
  const value = {
    source_urls: [
      'https://example.test/reports/12345678',
      'https://example.test/profiles/13800138000',
    ],
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), value);
});

test('still masks phone and identity numbers in ordinary text fields', () => {
  const redacted = redactSensitiveValue({
    snippet: '联系人 13800138000，身份证 110101199001011234',
  }, { pii: 'mask' }) as { snippet: string };

  assert.equal(redacted.snippet.includes('13800138000'), false);
  assert.equal(redacted.snippet.includes('110101199001011234'), false);
  assert.match(redacted.snippet, /\[REDACTED_PHONE\]/);
  assert.match(redacted.snippet, /\[REDACTED_ID\]/);
});

test('still masks standalone landline numbers in ordinary text fields', () => {
  const redacted = redactSensitiveValue({
    snippet: '服务热线 12345678，或拨打 010-87654321；电话:76543210，tel:010-76543210。',
  }, { pii: 'mask' }) as { snippet: string };

  assert.equal(redacted.snippet.includes('12345678'), false);
  assert.equal(redacted.snippet.includes('010-87654321'), false);
  assert.equal(redacted.snippet.includes('76543210'), false);
  assert.equal(redacted.snippet.includes('010-76543210'), false);
  assert.equal(redacted.snippet.match(/\[REDACTED_LANDLINE\]/g)?.length, 4);
});

test('preserves canonical SHA-256 digests while masking PII', () => {
  const digest = 'sha256:24a0e784e3a0277542c6835206e431c1e126b77c98d9e5f016bdecb414b0ab2a';

  assert.deepEqual(
    redactSensitiveValue({ content_sha256: digest }, { pii: 'mask' }),
    { content_sha256: digest },
  );
});

test('preserves public entity names and ordinary research terminology', () => {
  const value = {
    name: 'HAY Dogs',
    summary: '比较市场、地区、路线与证据编号，不应被识别为住址。',
  };

  assert.deepEqual(redactSensitiveValue(value, { pii: 'mask' }), value);
});

test('still masks a structured Chinese street address', () => {
  const redacted = redactSensitiveValue({
    snippet: '收货地点是北京市朝阳区建国路88号，请勿公开。',
  }, { pii: 'mask' }) as { snippet: string };

  assert.equal(redacted.snippet.includes('北京市朝阳区建国路88号'), false);
  assert.match(redacted.snippet, /\[REDACTED_ADDRESS\]/);
});

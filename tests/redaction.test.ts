import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSensitiveValue } from '../apps/orchestrator-runtime/src/runtime/redaction.ts';

test('preserves numeric identifiers inside explicit URL fields', () => {
  const value = {
    url: 'https://www.jd.com/phb/123456789012345.html',
    oss_url: 'https://www.petslib.cn/news/123456789012345678.html',
    sourceUrl: 'https://example.test/13800138000',
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

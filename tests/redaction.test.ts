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

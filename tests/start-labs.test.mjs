import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('start-labs 支持指定实验室，且保留 server/web 模式开关', () => {
  const source = readFileSync(new URL('../scripts/start-labs.mjs', import.meta.url), 'utf8');
  assert.match(source, /--labs=/);
  assert.match(source, /!args\.includes\('--web'\)/);
  assert.match(source, /!args\.includes\('--server'\)/);
});

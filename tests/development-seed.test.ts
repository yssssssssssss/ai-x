import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVELOPMENT_SEED_USER_ID,
  assertDevelopmentSeedUser,
} from '../database/development-seed.ts';

test('seed-dependent CLI rejects a database without the explicit development seed', () => {
  assert.throws(
    () => assertDevelopmentSeedUser(null),
    /DEVELOPMENT_SEED_MISSING: run pnpm db:seed/,
  );
});

test('seed-dependent CLI accepts the seeded development user', () => {
  assert.doesNotThrow(() => assertDevelopmentSeedUser({ id: DEVELOPMENT_SEED_USER_ID }));
});

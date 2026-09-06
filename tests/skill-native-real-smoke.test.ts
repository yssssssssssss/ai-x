import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeRealSmokeConfig } from '../scripts/skill-native-real-smoke.ts';

function validConfig(): NodeJS.ProcessEnv {
  return {
    ALLOW_REAL_PROVIDER: '1',
    LLM_PROVIDER: 'gateway',
    TOOL_ADAPTER: 'real',
    ZERO_PUBLICATION_ENABLED: 'false',
    DATABASE_URL: 'postgres://smoke',
    LLM_GATEWAY_BASE_URL: 'https://gateway.example/v1',
    LLM_GATEWAY_API_KEY: 'secret',
    LLM_MODEL_NAME: 'requested-model',
    LLM_EXPECTED_ACTUAL_MODEL: 'actual-model',
    SKILL_SANDBOX_IMAGE: `registry.example/skill-runtime@sha256:${'a'.repeat(64)}`,
  };
}

test('native real smoke requires real providers and a digest-pinned sandbox', () => {
  const config = assertNativeRealSmokeConfig(validConfig());
  assert.equal(config.ownerUserId, '00000000-0000-0000-0000-000000000001');

  assert.throws(
    () => assertNativeRealSmokeConfig({ ...validConfig(), ALLOW_REAL_PROVIDER: '0' }),
    /ALLOW_REAL_PROVIDER/u,
  );
  assert.throws(
    () => assertNativeRealSmokeConfig({ ...validConfig(), SKILL_SANDBOX_IMAGE: 'skill-runtime:latest' }),
    /immutable sha256 digest/u,
  );
  assert.throws(
    () => assertNativeRealSmokeConfig({ ...validConfig(), ZERO_PUBLICATION_ENABLED: 'true' }),
    /must remain disabled/u,
  );
});

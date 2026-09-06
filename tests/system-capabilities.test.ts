import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import express from 'express';
import { createSystemCapabilitiesRouter } from '../apps/agent-api/src/routes/system-capabilities.ts';
import { SKILL_NATIVE_PLAN_VERSION } from '../packages/api-contract/skill-native.ts';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

test('system capabilities expose only the active package runtime', async () => {
  process.env.ZERO_PUBLICATION_ENABLED = 'false';
  const app = express();
  app.use('/api/system/capabilities', createSystemCapabilitiesRouter({
    catalog: () => ({
      skills: [{
        id: 'one', name: 'One', description: 'One', packageHash: 'sha256:1',
        fileCount: 1, byteSize: 10, available: true,
      }],
      unavailableSkills: [{ id: 'bad', sourcePath: 'bad', reason: 'missing SKILL.md' }],
    }),
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/system/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.planContractVersion, SKILL_NATIVE_PLAN_VERSION);
    assert.deepEqual(body.skillPackages, ['one']);
    assert.equal(body.unavailableSkillPackages, 1);
    assert.equal(body.zeroPublicationEnabled, false);
    assert.match(String(body.toolRegistryHash), /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(body), /native_delivery|ReportResult|\/Users\//u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { systemCapabilitiesRouter } from '../apps/agent-api/src/routes/system-capabilities.ts';

test('system capabilities expose live contract and registry identities without local paths', async () => {
  const app = express();
  app.use('/api/system/capabilities', systemCapabilitiesRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/system/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body.planContractVersions, ['current-execution-plan-v1', 'current-execution-plan-v2']);
    assert.deepEqual(body.reportDocumentVersions, ['report-document-v1', 'report-document-v2']);
    assert.ok((body.activeDeliverables as string[]).includes('research_plan'));
    assert.ok((body.compiledSkills as string[]).includes('generate-research-plan'));
    assert.match(String(body.toolRegistryHash), /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(body), /Users\/|storage_uri|DATABASE_URL/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signToken } from '../apps/agent-api/src/auth.ts';
import { createAgentApiApp } from '../apps/agent-api/src/server.ts';
import {
  CutoverGateError,
  assertMigrationPlanFrozen,
  backupInventoryFromFiles,
} from '../apps/orchestrator-runtime/src/cutover/cutover-service.ts';

test('backup inventory records sha256 and requires restore checks for every artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-inventory-'));
  try {
    const db = join(root, 'db.dump');
    const workspace = join(root, 'workspace.tar');
    const audit = join(root, 'audit.tar');
    writeFileSync(db, 'database-backup');
    writeFileSync(workspace, 'workspace-backup');
    writeFileSync(audit, 'audit-backup');

    const inventory = backupInventoryFromFiles({
      database: { path: db, uri: 'file://db.dump', restoreChecked: true },
      workspace: { path: workspace, uri: 'file://workspace.tar', restoreChecked: true },
      audit: { path: audit, uri: 'file://audit.tar', restoreChecked: true },
    });

    assert.equal(inventory.database.bytes, 15);
    assert.match(inventory.database.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(inventory.workspace.restoreChecked, true);
    assert.equal(inventory.audit.uri, 'file://audit.tar');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration plan freeze rejects missing production schema version', () => {
  assert.throws(
    () => assertMigrationPlanFrozen({ expectedSchemaVersion: '003', appliedVersions: ['001', '002'], ledgerFrozen: true, contractVersionVerified: true }),
    (error: unknown) => error instanceof CutoverGateError && error.message.includes('migrations.schemaVersion'),
  );
});

test('agent app factory supports read-only smoke without exposing old mutation routes', async () => {
  const app = createAgentApiApp();
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const token = signToken({ userId: '00000000-0000-0000-0000-000000000001', email: 'owner@test.local' });
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const legacyMutation = await fetch(`http://127.0.0.1:${address.port}/api/tasks/task-id/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(legacyMutation.status, 410);

    const oldRoute = await fetch(`http://127.0.0.1:${address.port}/api/legacy/tasks/task-id/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(oldRoute.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

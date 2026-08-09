import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AuditSealError,
  AuditPackageService,
} from '../apps/orchestrator-runtime/src/audit/audit-package-service.ts';

function packageInput() {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    machineEvidence: {
      plan: { id: 'plan-1', hash: 'sha256:plan' },
      gates: [{ id: 'gate-1', decision: 'approved' }],
      executionSteps: [{ stepNo: 1, state: 'succeeded' }],
      toolProofs: [{ implementationId: 'tavily', mode: 'real' }],
      modelCalls: [{ model: 'pinned-model' }],
      evidenceManifest: { version: 'evidence-v1', entries: [] },
      report: { version: 'current-evidence-report-v1', taskId: 'task-1' },
      failures: [],
    },
  };
}

test('seals a self-contained run package and detects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-seal-'));
  try {
    const service = new AuditPackageService({ root });
    const sealed = service.sealRunPackage(packageInput());
    assert.equal(service.verifyRunPackage(sealed.directory).runId, 'run-1');

    writeFileSync(join(sealed.directory, 'machine', 'report.json'), '{"tampered":true}');
    assert.throws(() => service.verifyRunPackage(sealed.directory), AuditSealError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appends review without modifying sealed machine manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-review-'));
  try {
    const service = new AuditPackageService({ root });
    const sealed = service.sealRunPackage(packageInput());
    const before = readFileSync(join(sealed.directory, 'machine-manifest.json'), 'utf8');
    const review = service.appendReview({
      directory: sealed.directory,
      reviewerId: 'reviewer-1',
      independence: { capabilityOwner: false, operator: false, artifactEditor: false },
      verdict: 'usable',
      findingSupport: [{ findingId: 'F1', decision: 'supported' }],
    });
    const after = readFileSync(join(sealed.directory, 'machine-manifest.json'), 'utf8');
    assert.equal(after, before);
    assert.match(readFileSync(review.path, 'utf8'), /reviewer-1/);
    assert.doesNotThrow(() => service.verifyRunPackage(sealed.directory));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses secrets, Base64, prompts, and raw sensitive fields in machine evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-redaction-'));
  try {
    const service = new AuditPackageService({ root });
    for (const machineEvidence of [
      { prompt: 'full prompt must not persist' },
      { authorization: 'Bearer secret-token' },
      { screenshot: 'data:image/png;base64,AAAA' },
      { raw_input: { email: 'person@example.test' } },
    ]) {
      assert.throws(
        () => service.sealRunPackage({ ...packageInput(), runId: `unsafe-${Object.keys(machineEvidence)[0]}`, machineEvidence }),
        AuditSealError,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seals a batch root bound to exactly three run manifests and review hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-batch-'));
  try {
    const service = new AuditPackageService({ root });
    const runs = [1, 2, 3].map((slot) => service.sealRunPackage({ ...packageInput(), runId: `run-${slot}`, attemptId: `attempt-${slot}` }));
    const batch = service.sealBatchRoot({
      batchId: 'batch-1',
      runDirectories: runs.map((run) => run.directory),
      decision: { status: 'READY_FOR_REVIEW' },
    });
    const manifest = service.verifyBatchRoot(batch.directory);
    assert.equal(manifest.runManifests.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export class AuditSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSealError';
  }
}

interface FileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

interface MachineManifest {
  version: 'audit-machine-v1';
  runId: string;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  files: FileEntry[];
  manifestHash: string;
}

interface BatchManifest {
  version: 'audit-batch-v1';
  batchId: string;
  runManifests: Array<{ runId: string; manifestHash: string; directory: string }>;
  reviewHashes: string[];
  decision: Record<string, unknown>;
  manifestHash: string;
}

function hashBytes(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function hashJson(value: unknown): string {
  return hashBytes(JSON.stringify(stable(value)));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertSafe(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (/data:[^,]+;base64,/i.test(value)) throw new AuditSealError(`base64 is forbidden at ${path}`);
    if (/Bearer\s+\S+|authorization\s*[:=]|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]/i.test(value)) {
      throw new AuditSealError(`secret-like text is forbidden at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafe(entry, `${path}/${index}`));
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, child] of Object.entries(object)) {
    if (/^(authorization|api[_-]?key|token|password|secret|prompt|raw_input)$/i.test(key)) {
      throw new AuditSealError(`forbidden field ${path}/${key}`);
    }
    assertSafe(child, `${path}/${key}`);
  }
}

function writeJson(path: string, value: unknown): void {
  assertSafe(value);
  writeFileSync(path, `${JSON.stringify(stable(value), null, 2)}\n`);
}

function filesUnder(root: string, directory: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, name.name);
      if (name.isDirectory()) visit(next);
      else {
        const bytes = readFileSync(next);
        entries.push({ path: relative(root, next), sha256: hashBytes(bytes), bytes: bytes.length });
      }
    }
  };
  visit(directory);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export class AuditPackageService {
  constructor(private readonly options: { root: string }) {}

  sealRunPackage(input: {
    runId: string;
    taskId: string;
    planVersionId: string;
    attemptId: string;
    machineEvidence: Record<string, unknown>;
  }): { directory: string; manifest: MachineManifest } {
    const directory = join(this.options.root, 'runs', input.runId);
    if (existsSync(directory)) throw new AuditSealError(`run package ${input.runId} already exists`);
    const machineDirectory = join(directory, 'machine');
    assertSafe(input.machineEvidence);
    mkdirSync(machineDirectory, { recursive: true });
    for (const [name, value] of Object.entries(input.machineEvidence)) {
      writeJson(join(machineDirectory, `${name}.json`), value);
    }
    const files = filesUnder(directory, machineDirectory);
    const draft = {
      version: 'audit-machine-v1' as const,
      runId: input.runId,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      files,
    };
    const manifest: MachineManifest = { ...draft, manifestHash: hashJson(draft) };
    writeJson(join(directory, 'machine-manifest.json'), manifest);
    mkdirSync(join(directory, 'reviews'));
    return { directory, manifest };
  }

  verifyRunPackage(directory: string): MachineManifest {
    const manifestPath = join(directory, 'machine-manifest.json');
    if (!existsSync(manifestPath)) throw new AuditSealError('machine manifest is missing');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MachineManifest;
    const draft = {
      version: manifest.version,
      runId: manifest.runId,
      taskId: manifest.taskId,
      planVersionId: manifest.planVersionId,
      attemptId: manifest.attemptId,
      files: manifest.files,
    };
    if (manifest.manifestHash !== hashJson(draft)) throw new AuditSealError('machine manifest hash is invalid');
    for (const entry of manifest.files) {
      const path = join(directory, entry.path);
      if (!existsSync(path)) throw new AuditSealError(`sealed file is missing: ${entry.path}`);
      const bytes = readFileSync(path);
      if (bytes.length !== entry.bytes || hashBytes(bytes) !== entry.sha256) {
        throw new AuditSealError(`sealed file was modified: ${entry.path}`);
      }
    }
    return manifest;
  }

  appendReview(input: {
    directory: string;
    reviewerId: string;
    independence: Record<string, boolean>;
    verdict: 'usable' | 'needs_revision' | 'unusable';
    findingSupport: Array<{ findingId: string; decision: 'supported' | 'unsupported' | 'pending' }>;
  }): { path: string; sha256: string } {
    this.verifyRunPackage(input.directory);
    if (Object.values(input.independence).some(Boolean)) throw new AuditSealError('reviewer is not independent');
    const payload = { version: 'review-v1', ...input };
    assertSafe(payload);
    const contents = `${JSON.stringify(stable(payload), null, 2)}\n`;
    const path = join(input.directory, 'reviews', `${input.reviewerId}.json`);
    if (existsSync(path)) throw new AuditSealError(`review already exists for ${input.reviewerId}`);
    writeFileSync(path, contents);
    return { path, sha256: hashBytes(contents) };
  }

  sealBatchRoot(input: {
    batchId: string;
    runDirectories: string[];
    decision: Record<string, unknown>;
  }): { directory: string; manifest: BatchManifest } {
    if (input.runDirectories.length !== 3) throw new AuditSealError('batch root requires exactly three run packages');
    const directory = join(this.options.root, 'batches', input.batchId);
    if (existsSync(directory)) throw new AuditSealError(`batch package ${input.batchId} already exists`);
    const runManifests = input.runDirectories.map((runDirectory) => {
      const manifest = this.verifyRunPackage(runDirectory);
      return { runId: manifest.runId, manifestHash: manifest.manifestHash, directory: runDirectory };
    });
    const reviewHashes = input.runDirectories.flatMap((runDirectory) =>
      filesUnder(runDirectory, join(runDirectory, 'reviews')).map((entry) => entry.sha256),
    );
    const draft = {
      version: 'audit-batch-v1' as const,
      batchId: input.batchId,
      runManifests,
      reviewHashes,
      decision: input.decision,
    };
    const manifest: BatchManifest = { ...draft, manifestHash: hashJson(draft) };
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, 'batch-manifest.json'), manifest);
    return { directory, manifest };
  }

  verifyBatchRoot(directory: string): BatchManifest {
    const path = join(directory, 'batch-manifest.json');
    if (!existsSync(path)) throw new AuditSealError('batch manifest is missing');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as BatchManifest;
    if (manifest.runManifests.length !== 3) throw new AuditSealError('batch manifest does not bind three runs');
    const draft = {
      version: manifest.version,
      batchId: manifest.batchId,
      runManifests: manifest.runManifests,
      reviewHashes: manifest.reviewHashes,
      decision: manifest.decision,
    };
    if (manifest.manifestHash !== hashJson(draft)) throw new AuditSealError('batch manifest hash is invalid');
    for (const run of manifest.runManifests) {
      const current = this.verifyRunPackage(run.directory);
      if (current.manifestHash !== run.manifestHash) throw new AuditSealError(`run manifest drift for ${run.runId}`);
    }
    return manifest;
  }
}

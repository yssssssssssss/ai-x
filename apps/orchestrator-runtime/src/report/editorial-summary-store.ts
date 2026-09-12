import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { EditorialSummaryManifestV1 } from '../../../../packages/api-contract/editorial-summary.ts';
import {
  EDITORIAL_MAX_JSON_BYTES,
  EDITORIAL_MAX_MANIFEST_BYTES,
  canonicalJsonBytes,
  canonicalSha256,
  hashBytes,
  type Sha256,
} from './editorial-report-contract.ts';

import { validateEditorialSummaryHtml } from './editorial-summary-generator.ts';
import type { EditorialSummarySourceV1 } from './editorial-summary-source.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REQUEST_KEY = /^esrq_[a-f0-9]{64}$/u;
const PUBLICATION_ID = /^esrp_[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLOT = 'summary-ready';
const FILES = Object.freeze({
  source: 'source-bundle.json',
  plan: 'editorial-plan.json',
  html: 'report.html',
  validation: 'coverage.json',
  fidelity: 'fidelity.json',
  manifest: 'manifest.json',
});
const EXPECTED_FILES = Object.values(FILES).sort();
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const LOCK_STALE_MS = 30 * 60 * 1_000;

export interface EditorialSummaryStorePublishInput {
  taskId: string;
  attemptId: string;
  requestKey: string;
  sourceBytes: Uint8Array;
  planBytes: Uint8Array;
  htmlBytes: Uint8Array;
  validationBytes: Uint8Array;
  fidelityBytes: Uint8Array;
  manifestBytes: Uint8Array;
  assertStillCurrent(): Promise<void>;
}

export interface EditorialSummaryStoredPublication {
  slotPath: string;
  reportPath: string;
  manifestPath: string;
  manifest: EditorialSummaryManifestV1;
  sourceBytes: Buffer;
  planBytes: Buffer;
  htmlBytes: Buffer;
  validationBytes: Buffer;
  fidelityBytes: Buffer;
  manifestBytes: Buffer;
}

export class EditorialSummaryStoreError extends Error {
  readonly name = 'EditorialSummaryStoreError';
  constructor(readonly code: 'SUMMARY_STORE_INVALID' | 'SUMMARY_STORE_WRITE_FAILED') { super(code); }
}

function fail(code: EditorialSummaryStoreError['code']): never { throw new EditorialSummaryStoreError(code); }
function same(left: Uint8Array, right: Uint8Array): boolean { return Buffer.from(left).equals(Buffer.from(right)); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SUMMARY_STORE_INVALID');
  return value as Record<string, unknown>;
}
function sha(value: unknown): Sha256 {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail('SUMMARY_STORE_INVALID');
  return value as Sha256;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('SUMMARY_STORE_INVALID');
  return value;
}
function exactKeys(item: Record<string, unknown>, required: readonly string[]): void {
  const keys = Object.keys(item).sort();
  const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('SUMMARY_STORE_INVALID');
  }
}

function parseManifest(value: unknown): EditorialSummaryManifestV1 {
  const item = object(value);
  exactKeys(item, [
    'version', 'authority', 'status', 'generationMode', 'taskId', 'planVersionId', 'attemptId',
    'requestKey', 'publicationId', 'sourceReportPackage', 'sourceHash', 'planHash', 'htmlHash',
    'validationHash', 'fidelityHash', 'modelCalls', 'generatedAt',
  ]);
  if (
    item.version !== 'editorial-summary-publication-v1'
    || item.authority !== 'derived'
    || item.status !== 'ready'
    || item.generationMode !== 'llm_html'
    || !UUID.test(text(item.taskId))
    || !UUID.test(text(item.planVersionId))
    || !UUID.test(text(item.attemptId))
    || !REQUEST_KEY.test(text(item.requestKey))
    || !PUBLICATION_ID.test(text(item.publicationId))
    || Number.isNaN(Date.parse(text(item.generatedAt)))
    || !Array.isArray(item.modelCalls)
  ) fail('SUMMARY_STORE_INVALID');
  const sourcePackage = object(item.sourceReportPackage);
  exactKeys(sourcePackage, ['artifactId', 'kind', 'schemaVersion', 'contentSha256']);
  const modelCalls = item.modelCalls.map((candidate) => {
    const call = object(candidate);
    const allowed = [
      'stage', 'modelName', 'modelVersion', 'traceId', 'promptHash', 'responseHash',
      ...(call.receiptId === undefined ? [] : ['receiptId']),
    ];
    exactKeys(call, allowed);
    if (!['editorial_summary_plan', 'editorial_summary_html', 'editorial_summary_fidelity', 'editorial_summary_repair'].includes(text(call.stage))) {
      fail('SUMMARY_STORE_INVALID');
    }
    return {
      stage: call.stage,
      modelName: text(call.modelName),
      modelVersion: text(call.modelVersion),
      traceId: text(call.traceId),
      promptHash: text(call.promptHash),
      ...(call.receiptId === undefined ? {} : { receiptId: text(call.receiptId) }),
      responseHash: sha(call.responseHash),
    } as EditorialSummaryManifestV1['modelCalls'][number];
  });
  return {
    version: 'editorial-summary-publication-v1',
    authority: 'derived',
    status: 'ready',
    generationMode: 'llm_html',
    taskId: item.taskId as string,
    planVersionId: item.planVersionId as string,
    attemptId: item.attemptId as string,
    requestKey: item.requestKey as string,
    publicationId: item.publicationId as string,
    sourceReportPackage: {
      artifactId: text(sourcePackage.artifactId),
      kind: text(sourcePackage.kind),
      schemaVersion: text(sourcePackage.schemaVersion),
      contentSha256: sha(sourcePackage.contentSha256),
    },
    sourceHash: sha(item.sourceHash),
    planHash: sha(item.planHash),
    htmlHash: sha(item.htmlHash),
    validationHash: sha(item.validationHash),
    fidelityHash: sha(item.fidelityHash),
    modelCalls,
    generatedAt: item.generatedAt as string,
  };
}

async function writeOwnerOnly(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', FILE_MODE).catch(() => fail('SUMMARY_STORE_WRITE_FAILED'));
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, FILE_MODE);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function reclaimableLock(lockPath: string): Promise<boolean> {
  const info = await lstat(lockPath).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return true;
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
  const owner = await readFile(join(lockPath, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null) as { pid?: unknown } | null;
  return !owner || !Number.isSafeInteger(owner.pid) || !processAlive(owner.pid as number);
}

export class EditorialSummaryStore {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private coordinates(input: { taskId: string; attemptId: string; requestKey: string }): string {
    if (!UUID.test(input.taskId) || !UUID.test(input.attemptId) || !REQUEST_KEY.test(input.requestKey)) {
      fail('SUMMARY_STORE_INVALID');
    }
    return join('tasks', input.taskId, 'attempts', input.attemptId, 'summary-requests', input.requestKey, SLOT);
  }

  async acquire(input: { taskId: string; attemptId: string; requestKey: string }): Promise<{ release(): Promise<boolean> }> {
    const slotPath = join(this.root, this.coordinates(input));
    const requestPath = dirname(slotPath);
    await mkdir(requestPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(requestPath, DIRECTORY_MODE);
    const lockPath = join(requestPath, '.summary-lock');
    const createLock = async () => {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      await chmod(lockPath, DIRECTORY_MODE);
      await writeOwnerOnly(join(lockPath, 'owner.json'), canonicalJsonBytes({ pid: process.pid }));
    };
    try {
      await createLock();
    } catch {
      if (!await reclaimableLock(lockPath)) fail('SUMMARY_STORE_WRITE_FAILED');
      await rm(lockPath, { recursive: true, force: true });
      await createLock().catch(() => fail('SUMMARY_STORE_WRITE_FAILED'));
    }
    let released = false;
    return {
      release: async () => {
        if (released) return false;
        released = true;
        await rm(lockPath, { recursive: true, force: true });
        return true;
      },
    };
  }

  async read(input: {
    taskId: string;
    attemptId: string;
    requestKey: string;
    expected?: {
      planVersionId: string;
      sourceReportPackageId: string;
      sourceReportPackageHash: Sha256;
      sourceHash: Sha256;
    };
  }): Promise<EditorialSummaryStoredPublication | null> {
    const slotPath = join(this.root, this.coordinates(input));
    const directory = await lstat(slotPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      fail('SUMMARY_STORE_INVALID');
    });
    if (directory === null) return null;
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== DIRECTORY_MODE) {
      fail('SUMMARY_STORE_INVALID');
    }
    const names = (await readdir(slotPath)).sort();
    if (!same(canonicalJsonBytes(names), canonicalJsonBytes(EXPECTED_FILES))) fail('SUMMARY_STORE_INVALID');
    const readBounded = async (name: string, maximum: number): Promise<Buffer> => {
      const path = join(slotPath, name);
      const info = await lstat(path).catch(() => fail('SUMMARY_STORE_INVALID'));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== FILE_MODE || info.size > maximum) {
        fail('SUMMARY_STORE_INVALID');
      }
      const handle = await open(path, 'r');
      try { return await handle.readFile(); } finally { await handle.close(); }
    };
    const [sourceBytes, planBytes, htmlBytes, validationBytes, fidelityBytes, manifestBytes] = await Promise.all([
      readBounded(FILES.source, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.plan, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.html, MAX_HTML_BYTES),
      readBounded(FILES.validation, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.fidelity, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.manifest, EDITORIAL_MAX_MANIFEST_BYTES),
    ]);
    let manifest: EditorialSummaryManifestV1;
    let sourceValue: Record<string, unknown>;
    let planValue: Record<string, unknown>;
    let validationValue: Record<string, unknown>;
    let fidelityValue: Record<string, unknown>;
    try {
      for (const bytes of [sourceBytes, planBytes, validationBytes, fidelityBytes, manifestBytes]) {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!same(canonicalJsonBytes(parsed), bytes)) fail('SUMMARY_STORE_INVALID');
      }
      sourceValue = object(JSON.parse(sourceBytes.toString('utf8')));
      planValue = object(JSON.parse(planBytes.toString('utf8')));
      validationValue = object(JSON.parse(validationBytes.toString('utf8')));
      fidelityValue = object(JSON.parse(fidelityBytes.toString('utf8')));
      manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
    } catch (error) {
      if (error instanceof EditorialSummaryStoreError) throw error;
      fail('SUMMARY_STORE_INVALID');
    }
    const sourceBinding = object(sourceValue.binding);
    let rebuiltValidation;
    try {
      rebuiltValidation = validateEditorialSummaryHtml({
        source: sourceValue as unknown as EditorialSummarySourceV1,
        html: htmlBytes.toString('utf8'),
      });
    } catch {
      fail('SUMMARY_STORE_INVALID');
    }
    if (
      planValue.version !== 'editorial-summary-plan-v1'
      || validationValue.version !== 'editorial-summary-validation-v1'
      || fidelityValue.version !== 'editorial-summary-fidelity-v1'
      || fidelityValue.verdict !== 'pass'
      || !Array.isArray(fidelityValue.issues)
      || fidelityValue.issues.length !== 0
      || !same(canonicalJsonBytes(rebuiltValidation), validationBytes)
    ) fail('SUMMARY_STORE_INVALID');
    const expectedPublicationId = `esrp_${canonicalSha256({
      requestKey: manifest.requestKey,
      planHash: manifest.planHash,
      htmlHash: manifest.htmlHash,
      validationHash: manifest.validationHash,
      fidelityHash: manifest.fidelityHash,
    }).slice('sha256:'.length)}`;
    if (
      manifest.taskId !== input.taskId
      || manifest.attemptId !== input.attemptId
      || manifest.requestKey !== input.requestKey
      || manifest.publicationId !== expectedPublicationId
      || sourceBinding.taskId !== manifest.taskId
      || sourceBinding.planVersionId !== manifest.planVersionId
      || sourceBinding.attemptId !== manifest.attemptId
      || sourceBinding.sourceReportPackageId !== manifest.sourceReportPackage.artifactId
      || sourceBinding.sourceReportPackageHash !== manifest.sourceReportPackage.contentSha256
      || manifest.sourceHash !== hashBytes(sourceBytes)
      || manifest.planHash !== hashBytes(planBytes)
      || manifest.htmlHash !== hashBytes(htmlBytes)
      || manifest.validationHash !== hashBytes(validationBytes)
      || manifest.fidelityHash !== hashBytes(fidelityBytes)
      || input.expected && (
        manifest.planVersionId !== input.expected.planVersionId
        || manifest.sourceReportPackage.artifactId !== input.expected.sourceReportPackageId
        || manifest.sourceReportPackage.contentSha256 !== input.expected.sourceReportPackageHash
        || manifest.sourceHash !== input.expected.sourceHash
      )
    ) fail('SUMMARY_STORE_INVALID');
    return {
      slotPath,
      reportPath: join(slotPath, FILES.html),
      manifestPath: join(slotPath, FILES.manifest),
      manifest,
      sourceBytes, planBytes, htmlBytes, validationBytes, fidelityBytes, manifestBytes,
    };
  }

  async publish(input: EditorialSummaryStorePublishInput): Promise<EditorialSummaryStoredPublication> {
    const existing = await this.read(input);
    if (existing) return existing;
    const targetPath = join(this.root, this.coordinates(input));
    const requestPath = dirname(targetPath);
    await mkdir(requestPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(requestPath, DIRECTORY_MODE);
    const stagingPath = join(requestPath, `.summary-staging-${randomUUID()}`);
    await mkdir(stagingPath, { mode: DIRECTORY_MODE });
    await chmod(stagingPath, DIRECTORY_MODE);
    let published = false;
    try {
      await Promise.all([
        writeOwnerOnly(join(stagingPath, FILES.source), input.sourceBytes),
        writeOwnerOnly(join(stagingPath, FILES.plan), input.planBytes),
        writeOwnerOnly(join(stagingPath, FILES.html), input.htmlBytes),
        writeOwnerOnly(join(stagingPath, FILES.validation), input.validationBytes),
        writeOwnerOnly(join(stagingPath, FILES.fidelity), input.fidelityBytes),
        writeOwnerOnly(join(stagingPath, FILES.manifest), input.manifestBytes),
      ]);
      await input.assertStillCurrent();
      try { await rename(stagingPath, targetPath); published = true; } catch (error) {
        const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') fail('SUMMARY_STORE_WRITE_FAILED');
      }
      if (!published) await rm(stagingPath, { recursive: true, force: true });
      const stored = await this.read(input);
      if (!stored) fail('SUMMARY_STORE_WRITE_FAILED');
      return stored;
    } finally {
      if (!published) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type {
  EditorialPresentationSpecV1,
  EditorialShowcaseIntentV1,
  EditorialShowcaseManifestV1,
  EditorialShowcaseRenderManifestV1,
} from '../../../../packages/api-contract/editorial-showcase.ts';
import {
  EDITORIAL_MAX_JSON_BYTES,
  EDITORIAL_MAX_MANIFEST_BYTES,
  canonicalJsonBytes,
  hashBytes,
  parseEditorialMaterial,
  type EditorialMaterial,
  type Sha256,
} from './editorial-report-contract.ts';
import { buildEditorialHtmlSourcePacket, type EditorialHtmlSourcePacketV2 } from './editorial-html-source-packet.ts';
import { loadEditorialPresentationBrief } from './editorial-presentation-brief.ts';
import { compileEditorialShowcase } from './editorial-showcase-compiler.ts';
import { loadEditorialShowcaseProfile } from './editorial-showcase-profile.ts';
import { renderEditorialShowcase } from './editorial-showcase-renderer.ts';
import { validateEditorialShowcase, type EditorialShowcaseValidationV1 } from './editorial-showcase-validator.ts';
import { SchemaValidator } from '../schema/validator.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REQUEST_KEY = /^esq_[a-f0-9]{64}$/u;
const PUBLICATION_ID = /^esh_[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLOT = 'showcase-ready';
const FILES = Object.freeze({
  material: 'editorial-material.json',
  sourcePacket: 'editorial-source-packet.json',
  intent: 'editorial-showcase-intent.json',
  spec: 'editorial-presentation-spec.json',
  renderManifest: 'editorial-showcase-render-manifest.json',
  validation: 'editorial-showcase-validation.json',
  html: 'editorial-showcase.html',
  manifest: 'manifest.json',
});
const EXPECTED_FILES = Object.values(FILES).sort();

export interface EditorialShowcaseStorePublishInput {
  taskId: string;
  attemptId: string;
  requestKey: string;
  materialBytes: Uint8Array;
  sourcePacketBytes: Uint8Array;
  intentBytes: Uint8Array;
  specBytes: Uint8Array;
  renderManifestBytes: Uint8Array;
  validationBytes: Uint8Array;
  htmlBytes: Uint8Array;
  manifestBytes: Uint8Array;
  assertStillCurrent(): Promise<void>;
}

export interface EditorialShowcaseStoredPublication {
  slotPath: string;
  reportPath: string;
  manifestPath: string;
  manifest: EditorialShowcaseManifestV1;
  materialBytes: Buffer;
  sourcePacketBytes: Buffer;
  intentBytes: Buffer;
  specBytes: Buffer;
  renderManifestBytes: Buffer;
  validationBytes: Buffer;
  htmlBytes: Buffer;
  manifestBytes: Buffer;
}

export class EditorialShowcaseStoreError extends Error {
  readonly name = 'EditorialShowcaseStoreError';
  constructor(readonly code: 'SHOWCASE_STORE_INVALID' | 'SHOWCASE_STORE_WRITE_FAILED') { super(code); }
}

function fail(code: EditorialShowcaseStoreError['code']): never { throw new EditorialShowcaseStoreError(code); }
function same(left: Uint8Array, right: Uint8Array): boolean { return Buffer.from(left).equals(Buffer.from(right)); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SHOWCASE_STORE_INVALID');
  return value as Record<string, unknown>;
}
function sha(value: unknown): Sha256 {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail('SHOWCASE_STORE_INVALID');
  return value as Sha256;
}

function parseManifest(value: unknown): EditorialShowcaseManifestV1 {
  const item = object(value);
  const required = [
    'version', 'authority', 'status', 'generationMode', 'taskId', 'planVersionId', 'attemptId',
    'requestKey', 'publicationId', 'profileId', 'sourceReportPackage', 'materialHash', 'sourcePacketHash',
    'intentHash', 'specHash', 'profileHash', 'htmlHash', 'renderManifestHash', 'validationHash', 'generatedAt',
  ];
  const keys = Object.keys(item).sort();
  const expected = [...required, ...(item.modelCall === undefined ? [] : ['modelCall'])].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail('SHOWCASE_STORE_INVALID');
  if (
    item.version !== 'universal-editorial-showcase-publication-v1'
    || item.authority !== 'derived'
    || item.status !== 'ready'
    || (item.generationMode !== 'model_intent' && item.generationMode !== 'deterministic_showcase')
    || item.profileId !== 'universal-editorial-showcase-v1'
    || typeof item.taskId !== 'string'
    || typeof item.planVersionId !== 'string'
    || typeof item.attemptId !== 'string'
    || typeof item.requestKey !== 'string'
    || typeof item.publicationId !== 'string'
    || typeof item.generatedAt !== 'string'
    || !UUID.test(item.taskId)
    || !UUID.test(item.planVersionId)
    || !UUID.test(item.attemptId)
    || !REQUEST_KEY.test(item.requestKey)
    || !PUBLICATION_ID.test(item.publicationId)
    || Number.isNaN(Date.parse(item.generatedAt))
  ) fail('SHOWCASE_STORE_INVALID');
  const source = object(item.sourceReportPackage);
  if (
    typeof source.artifactId !== 'string'
    || typeof source.kind !== 'string'
    || typeof source.schemaVersion !== 'string'
  ) fail('SHOWCASE_STORE_INVALID');
  return {
    version: 'universal-editorial-showcase-publication-v1',
    authority: 'derived',
    status: 'ready',
    generationMode: item.generationMode,
    taskId: item.taskId,
    planVersionId: item.planVersionId,
    attemptId: item.attemptId,
    requestKey: item.requestKey,
    publicationId: item.publicationId,
    profileId: 'universal-editorial-showcase-v1',
    sourceReportPackage: {
      artifactId: source.artifactId,
      kind: source.kind,
      schemaVersion: source.schemaVersion,
      contentSha256: sha(source.contentSha256),
    },
    materialHash: sha(item.materialHash),
    sourcePacketHash: sha(item.sourcePacketHash),
    intentHash: sha(item.intentHash),
    specHash: sha(item.specHash),
    profileHash: sha(item.profileHash),
    htmlHash: sha(item.htmlHash),
    renderManifestHash: sha(item.renderManifestHash),
    validationHash: sha(item.validationHash),
    ...(item.modelCall === undefined ? {} : { modelCall: item.modelCall as EditorialShowcaseManifestV1['modelCall'] }),
    generatedAt: item.generatedAt,
  };
}

async function writeOwnerOnly(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', FILE_MODE).catch(() => fail('SHOWCASE_STORE_WRITE_FAILED'));
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, FILE_MODE);
}

export class EditorialShowcaseStore {
  private readonly root: string;
  private readonly validator = new SchemaValidator();

  constructor(root: string) { this.root = resolve(root); }

  private coordinates(input: { taskId: string; attemptId: string; requestKey: string }): string {
    if (!UUID.test(input.taskId) || !UUID.test(input.attemptId) || !REQUEST_KEY.test(input.requestKey)) {
      fail('SHOWCASE_STORE_INVALID');
    }
    return join('tasks', input.taskId, 'attempts', input.attemptId, 'showcase-requests', input.requestKey, SLOT);
  }

  async acquire(input: { taskId: string; attemptId: string; requestKey: string }): Promise<{ release(): Promise<boolean> }> {
    const slotPath = join(this.root, this.coordinates(input));
    const requestPath = dirname(slotPath);
    await mkdir(requestPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(requestPath, DIRECTORY_MODE);
    const lockPath = join(requestPath, '.showcase-lock');
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      await chmod(lockPath, DIRECTORY_MODE);
    } catch {
      fail('SHOWCASE_STORE_WRITE_FAILED');
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
    };
  }): Promise<EditorialShowcaseStoredPublication | null> {
    const slotPath = join(this.root, this.coordinates(input));
    const directory = await lstat(slotPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      fail('SHOWCASE_STORE_INVALID');
    });
    if (directory === null) return null;
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== DIRECTORY_MODE) {
      fail('SHOWCASE_STORE_INVALID');
    }
    const names = (await readdir(slotPath)).sort();
    if (!same(canonicalJsonBytes(names), canonicalJsonBytes(EXPECTED_FILES))) fail('SHOWCASE_STORE_INVALID');
    const readBounded = async (name: string, maximum: number): Promise<Buffer> => {
      const path = join(slotPath, name);
      const info = await lstat(path).catch(() => fail('SHOWCASE_STORE_INVALID'));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== FILE_MODE || info.size > maximum) {
        fail('SHOWCASE_STORE_INVALID');
      }
      const handle = await open(path, 'r');
      try { return await handle.readFile(); } finally { await handle.close(); }
    };
    const [materialBytes, sourcePacketBytes, intentBytes, specBytes, renderManifestBytes, validationBytes, htmlBytes, manifestBytes] = await Promise.all([
      readBounded(FILES.material, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.sourcePacket, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.intent, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.spec, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.renderManifest, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.validation, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.html, EDITORIAL_MAX_JSON_BYTES),
      readBounded(FILES.manifest, EDITORIAL_MAX_MANIFEST_BYTES),
    ]);
    let material: EditorialMaterial;
    let sourcePacket: EditorialHtmlSourcePacketV2;
    let intent: EditorialShowcaseIntentV1 | null;
    let spec: EditorialPresentationSpecV1;
    let renderManifest: EditorialShowcaseRenderManifestV1;
    let validation: EditorialShowcaseValidationV1;
    let manifest: EditorialShowcaseManifestV1;
    try {
      const parsedMaterial = JSON.parse(materialBytes.toString('utf8'));
      const parsedSourcePacket = JSON.parse(sourcePacketBytes.toString('utf8'));
      const parsedIntent = JSON.parse(intentBytes.toString('utf8'));
      const parsedSpec = JSON.parse(specBytes.toString('utf8'));
      const parsedRenderManifest = JSON.parse(renderManifestBytes.toString('utf8'));
      const parsedValidation = JSON.parse(validationBytes.toString('utf8'));
      const parsedManifest = JSON.parse(manifestBytes.toString('utf8'));
      material = parseEditorialMaterial(parsedMaterial);
      sourcePacket = buildEditorialHtmlSourcePacket({
        material, presentationBrief: loadEditorialPresentationBrief().brief,
      }).packet;
      intent = parsedIntent === null ? null : parsedIntent as EditorialShowcaseIntentV1;
      if (intent !== null) this.validator.validateOrThrow('universal-editorial-showcase-intent-v1', intent);
      const compiled = compileEditorialShowcase({ material, sourcePacket, intent });
      spec = compiled.spec;
      const rendered = renderEditorialShowcase({ spec });
      renderManifest = rendered.renderManifest;
      validation = validateEditorialShowcase({ material, sourcePacket, spec, intent, renderResult: rendered });
      manifest = parseManifest(parsedManifest);
      if (
        !same(canonicalJsonBytes(parsedMaterial), materialBytes)
        || !same(canonicalJsonBytes(sourcePacket), sourcePacketBytes)
        || !same(canonicalJsonBytes(intent), intentBytes)
        || !same(canonicalJsonBytes(spec), specBytes)
        || !same(canonicalJsonBytes(renderManifest), renderManifestBytes)
        || !same(canonicalJsonBytes(validation), validationBytes)
        || !same(rendered.htmlBytes, htmlBytes)
        || !same(canonicalJsonBytes(parsedManifest), manifestBytes)
      ) fail('SHOWCASE_STORE_INVALID');
    } catch {
      fail('SHOWCASE_STORE_INVALID');
    }
    const profile = loadEditorialShowcaseProfile();
    if (
      manifest.taskId !== input.taskId
      || manifest.attemptId !== input.attemptId
      || manifest.requestKey !== input.requestKey
      || manifest.taskId !== material.taskId
      || manifest.planVersionId !== material.planVersionId
      || manifest.attemptId !== material.attemptId
      || manifest.sourceReportPackage.artifactId !== material.sourceReportPackage.artifactId
      || manifest.sourceReportPackage.contentSha256 !== material.sourceReportPackage.contentSha256
      || manifest.generationMode !== spec.generationMode
      || manifest.materialHash !== hashBytes(materialBytes)
      || manifest.sourcePacketHash !== hashBytes(sourcePacketBytes)
      || manifest.intentHash !== hashBytes(intentBytes)
      || manifest.specHash !== hashBytes(specBytes)
      || manifest.profileHash !== profile.hash
      || manifest.htmlHash !== hashBytes(htmlBytes)
      || manifest.renderManifestHash !== hashBytes(renderManifestBytes)
      || manifest.validationHash !== hashBytes(validationBytes)
      || validation.verdict !== 'pass'
      || renderManifest.htmlHash !== manifest.htmlHash
      || renderManifest.specHash !== manifest.specHash
      || renderManifest.profileHash !== manifest.profileHash
    ) fail('SHOWCASE_STORE_INVALID');
    if (input.expected && (
      manifest.planVersionId !== input.expected.planVersionId
      || manifest.sourceReportPackage.artifactId !== input.expected.sourceReportPackageId
      || manifest.sourceReportPackage.contentSha256 !== input.expected.sourceReportPackageHash
    )) fail('SHOWCASE_STORE_INVALID');
    return {
      slotPath,
      reportPath: join(slotPath, FILES.html),
      manifestPath: join(slotPath, FILES.manifest),
      manifest,
      materialBytes, sourcePacketBytes, intentBytes, specBytes,
      renderManifestBytes, validationBytes, htmlBytes, manifestBytes,
    };
  }

  async publish(input: EditorialShowcaseStorePublishInput): Promise<EditorialShowcaseStoredPublication> {
    const existing = await this.read(input);
    if (existing) return existing;
    const targetPath = join(this.root, this.coordinates(input));
    const requestPath = dirname(targetPath);
    await mkdir(requestPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(requestPath, DIRECTORY_MODE);
    const stagingPath = join(requestPath, `.showcase-staging-${randomUUID()}`);
    await mkdir(stagingPath, { mode: DIRECTORY_MODE });
    await chmod(stagingPath, DIRECTORY_MODE);
    let published = false;
    try {
      await Promise.all([
        writeOwnerOnly(join(stagingPath, FILES.material), input.materialBytes),
        writeOwnerOnly(join(stagingPath, FILES.sourcePacket), input.sourcePacketBytes),
        writeOwnerOnly(join(stagingPath, FILES.intent), input.intentBytes),
        writeOwnerOnly(join(stagingPath, FILES.spec), input.specBytes),
        writeOwnerOnly(join(stagingPath, FILES.renderManifest), input.renderManifestBytes),
        writeOwnerOnly(join(stagingPath, FILES.validation), input.validationBytes),
        writeOwnerOnly(join(stagingPath, FILES.html), input.htmlBytes),
        writeOwnerOnly(join(stagingPath, FILES.manifest), input.manifestBytes),
      ]);
      await input.assertStillCurrent();
      try {
        await rename(stagingPath, targetPath);
        published = true;
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') fail('SHOWCASE_STORE_WRITE_FAILED');
      }
      if (!published) await rm(stagingPath, { recursive: true, force: true });
      const stored = await this.read(input);
      if (!stored) fail('SHOWCASE_STORE_WRITE_FAILED');
      return stored;
    } finally {
      if (!published) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

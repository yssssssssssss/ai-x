import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EDITORIAL_MAX_JSON_BYTES,
  canonicalJsonBytes,
  canonicalSha256,
  hashBytes,
  parseEditorialMaterial,
} from './report/editorial-report-contract.ts';
import { buildEditorialHtmlSourcePacket } from './report/editorial-html-source-packet.ts';
import { loadEditorialPresentationBrief } from './report/editorial-presentation-brief.ts';
import { compileEditorialShowcase } from './report/editorial-showcase-compiler.ts';
import { renderEditorialShowcase } from './report/editorial-showcase-renderer.ts';
import { validateEditorialShowcase } from './report/editorial-showcase-validator.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface EditorialShowcaseOfflineCliDependencies {
  enabled?: boolean;
  now?: () => Date;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export class EditorialShowcaseOfflineCliError extends Error {
  readonly name = 'EditorialShowcaseOfflineCliError';
  constructor(readonly code:
    | 'SHOWCASE_CLI_ARGUMENT_INVALID'
    | 'SHOWCASE_CLI_INPUT_INVALID'
    | 'SHOWCASE_CLI_OUTPUT_EXISTS'
    | 'SHOWCASE_CLI_WRITE_FAILED') {
    super(code);
  }
}

function parseArgs(args: readonly string[]): { materialPath: string; outputDir: string } {
  const values = args[0] === '--' ? args.slice(1) : [...args];
  if (
    values.length !== 4
    || values[0] !== '--material-path'
    || !values[1]
    || values[2] !== '--output-dir'
    || !values[3]
  ) throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_ARGUMENT_INVALID');
  return { materialPath: resolve(values[1]), outputDir: resolve(values[3]) };
}

async function writeOwnerOnly(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: 'wx', mode: FILE_MODE });
  await chmod(path, FILE_MODE);
}

export async function runEditorialShowcaseOfflineCli(
  args: readonly string[],
  dependencies: EditorialShowcaseOfflineCliDependencies = {},
): Promise<0 | 1> {
  const stdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = dependencies.now ?? (() => new Date());
  let stagingPath: string | undefined;
  try {
    const enabled = dependencies.enabled ?? process.env.EDITORIAL_SHOWCASE_MODE === 'manual';
    if (!enabled) throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_ARGUMENT_INVALID');
    const command = parseArgs(args);
    const sourceStat = await lstat(command.materialPath).catch(() => {
      throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_INPUT_INVALID');
    });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > EDITORIAL_MAX_JSON_BYTES) {
      throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_INPUT_INVALID');
    }
    const sourceBytes = await readFile(command.materialPath);
    let material;
    try {
      material = parseEditorialMaterial(JSON.parse(sourceBytes.toString('utf8')));
    } catch {
      throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_INPUT_INVALID');
    }
    const materialBytes = canonicalJsonBytes(material);
    const sourcePacket = buildEditorialHtmlSourcePacket({
      material,
      presentationBrief: loadEditorialPresentationBrief().brief,
    });
    const compiled = compileEditorialShowcase({ material, sourcePacket: sourcePacket.packet, intent: null });
    const rendered = renderEditorialShowcase({ spec: compiled.spec });
    const validation = validateEditorialShowcase({
      material,
      sourcePacket: sourcePacket.packet,
      spec: compiled.spec,
      renderResult: rendered,
    });
    const validationBytes = canonicalJsonBytes(validation);
    const publicationId = `esh_${canonicalSha256({
      materialHash: hashBytes(materialBytes),
      sourcePacketHash: sourcePacket.hash,
      specHash: compiled.hash,
      htmlHash: rendered.htmlHash,
    }).slice('sha256:'.length)}`;
    const manifest = {
      version: 'editorial-showcase-offline-v1',
      authority: 'derived',
      status: 'ready',
      generationMode: 'deterministic_showcase',
      taskId: material.taskId,
      planVersionId: material.planVersionId,
      attemptId: material.attemptId,
      publicationId,
      profileId: 'universal-editorial-showcase-v1',
      sourceReportPackage: material.sourceReportPackage,
      materialHash: hashBytes(materialBytes),
      sourcePacketHash: sourcePacket.hash,
      specHash: compiled.hash,
      profileHash: rendered.profileHash,
      htmlHash: rendered.htmlHash,
      renderManifestHash: rendered.renderManifestHash,
      validationHash: hashBytes(validationBytes),
      generatedAt: now().toISOString(),
    } as const;

    const targetPath = command.outputDir;
    const existing = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_WRITE_FAILED');
    });
    if (existing !== null) throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_OUTPUT_EXISTS');
    await mkdir(dirname(targetPath), { recursive: true, mode: DIRECTORY_MODE });
    stagingPath = `${targetPath}.staging-${randomUUID()}`;
    await mkdir(stagingPath, { mode: DIRECTORY_MODE });
    await chmod(stagingPath, DIRECTORY_MODE);
    await Promise.all([
      writeOwnerOnly(join(stagingPath, 'editorial-material.json'), materialBytes),
      writeOwnerOnly(join(stagingPath, 'editorial-source-packet.json'), sourcePacket.bytes),
      writeOwnerOnly(join(stagingPath, 'editorial-presentation-spec.json'), compiled.bytes),
      writeOwnerOnly(join(stagingPath, 'editorial-showcase-render-manifest.json'), rendered.renderManifestBytes),
      writeOwnerOnly(join(stagingPath, 'editorial-showcase-validation.json'), validationBytes),
      writeOwnerOnly(join(stagingPath, 'editorial-showcase.html'), rendered.htmlBytes),
      writeOwnerOnly(join(stagingPath, 'manifest.json'), canonicalJsonBytes(manifest)),
    ]);
    await rename(stagingPath, targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_OUTPUT_EXISTS');
      }
      throw new EditorialShowcaseOfflineCliError('SHOWCASE_CLI_WRITE_FAILED');
    });
    stagingPath = undefined;
    stdout(JSON.stringify({
      status: 'ready',
      generationMode: 'deterministic_showcase',
      taskId: material.taskId,
      planVersionId: material.planVersionId,
      attemptId: material.attemptId,
      publicationId,
      reportPath: join(targetPath, 'editorial-showcase.html'),
      manifestPath: join(targetPath, 'manifest.json'),
    }));
    return 0;
  } catch (error) {
    const code = error instanceof EditorialShowcaseOfflineCliError
      ? error.code
      : 'SHOWCASE_CLI_WRITE_FAILED';
    stderr(code);
    return 1;
  } finally {
    if (stagingPath !== undefined) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void runEditorialShowcaseOfflineCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ReportEditorialMaterialV1 } from '../packages/api-contract/report-editorial.ts';
import type { ReportEditorialShowcaseIntentV1 } from '../packages/api-contract/report-editorial-showcase.ts';
import type { EvidenceManifest } from '../packages/api-contract/research-deliverable.ts';
import {
  compileEditorialShowcase,
  createDeterministicEditorialShowcaseSpec,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-renderer.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

interface ShowcaseCliOptions {
  materialPath: string;
  evidencePath: string;
  outputPath: string;
  intentPath?: string;
}

function parseArgs(argv: readonly string[]): ShowcaseCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) {
      throw new Error('Usage: --material <json> --evidence <json> --output <html> [--intent <json>]');
    }
    values.set(flag, value);
  }
  const materialPath = values.get('--material');
  const evidencePath = values.get('--evidence');
  const outputPath = values.get('--output');
  if (!materialPath || !evidencePath || !outputPath) {
    throw new Error('Usage: --material <json> --evidence <json> --output <html> [--intent <json>]');
  }
  return {
    materialPath: resolve(materialPath),
    evidencePath: resolve(evidencePath),
    outputPath: resolve(outputPath),
    ...(values.has('--intent') ? { intentPath: resolve(values.get('--intent')!) } : {}),
  };
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function generateEditorialShowcase(options: ShowcaseCliOptions): Promise<{
  outputPath: string;
  generationMode: 'model' | 'fallback';
  outlineSignature: string;
  htmlBytes: number;
}> {
  const material = await json<ReportEditorialMaterialV1>(options.materialPath);
  const evidenceManifest = await json<EvidenceManifest>(options.evidencePath);
  const validator = new SchemaValidator();
  validator.validateFileOrThrow('schemas/report-editorial-material-v1.schema.json', material);
  const spec = options.intentPath
    ? compileEditorialShowcase(
        material,
        await json<ReportEditorialShowcaseIntentV1>(options.intentPath),
        'model',
      ).spec
    : createDeterministicEditorialShowcaseSpec(material);
  validator.validateFileOrThrow('schemas/editorial-presentation-spec-v1.schema.json', spec);
  const rendered = renderEditorialShowcase({ spec, material, evidenceManifest });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, rendered.html, 'utf8');
  return {
    outputPath: options.outputPath,
    generationMode: spec.generationMode,
    outlineSignature: spec.showcaseOutlineSignature,
    htmlBytes: Buffer.byteLength(rendered.html, 'utf8'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  generateEditorialShowcase(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

import type {
  EditorialPresentationSpecV1,
  EditorialShowcaseIntentV1,
} from '../../../../packages/api-contract/editorial-showcase.ts';
import {
  canonicalJsonBytes,
  EDITORIAL_MAX_JSON_BYTES,
  hashBytes,
  parseEditorialMaterial,
  type EditorialMaterial,
  type Sha256,
} from './editorial-report-contract.ts';
import type { EditorialHtmlSourcePacketV2 } from './editorial-html-source-packet.ts';
import { compileEditorialShowcase } from './editorial-showcase-compiler.ts';
import {
  EDITORIAL_SHOWCASE_CSP,
  renderEditorialShowcase,
  type EditorialShowcaseRenderResult,
} from './editorial-showcase-renderer.ts';

export interface EditorialShowcaseValidationV1 {
  version: 'universal-editorial-showcase-validation-v1';
  verdict: 'pass';
  specHash: Sha256;
  htmlHash: Sha256;
  renderManifestHash: Sha256;
  componentCount: number;
  ownedBodyUnitCount: number;
  promotedSupportingUnitCount: number;
  ownedAuditUnitCount: number;
}

export class EditorialShowcaseValidationError extends Error {
  readonly name = 'EditorialShowcaseValidationError';
  constructor(readonly code: 'SHOWCASE_VALIDATION_FAILED') { super(code); }
}

function fail(): never { throw new EditorialShowcaseValidationError('SHOWCASE_VALIDATION_FAILED'); }
function same(left: Uint8Array, right: Uint8Array): boolean { return Buffer.from(left).equals(Buffer.from(right)); }

function assertShowcaseHtmlSafe(bytes: Uint8Array): void {
  if (bytes.byteLength > EDITORIAL_MAX_JSON_BYTES) fail();
  const source = Buffer.from(bytes);
  const html = source.toString('utf8');
  if (!Buffer.from(html, 'utf8').equals(source)) fail();
  if (
    !/^<!doctype html><html lang="(?:zh-CN|en)">/u.test(html)
    || !html.includes('<meta charset="utf-8">')
    || !html.includes(`content="${EDITORIAL_SHOWCASE_CSP}"`)
    || !html.includes('<meta name="editorial-profile-id" content="universal-editorial-showcase-v1">')
    || /<\/?(?:script|img|picture|iframe|frame|frameset|form|input|button|object|embed|svg|canvas|link|base|audio|video|source|track)\b|<\?xml\b/iu.test(html)
    || /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/iu.test(html)
    || /\son[a-z]+\s*=|\s(?:style|src|srcset|poster|ping|action|formaction)\s*=/iu.test(html)
    || /@import\b|url\s*\(|expression\s*\(/iu.test(html)
  ) fail();
  for (const match of html.matchAll(/\bhref="([^"]*)"/giu)) {
    const href = match[1] ?? '';
    if (href.startsWith('#')) continue;
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') fail();
    } catch {
      fail();
    }
  }
}

export function validateEditorialShowcase(input: {
  material: EditorialMaterial;
  sourcePacket: EditorialHtmlSourcePacketV2;
  spec: EditorialPresentationSpecV1;
  intent?: EditorialShowcaseIntentV1 | null;
  renderResult: EditorialShowcaseRenderResult;
}): EditorialShowcaseValidationV1 {
  const material = parseEditorialMaterial(input.material);
  let compiled: ReturnType<typeof compileEditorialShowcase>;
  let rendered: ReturnType<typeof renderEditorialShowcase>;
  try {
    let intent: EditorialShowcaseIntentV1 | null = null;
    if (input.spec.generationMode === 'model_intent') {
      if (input.intent === undefined || input.intent === null) fail();
      intent = input.intent;
    }
    compiled = compileEditorialShowcase({ material, sourcePacket: input.sourcePacket, intent });
    rendered = renderEditorialShowcase({ spec: compiled.spec });
    assertShowcaseHtmlSafe(input.renderResult.htmlBytes);
  } catch {
    fail();
  }
  const html = input.renderResult.htmlBytes.toString('utf8');
  if (
    !same(compiled.bytes, canonicalJsonBytes(input.spec))
    || !same(rendered.htmlBytes, input.renderResult.htmlBytes)
    || !same(rendered.renderManifestBytes, input.renderResult.renderManifestBytes)
    || hashBytes(input.renderResult.htmlBytes) !== input.renderResult.htmlHash
    || hashBytes(input.renderResult.renderManifestBytes) !== input.renderResult.renderManifestHash
    || input.renderResult.renderManifest.htmlHash !== input.renderResult.htmlHash
    || input.renderResult.renderManifest.specHash !== compiled.hash
    || !html.includes(`content="${EDITORIAL_SHOWCASE_CSP}"`)
    || !html.includes('<meta name="editorial-profile-id" content="universal-editorial-showcase-v1">')
    || /<script|<img|<picture|<svg|<canvas|<iframe|<form|<input|<button|<object|<embed|@import|url\s*\(/iu.test(html)
  ) fail();

  const components = input.spec.sections.flatMap(({ components }) => components);
  const componentIds = components.map(({ id }) => id);
  const ownedMainUnitIds = input.spec.sections
    .filter(({ role }) => role !== 'appendix')
    .flatMap(({ components }) => components.flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const ownedAuditUnitIds = input.spec.sections
    .filter(({ role }) => role === 'appendix')
    .flatMap(({ components }) => components
      .filter(({ kind }) => kind === 'analysis-appendix')
      .flatMap(({ ownedUnitIds }) => ownedUnitIds));
  const visibleUnitIds = [...html.matchAll(/\bdata-showcase-unit-id="([^"]+)"/gu)].map((match) => match[1]!);
  const knownUnitIds = new Set(material.units.map(({ id }) => id));
  if (
    visibleUnitIds.some((id) => !knownUnitIds.has(id))
    || [...ownedMainUnitIds, ...ownedAuditUnitIds].some((id) => !visibleUnitIds.includes(id))
  ) fail();
  if (
    new Set(componentIds).size !== componentIds.length
    || new Set(ownedMainUnitIds).size !== ownedMainUnitIds.length
    || new Set(ownedAuditUnitIds).size !== ownedAuditUnitIds.length
    || input.renderResult.renderManifest.renderedComponents.length !== components.length
    || input.renderResult.renderManifest.renderedComponents.some((entry, index) => {
      const component = components[index];
      return !component
        || entry.componentId !== component.id
        || entry.kind !== component.kind
        || !same(canonicalJsonBytes(entry.ownedUnitIds), canonicalJsonBytes(component.ownedUnitIds))
        || !same(canonicalJsonBytes(entry.sourceUnitIds), canonicalJsonBytes(component.sourceUnitIds));
    })
  ) fail();

  return {
    version: 'universal-editorial-showcase-validation-v1',
    verdict: 'pass',
    specHash: compiled.hash,
    htmlHash: input.renderResult.htmlHash,
    renderManifestHash: input.renderResult.renderManifestHash,
    componentCount: components.length,
    ownedBodyUnitCount: input.spec.requiredBodyUnitIds.length,
    promotedSupportingUnitCount: input.spec.promotedSupportingUnitIds.length,
    ownedAuditUnitCount: ownedAuditUnitIds.length,
  };
}

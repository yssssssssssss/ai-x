import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type { ControlArtifact } from '../database/control-plane.ts';
import type { VerifiedVisualAsset } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
import {
  assertEditorialHtmlSafe,
  formatEditorialRatio,
  renderEditorialReport,
} from '../apps/orchestrator-runtime/src/report/editorial-report-renderer.ts';
import {
  canonicalSha256,
  createEditorialMaterialUnitId,
  EDITORIAL_MAX_JSON_BYTES,
  hashBytes,
  type EditorialBlueprint,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type Sha256,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';

const SOURCE_HASH = `sha256:${'1'.repeat(64)}` as Sha256;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

function unit(input: {
  pointer: string;
  value: string | number | boolean;
  role: EditorialMaterialUnit['role'];
  epistemicStatus?: 'fact' | 'inference' | 'unknown';
  groupId?: string;
  unit?: '/5' | 'ratio' | '个' | '条';
  metricEligible?: boolean;
  basisUnitIds?: string[];
  requiredInBody?: boolean;
}): EditorialMaterialUnit {
  const id = createEditorialMaterialUnitId({
    sourceArtifactId: 'deliverable-1',
    sourceArtifactContentSha256: SOURCE_HASH,
    sourceJsonPointer: input.pointer,
    role: input.role,
    value: input.value,
  });
  const base = {
    id,
    value: input.value,
    metricEligible: input.metricEligible ?? false,
    sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: input.pointer }] as const,
    basisUnitIds: input.basisUnitIds ?? [],
    evidenceIds: input.role === 'claim' && input.epistemicStatus === 'fact' ? ['evidence-1'] : [],
    questionIds: input.role === 'claim' ? ['question-1'] : [],
    requiredInOutput: true,
    requiredInBody: input.requiredInBody ?? true,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.unit ? { unit: input.unit } : {}),
  };
  if (input.role === 'claim') return { ...base, role: 'claim', epistemicStatus: input.epistemicStatus ?? 'inference' };
  if (input.role === 'recommendation') return { ...base, role: 'recommendation', epistemicStatus: 'inference' };
  if (input.role === 'risk' || input.role === 'validation') return { ...base, role: input.role, epistemicStatus: 'unknown' };
  return { ...base, role: input.role };
}

function fixture(): { material: EditorialMaterial; blueprint: EditorialBlueprint } {
  const method = unit({ pointer: '/methodSummary', value: '方法说明', role: 'context', groupId: 'research-plan' });
  const fact = unit({ pointer: '/findingGraph/findings/0/statement', value: '<script>alert("x")</script>', role: 'claim', epistemicStatus: 'fact', groupId: 'research-plan' });
  const inference = unit({ pointer: '/findingGraph/analyses/0/statement', value: '分析判断', role: 'claim', epistemicStatus: 'inference', groupId: 'research-sampling', basisUnitIds: [fact.id] });
  const metric = unit({ pointer: '/payload/competitorSampling/targetCount', value: 5, role: 'context', groupId: 'research-sampling', unit: '个', metricEligible: true });
  const phase = unit({ pointer: '/payload/executionPlan/0/phase', value: '探索', role: 'context', groupId: 'research-phase:0' });
  const activity = unit({ pointer: '/payload/executionPlan/0/activities/0', value: '访谈', role: 'recommendation', groupId: 'research-phase:0', basisUnitIds: [phase.id] });
  const validation = unit({ pointer: '/payload/qualityChecks/0', value: '交叉核验', role: 'validation', groupId: 'validation' });
  const risk = unit({ pointer: '/risksAndOpenIssues/0', value: '仍需验证', role: 'risk', groupId: 'risk' });
  const units = [method, fact, inference, metric, phase, activity, validation, risk];
  const material: EditorialMaterial = {
    version: 'editorial-material-v1', taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    deliverableType: 'research_plan', presentationMode: 'current_text',
    sourceReportPackage: { artifactId: 'package-1', kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: `sha256:${'0'.repeat(64)}` },
    sourceArtifacts: [
      { artifactId: 'package-1', kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: `sha256:${'0'.repeat(64)}` },
      { artifactId: 'deliverable-1', kind: 'deliverable', schemaVersion: 'research-deliverable-v1-review-gated', contentSha256: SOURCE_HASH },
      { artifactId: 'evidence-artifact-1', kind: 'tool_output', schemaVersion: 'tool-output-v1', contentSha256: `sha256:${'2'.repeat(64)}` },
    ],
    materializationWarningCodes: [],
    methodSummaryUnitId: method.id,
    units,
    assets: [],
    evidence: [{ id: 'evidence-1', kind: 'tool_output', evidenceClass: 'public_source', artifactId: 'evidence-artifact-1', artifactContentSha256: `sha256:${'2'.repeat(64)}`, jsonPointer: '/output/value', sensitivity: 'public', redaction: 'none', sourceUrl: 'https://example.com/source' }],
  };
  const copy = (candidate: EditorialMaterialUnit) => ({ text: String(candidate.value), mode: 'verbatim' as const, materialUnitIds: [candidate.id] });
  const blueprint: EditorialBlueprint = {
    version: 'editorial-blueprint-v1', taskId: material.taskId, planVersionId: material.planVersionId,
    attemptId: material.attemptId, requestKey: `erq_${'a'.repeat(64)}`,
    materialHash: canonicalSha256(material), locale: 'zh-CN', deck: copy(method),
    sections: [
      { id: 'decision', role: 'decision', questionIds: ['question-1'], blocks: [
        { id: 'decision-cover', kind: 'decision-cover', summary: copy(fact) },
        { id: 'metrics', kind: 'metric-cards', items: [{ labelKey: 'target-sample-count', valueUnitId: metric.id }] },
        { id: 'truth', kind: 'truth-triad', factIds: [fact.id], inferenceIds: [inference.id], unknownIds: [risk.id, validation.id] },
      ] },
      { id: 'work', role: 'roadmap', questionIds: [], blocks: [
        { id: 'cards', kind: 'card-grid', cards: [{ title: copy(phase), body: copy(activity) }] },
        { id: 'flow', kind: 'flow', steps: [{ label: copy(phase), body: copy(activity) }] },
        { id: 'roadmap', kind: 'roadmap', lanes: [{ label: copy(phase), items: [copy(activity)] }] },
      ] },
      { id: 'risks', role: 'risk', questionIds: [], blocks: [
        { id: 'risk-register', kind: 'risk-register', items: [{ risk: copy(risk) }] },
      ] },
      { id: 'audit', role: 'audit', questionIds: ['question-1'], blocks: [
        { id: 'audit-appendix', kind: 'audit-appendix', unitIds: units.map(({ id }) => id), evidenceIds: ['evidence-1'] },
      ] },
    ],
  };
  return { material, blueprint };
}

function auditUnitFragment(html: string, unitId: string): string {
  const marker = `<article class="audit-unit" data-editorial-unit-id="${unitId}">`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `missing audit Unit ${unitId}`);
  const end = html.indexOf('</article>', start);
  assert.notEqual(end, -1, `unterminated audit Unit ${unitId}`);
  return html.slice(start, end + '</article>'.length);
}

function verifiedPng(
  assetId: string,
  manifestArtifactId: string,
  byte: number,
  derivedFrom?: VerifiedVisualAsset,
): VerifiedVisualAsset {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const contentSha256 = hashBytes(bytes);
  const artifact: ControlArtifact = {
    id: assetId, taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    kind: 'visual_asset', state: 'SEALED', storageUri: `${assetId}.png`, contentSha256,
    byteSize: bytes.byteLength, schemaVersion: 'visual-asset-v1', sensitivity: 'internal',
    redactionPolicyVersion: 'v1', failureReason: null, mediaType: 'image/png',
    metadata: { width: 1, height: 1 },
  };
  const manifestArtifact: ControlArtifact = {
    ...artifact, id: manifestArtifactId, kind: 'visual_asset_manifest',
    storageUri: `${manifestArtifactId}.json`, schemaVersion: 'visual-asset-manifest-v1', mediaType: null,
  };
  return {
    artifact,
    manifestArtifact,
    bytes,
    metadata: { contentType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1 },
    manifest: {
      version: 'visual-asset-manifest-v1', taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
      assetId, contentSha256, mediaType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1,
      exportPolicy: 'allow', source: derivedFrom ? { kind: 'derived' } : { kind: 'user_upload', fileName: `${assetId}.png` },
      derivedFrom: derivedFrom ? {
        assetId: derivedFrom.artifact.id,
        manifestArtifactId: derivedFrom.manifestArtifact.id,
        contentSha256: derivedFrom.artifact.contentSha256!,
        manifestHash: derivedFrom.manifest.manifestHash,
      } : null,
      derivation: derivedFrom ? { kind: 'annotation', overlayArtifactId: 'overlay-1' } : null,
      manifestHash: `sha256:${String(byte).repeat(64)}`,
    },
  } as VerifiedVisualAsset;
}

test('renders fixed professional HTML, escapes source text and records actual block trace', () => {
  const input = fixture();
  const result = renderEditorialReport({ ...input, verifiedVisualAssets: [] });
  const html = result.htmlBytes.toString('utf8');
  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /@page\{size:A4 portrait/u);
  assert.equal(html.includes('<script>alert'), false);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.deepEqual(result.trace.renderedCompositionKinds, [
    'metric-cards', 'truth-triad', 'card-grid', 'flow', 'roadmap',
  ]);
  assert.equal(result.trace.renderedBlocks.at(-1)?.kind, 'audit-appendix');
  assert.deepEqual(result.trace.appendixUnitIds, input.material.units.map(({ id }) => id));
  assertEditorialHtmlSafe(result.htmlBytes);
});

test('places fixed material scale after the decision cover and always renders the fixed footer', () => {
  const input = fixture();
  const result = renderEditorialReport({ ...input, verifiedVisualAssets: [] });
  const html = result.htmlBytes.toString('utf8');
  const decisionIndex = html.indexOf('<div class="block decision-cover">');
  const materialScaleIndex = html.indexOf('<aside class="material-scale" aria-label="材料规模">');
  const businessMetricsIndex = html.indexOf('<div class="block metric-grid">');
  const footerIndex = html.indexOf('<footer class="report-footer" aria-label="报告说明">');
  assert.ok(decisionIndex >= 0 && decisionIndex < materialScaleIndex);
  assert.ok(materialScaleIndex < businessMetricsIndex);
  assert.match(html, /data-editorial-count="units"><strong>8<\/strong><span>Material Units<\/span>/u);
  assert.match(html, /data-editorial-count="evidence"><strong>1<\/strong><span>Evidence 条目<\/span>/u);
  assert.match(html, /data-editorial-count="sources"><strong>3<\/strong><span>冻结源 Artifact<\/span>/u);
  assert.match(html, /data-editorial-count="assets"><strong>0<\/strong><span>视觉 Asset<\/span>/u);
  assert.match(html, /审计计数，不代表研究结论/u);
  assert.ok(footerIndex > html.indexOf('<details class="block audit-details"'));
  assert.doesNotMatch(html, /<details class="block audit-details" open>/u);
  assert.match(html, /<strong>Editorial Report<\/strong> · 本报告为已封存结果的派生呈现，不替代原报告。/u);
  assert.match(html, /Task task-1 · Attempt attempt-1 · Source Report Package package-1 · Renderer editorial-html-v1/u);
  assert.equal(html.match(/class="material-scale"/gu)?.length, 1);
  assert.equal(html.match(/class="report-footer"/gu)?.length, 1);
  assert.deepEqual(result.trace.renderedCompositionKinds, [
    'metric-cards', 'truth-triad', 'card-grid', 'flow', 'roadmap',
  ]);
});

test('audit appendix exposes direct and transitive basis-reachable Evidence IDs in canonical order', () => {
  const input = fixture();
  const fact = input.material.units.find(({ value }) => value === '<script>alert("x")</script>')!;
  const inference = input.material.units.find(({ value }) => value === '分析判断')!;
  const risk = input.material.units.find(({ value }) => value === '仍需验证')!;
  inference.evidenceIds = ['evidence-2'];
  risk.basisUnitIds = [inference.id];
  input.material.evidence.push({
    ...input.material.evidence[0]!,
    id: 'evidence-2',
    sourceUrl: 'https://example.com/source-2',
  });
  const appendix = input.blueprint.sections.at(-1)!.blocks[0]!;
  if (appendix.kind !== 'audit-appendix') throw new Error('fixture audit block is missing');
  appendix.evidenceIds = ['evidence-1', 'evidence-2'];
  input.blueprint.materialHash = canonicalSha256(input.material);

  const result = renderEditorialReport({ ...input, verifiedVisualAssets: [] });
  const html = result.htmlBytes.toString('utf8');
  const factAudit = auditUnitFragment(html, fact.id);
  const riskAudit = auditUnitFragment(html, risk.id);
  assert.match(factAudit, /<strong>直接 Evidence IDs<\/strong>[^<]*<a[^>]*>\[evidence-1\]<\/a>/u);
  assert.match(riskAudit, /<strong>直接 Evidence IDs<\/strong> —/u);
  assert.match(riskAudit, /<strong>Evidence 闭包（直接 \+ Basis 可达）<\/strong>/u);
  const evidence1Index = riskAudit.indexOf('[evidence-1]');
  const evidence2Index = riskAudit.indexOf('[evidence-2]');
  assert.ok(evidence1Index >= 0 && evidence1Index < evidence2Index);
  assertEditorialHtmlSafe(result.htmlBytes);
});

test('ratio formatting is deterministic and does not round through multiplication', () => {
  assert.deepEqual(
    [0, 1, 0.1, 0.29, 1e-7, -0].map(formatEditorialRatio),
    ['0%', '100%', '10%', '29%', '0.00001%', '0%'],
  );
});

test('HTML scanner rejects active content and external image dependencies', () => {
  const document = (body: string, css = '') => Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${css}@page{size:A4 portrait}@media print{}</style></head><body>${body}</body></html>`);
  for (const bytes of [
    document('<script>x</script>'),
    document('<img src="https://example.com/a.png">'),
    document("<img src='https://example.com/a.png'>"),
    document('<img src=https://example.com/a.png>'),
    document('<img srcset="https://example.com/a.png 1x">'),
    document('<link rel="stylesheet" href="https://example.com/a.css">'),
    document('<meta http-equiv="refresh" content="0;url=https://example.com">'),
    document('<p style="background:red">x</p>'),
    document('', '@import "https://example.com/a.css";'),
    document('', 'body{background:url(https://example.com/a.png)}'),
    Buffer.concat([document(''), Buffer.from([0xff])]),
  ]) {
    assert.throws(() => assertEditorialHtmlSafe(bytes), /EDITORIAL_HTML_UNSAFE/);
  }
});

test('HTML safety limit accepts exactly 8 MiB and rejects one additional byte', () => {
  const prefix = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>@page{size:A4 portrait}@media print{}</style></head><body>`;
  const suffix = '</body></html>';
  const paddingBytes = EDITORIAL_MAX_JSON_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(paddingBytes > 0);
  const exact = Buffer.from(`${prefix}${'x'.repeat(paddingBytes)}${suffix}`);

  assert.equal(exact.byteLength, EDITORIAL_MAX_JSON_BYTES);
  assert.doesNotThrow(() => assertEditorialHtmlSafe(exact));
  assert.throws(
    () => assertEditorialHtmlSafe(Buffer.concat([exact, Buffer.from('x')])),
    /SOURCE_NOT_RENDERABLE: HTML exceeds 8 MiB/u,
  );
});

test('HTML scanner ignores attribute-like words in inert body text', () => {
  const input = fixture();
  input.material.units[0]!.value = '排查 src=local、href=note 与 onclick=word 三个文本标记';
  input.material.units[0]!.id = createEditorialMaterialUnitId({
    sourceArtifactId: 'deliverable-1',
    sourceArtifactContentSha256: SOURCE_HASH,
    sourceJsonPointer: input.material.units[0]!.sourceRefs[0]!.jsonPointer,
    role: input.material.units[0]!.role,
    value: input.material.units[0]!.value,
  });
  input.material.methodSummaryUnitId = input.material.units[0]!.id;
  input.blueprint.deck = {
    text: String(input.material.units[0]!.value),
    mode: 'verbatim',
    materialUnitIds: [input.material.units[0]!.id],
  };
  const appendix = input.blueprint.sections.at(-1)!.blocks[0]!;
  if (appendix.kind !== 'audit-appendix') throw new Error('fixture audit block is missing');
  appendix.unitIds[0] = input.material.units[0]!.id;
  input.blueprint.materialHash = canonicalSha256(input.material);

  assert.doesNotThrow(() => renderEditorialReport({ ...input, verifiedVisualAssets: [] }));
});

test('renderer rejects non-public and credential-bearing Evidence URLs', () => {
  const input = fixture();
  const publicUrl = input.material.evidence[0]!.sourceUrl;
  assert.match(
    renderEditorialReport({ ...input, verifiedVisualAssets: [] }).htmlBytes.toString('utf8'),
    /href="https:\/\/example\.com\/source"/u,
  );
  for (const mutate of [
    () => Object.assign(input.material.evidence[0]!, {
      evidenceClass: 'dataset', sensitivity: 'internal', sourceUrl: 'https://example.com/private?token=must-not-escape',
    }),
    () => Object.assign(input.material.evidence[0]!, {
      evidenceClass: 'public_source', sensitivity: 'public', sourceUrl: 'https://user:secret@example.com/source',
    }),
  ]) {
    mutate();
    input.blueprint.materialHash = canonicalSha256(input.material);
    assert.throws(
      () => renderEditorialReport({ ...input, verifiedVisualAssets: [] }),
      /REFERENCE_INTEGRITY/u,
    );
  }
  assert.equal(publicUrl, 'https://example.com/source');
});

test('gallery uses only frozen raster bytes and traces the exported Asset', () => {
  const input = fixture();
  const caption = unit({ pointer: '/sections/0/blocks/0/caption', value: '来源截图', role: 'context', groupId: 'visual', requiredInBody: false });
  const alt = unit({ pointer: '/sections/0/blocks/0/altText', value: '界面截图', role: 'audit', groupId: 'visual', requiredInBody: false });
  input.material.units.push(caption, alt);
  const assetHash = `sha256:${'9'.repeat(64)}` as Sha256;
  input.material.assets.push({ id: 'ema_asset', assetId: 'asset-1', manifestArtifactId: 'asset-manifest-1', visualRole: 'standalone', mediaType: 'image/png', byteSize: 8, width: 1, height: 1, exportPolicy: 'allow', captionUnitId: caption.id, altTextUnitId: alt.id, evidenceIds: [], sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: '/payload/visual/0' }] });
  input.blueprint.sections[1]!.blocks.push({ id: 'gallery', kind: 'visual-gallery', assetIds: ['ema_asset'] });
  const binaryArtifact: ControlArtifact = { id: 'asset-1', taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1', kind: 'visual_asset', state: 'SEALED', storageUri: 'asset.png', contentSha256: assetHash, byteSize: 8, schemaVersion: 'visual-asset-v1', sensitivity: 'internal', redactionPolicyVersion: 'v1', failureReason: null, mediaType: 'image/png', metadata: { width: 1, height: 1 } };
  const manifestArtifact: ControlArtifact = { ...binaryArtifact, id: 'asset-manifest-1', kind: 'visual_asset_manifest', storageUri: 'asset.json', schemaVersion: 'visual-asset-manifest-v1', mediaType: null };
  const result = renderEditorialReport({ ...input, verifiedVisualAssets: [{ artifact: binaryArtifact, manifestArtifact, bytes: Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]), metadata: { contentType: 'image/png', byteSize: 8, width: 1, height: 1 }, manifest: { version: 'visual-asset-manifest-v1', taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1', assetId: 'asset-1', contentSha256: assetHash, mediaType: 'image/png', byteSize: 8, width: 1, height: 1, exportPolicy: 'allow', source: { kind: 'user_upload', fileName: 'asset.png' }, derivedFrom: null, derivation: null, manifestHash: `sha256:${'8'.repeat(64)}` } }] });
  assert.match(result.htmlBytes.toString('utf8'), /data:image\/png;base64,/u);
  assert.deepEqual(result.trace.assetIds, ['ema_asset']);
  assert.deepEqual(result.exportedAssets, [{ assetId: 'asset-1', contentSha256: assetHash }]);
});

test('comparison Assets render as one labelled before-and-after group', () => {
  const input = fixture();
  const caption = unit({ pointer: '/sections/0/blocks/0/caption', value: '入口对比', role: 'context', groupId: 'visual', requiredInBody: false });
  const alt = unit({ pointer: '/sections/0/blocks/0/altText', value: '入口调整前后对比', role: 'audit', groupId: 'visual', requiredInBody: false });
  const before = verifiedPng('asset-before', 'manifest-before', 1);
  const after = verifiedPng('asset-after', 'manifest-after', 2, before);
  input.material.units.push(caption, alt);
  input.material.assets.push({
    id: 'ema_before', assetId: before.artifact.id, manifestArtifactId: before.manifestArtifact.id,
    visualRole: 'comparison-before', comparisonGroupId: 'comparison-1', mediaType: 'image/png',
    byteSize: before.bytes.byteLength, width: 1, height: 1, exportPolicy: 'allow',
    captionUnitId: caption.id, altTextUnitId: alt.id, evidenceIds: [],
    sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: '/payload/visual/0' }],
  }, {
    id: 'ema_after', assetId: after.artifact.id, manifestArtifactId: after.manifestArtifact.id,
    visualRole: 'comparison-after', comparisonGroupId: 'comparison-1',
    derivedFromAssetId: before.artifact.id, mediaType: 'image/png', byteSize: after.bytes.byteLength,
    width: 1, height: 1, exportPolicy: 'allow', captionUnitId: caption.id, altTextUnitId: alt.id,
    evidenceIds: [], sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: '/payload/visual/0' }],
  });
  input.blueprint.sections[1]!.blocks.push({
    id: 'comparison-gallery', kind: 'visual-gallery', assetIds: ['ema_before', 'ema_after'],
  });
  input.blueprint.materialHash = canonicalSha256(input.material);

  const result = renderEditorialReport({ ...input, verifiedVisualAssets: [before, after] });
  const html = result.htmlBytes.toString('utf8');

  assert.match(html, /class="visual-comparison" role="group" aria-label="前后对比"/u);
  assert.match(html, /class="visual-label">优化前<\/span>/u);
  assert.match(html, /class="visual-label">优化后<\/span>/u);
  assert.deepEqual(result.trace.assetIds, ['ema_before', 'ema_after']);
});

test('removes the final image group atomically until escaped HTML fits the 8 MiB limit', () => {
  const input = fixture();
  const longUnit = unit({
    pointer: '/payload/long-copy',
    value: '&'.repeat(16_000),
    role: 'context',
    groupId: 'long-copy',
  });
  input.material.units.push(longUnit);
  input.blueprint.sections[1]!.blocks.unshift({
    id: 'long-copy',
    kind: 'narrative',
    paragraphs: Array.from({ length: 24 }, () => ({
      text: String(longUnit.value),
      mode: 'verbatim' as const,
      materialUnitIds: [longUnit.id],
    })),
  });
  const appendix = input.blueprint.sections.at(-1)!.blocks[0]!;
  if (appendix.kind !== 'audit-appendix') throw new Error('fixture audit block is missing');
  appendix.unitIds.push(longUnit.id);

  const bytes = Buffer.alloc(800 * 1024, 0xab);
  const verifiedVisualAssets: VerifiedVisualAsset[] = [];
  for (let index = 0; index < 6; index += 1) {
    const assetId = `asset-${index}`;
    const manifestArtifactId = `asset-manifest-${index}`;
    const contentSha256 = hashBytes(bytes);
    const comparison = index >= 4;
    input.material.assets.push({
      id: `ema_asset_${index}`,
      assetId,
      manifestArtifactId,
      visualRole: index === 4 ? 'comparison-before' : index === 5 ? 'comparison-after' : 'standalone',
      ...(comparison ? { comparisonGroupId: 'last-pair' } : {}),
      ...(index === 5 ? { derivedFromAssetId: 'asset-4' } : {}),
      mediaType: 'image/png',
      byteSize: bytes.byteLength,
      width: 1,
      height: 1,
      exportPolicy: 'allow',
      captionUnitId: input.material.units[0]!.id,
      altTextUnitId: input.material.units[4]!.id,
      evidenceIds: [],
      sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: `/payload/visual/${index}` }],
    });
    const artifact: ControlArtifact = {
      id: assetId,
      taskId: 'task-1',
      planVersionId: 'plan-1',
      attemptId: 'attempt-1',
      kind: 'visual_asset',
      state: 'SEALED',
      storageUri: `${assetId}.png`,
      contentSha256,
      byteSize: bytes.byteLength,
      schemaVersion: 'visual-asset-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      failureReason: null,
      mediaType: 'image/png',
      metadata: { width: 1, height: 1 },
    };
    const manifestArtifact: ControlArtifact = {
      ...artifact,
      id: manifestArtifactId,
      kind: 'visual_asset_manifest',
      storageUri: `${manifestArtifactId}.json`,
      schemaVersion: 'visual-asset-manifest-v1',
      mediaType: null,
    };
    verifiedVisualAssets.push({
      artifact,
      manifestArtifact,
      bytes,
      metadata: { contentType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1 },
      manifest: {
        version: 'visual-asset-manifest-v1',
        taskId: 'task-1',
        planVersionId: 'plan-1',
        attemptId: 'attempt-1',
        assetId,
        contentSha256,
        mediaType: 'image/png',
        byteSize: bytes.byteLength,
        width: 1,
        height: 1,
        exportPolicy: 'allow',
        source: { kind: 'user_upload', fileName: `${assetId}.png` },
        derivedFrom: null,
        derivation: null,
        manifestHash: `sha256:${String(index).repeat(64)}` as Sha256,
      },
    });
  }
  input.blueprint.sections[1]!.blocks.push({
    id: 'gallery',
    kind: 'visual-gallery',
    assetIds: input.material.assets.map(({ id }) => id),
  });

  const result = renderEditorialReport({ ...input, verifiedVisualAssets });

  assert.ok(result.htmlBytes.byteLength <= 8 * 1024 * 1024);
  assert.deepEqual(result.trace.assetIds, ['ema_asset_0', 'ema_asset_1', 'ema_asset_2', 'ema_asset_3']);
  assert.deepEqual(result.exportedAssets.map(({ assetId }) => assetId), ['asset-0', 'asset-1', 'asset-2', 'asset-3']);
  assert.equal(result.warnings.some(({ code }) => code === 'VISUAL_BUDGET_OMITTED'), true);
});

test('omits an over-budget gallery without leaving empty DOM or trace entries', () => {
  const input = fixture();
  const caption = unit({ pointer: '/sections/0/blocks/0/caption', value: '大图', role: 'context', groupId: 'visual', requiredInBody: false });
  const alt = unit({ pointer: '/sections/0/blocks/0/altText', value: '大图替代文本', role: 'audit', groupId: 'visual', requiredInBody: false });
  const base = verifiedPng('oversized-asset', 'oversized-manifest', 4);
  const bytes = Buffer.alloc((1.5 * 1024 * 1024) + 1, 0xab);
  const contentSha256 = hashBytes(bytes);
  const oversized: VerifiedVisualAsset = {
    ...base,
    bytes,
    artifact: { ...base.artifact, contentSha256, byteSize: bytes.byteLength },
    metadata: { ...base.metadata, byteSize: bytes.byteLength },
    manifest: { ...base.manifest, contentSha256, byteSize: bytes.byteLength },
  };
  input.material.units.push(caption, alt);
  input.material.assets.push({
    id: 'ema_oversized', assetId: oversized.artifact.id,
    manifestArtifactId: oversized.manifestArtifact.id, visualRole: 'standalone', mediaType: 'image/png',
    byteSize: bytes.byteLength, width: 1, height: 1, exportPolicy: 'allow',
    captionUnitId: caption.id, altTextUnitId: alt.id, evidenceIds: [],
    sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: '/payload/visual/0' }],
  });
  input.blueprint.sections[1]!.blocks.push({
    id: 'empty-gallery', kind: 'visual-gallery', assetIds: ['ema_oversized'],
  });
  input.blueprint.materialHash = canonicalSha256(input.material);

  const result = renderEditorialReport({ ...input, verifiedVisualAssets: [oversized] });
  const html = result.htmlBytes.toString('utf8');

  assert.equal(html.includes('<div class="block gallery">'), false);
  assert.equal(result.trace.renderedBlocks.some(({ blockId }) => blockId === 'empty-gallery'), false);
  assert.equal(result.trace.renderedCompositionKinds.includes('visual-gallery'), false);
  assert.deepEqual(result.exportedAssets, []);
  assert.equal(result.warnings.some(({ code }) => code === 'VISUAL_BUDGET_OMITTED'), true);
});

test('real Chromium renders desktop, mobile, keyboard, and A4 print contracts offline', {
  skip: process.env.PLAYWRIGHT_CONTRACT !== '1'
    ? 'set PLAYWRIGHT_CONTRACT=1 in the isolated CI job'
    : false,
}, async () => {
  assert.notEqual(process.geteuid?.(), 0, 'Chromium contract must run with a non-root effective UID');
  const input = fixture();
  const caption = unit({ pointer: '/sections/0/blocks/0/caption', value: '来源截图', role: 'context', groupId: 'visual', requiredInBody: false });
  const alt = unit({ pointer: '/sections/0/blocks/0/altText', value: '报告入口的完整界面截图', role: 'audit', groupId: 'visual', requiredInBody: false });
  const visual = verifiedPng('acceptance-asset', 'acceptance-manifest', 3);
  input.material.units.push(caption, alt);
  input.material.sourceArtifacts.push({
    artifactId: visual.artifact.id,
    kind: visual.artifact.kind,
    schemaVersion: visual.artifact.schemaVersion,
    contentSha256: visual.artifact.contentSha256 as Sha256,
  }, {
    artifactId: visual.manifestArtifact.id,
    kind: visual.manifestArtifact.kind,
    schemaVersion: visual.manifestArtifact.schemaVersion,
    contentSha256: visual.manifestArtifact.contentSha256 as Sha256,
  });
  input.material.assets.push({
    id: 'ema_acceptance', assetId: visual.artifact.id,
    manifestArtifactId: visual.manifestArtifact.id, visualRole: 'standalone', mediaType: 'image/png',
    byteSize: visual.bytes.byteLength, width: 1, height: 1, exportPolicy: 'allow',
    captionUnitId: caption.id, altTextUnitId: alt.id, evidenceIds: [],
    sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: '/payload/visual/0' }],
  });
  input.blueprint.sections[1]!.blocks.push({
    id: 'acceptance-gallery', kind: 'visual-gallery', assetIds: ['ema_acceptance'],
  });
  input.blueprint.materialHash = canonicalSha256(input.material);
  const html = renderEditorialReport({ ...input, verifiedVisualAssets: [visual] }).htmlBytes.toString('utf8');
  const outputRoot = resolve('run-workspaces/editorial-report-acceptance');
  await mkdir(outputRoot, { recursive: true });
  const requests: string[] = [];
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block', acceptDownloads: false, permissions: [],
      viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
    });
    await context.route('**/*', async (route) => {
      requests.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    await page.goto('about:blank');
    await page.setContent(html, { waitUntil: 'load' });

    const assertLayout = async (): Promise<void> => {
      const metrics = await page.evaluate(() => ({
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        rootClientWidth: document.documentElement.clientWidth,
        rootScrollWidth: document.documentElement.scrollWidth,
        missingAlt: Array.from(document.querySelectorAll('img')).filter((image) => !image.alt.trim()).length,
        headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(({ tagName }) => Number(tagName.slice(1))),
      }));
      assert.ok(metrics.bodyScrollWidth <= metrics.bodyClientWidth);
      assert.ok(metrics.rootScrollWidth <= metrics.rootClientWidth);
      assert.equal(metrics.missingAlt, 0);
      assert.equal(metrics.headings[0], 1);
      for (let index = 1; index < metrics.headings.length; index += 1) {
        assert.ok(metrics.headings[index]! - metrics.headings[index - 1]! <= 1);
      }
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'A');
    };

    assert.equal(await page.locator('.rail').evaluate((node) => getComputedStyle(node).position), 'sticky');
    assert.equal(await page.locator('.audit-details').evaluate((node) => (node as HTMLDetailsElement).open), false);
    assert.equal(await page.locator('.audit-list').isVisible(), false);
    await assertLayout();
    await page.screenshot({ path: resolve(outputRoot, 'editorial-desktop-1440x1000.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal(await page.locator('.rail').evaluate((node) => getComputedStyle(node).position), 'static');
    await assertLayout();
    await page.screenshot({ path: resolve(outputRoot, 'editorial-mobile-390x844.png') });

    const auditSummary = page.locator('.audit-details > summary');
    await auditSummary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.audit-details').evaluate((node) => (node as HTMLDetailsElement).open), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.audit-details').evaluate((node) => (node as HTMLDetailsElement).open), false);

    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.audit-details').evaluate((node) => (node as HTMLDetailsElement).open), false);
    assert.equal(await page.locator('.audit-list').isVisible(), true);
    const pdf = await page.pdf({
      path: resolve(outputRoot, 'editorial-a4.pdf'), format: 'A4', printBackground: true,
    });
    assert.ok(pdf.byteLength > 1_000);
    assert.deepEqual(requests, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

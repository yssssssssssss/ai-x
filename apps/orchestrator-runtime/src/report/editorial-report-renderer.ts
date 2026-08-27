import type { VerifiedVisualAsset } from './visual-asset-service.ts';
import {
  computeEligibleCompositionKinds,
  EDITORIAL_MAX_JSON_BYTES,
  EDITORIAL_RENDERER_VERSION,
  createEditorialVisualWarning,
  formatEditorialRatio,
  hashBytes,
  type EditorialBlockKind,
  type EditorialBlueprint,
  type EditorialCompositionKind,
  type EditorialCopy,
  type EditorialDiagnosticIssue,
  type EditorialMaterial,
  type EditorialMaterialAsset,
  type EditorialMaterialUnit,
  type EditorialRenderTrace,
  type EpistemicStatus,
  type Sha256,
} from './editorial-report-contract.ts';

export { formatEditorialRatio } from './editorial-report-contract.ts';

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_EXPORTED_ASSETS = 6;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const BLOCK_KIND_ORDER: EditorialBlockKind[] = [
  'narrative', 'decision-cover', 'metric-cards', 'truth-triad', 'card-grid', 'flow',
  'strategy-matrix', 'roadmap', 'validation-gates', 'risk-register', 'visual-gallery',
  'audit-appendix',
];
const COMPOSITION_KIND_ORDER: EditorialCompositionKind[] = [
  'metric-cards', 'truth-triad', 'card-grid', 'flow', 'strategy-matrix', 'roadmap',
  'validation-gates', 'visual-gallery',
];

const TITLES: Record<EditorialMaterial['deliverableType'], string> = {
  research_plan: '研究计划',
  competitive_analysis_report: '竞品分析报告',
  voc_diagnosis_report: 'VOC 诊断报告',
  design_audit_report: '设计审计报告',
  accessibility_audit_report: '无障碍审计报告',
};

const SECTION_LABELS: Record<EditorialBlueprint['sections'][number]['role'], string> = {
  decision: '核心判断', positioning: '定位', audience: '人群', motivation: '动机',
  journey: '关键链路', strategy: '策略', opportunity: '机会', roadmap: '行动路线',
  validation: '验证计划', risk: '风险与未知', boundary: '适用边界', audit: '证据与审计',
};

const STATUS: Record<EpistemicStatus | 'audit', { className: string; label: string }> = {
  fact: { className: 'fact', label: '已有来源支持' },
  inference: { className: 'inference', label: '分析推断' },
  unknown: { className: 'unknown', label: '未知／待验证' },
  audit: { className: 'audit', label: '来源审计' },
};

const CSS = `
:root{--paper:#f3f0e9;--surface:#fffdf9;--ink:#191817;--muted:#716b66;--accent:#e1251b;--hero:#273038;--line:#ded8ce;--fact:#247357;--fact-bg:#e4f2ec;--inference:#a96506;--inference-bg:#fff1d6;--unknown:#a91610;--unknown-bg:#fde9e6;--audit:#315f82;--audit-bg:#e7f0f6;--radius:18px;--shadow:0 18px 54px rgba(48,38,30,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--paper);font:16px/1.68 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--audit);overflow-wrap:anywhere}.layout{display:grid;grid-template-columns:226px minmax(0,1fr);gap:34px;max-width:1500px;margin:auto;padding:28px}.rail{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow:auto}.rail strong{display:block;margin-bottom:10px;font-size:13px;letter-spacing:.08em}.rail a{display:block;padding:6px 0;color:var(--muted);text-decoration:none}.content{min-width:0}.hero{padding:42px;border-radius:24px;color:#fff;background:var(--hero);box-shadow:var(--shadow)}.eyebrow{color:#ffb4ae;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{margin:.15em 0;font-size:clamp(40px,5.7vw,78px);line-height:1.04}.hero-deck{max-width:72ch;color:#eee7df}.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.status{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font-size:12px;font-weight:800}.status.fact{color:var(--fact);background:var(--fact-bg)}.status.inference{color:var(--inference);background:var(--inference-bg)}.status.unknown{color:var(--unknown);background:var(--unknown-bg)}.status.audit{color:var(--audit);background:var(--audit-bg)}.panel{margin-top:24px;padding:28px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow)}.section-no{color:var(--accent);font-size:12px;font-weight:900;letter-spacing:.1em}.panel h2{margin:.15em 0 .4em;font-size:30px;line-height:1.15}.panel h3{font-size:18px}.lead{max-width:72ch;color:var(--muted)}.block{margin-top:20px}.decision-cover{padding:22px;border-left:5px solid var(--accent);background:#faf8f3}.boundary{margin-top:12px;color:var(--unknown)}.material-scale{margin-top:18px;padding:18px;border:1px solid var(--line);border-radius:12px;background:#f8f2ef}.material-scale-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 18px}.material-scale-head span{color:var(--muted);font-size:12px}.material-count-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:12px}.material-count{padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.material-count strong{display:block;font-size:28px;line-height:1.1}.material-count span{color:var(--muted);font-size:12px}.metric-grid,.card-grid,.truth-grid,.roadmap-grid,.gate-grid,.risk-grid,.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.visual-comparison{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.visual-label{display:block;margin-bottom:10px;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.08em}.metric,.card,.truth,.lane,.gate,.risk-card,figure{margin:0;padding:18px;border:1px solid var(--line);border-radius:12px;background:#faf8f3}.metric strong{display:block;font-size:30px;line-height:1.15}.metric span{color:var(--muted);font-size:13px}.truth.fact{background:var(--fact-bg)}.truth.inference{background:var(--inference-bg)}.truth.unknown{background:var(--unknown-bg)}.flow{display:grid;gap:12px;counter-reset:step}.flow-step{position:relative;padding:16px 16px 16px 54px;border-left:3px solid var(--accent);background:#faf8f3}.flow-step:before{counter-increment:step;content:counter(step);position:absolute;left:14px;top:14px;width:26px;height:26px;display:grid;place-items:center;border-radius:50%;color:#fff;background:var(--accent);font-weight:800}.matrix{width:100%;border-collapse:collapse}.matrix th,.matrix td{padding:12px;border:1px solid var(--line);vertical-align:top;text-align:left}.matrix thead th{color:#fff;background:var(--hero)}.matrix tbody th{background:#f8f2ef}.lane{border-top:5px solid var(--accent)}.gate{border-top:4px solid var(--audit)}.risk-card{border-left:4px solid var(--unknown)}figure img{display:block;width:100%;height:auto;border-radius:8px}figcaption{margin-top:8px;color:var(--muted);font-size:13px}.audit-details summary{cursor:pointer;font-weight:800}.audit-list{display:grid;gap:10px;margin-top:14px}.audit-unit{padding:12px;border-left:3px solid var(--audit);background:var(--audit-bg);overflow-wrap:anywhere}.audit-meta{color:var(--muted);font-size:12px}.audit-evidence{margin-top:4px}.audit-evidence-id{font-weight:700}.source-ref{font-size:11px;vertical-align:super}.provenance{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.report-footer{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 18px;margin-top:24px;padding:18px 4px 4px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.report-footer p{margin:0}.report-footer-meta{overflow-wrap:anywhere}p{max-width:72ch}ul{padding-left:1.25em}
@media(max-width:1080px){.layout{grid-template-columns:1fr}.rail{position:static;max-height:none;display:flex;flex-wrap:wrap;gap:0 14px}.rail strong{width:100%}}
@media(max-width:680px){.layout{padding:12px}.hero,.panel{padding:20px;border-radius:14px}.metric-grid,.card-grid,.truth-grid,.roadmap-grid,.gate-grid,.risk-grid,.gallery,.visual-comparison{grid-template-columns:1fr}.matrix-wrap{overflow-x:auto}}
@page{size:A4 portrait;margin:14mm}@media print{body{background:#fff}.layout{display:block;max-width:none;padding:0}.rail{display:none}.hero,.panel{box-shadow:none;break-inside:auto}.block,.material-scale,.material-count,.metric,.card,.truth,.lane,.gate,.risk-card,.visual-comparison,figure,tr,.report-footer{break-inside:avoid}.audit-details::details-content{content-visibility:visible!important}.audit-details>summary{display:none}.audit-details>.audit-list{display:grid!important}a{color:var(--ink);text-decoration:underline}.hero{color:var(--ink);background:#fff;border:2px solid var(--ink)}.hero-deck{color:var(--muted)}}`;

export class EditorialRendererError extends Error {
  readonly name = 'EditorialRendererError';

  constructor(
    readonly code: 'EDITORIAL_HTML_UNSAFE' | 'EDITORIAL_RENDER_TRACE_INVALID' | 'SOURCE_NOT_RENDERABLE',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface EditorialRenderResult {
  htmlBytes: Buffer;
  trace: EditorialRenderTrace;
  exportedAssets: Array<{ assetId: string; contentSha256: Sha256 }>;
  warnings: EditorialDiagnosticIssue[];
}

export interface EditorialRenderableVisualAsset {
  artifact: Pick<VerifiedVisualAsset['artifact'], 'id'>;
  manifestArtifact: Pick<VerifiedVisualAsset['manifestArtifact'], 'id'>;
  bytes: Buffer;
  manifest: Pick<VerifiedVisualAsset['manifest'], 'contentSha256'>;
}

type RendererVisualAsset = VerifiedVisualAsset | EditorialRenderableVisualAsset;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scalarText(value: string | number | boolean): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function displayUnit(unit: EditorialMaterialUnit): string {
  const value = typeof unit.value === 'number' && unit.unit === 'ratio'
    ? formatEditorialRatio(unit.value)
    : scalarText(unit.value);
  if (unit.unit === undefined || unit.unit === 'ratio') return value;
  return `${value}${unit.unit}`;
}

function unitStatus(unit: EditorialMaterialUnit): EpistemicStatus | 'audit' {
  if (unit.role === 'risk' || unit.role === 'validation') return 'unknown';
  if (unit.role === 'claim' || unit.role === 'recommendation') return unit.epistemicStatus;
  return 'audit';
}

function conservativeStatus(units: readonly EditorialMaterialUnit[]): EpistemicStatus | 'audit' {
  const statuses = units.map(unitStatus);
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('inference')) return 'inference';
  if (statuses.includes('fact')) return 'fact';
  return 'audit';
}

function statusBadge(status: EpistemicStatus | 'audit'): string {
  const item = STATUS[status];
  return `<span class="status ${item.className}">${item.label}</span>`;
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function visualKey(assetId: string, manifestArtifactId: string): string {
  return `${assetId}\u0000${manifestArtifactId}`;
}

function renderMaterialScale(material: EditorialMaterial): string {
  const counts = [
    { key: 'units', value: material.units.length, label: 'Material Units' },
    { key: 'evidence', value: material.evidence.length, label: 'Evidence 条目' },
    { key: 'sources', value: material.sourceArtifacts.length, label: '冻结源 Artifact' },
    { key: 'assets', value: material.assets.length, label: '视觉 Asset' },
  ];
  return `<aside class="material-scale" aria-label="材料规模"><div class="material-scale-head"><strong>材料规模</strong><span>审计计数，不代表研究结论</span></div><div class="material-count-grid">${counts.map(({ key, value, label }) => `<div class="material-count" data-editorial-count="${key}"><strong>${String(value)}</strong><span>${label}</span></div>`).join('')}</div></aside>`;
}

function renderFooter(material: EditorialMaterial): string {
  return `<footer class="report-footer" aria-label="报告说明"><p><strong>Editorial Report</strong> · 本报告为已封存结果的派生呈现，不替代原报告。</p><p class="report-footer-meta">Task ${escapeHtml(material.taskId)} · Attempt ${escapeHtml(material.attemptId)} · Source Report Package ${escapeHtml(material.sourceReportPackage.artifactId)} · Renderer ${EDITORIAL_RENDERER_VERSION}</p></footer>`;
}

function selectedVisuals(
  material: EditorialMaterial,
  verifiedVisualAssets: ReadonlyArray<RendererVisualAsset>,
): { selected: Map<string, RendererVisualAsset>; exportedAssets: EditorialRenderResult['exportedAssets']; warnings: EditorialDiagnosticIssue[] } {
  const verified = new Map(verifiedVisualAssets.map((asset) => [visualKey(asset.artifact.id, asset.manifestArtifact.id), asset]));
  const selected = new Map<string, RendererVisualAsset>();
  const exportedAssets: EditorialRenderResult['exportedAssets'] = [];
  const warnings: EditorialDiagnosticIssue[] = [];
  let totalBytes = 0;
  const byGroup = new Map<string, EditorialMaterialAsset[]>();
  const groups: EditorialMaterialAsset[][] = [];
  for (const asset of material.assets) {
    if (asset.comparisonGroupId) {
      const group = byGroup.get(asset.comparisonGroupId);
      if (group) group.push(asset);
      else {
        const next = [asset];
        byGroup.set(asset.comparisonGroupId, next);
        groups.push(next);
      }
    } else groups.push([asset]);
  }
  for (const group of groups) {
    const resolved = group.map((asset) => ({
      material: asset,
      verified: verified.get(visualKey(asset.assetId, asset.manifestArtifactId)),
    }));
    if (resolved.some(({ verified: item }) => item === undefined)) {
      throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'Material Asset has no frozen verified bytes');
    }
    if (group[0]?.comparisonGroupId && (
      group.length !== 2
      || group[0]?.visualRole !== 'comparison-before'
      || group[1]?.visualRole !== 'comparison-after'
    )) {
      throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'comparison Asset group is incomplete or out of order');
    }
    const groupBytes = resolved.reduce((sum, item) => sum + item.verified!.bytes.byteLength, 0);
    const wouldExceed = resolved.some((item) => item.verified!.bytes.byteLength > MAX_IMAGE_BYTES)
      || totalBytes + groupBytes > MAX_TOTAL_IMAGE_BYTES
      || exportedAssets.length + group.length > MAX_EXPORTED_ASSETS;
    if (wouldExceed) {
      warnings.push(createEditorialVisualWarning('VISUAL_BUDGET_OMITTED'));
      continue;
    }
    resolved.forEach(({ material: asset, verified: item }) => {
      selected.set(asset.id, item!);
      exportedAssets.push({ assetId: asset.assetId, contentSha256: item!.manifest.contentSha256 as Sha256 });
    });
    totalBytes += groupBytes;
  }
  return { selected, exportedAssets, warnings };
}

function renderOnce(input: {
  material: EditorialMaterial;
  blueprint: EditorialBlueprint;
  selected: ReadonlyMap<string, RendererVisualAsset>;
  warnings: EditorialDiagnosticIssue[];
}): EditorialRenderResult {
  const { material, blueprint, selected } = input;
  const units = new Map(material.units.map((unit) => [unit.id, unit]));
  const assets = new Map(material.assets.map((asset) => [asset.id, asset]));
  const evidence = new Map(material.evidence.map((entry) => [entry.id, entry]));
  const body = new Set<string>();
  const appendix: string[] = [];
  const tracedAssets = new Set<string>();
  const renderedBlocks: EditorialRenderTrace['renderedBlocks'] = [];

  const resolveUnits = (ids: readonly string[]): EditorialMaterialUnit[] => ids.map((id) => {
    const unit = units.get(id);
    if (!unit) throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', `Blueprint references unknown Unit ${id}`);
    return unit;
  });
  const resolveEvidence = (id: string) => {
    const entry = evidence.get(id);
    if (!entry) throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', `Unit references unknown Evidence ${id}`);
    return entry;
  };
  const evidenceReference = (id: string, className: 'source-ref' | 'audit-evidence-id'): string => {
    const entry = resolveEvidence(id);
    const url = entry.evidenceClass === 'public_source' && entry.sensitivity === 'public'
      ? safeHttpsUrl(entry.sourceUrl)
      : null;
    const label = escapeHtml(id);
    return url
      ? `<a class="${className}" href="${escapeHtml(url)}" rel="noopener noreferrer">[${label}]</a>`
      : `<span class="${className}">[${label}]</span>`;
  };
  const citations = (referenced: readonly EditorialMaterialUnit[]): string => {
    const ids = [...new Set(referenced.flatMap((unit) => unit.evidenceIds))];
    return ids.map((id) => evidenceReference(id, 'source-ref')).join('');
  };
  const reachableEvidenceIds = (root: EditorialMaterialUnit): string[] => {
    const reachable = new Set<string>();
    const complete = new Set<string>();
    const active = new Set<string>();
    const visit = (unit: EditorialMaterialUnit): void => {
      if (complete.has(unit.id)) return;
      if (active.has(unit.id)) {
        throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', `Material basis graph contains a cycle at Unit ${unit.id}`);
      }
      active.add(unit.id);
      for (const evidenceId of unit.evidenceIds) {
        resolveEvidence(evidenceId);
        reachable.add(evidenceId);
      }
      resolveUnits(unit.basisUnitIds).forEach(visit);
      active.delete(unit.id);
      complete.add(unit.id);
    };
    visit(root);
    return material.evidence.filter(({ id }) => reachable.has(id)).map(({ id }) => id);
  };
  const auditEvidence = (ids: readonly string[]): string => {
    if (ids.length === 0) return '—';
    return ids.map((id) => evidenceReference(id, 'audit-evidence-id')).join(' ');
  };
  const renderCopy = (copy: EditorialCopy): string => {
    const referenced = resolveUnits(copy.materialUnitIds);
    referenced.forEach(({ id }) => body.add(id));
    return `<span>${escapeHtml(copy.text)}</span>${citations(referenced)}`;
  };
  const renderUnitItem = (id: string): string => {
    const unit = resolveUnits([id])[0]!;
    body.add(id);
    return `<li>${statusBadge(unitStatus(unit))}<span>${escapeHtml(displayUnit(unit))}</span>${citations([unit])}</li>`;
  };
  const renderVisual = (asset: EditorialMaterialAsset, label?: '优化前' | '优化后'): string => {
    const verified = selected.get(asset.id);
    if (!verified) return '';
    const caption = resolveUnits([asset.captionUnitId])[0]!;
    const alt = resolveUnits([asset.altTextUnitId])[0]!;
    body.add(caption.id);
    body.add(alt.id);
    tracedAssets.add(asset.id);
    const mime = asset.mediaType;
    const src = `data:${mime};base64,${verified.bytes.toString('base64')}`;
    return `<figure>${label ? `<span class="visual-label">${label}</span>` : ''}<img data-editorial-asset-id="${escapeHtml(asset.assetId)}" src="${src}" alt="${escapeHtml(scalarText(alt.value))}"><figcaption>${escapeHtml(scalarText(caption.value))}${citations([caption, alt])}</figcaption></figure>`;
  };

  const blockHtml = (block: EditorialBlueprint['sections'][number]['blocks'][number]): string => {
    switch (block.kind) {
      case 'narrative':
        return `<div class="block narrative">${block.paragraphs.map((paragraph) => `<p>${renderCopy(paragraph)}</p>`).join('')}</div>`;
      case 'decision-cover': {
        const referenced = resolveUnits(block.summary.materialUnitIds);
        return `<div class="block decision-cover">${statusBadge(conservativeStatus(referenced))}<p>${renderCopy(block.summary)}</p>${block.boundary ? `<p class="boundary">${renderCopy(block.boundary)}</p>` : ''}<p class="provenance">本报告为已封存结果的派生呈现，不替代原报告。</p></div>`;
      }
      case 'metric-cards':
        return `<div class="block metric-grid">${block.items.map((item) => {
          const unit = resolveUnits([item.valueUnitId])[0]!;
          body.add(unit.id);
          const label = item.labelKey === 'target-sample-count' ? '目标样本数' : renderCopy(item.label);
          return `<article class="metric">${statusBadge(unitStatus(unit))}<strong>${escapeHtml(displayUnit(unit))}</strong><span>${label}</span>${citations([unit])}</article>`;
        }).join('')}</div>`;
      case 'truth-triad':
        return `<div class="block truth-grid"><article class="truth fact"><h3>已有来源支持</h3><ul>${block.factIds.map(renderUnitItem).join('')}</ul></article><article class="truth inference"><h3>分析推断</h3><ul>${block.inferenceIds.map(renderUnitItem).join('')}</ul></article><article class="truth unknown"><h3>未知／待验证</h3><ul>${block.unknownIds.map(renderUnitItem).join('')}</ul></article></div>`;
      case 'card-grid':
        return `<div class="block card-grid">${block.cards.map((card) => {
          const referenced = resolveUnits([...card.title.materialUnitIds, ...card.body.materialUnitIds]);
          return `<article class="card">${statusBadge(conservativeStatus(referenced))}<h3>${renderCopy(card.title)}</h3><p>${renderCopy(card.body)}</p></article>`;
        }).join('')}</div>`;
      case 'flow':
        return `<div class="block flow">${block.steps.map((step) => `<article class="flow-step"><strong>${renderCopy(step.label)}</strong><p>${renderCopy(step.body)}</p></article>`).join('')}</div>`;
      case 'strategy-matrix':
        return `<div class="block matrix-wrap"><table class="matrix"><thead><tr><th scope="col">维度</th>${block.columns.map((column) => `<th scope="col">${renderCopy(column)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr><th scope="row">${renderCopy(row.label)}</th>${row.cells.map((cell) => `<td>${renderCopy(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'roadmap':
        return `<div class="block roadmap-grid">${block.lanes.map((lane) => `<article class="lane"><h3>${renderCopy(lane.label)}</h3><ul>${lane.items.map((item) => `<li>${renderCopy(item)}</li>`).join('')}</ul></article>`).join('')}</div>`;
      case 'validation-gates':
        return `<div class="block gate-grid">${block.gates.map((gate) => `<article class="gate"><h3>${renderCopy(gate.label)}</h3><p><strong>方法：</strong>${renderCopy(gate.method)}</p>${gate.successCriterion ? `<p><strong>成功标准：</strong>${renderCopy(gate.successCriterion)}</p>` : ''}</article>`).join('')}</div>`;
      case 'risk-register':
        return `<div class="block risk-grid">${block.items.map((item) => `<article class="risk-card">${statusBadge('unknown')}<h3>${renderCopy(item.risk)}</h3>${item.impact ? `<p><strong>影响：</strong>${renderCopy(item.impact)}</p>` : ''}${item.response ? `<p><strong>响应：</strong>${renderCopy(item.response)}</p>` : ''}</article>`).join('')}</div>`;
      case 'visual-gallery': {
        const rendered: string[] = [];
        for (let index = 0; index < block.assetIds.length; index += 1) {
          const id = block.assetIds[index]!;
          const asset = assets.get(id);
          if (!asset) throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', `Blueprint references unknown Asset ${id}`);
          if (asset.visualRole === 'comparison-before') {
            const afterId = block.assetIds[index + 1];
            const after = afterId === undefined ? undefined : assets.get(afterId);
            if (!after || after.visualRole !== 'comparison-after' || after.comparisonGroupId !== asset.comparisonGroupId) {
              throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'comparison Asset group is incomplete or out of order');
            }
            const beforeHtml = renderVisual(asset, '优化前');
            const afterHtml = renderVisual(after, '优化后');
            if (beforeHtml && afterHtml) {
              rendered.push(`<div class="visual-comparison" role="group" aria-label="前后对比">${beforeHtml}${afterHtml}</div>`);
            }
            index += 1;
          } else if (asset.visualRole === 'comparison-after') {
            throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'comparison-after cannot render without its preceding before Asset');
          } else {
            const html = renderVisual(asset);
            if (html) rendered.push(html);
          }
        }
        return rendered.length === 0 ? '' : `<div class="block gallery">${rendered.join('')}</div>`;
      }
      case 'audit-appendix': {
        const items = block.unitIds.map((id) => {
          const unit = resolveUnits([id])[0]!;
          appendix.push(id);
          const pointers = unit.sourceRefs.map((ref) => `${ref.artifactId}${ref.jsonPointer}`).join(', ');
          const evidenceClosure = reachableEvidenceIds(unit);
          return `<article class="audit-unit" data-editorial-unit-id="${escapeHtml(unit.id)}">${statusBadge(unitStatus(unit))}<div>${escapeHtml(displayUnit(unit))}${citations([unit])}</div><div class="audit-meta">Unit ${escapeHtml(unit.id)} · Source ${escapeHtml(pointers)} · Basis ${escapeHtml(unit.basisUnitIds.join(', ') || '—')} · Question ${escapeHtml(unit.questionIds.join(', ') || '—')}</div><div class="audit-meta audit-evidence"><strong>直接 Evidence IDs</strong> ${auditEvidence(unit.evidenceIds)} · <strong>Evidence 闭包（直接 + Basis 可达）</strong> ${auditEvidence(evidenceClosure)}</div></article>`;
        }).join('');
        return `<details class="block audit-details"><summary>完整证据与追溯</summary><div class="audit-list">${items}</div></details>`;
      }
    }
  };

  const title = blueprint.title?.text ?? TITLES[material.deliverableType];
  const nav = blueprint.sections.map((section) => `<a href="#${section.id}">${escapeHtml(section.title?.text ?? SECTION_LABELS[section.role])}</a>`).join('');
  const sections = blueprint.sections.map((section, sectionIndex) => {
    const blocks = section.blocks.map((block) => {
      const html = blockHtml(block);
      if (html) renderedBlocks.push({ blockId: block.id, kind: block.kind });
      return html && block.kind === 'decision-cover' ? `${html}${renderMaterialScale(material)}` : html;
    }).join('');
    const sectionTitle = section.title ? renderCopy(section.title) : escapeHtml(SECTION_LABELS[section.role]);
    const lead = section.lead ? `<p class="lead">${renderCopy(section.lead)}</p>` : '';
    return `<section class="panel" id="${section.id}"><div class="section-no">${String(sectionIndex + 1).padStart(2, '0')}</div><h2>${sectionTitle}</h2>${lead}${blocks}</section>`;
  }).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><div class="layout"><nav class="rail" aria-label="报告目录"><strong>报告目录</strong>${nav}</nav><main class="content"><header class="hero"><div class="eyebrow">Editorial · ${EDITORIAL_RENDERER_VERSION}</div><h1>${escapeHtml(title)}</h1><p class="hero-deck">${renderCopy(blueprint.deck)}</p><div class="legend">${statusBadge('fact')}${statusBadge('inference')}${statusBadge('unknown')}</div></header>${sections}${renderFooter(material)}</main></div></body></html>`;
  const htmlBytes = Buffer.from(html, 'utf8');
  const renderedKindSet = new Set(renderedBlocks.map(({ kind }) => kind));
  const renderedBlockKinds = BLOCK_KIND_ORDER.filter((kind) => renderedKindSet.has(kind));
  const renderedCompositionKinds = COMPOSITION_KIND_ORDER.filter((kind) => renderedKindSet.has(kind));
  const orderedBody = material.units.filter(({ id }) => body.has(id)).map(({ id }) => id);
  const orderedAssets = material.assets.filter(({ id }) => tracedAssets.has(id));
  const selectedResult = orderedAssets.map((asset) => ({
    assetId: asset.assetId,
    contentSha256: selected.get(asset.id)!.manifest.contentSha256 as Sha256,
  }));
  return {
    htmlBytes,
    trace: {
      bodyUnitIds: orderedBody,
      appendixUnitIds: appendix,
      assetIds: orderedAssets.map(({ id }) => id),
      renderedBlocks,
      renderedBlockKinds,
      eligibleCompositionKinds: computeEligibleCompositionKinds(material, [...tracedAssets]),
      renderedCompositionKinds,
    },
    exportedAssets: selectedResult,
    warnings: input.warnings,
  };
}

export function assertEditorialHtmlSafe(bytes: Uint8Array): void {
  if (bytes.byteLength > EDITORIAL_MAX_JSON_BYTES) {
    throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'HTML exceeds 8 MiB');
  }
  const sourceBytes = Buffer.from(bytes);
  const html = sourceBytes.toString('utf8');
  if (!Buffer.from(html, 'utf8').equals(sourceBytes)) {
    throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'HTML is not valid UTF-8');
  }
  const required = [
    '<!doctype html>', '<html lang="zh-CN">', '<meta charset="utf-8">',
    '<meta name="viewport"', `content="${CSP}"`, '@page{size:A4 portrait', '@media print',
  ];
  if (required.some((value) => !html.includes(value))) {
    throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'required self-contained HTML policy is missing');
  }
  if (
    /<\/?(?:script|iframe|frame|frameset|form|object|embed|svg|link|base|audio|video|source|track)\b|<\?xml\b/iu.test(html)
    || /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/iu.test(html)
  ) {
    throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'forbidden active HTML content was emitted');
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    if (/@import\b|url\s*\(|expression\s*\(/iu.test(match[1] ?? '')) {
      throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'stylesheet contains an external or active dependency');
    }
  }
  const startTags = [...html.matchAll(/<[a-z][^>]*>/giu)].map(([tag]) => tag);
  if (startTags.some((tag) => /\son[a-z]+\s*=|\s(?:style|srcset|poster|ping|action|formaction)\s*=/iu.test(tag))) {
    throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'forbidden active HTML content was emitted');
  }
  const sourceAttributes = startTags.flatMap((tag) => [...tag.matchAll(/\bsrc\s*=/giu)]);
  const quotedSources = startTags.flatMap((tag) => [...tag.matchAll(/\bsrc="([^"]*)"/giu)]);
  if (sourceAttributes.length !== quotedSources.length) {
    throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'image source attributes must use the fixed quoted form');
  }
  for (const match of quotedSources) {
    if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(match[1] ?? '')) {
      throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'non-raster or external image source was emitted');
    }
  }
  const hrefAttributes = startTags.flatMap((tag) => [...tag.matchAll(/\bhref\s*=/giu)]);
  const quotedHrefs = startTags.flatMap((tag) => [...tag.matchAll(/\bhref="([^"]*)"/giu)]);
  if (hrefAttributes.length !== quotedHrefs.length) {
    throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'link attributes must use the fixed quoted form');
  }
  for (const match of quotedHrefs) {
    const href = match[1] ?? '';
    if (!href.startsWith('#') && safeHttpsUrl(href) === null) {
      throw new EditorialRendererError('EDITORIAL_HTML_UNSAFE', 'non-HTTPS external link was emitted');
    }
  }
}

export function renderEditorialReport(input: {
  material: EditorialMaterial;
  blueprint: EditorialBlueprint;
  verifiedVisualAssets: ReadonlyArray<RendererVisualAsset>;
}): EditorialRenderResult {
  const selection = selectedVisuals(input.material, input.verifiedVisualAssets);
  let result = renderOnce({ ...input, selected: selection.selected, warnings: selection.warnings });
  while (result.htmlBytes.byteLength > EDITORIAL_MAX_JSON_BYTES && selection.selected.size > 0) {
    const lastSelected = [...input.material.assets]
      .reverse()
      .find((asset) => selection.selected.has(asset.id));
    if (!lastSelected) break;
    const omittedIds = lastSelected.comparisonGroupId === undefined
      ? [lastSelected.id]
      : input.material.assets
        .filter(({ comparisonGroupId }) => comparisonGroupId === lastSelected.comparisonGroupId)
        .map(({ id }) => id);
    omittedIds.forEach((id) => selection.selected.delete(id));
    selection.warnings.push(createEditorialVisualWarning('VISUAL_BUDGET_OMITTED'));
    result = renderOnce({ ...input, selected: selection.selected, warnings: selection.warnings });
  }
  assertEditorialHtmlSafe(result.htmlBytes);
  const eligible = new Set(result.trace.eligibleCompositionKinds);
  if (result.trace.renderedCompositionKinds.some((kind) => !eligible.has(kind))) {
    throw new EditorialRendererError('EDITORIAL_RENDER_TRACE_INVALID', 'Renderer emitted an ineligible composition kind');
  }
  if (eligible.size >= 5 && result.trace.renderedCompositionKinds.length < 5) {
    throw new EditorialRendererError('EDITORIAL_RENDER_TRACE_INVALID', 'Renderer did not render five eligible composition kinds');
  }
  return result;
}

export function replayEditorialReport(input: {
  material: EditorialMaterial;
  blueprint: EditorialBlueprint;
  htmlBytes: Uint8Array;
}): EditorialRenderResult {
  const htmlBytes = Buffer.from(input.htmlBytes);
  assertEditorialHtmlSafe(htmlBytes);
  const html = htmlBytes.toString('utf8');
  const embedded = new Map<string, { bytes: Buffer; mediaType: string }>();
  for (const match of html.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    const assetId = tag.match(/\bdata-editorial-asset-id="([^"]+)"/u)?.[1];
    const source = tag.match(/\bsrc="data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})"/u);
    if (!assetId || !source || embedded.has(assetId)) {
      throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'stored HTML has an invalid visual Asset set');
    }
    const bytes = Buffer.from(source[2]!, 'base64');
    if (bytes.toString('base64') !== source[2]) {
      throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'stored HTML has non-canonical visual bytes');
    }
    embedded.set(assetId, { bytes, mediaType: source[1]! });
  }

  const sourceById = new Map(input.material.sourceArtifacts.map((source) => [source.artifactId, source]));
  const consumed = new Set<string>();
  let placeholderBytes: Buffer | undefined;
  const verifiedVisualAssets: EditorialRenderableVisualAsset[] = input.material.assets.map((asset) => {
    const source = sourceById.get(asset.assetId);
    const manifestSource = sourceById.get(asset.manifestArtifactId);
    if (!source || !manifestSource) {
      throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'Material visual Asset is not source-bound');
    }
    const storedId = escapeHtml(asset.assetId);
    const inline = embedded.get(storedId);
    if (inline) {
      consumed.add(storedId);
      if (
        inline.mediaType !== asset.mediaType
        || inline.bytes.byteLength !== asset.byteSize
        || hashBytes(inline.bytes) !== source.contentSha256
      ) {
        throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'stored visual bytes do not match Material');
      }
    }
    if (!inline) placeholderBytes ??= Buffer.alloc(MAX_IMAGE_BYTES + 1);
    return {
      artifact: { id: asset.assetId },
      manifestArtifact: { id: asset.manifestArtifactId },
      bytes: inline?.bytes ?? placeholderBytes!.subarray(0, Math.min(asset.byteSize, placeholderBytes!.byteLength)),
      manifest: { contentSha256: source.contentSha256 },
    };
  });
  if (consumed.size !== embedded.size) {
    throw new EditorialRendererError('SOURCE_NOT_RENDERABLE', 'stored HTML contains an unknown visual Asset');
  }
  return renderEditorialReport({ ...input, verifiedVisualAssets });
}

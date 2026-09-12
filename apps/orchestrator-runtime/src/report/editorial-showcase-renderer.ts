import type {
  EditorialPresentationComponentV1,
  EditorialPresentationSpecV1,
  EditorialShowcaseRenderManifestV1,
  EditorialShowcaseStatusV1,
  EditorialShowcaseUnitV1,
} from '../../../../packages/api-contract/editorial-showcase.ts';
import { canonicalJsonBytes, hashBytes, type Sha256 } from './editorial-report-contract.ts';
import { loadEditorialShowcaseProfile } from './editorial-showcase-profile.ts';

export const EDITORIAL_SHOWCASE_RENDERER_VERSION = 'universal-editorial-showcase-renderer-v1' as const;
export const EDITORIAL_SHOWCASE_CSP = "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

export interface EditorialShowcaseRenderResult {
  htmlBytes: Buffer;
  htmlHash: Sha256;
  renderManifest: EditorialShowcaseRenderManifestV1;
  renderManifestBytes: Buffer;
  renderManifestHash: Sha256;
  profileHash: Sha256;
}

export class EditorialShowcaseRendererError extends Error {
  readonly name = 'EditorialShowcaseRendererError';
  constructor(readonly code: 'SHOWCASE_RENDER_FAILED') { super(code); }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function valueText(unit: EditorialShowcaseUnitV1): string {
  const value = typeof unit.value === 'string' ? unit.value : JSON.stringify(unit.value);
  return unit.unit === undefined || unit.unit === 'ratio' ? value : `${value}${unit.unit}`;
}

const STATUS_LABELS: Record<EditorialShowcaseStatusV1, string> = {
  fact: '已有来源支持',
  inference: '分析推断',
  unknown: '未知／待验证',
};

function statusBadge(status: EditorialShowcaseStatusV1 | undefined): string {
  return status === undefined
    ? ''
    : `<span class="showcase-status status-${status}">${STATUS_LABELS[status]}</span>`;
}

function attrIds(values: readonly string[]): string {
  return escapeHtml(values.join(' '));
}

function componentAttributes(component: EditorialPresentationComponentV1): string {
  return [
    `data-component-id="${escapeHtml(component.id)}"`,
    `data-component-kind="${component.kind}"`,
    `data-owned-unit-ids="${attrIds(component.ownedUnitIds)}"`,
    `data-source-unit-ids="${attrIds(component.sourceUnitIds)}"`,
    `data-source-relation-ids="${attrIds(component.sourceRelationIds)}"`,
    `data-evidence-ids="${attrIds(component.evidenceIds)}"`,
    ...(component.status === undefined ? [] : [`data-status="${component.status}"`]),
  ].join(' ');
}

function evidenceMap(spec: EditorialPresentationSpecV1): Map<string, string | undefined> {
  const entries = spec.sections.flatMap(({ components }) => components).flatMap((component) => (
    component.kind === 'source-register' ? component.content.evidence : []
  ));
  return new Map(entries.map(({ id, sourceUrl }) => [id, sourceUrl]));
}

function citations(unit: EditorialShowcaseUnitV1, evidence: ReadonlyMap<string, string | undefined>): string {
  if (unit.evidenceIds.length === 0) return '';
  return `<span class="showcase-citations">${unit.evidenceIds.map((id) => {
    const url = evidence.get(id);
    const label = `[${escapeHtml(id)}]`;
    return url === undefined
      ? `<span class="showcase-citation">${label}</span>`
      : `<a class="showcase-citation" href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>`;
  }).join('')}</span>`;
}

function unitText(unit: EditorialShowcaseUnitV1, evidence: ReadonlyMap<string, string | undefined>): string {
  return `<span class="showcase-unit" data-showcase-unit-id="${escapeHtml(unit.unitId)}">${escapeHtml(valueText(unit))}</span>${citations(unit, evidence)}`;
}

function renderComponent(
  component: EditorialPresentationComponentV1,
  evidence: ReadonlyMap<string, string | undefined>,
  sectionTitle: string,
): string {
  const attributes = componentAttributes(component);
  switch (component.kind) {
    case 'editorial-hero':
      return `<header class="showcase-component showcase-hero" ${attributes}><div class="showcase-kicker">EDITORIAL SHOWCASE</div><h1>${unitText(component.content.title, evidence)}</h1><p class="showcase-deck">${unitText(component.content.deck, evidence)}</p>${component.content.highlights.length === 0 ? '' : `<div class="showcase-hero-highlights">${component.content.highlights.map((item) => `<p>${unitText(item, evidence)}</p>`).join('')}</div>`}${component.content.boundary.length === 0 ? '' : `<aside class="showcase-hero-boundary"><strong>适用边界</strong>${component.content.boundary.map((item) => `<p>${unitText(item, evidence)}</p>`).join('')}</aside>`}</header>`;
    case 'evidence-boundary':
      return `<section class="showcase-component showcase-evidence-boundary" ${attributes}><div class="showcase-component-heading"><span>Evidence Boundary</span><h3>事实、推断与待验证内容分开阅读</h3></div><div class="showcase-evidence-grid">${component.content.columns.map((column) => `<article class="showcase-evidence-column evidence-${column.status}">${statusBadge(column.status)}<ol>${column.items.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ol></article>`).join('')}</div></section>`;
    case 'answer-chain': {
      const evidenceGroups = (['fact', 'inference', 'unknown'] as const).flatMap((status) => {
        const items = component.content.supporting.filter((item) => item.status === status);
        return items.length === 0 ? [] : [{ status, items }];
      });
      const uncategorized = component.content.supporting.filter((item) => item.status === undefined);
      const questionText = String(component.content.question.value);
      const question = sectionTitle === questionText
        ? ''
        : `<div class="showcase-answer-question"><span class="showcase-answer-label">研究问题</span><h3>${unitText(component.content.question, evidence)}</h3></div>`;
      return `<section class="showcase-component showcase-answer-chain" ${attributes}>${question}<article class="showcase-answer-main"><span class="showcase-answer-label">直接答案</span>${statusBadge(component.content.answer.status)}<strong>${unitText(component.content.answer, evidence)}</strong></article>${evidenceGroups.length === 0 && uncategorized.length === 0 ? '' : `<div class="showcase-answer-evidence"><span class="showcase-answer-label">阅读依据</span><div class="showcase-answer-evidence-grid">${evidenceGroups.map(({ status, items }) => `<article class="showcase-answer-evidence-group evidence-${status}">${statusBadge(status)}<ul>${items.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul></article>`).join('')}${uncategorized.length === 0 ? '' : `<article class="showcase-answer-evidence-group"><span>补充背景</span><ul>${uncategorized.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul></article>`}</div></div>`}${component.content.actions.length === 0 ? '' : `<div class="showcase-answer-actions"><span class="showcase-answer-label">建议行动</span><ol>${component.content.actions.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ol></div>`}</section>`;
    }
    case 'metric-cards':
      return `<section class="showcase-component showcase-metrics" ${attributes}><div class="showcase-component-heading"><span>Verified Metrics</span><h3>材料中可直接使用的数值</h3></div><div class="showcase-metric-strip">${component.content.items.map(({ label, value }) => `<article class="showcase-metric"><strong>${unitText(value, evidence)}</strong><p>${unitText(label, evidence)}</p></article>`).join('')}</div></section>`;
    case 'record-grid':
      return `<section class="showcase-component showcase-records" ${attributes}><div class="showcase-component-heading"><span>Structured Records</span><h3>按来源结构组织的信息组</h3></div><div class="showcase-record-grid">${component.content.records.map((record, index) => `<article class="showcase-record"><span class="showcase-record-index">${String(index + 1).padStart(2, '0')}</span>${record.title ? `<h4>${unitText(record.title, evidence)}</h4>` : ''}<ul>${record.items.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul></article>`).join('')}</div></section>`;
    case 'record-table':
      return `<section class="showcase-component showcase-scope" ${attributes}><div class="showcase-component-heading"><span>Scope Definition</span><h3>研究边界与对象</h3></div><table class="showcase-scope-table"><tbody>${component.content.records.map((record, index) => `<tr><th>${escapeHtml(record.label ?? `范围项 ${index + 1}`)}</th><td>${record.title ? `${unitText(record.title, evidence)} ` : ''}${record.items.map((item) => unitText(item, evidence)).join('；')}</td></tr>`).join('')}</tbody></table></section>`;
    case 'deliverable-map':
      return `<section class="showcase-component showcase-deliverables" ${attributes}><div class="showcase-component-heading"><span>Deliverable Map</span><h3>研究最终需要形成的输出</h3></div><ol class="showcase-deliverable-map">${component.content.items.map((item, index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><strong>${unitText(item, evidence)}</strong></li>`).join('')}</ol></section>`;
    case 'dimension-table':
      return `<section class="showcase-component showcase-dimensions" ${attributes}><div class="showcase-component-heading"><span>Analysis Dimensions</span><h3>研究需要覆盖的分析维度</h3></div><div class="showcase-table-wrap"><table class="showcase-dimension-table"><thead><tr><th>分析维度</th><th>用途</th><th>采集与分析字段</th></tr></thead><tbody>${component.content.rows.map((row) => `<tr><th>${unitText(row.name, evidence)}</th><td>${row.purpose ? unitText(row.purpose, evidence) : '—'}</td><td><ul>${row.fields.map((field) => `<li>${unitText(field, evidence)}</li>`).join('')}</ul></td></tr>`).join('')}</tbody></table></div></section>`;
    case 'method-board':
      return `<section class="showcase-component showcase-methods" ${attributes}><div class="showcase-component-heading"><span>Method Mix</span><h3>分析方法组合</h3></div><ol class="showcase-method-board">${component.content.items.map((item, index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><strong>${unitText(item, evidence)}</strong></li>`).join('')}</ol></section>`;
    case 'matrix':
      return `<section class="showcase-component showcase-matrix-section" ${attributes}><div class="showcase-component-heading"><span>Matrix</span><h3>${unitText(component.content.title, evidence)}</h3></div><div class="showcase-matrix-wrap"><table class="showcase-matrix"><thead><tr><th>维度</th>${component.content.columns.map((column) => `<th>${unitText(column, evidence)}</th>`).join('')}</tr></thead><tbody>${component.content.rows.map((row) => `<tr><th>${unitText(row.label, evidence)}</th>${row.cells.map((cell) => `<td>${unitText(cell, evidence)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
    case 'stage-flow':
      return `<section class="showcase-component showcase-flow" ${attributes}><div class="showcase-component-heading"><span>Execution Flow</span><h3>按显式顺序推进</h3></div><ol class="showcase-stage-track">${component.content.stages.map((stage) => `<li class="showcase-stage"><div class="showcase-stage-marker">${String(stage.sequence + 1).padStart(2, '0')}</div><div class="showcase-stage-content"><div class="showcase-stage-head"><h4>${unitText(stage.label, evidence)}</h4>${stage.duration === undefined ? '' : `<span class="showcase-stage-duration">${unitText(stage.duration, evidence)}</span>`}</div><ul>${stage.items.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul>${stage.outputs.length === 0 ? '' : `<div class="showcase-stage-outputs"><strong>阶段输出</strong><ul>${stage.outputs.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul></div>`}</div></li>`).join('')}</ol></section>`;
    case 'relation-map':
      return `<section class="showcase-component showcase-relations" ${attributes}><div class="showcase-component-heading"><span>Relation Map</span><h3>结论、分析与行动之间的来源关系</h3></div><div class="showcase-relation-canvas"><div class="showcase-relation-nodes">${component.content.nodes.map((node) => `<article class="showcase-relation-node" data-source-group-id="${escapeHtml(node.groupId)}"><strong>${unitText(node.label, evidence)}</strong>${node.items.length === 0 ? '' : `<ul>${node.items.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul>`}</article>`).join('')}</div><ol class="showcase-relation-edges">${component.content.edges.map((edge) => `<li data-source-relation-id="${escapeHtml(edge.relationId)}"><span>${escapeHtml(edge.fromGroupId)}</span><strong>→ ${escapeHtml(edge.kind)} →</strong><span>${escapeHtml(edge.toGroupId)}</span></li>`).join('')}</ol></div></section>`;
    case 'priority-lanes':
      return `<section class="showcase-component showcase-priorities" ${attributes}><div class="showcase-component-heading"><span>Priority Lanes</span><h3>${unitText(component.content.title, evidence)}</h3></div><div class="showcase-priority-lanes">${component.content.lanes.map((lane) => `<article class="showcase-priority-lane priority-${lane.priority.toLowerCase()}"><h4>${lane.priority}</h4><ul>${lane.items.map((item) => `<li>${unitText(item, evidence)}</li>`).join('')}</ul></article>`).join('')}</div></section>`;
    case 'validation-list':
      return `<section class="showcase-component showcase-validations" ${attributes}><div class="showcase-component-heading"><span>Validation Gates</span><h3>交付前需要满足的验证条件</h3></div><ol class="showcase-validation-list">${component.content.items.map((item) => `<li><span class="showcase-check">✓</span><div>${statusBadge(item.status)}${unitText(item, evidence)}</div></li>`).join('')}</ol></section>`;
    case 'risk-register':
      return `<section class="showcase-component showcase-risks" ${attributes}><div class="showcase-component-heading"><span>Risk Register</span><h3>风险与待验证边界</h3></div><div class="showcase-risk-register">${component.content.items.map((item) => `<article class="showcase-risk-item">${statusBadge(item.status)}<p>${unitText(item, evidence)}</p></article>`).join('')}</div></section>`;
    case 'narrative-list':
      return `<section class="showcase-component showcase-narrative" ${attributes}><div class="showcase-component-heading"><span>Complete Analysis</span><h3>完整内容</h3></div><div class="showcase-narrative-list">${component.content.items.map((item) => `<p>${statusBadge(item.status)}${unitText(item, evidence)}</p>`).join('')}</div></section>`;
    case 'analysis-appendix':
      return `<details class="showcase-component showcase-appendix" ${attributes}><summary>展开完整分析附件</summary><div class="showcase-appendix-list">${component.content.items.map((item) => `<article><strong>${escapeHtml(item.role)}</strong><p>${unitText(item, evidence)}</p></article>`).join('')}</div></details>`;
    case 'source-register':
      return `<details class="showcase-component showcase-sources" ${attributes}><summary>展开来源登记</summary><div class="showcase-table-wrap"><table class="showcase-source-table"><thead><tr><th>Evidence ID</th><th>来源地址</th></tr></thead><tbody>${component.content.evidence.map(({ id, sourceUrl }) => `<tr><th>${escapeHtml(id)}</th><td>${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a>` : '未提供公开 URL'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
}

function documentLanguage(title: string): 'zh-CN' | 'en' {
  return /\p{Script=Han}/u.test(title) ? 'zh-CN' : 'en';
}

function css(input: ReturnType<typeof loadEditorialShowcaseProfile>['profile']): string {
  return `
:root,.showcase-layout{--paper:${input.colors.paper};--surface:${input.colors.surface};--ink:${input.colors.ink};--muted:${input.colors.muted};--accent:${input.colors.accent};--fact:${input.colors.fact};--inference:${input.colors.inference};--unknown:${input.colors.unknown};--method:${input.colors.method};--line:#d8d0c5;--soft:#ebe5dc;--display:${input.typography.display};--body:${input.typography.body}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body,.showcase-layout{margin:0;background:var(--paper);color:var(--ink);font:16px/1.7 var(--body)}a{color:var(--method);overflow-wrap:anywhere}.showcase-layout{display:grid;grid-template-columns:${input.layout.railWidth}px minmax(0,1fr);gap:42px;max-width:${input.layout.maxWidth}px;margin:0 auto;padding:32px}.showcase-rail{position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;border-top:4px solid var(--ink);padding-top:18px}.showcase-rail strong{display:block;font:700 19px/1.25 var(--display);margin-bottom:16px}.showcase-rail a{display:block;padding:7px 0;border-bottom:1px solid var(--soft);color:var(--muted);font-size:13px;text-decoration:none}.showcase-main{min-width:0}.showcase-hero{position:relative;overflow:hidden;min-height:420px;padding:56px 60px;background:#20282e;color:#fff}.showcase-hero:after{content:"";position:absolute;right:-90px;bottom:-130px;width:340px;height:340px;border:42px solid var(--accent);border-radius:50%;opacity:.76}.showcase-kicker{position:relative;z-index:1;color:#ffb0aa;font-size:12px;font-weight:800;letter-spacing:.2em}.showcase-hero h1{position:relative;z-index:1;max-width:13ch;margin:18px 0;font:700 clamp(46px,5vw,76px)/1.04 var(--display)}.showcase-hero h1 .showcase-citations{display:none}.showcase-deck{position:relative;z-index:1;max-width:66ch;color:#e8e3dc;font-size:18px}.showcase-hero-highlights{position:relative;z-index:1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-width:760px;margin-top:26px;border-top:1px solid #ffffff40}.showcase-hero-highlights p{margin:0;padding:14px 18px 0 0}.showcase-hero-boundary{position:relative;z-index:1;max-width:760px;margin-top:24px;padding:16px 20px;border-left:4px solid #ff8b82;background:#ffffff12}.showcase-hero-boundary p{margin:5px 0}.showcase-section{padding:54px 10px 44px;border-bottom:1px solid var(--line)}.section-decision{padding-top:0}.showcase-section-header{display:grid;grid-template-columns:70px minmax(0,1fr);gap:20px;margin-bottom:28px}.showcase-section-no{color:var(--accent);font-weight:900;letter-spacing:.12em}.showcase-section h2{margin:0;font:700 34px/1.15 var(--display)}.showcase-component{margin-top:30px}.showcase-component-heading{display:grid;grid-template-columns:160px minmax(0,1fr);gap:20px;align-items:end;margin-bottom:20px}.showcase-component-heading>span{color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.showcase-component-heading h3{margin:0;font:700 24px/1.2 var(--display)}.showcase-status{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800;white-space:nowrap}.status-fact{color:var(--fact);background:#dff2e8}.status-inference{color:var(--inference);background:#fff0d4}.status-unknown{color:var(--unknown);background:#fde3df}.showcase-citations{display:inline-flex;gap:3px;margin-left:4px;font-size:10px;vertical-align:super}.showcase-citation{text-decoration:none}.showcase-evidence-boundary{margin-top:0;padding:32px;background:#20282e;color:#fff}.showcase-evidence-boundary .showcase-component-heading{color:#fff}.showcase-evidence-boundary .showcase-component-heading>span{color:#ffb0aa}.showcase-evidence-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#ffffff35}.showcase-evidence-column{min-width:0;padding:20px;background:#263138}.showcase-evidence-column ol{margin:14px 0 0;padding-left:18px;color:#f2eee8}.showcase-evidence-column li{margin:8px 0}.showcase-answer-chain{padding:30px 0;border-top:5px solid var(--ink)}.showcase-answer-question{margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--line)}.showcase-answer-question h3{margin:4px 0 0;font:700 24px/1.35 var(--display)}.showcase-answer-label{display:block;margin-bottom:10px;color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.14em}.showcase-answer-main{padding:26px 0;border-bottom:1px solid var(--line)}.showcase-answer-main>strong{display:block;max-width:56ch;margin-top:12px;font:700 24px/1.5 var(--display)}.showcase-answer-evidence{margin-top:24px}.showcase-answer-evidence-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}.showcase-answer-evidence-group{padding:20px;border-top:4px solid var(--method);background:#eee8df}.showcase-answer-evidence-group.evidence-fact{border-color:var(--fact)}.showcase-answer-evidence-group.evidence-inference{border-color:var(--inference)}.showcase-answer-evidence-group.evidence-unknown{border-color:var(--unknown)}.showcase-answer-evidence-group ul{margin:12px 0 0;padding-left:18px}.showcase-answer-evidence-group li{margin:9px 0}.showcase-answer-actions{display:grid;grid-template-columns:160px minmax(0,1fr);gap:20px;margin-top:22px;padding:20px;border-left:5px solid var(--accent);background:var(--surface)}.showcase-answer-actions ol{margin:0;padding-left:20px}.showcase-answer-actions li{margin:8px 0}.showcase-metric-strip{display:flex;flex-wrap:wrap;border-top:5px solid var(--accent);border-bottom:1px solid var(--line)}.showcase-metric{flex:1 1 190px;padding:24px 28px;border-right:1px solid var(--line)}.showcase-metric strong{display:block;font:700 42px/1 var(--display)}.showcase-metric p{margin:10px 0 0;color:var(--muted)}.showcase-record-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;border-top:1px solid var(--line)}.showcase-record{position:relative;min-height:180px;padding:28px 28px 28px 62px;border-bottom:1px solid var(--line)}.showcase-record:nth-child(odd){border-right:1px solid var(--line)}.showcase-record-index{position:absolute;left:0;top:29px;color:var(--accent);font-weight:900}.showcase-record h4{margin:0 0 12px;font:700 21px/1.25 var(--display)}.showcase-scope-table{width:100%;border-collapse:collapse;border-top:2px solid var(--ink)}.showcase-scope-table th,.showcase-scope-table td{padding:15px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.showcase-scope-table th{width:170px;color:var(--accent);font-size:12px;letter-spacing:.04em}.showcase-scope-table tr:nth-child(even){background:#eee8df}.showcase-deliverable-map{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none}.showcase-deliverable-map li{min-height:170px;padding:18px;border-top:5px solid var(--accent);background:var(--surface)}.showcase-deliverable-map li>span{display:block;color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.12em}.showcase-deliverable-map strong{display:block;margin-top:28px;font:700 18px/1.45 var(--display)}.showcase-table-wrap{overflow:auto}.showcase-dimension-table,.showcase-source-table{width:100%;border-collapse:collapse;border-top:2px solid var(--ink)}.showcase-dimension-table th,.showcase-dimension-table td,.showcase-source-table th,.showcase-source-table td{padding:14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.showcase-dimension-table thead th,.showcase-source-table thead th{color:#fff;background:#20282e;font-size:12px}.showcase-dimension-table tbody th,.showcase-source-table tbody th{color:var(--accent);font-weight:850}.showcase-dimension-table tbody tr:nth-child(even),.showcase-source-table tbody tr:nth-child(even){background:#eee8df}.showcase-dimension-table ul{margin:0;padding-left:18px}.showcase-method-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin:0;padding:0;list-style:none;border-top:1px solid var(--ink)}.showcase-method-board li{position:relative;min-height:130px;padding:24px 20px 20px 54px;border-bottom:1px solid var(--line)}.showcase-method-board li:nth-child(3n+1),.showcase-method-board li:nth-child(3n+2){border-right:1px solid var(--line)}.showcase-method-board li>span{position:absolute;left:0;color:var(--accent);font-weight:900}.showcase-method-board strong{font:700 17px/1.5 var(--display)}.showcase-stage-track{position:relative;margin:0;padding:0;list-style:none}.showcase-stage-track:before{content:"";position:absolute;left:31px;top:18px;bottom:18px;width:2px;background:var(--accent)}.showcase-stage{position:relative;display:grid;grid-template-columns:64px minmax(0,1fr);gap:24px;padding:12px 0 28px}.showcase-stage-marker{position:relative;z-index:1;display:grid;place-items:center;width:64px;height:64px;border:2px solid var(--accent);border-radius:50%;background:var(--surface);color:var(--accent);font-weight:900}.showcase-stage-content{padding:6px 0 22px;border-bottom:1px solid var(--line)}.showcase-stage-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:10px}.showcase-stage-content h4{margin:0;font:700 23px/1.25 var(--display)}.showcase-stage-duration{padding:3px 9px;border-radius:999px;color:var(--method);background:#e7f0f6;font-size:11px;font-weight:800}.showcase-stage-outputs{margin-top:14px;padding:12px 16px;border-left:3px solid var(--method);background:#eaf1f5}.showcase-stage-outputs>strong{color:var(--method);font-size:11px;letter-spacing:.08em}.showcase-stage-outputs ul{margin:7px 0 0;padding-left:18px}.showcase-relation-canvas{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.4fr);gap:26px;padding:28px;background:#20282e;color:#fff}.showcase-relation-nodes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.showcase-relation-node{min-height:92px;padding:16px;border:1px solid #ffffff40;background:#ffffff0b}.showcase-relation-node>strong{display:block;text-align:center}.showcase-relation-node ul{margin:12px 0 0;padding:12px 0 0 18px;border-top:1px solid #ffffff25;text-align:left}.showcase-relation-edges{margin:0;padding:0;list-style:none}.showcase-relation-edges li{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #ffffff25;font-size:12px}.showcase-relation-edges strong{color:#ffb0aa}.showcase-validation-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}.showcase-validation-list>li{display:grid;grid-template-columns:42px minmax(0,1fr);gap:16px;padding:18px 0;border-bottom:1px solid var(--line)}.showcase-check{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;color:#fff;background:var(--method);font-weight:900}.showcase-risk-register{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.showcase-risk-item{padding:22px 0;border-top:4px solid var(--unknown)}.showcase-narrative-list{columns:2;column-gap:42px}.showcase-narrative-list p{break-inside:avoid;margin:0 0 18px;padding-bottom:16px;border-bottom:1px solid var(--line)}.showcase-matrix-wrap{overflow:auto}.showcase-matrix{width:100%;border-collapse:collapse}.showcase-matrix th,.showcase-matrix td{padding:13px;border:1px solid var(--line);text-align:left;vertical-align:top}.showcase-matrix thead{color:#fff;background:#20282e}.showcase-priority-lanes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.showcase-priority-lane{padding:20px;border-top:5px solid var(--accent);background:var(--surface)}.showcase-appendix,.showcase-sources{margin-top:18px;border-top:1px solid var(--line);padding:18px 0}.showcase-appendix summary,.showcase-sources summary{cursor:pointer;font-weight:800}.showcase-appendix-list{display:grid;gap:10px;margin-top:16px}.showcase-appendix-list article{padding:14px;border-left:3px solid var(--method);background:#eaf1f5}.showcase-appendix-list p{margin:4px 0}.showcase-footer{display:flex;justify-content:space-between;gap:20px;padding:24px 10px 60px;color:var(--muted);font-size:12px}.showcase-notice{max-width:72ch}
`;
}

export function renderEditorialShowcase(input: {
  spec: EditorialPresentationSpecV1;
}): EditorialShowcaseRenderResult {
  if (input.spec.version !== 'universal-editorial-presentation-spec-v1' || input.spec.profileId !== 'universal-editorial-showcase-v1') {
    throw new EditorialShowcaseRendererError('SHOWCASE_RENDER_FAILED');
  }
  const profile = loadEditorialShowcaseProfile();
  const specBytes = canonicalJsonBytes(input.spec);
  const specHash = hashBytes(specBytes);
  const evidence = evidenceMap(input.spec);
  const sections = input.spec.sections;
  const heroComponent = sections.flatMap(({ components }) => components).find((component) => component.kind === 'editorial-hero');
  const documentTitle = heroComponent?.kind === 'editorial-hero'
    ? valueText(heroComponent.content.title)
    : 'Editorial Showcase';
  const language = documentLanguage(documentTitle);
  const nav = sections.map((section, index) => `<a href="#section-${escapeHtml(section.id)}"><span>${String(index + 1).padStart(2, '0')}</span> ${escapeHtml(section.title)}</a>`).join('');
  const body = sections.map((section, index) => {
    const firstIsHero = index === 0 && section.components[0]?.kind === 'editorial-hero';
    const answerChain = section.components.find((component) => (
      component.kind === 'answer-chain' && String(component.content.question.value) === section.title
    ));
    const sectionTitle = answerChain?.kind === 'answer-chain'
      ? `<span class="showcase-unit" data-showcase-unit-id="${escapeHtml(answerChain.content.question.unitId)}">${escapeHtml(section.title)}</span>`
      : escapeHtml(section.title);
    const heading = firstIsHero
      ? ''
      : `<header class="showcase-section-header"><span class="showcase-section-no">${String(index + 1).padStart(2, '0')}</span><h2>${sectionTitle}</h2></header>`;
    return `<section class="showcase-section section-${section.role}" id="section-${escapeHtml(section.id)}" data-section-role="${section.role}">${heading}${section.components.map((component) => renderComponent(component, evidence, section.title)).join('')}</section>`;
  }).join('');
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=1440,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${EDITORIAL_SHOWCASE_CSP}"><meta name="editorial-profile-id" content="${profile.profile.id}"><meta name="editorial-spec-hash" content="${specHash}"><meta name="editorial-profile-hash" content="${profile.hash}"><title>${escapeHtml(documentTitle)}</title><style>${css(profile.profile)}</style></head><body><div class="showcase-layout"><nav class="showcase-rail" aria-label="报告目录"><strong>内容导航</strong>${nav}</nav><main class="showcase-main">${body}<footer class="showcase-footer"><p class="showcase-notice">${escapeHtml(input.spec.notices.join(' '))}</p><p>Renderer ${EDITORIAL_SHOWCASE_RENDERER_VERSION}</p></footer></main></div></body></html>`;
  const htmlBytes = Buffer.from(html, 'utf8');
  const htmlHash = hashBytes(htmlBytes);
  const renderManifest: EditorialShowcaseRenderManifestV1 = {
    version: 'universal-editorial-showcase-render-manifest-v1',
    profileId: 'universal-editorial-showcase-v1',
    profileHash: profile.hash,
    specHash,
    htmlHash,
    renderedComponents: sections.flatMap(({ components }) => components.map((component) => ({
      componentId: component.id,
      kind: component.kind,
      ownedUnitIds: [...component.ownedUnitIds],
      sourceUnitIds: [...component.sourceUnitIds],
    }))),
  };
  const renderManifestBytes = canonicalJsonBytes(renderManifest);
  return {
    htmlBytes,
    htmlHash,
    renderManifest,
    renderManifestBytes,
    renderManifestHash: hashBytes(renderManifestBytes),
    profileHash: profile.hash,
  };
}

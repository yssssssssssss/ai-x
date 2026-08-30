import type { ReportEditorialPresentationUnitV1, ReportEditorialMaterialV1 } from '../../../../packages/api-contract/report-editorial.ts';
import type {
  EditorialPresentationSpecV1,
  EditorialShowcaseComponentV1,
  EditorialShowcaseRenderManifestV1,
} from '../../../../packages/api-contract/report-editorial-showcase.ts';
import { EDITORIAL_SHOWCASE_PROFILE_V1 } from '../../../../packages/api-contract/report-editorial-showcase.ts';
import {
  editorialShowcaseComponentTitle,
  editorialShowcaseNotices,
  editorialShowcaseOutlineSignature,
  editorialShowcaseSectionTitle,
} from './report-editorial-showcase-compiler.ts';
import type { EvidenceManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import { assertReportEditorialMaterialIntegrity } from '../../../../packages/report-rendering/report-editorial-validation.ts';
import {
  EDITORIAL_SHOWCASE_PROFILE_CSS,
  EDITORIAL_SHOWCASE_PROFILE_ID,
} from './report-editorial-showcase-profile.ts';

export const EDITORIAL_SHOWCASE_RENDERER_VERSION = 'editorial-showcase-html-v1';
const MAX_SHOWCASE_HTML_BYTES = 2 * 1024 * 1024;

export interface EditorialShowcaseRenderResult {
  html: string;
  renderManifest: EditorialShowcaseRenderManifestV1;
}

function escapeText(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function derivedStatus(
  material: ReportEditorialMaterialV1,
  leafIds: readonly string[],
): 'supported' | 'provisional' | 'unanswered' | undefined {
  const statuses = leafIds
    .map((leafId) => material.leafTraceIndex[leafId]?.support.status)
    .filter((value): value is 'supported' | 'provisional' | 'unanswered' => value !== undefined);
  if (statuses.includes('unanswered')) return 'unanswered';
  if (statuses.includes('provisional')) return 'provisional';
  if (statuses.includes('supported')) return 'supported';
  return undefined;
}

function derivedConfidence(
  material: ReportEditorialMaterialV1,
  leafIds: readonly string[],
): number | undefined {
  const values = leafIds.map((leafId) => material.leafTraceIndex[leafId]?.support.confidence);
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
  return Math.min(...(values as number[]));
}

function derivedEvidenceIds(
  material: ReportEditorialMaterialV1,
  leafIds: readonly string[],
): string[] {
  return unique(leafIds.flatMap((leafId) => (
    material.leafTraceIndex[leafId]?.support.evidenceIds ?? []
  )));
}

function componentAttributes(component: EditorialShowcaseComponentV1): string {
  return [
    `id="${escapeText(component.id)}"`,
    `data-component-id="${escapeText(component.id)}"`,
    `data-component-kind="${escapeText(component.kind)}"`,
    `data-component-variant="${escapeText(component.variant)}"`,
    `data-status="${escapeText(component.status ?? 'method')}"`,
    `data-confidence="${escapeText(component.confidence ?? '')}"`,
    `data-source-leaf-ids="${escapeText(component.sourceLeafIds.join(' '))}"`,
    `data-owned-leaf-ids="${escapeText(component.ownedLeafIds.join(' '))}"`,
    `data-source-contribution-unit-ids="${escapeText(component.sourceContributionUnitIds.join(' '))}"`,
    `data-evidence-ids="${escapeText(component.evidenceIds.join(' '))}"`,
  ].join(' ');
}

function statusChip(component: EditorialShowcaseComponentV1): string {
  const status = component.status ?? 'method';
  const label = status === 'supported' ? '已有来源支持'
    : status === 'provisional' ? '暂定判断'
      : status === 'unanswered' ? '当前未知'
        : '方法与审计';
  return `<span class="status status-${escapeText(status)}">${escapeText(label)}</span>`;
}

function unitById(material: ReportEditorialMaterialV1): Map<string, ReportEditorialPresentationUnitV1> {
  return new Map(material.presentationUnits.map((unit) => [unit.id, unit]));
}

function unitsFor(
  component: EditorialShowcaseComponentV1,
  units: ReadonlyMap<string, ReportEditorialPresentationUnitV1>,
): ReportEditorialPresentationUnitV1[] {
  return component.ownedUnitIds.map((unitId) => {
    const unit = units.get(unitId);
    if (!unit) throw new Error(`Showcase Renderer cannot resolve unit ${unitId}`);
    return unit;
  });
}

function scalar(value: string | number | boolean | null): string {
  return value === null ? '未提供' : String(value);
}

function recordFields(fields: ReadonlyArray<{ label: string; value: string | number | boolean | null }>): string {
  return `<dl class="record-fields">${fields.map(({ label, value }) => (
    `<dt>${escapeText(label)}</dt><dd>${escapeText(scalar(value))}</dd>`
  )).join('')}</dl>`;
}

function textForUnit(unit: ReportEditorialPresentationUnitV1): string {
  if (unit.shape === 'text') return unit.text;
  if (unit.shape === 'record') {
    return unit.fields.map(({ label, value }) => `${label}：${scalar(value)}`).join('；');
  }
  if (unit.shape === 'actions') return unit.actions.map(({ action, owner, rationale, validationMethod }) => [
    action,
    owner ? `负责人：${owner}` : undefined,
    rationale,
    validationMethod ? `验证：${validationMethod}` : undefined,
  ].filter(Boolean).join('；')).join('；');
  if (unit.shape === 'records') return unit.records.map(({ title, body, fields }) => (
    `${title}${body ? `：${body}` : ''}${fields.length > 0 ? `；${fields.map(({ label, value }) => `${label}：${scalar(value)}`).join('；')}` : ''}`
  )).join('；');
  if (unit.shape === 'stages') return unit.stages.map(({ label, description, activities, outputs }) => `${label}${description ? `：${description}` : ''}${activities.length > 0 ? `；活动：${activities.join('、')}` : ''}${outputs.length > 0 ? `；产出：${outputs.join('、')}` : ''}`).join('；');
  if (unit.shape === 'matrix') return unit.cells.map(({ row, column, value }) => `${row}/${column}：${scalar(value)}`).join('；');
  if (unit.shape === 'graph') {
    const labels = new Map(unit.nodes.map(({ id, label }) => [id, label]));
    const nodes = unit.nodes.map(({ label, description }) => `${label}${description ? `：${description}` : ''}`);
    const edges = unit.edges.map(({ from, to, label }) => `${labels.get(from) ?? from} → ${labels.get(to) ?? to}${label ? `：${label}` : ''}`);
    return [...nodes, ...edges].join('；');
  }
  if (unit.shape === 'chart') {
    const rows = unit.table.rows.map((row) => (
      `${row.label}：${unit.table.columns.map((column, index) => (
        `${column}：${scalar(row.cells[index] ?? null)}`
      )).join('；')}`
    ));
    return [unit.table.caption, ...rows].join('；');
  }
  if (unit.shape === 'asset') {
    const source = unit.sourceSummary.kind === 'browser_capture'
      ? `${unit.sourceSummary.pageTitle}（${unit.sourceSummary.domain}，${unit.sourceSummary.capturedAt}）`
      : unit.sourceSummary.kind === 'user_upload'
        ? `${unit.sourceSummary.fileName}（${unit.sourceSummary.role}）`
        : unit.sourceSummary.role;
    return `${unit.title ?? '视觉素材'}：${source}。Showcase V1 不显示图片。`;
  }
  return `${unit.title ?? '视觉对照'}。Showcase V1 不显示图片。`;
}

function unitRows(units: readonly ReportEditorialPresentationUnitV1[]): string {
  return units.map((unit) => (
    `<div class="list-row"><h4>${escapeText(unit.title ?? unit.semanticKind)}</h4><div>${unit.shape === 'record'
      ? recordFields(unit.fields)
      : `<p>${escapeText(textForUnit(unit))}</p>`}</div></div>`
  )).join('');
}

function renderEditorialHero(
  component: EditorialShowcaseComponentV1,
  material: ReportEditorialMaterialV1,
  units: readonly ReportEditorialPresentationUnitV1[],
): string {
  const answer = material.document.executiveAnswer?.trim() || textForUnit(units[0]!);
  return `<div class="showcase-editorial-hero"><blockquote>${escapeText(answer)}</blockquote>${material.document.decisionContext ? `<p class="hero-context">${escapeText(material.document.decisionContext)}</p>` : ''}<div class="showcase-narrative-list">${unitRows(units)}</div></div>`;
}

function weakestUnitStatus(
  material: ReportEditorialMaterialV1,
  unit: ReportEditorialPresentationUnitV1,
): 'supported' | 'provisional' | 'unanswered' | 'method' {
  const statuses = unit.leafIds.map((leafId) => material.leafTraceIndex[leafId]?.support.status);
  if (statuses.includes('unanswered')) return 'unanswered';
  if (statuses.includes('provisional')) return 'provisional';
  if (statuses.includes('supported')) return 'supported';
  return 'method';
}

function renderEvidenceBoundary(
  material: ReportEditorialMaterialV1,
  units: readonly ReportEditorialPresentationUnitV1[],
): string {
  const groups: Record<'supported' | 'provisional' | 'unanswered', ReportEditorialPresentationUnitV1[]> = {
    supported: [], provisional: [], unanswered: [],
  };
  for (const unit of units) {
    const status = weakestUnitStatus(material, unit);
    groups[status === 'method' ? 'provisional' : status].push(unit);
  }
  const column = (status: keyof typeof groups, label: string) => (
    `<section class="boundary-column boundary-${status}"><h4>${escapeText(label)}</h4>${groups[status].length === 0 ? '<p>无</p>' : `<ul>${groups[status].map((unit) => `<li>${escapeText(textForUnit(unit))}</li>`).join('')}</ul>`}</section>`
  );
  return `<div class="showcase-evidence-boundary">${column('supported', '可以确认')}${column('provisional', '暂定判断')}${column('unanswered', '当前未知')}</div>`;
}

function renderProfiles(units: readonly ReportEditorialPresentationUnitV1[]): string {
  const cards = units.flatMap((unit) => {
    if (unit.shape === 'graph') return unit.nodes.map(({ id, label, description }) => ({ id, title: label, body: description }));
    if (unit.shape === 'records') return unit.records.map(({ id, title, body, fields }) => ({
      id,
      title,
      body: [
        body,
        fields.length > 0
          ? fields.map(({ label, value }) => `${label}：${scalar(value)}`).join('；')
          : undefined,
      ].filter(Boolean).join('；'),
    }));
    return [{ id: unit.id, title: unit.title ?? unit.semanticKind, body: textForUnit(unit) }];
  });
  const relations = units.flatMap((unit) => {
    if (unit.shape !== 'graph') return [];
    const labels = new Map(unit.nodes.map(({ id, label }) => [id, label]));
    return unit.edges.map(({ from, to, label }) => (
      `${labels.get(from) ?? from} → ${labels.get(to) ?? to}${label ? `：${label}` : ''}`
    ));
  });
  return `<div class="showcase-profile-grid">${cards.map(({ title, body }) => (
    `<article class="profile-card"><h4>${escapeText(title)}</h4>${body ? `<p>${escapeText(body)}</p>` : ''}</article>`
  )).join('')}</div>${relations.length === 0 ? '' : `<ul class="profile-relations">${relations.map((relation) => `<li>${escapeText(relation)}</li>`).join('')}</ul>`}`;
}

function renderMatrix(units: readonly ReportEditorialPresentationUnitV1[]): string {
  return units.map((unit) => {
    if (unit.shape === 'matrix') {
      const byCell = new Map(unit.cells.map((cell) => [`${cell.row}\u0000${cell.column}`, cell]));
      return `<div class="table-wrap showcase-matrix"><table class="showcase-table"><caption>${escapeText(unit.title ?? '分析矩阵')}</caption><thead><tr><th scope="col">项目</th>${unit.columns.map((column) => `<th scope="col">${escapeText(column)}</th>`).join('')}</tr></thead><tbody>${unit.rows.map((row) => `<tr><th scope="row">${escapeText(row)}</th>${unit.columns.map((column) => `<td>${escapeText(scalar(byCell.get(`${row}\u0000${column}`)?.value ?? null))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    if (unit.shape === 'records') {
      const labels = unique(unit.records.flatMap(({ fields }) => fields.map(({ label }) => label)));
      const hasBody = unit.records.some(({ body }) => Boolean(body?.trim()));
      return `<div class="table-wrap showcase-matrix"><table class="showcase-table"><caption>${escapeText(unit.title ?? '分析矩阵')}</caption><thead><tr><th scope="col">项目</th>${hasBody ? '<th scope="col">说明</th>' : ''}${labels.map((label) => `<th scope="col">${escapeText(label)}</th>`).join('')}</tr></thead><tbody>${unit.records.map((record) => `<tr><th scope="row">${escapeText(record.title)}</th>${hasBody ? `<td>${escapeText(record.body ?? '未提供')}</td>` : ''}${labels.map((label) => `<td>${escapeText(scalar(record.fields.find((field) => field.label === label)?.value ?? null))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    throw new Error(`Showcase matrix cannot render unit ${unit.id}`);
  }).join('');
}

function renderStages(units: readonly ReportEditorialPresentationUnitV1[], timeline: boolean): string {
  const stages = units.flatMap((unit) => unit.shape === 'stages' ? unit.stages : []);
  return `<ol class="showcase-stage-flow ${timeline ? 'showcase-timeline' : ''}">${stages.map((stage, index) => (
    `<li class="stage-card"><span class="chapter-index">${String(index + 1).padStart(2, '0')}${stage.timeLabel ? ` · ${escapeText(stage.timeLabel)}` : ''}</span><h4>${escapeText(stage.label)}</h4>${stage.description ? `<p>${escapeText(stage.description)}</p>` : ''}${stage.activities.length > 0 ? `<ul>${stage.activities.map((activity) => `<li>${escapeText(activity)}</li>`).join('')}</ul>` : ''}${stage.outputs.length > 0 ? `<p>产出：${escapeText(stage.outputs.join('、'))}</p>` : ''}</li>`
  )).join('')}</ol>`;
}

function renderTensionMap(units: readonly ReportEditorialPresentationUnitV1[], title: string): string {
  const nodes = units.flatMap((unit) => unit.shape === 'graph' ? unit.nodes : []);
  const labels = new Map(nodes.map(({ id, label }) => [id, label]));
  const relations = units.flatMap((unit) => unit.shape === 'graph'
    ? unit.edges.map(({ from, to, label }) => (
        `${labels.get(from) ?? from} → ${labels.get(to) ?? to}${label ? `：${label}` : ''}`
      ))
    : []);
  const left = nodes.filter((_node, index) => index % 2 === 0);
  const right = nodes.filter((_node, index) => index % 2 === 1);
  const side = (items: typeof nodes) => `<div class="tension-side">${items.map(({ label, description }) => `<div class="tension-item"><strong>${escapeText(label)}</strong>${description ? `<p>${escapeText(description)}</p>` : ''}</div>`).join('')}</div>`;
  return `<div class="showcase-tension-map">${side(left)}<div class="tension-core">${escapeText(title)}</div>${side(right)}</div>${relations.length === 0 ? '' : `<ul class="profile-relations">${relations.map((relation) => `<li>${escapeText(relation)}</li>`).join('')}</ul>`}`;
}

function renderPrinciples(units: readonly ReportEditorialPresentationUnitV1[]): string {
  const rows = units.flatMap((unit) => {
    if (unit.shape === 'record') return [{ title: unit.title ?? '原则', body: textForUnit(unit) }];
    if (unit.shape === 'records') return unit.records.map(({ title, body, fields }) => ({ title, body: body ?? fields.map(({ label, value }) => `${label}：${scalar(value)}`).join('；') }));
    return [{ title: unit.title ?? '原则', body: textForUnit(unit) }];
  });
  return `<div class="showcase-principle-list">${rows.map(({ title, body }, index) => `<div class="principle-row"><span class="principle-no">${String(index + 1).padStart(2, '0')}</span><strong>${escapeText(title)}</strong><p>${escapeText(body)}</p></div>`).join('')}</div>`;
}

function renderPriorityLanes(units: readonly ReportEditorialPresentationUnitV1[]): string {
  const actions = units.flatMap((unit) => unit.shape === 'actions' ? unit.actions : []);
  const priorities = (['P0', 'P1', 'P2'] as const)
    .filter((priority) => actions.some((action) => action.priority === priority));
  return `<div class="showcase-priority-lanes">${priorities.map((priority) => `<section class="priority-lane"><h4>${priority}</h4>${actions.filter((action) => action.priority === priority).map(({ action, owner, rationale, validationMethod }) => `<div class="priority-action"><strong>${escapeText(action)}</strong>${owner ? `<p>负责人：${escapeText(owner)}</p>` : ''}${rationale ? `<p>${escapeText(rationale)}</p>` : ''}${validationMethod ? `<p>验证：${escapeText(validationMethod)}</p>` : ''}</div>`).join('')}</section>`).join('')}</div>`;
}

function renderConfidence(
  component: EditorialShowcaseComponentV1,
  material: ReportEditorialMaterialV1,
  units: readonly ReportEditorialPresentationUnitV1[],
): string {
  const ownerByLeaf = new Map(units.flatMap((unit) => unit.leafIds.map((leafId) => [leafId, unit] as const)));
  return `<div class="showcase-confidence-bars">${component.sourceLeafIds.flatMap((leafId) => {
    const confidence = material.leafTraceIndex[leafId]?.support.confidence;
    if (confidence === undefined) return [];
    const label = ownerByLeaf.get(leafId)?.title ?? leafId;
    return [`<div class="confidence-row"><span>${escapeText(label)}</span><div class="confidence-track"><div class="confidence-fill" style="width:${Math.max(0, Math.min(100, confidence * 100))}%"></div></div><span class="confidence-value">${confidence.toFixed(2)}</span></div>`];
  }).join('')}</div><div class="showcase-narrative-list">${unitRows(units)}</div>`;
}

function renderSourceRegister(
  component: EditorialShowcaseComponentV1,
  manifest: EvidenceManifest,
  units: readonly ReportEditorialPresentationUnitV1[],
): string {
  const selected = manifest.entries.filter(({ id }) => component.evidenceIds.includes(id));
  const rows = selected.length > 0
    ? selected.map((entry) => `<div class="source-row"><span class="source-id">${escapeText(entry.id)}</span><span>${escapeText(entry.evidenceClass)}</span><span>${escapeText(entry.redaction === 'none' ? (entry.sourceUrl ?? `${entry.kind} · ${entry.jsonPointer}`) : `${entry.kind} · ${entry.redaction}`)}</span></div>`).join('')
    : '<p>无已绑定 Evidence。</p>';
  return `<div class="showcase-narrative-list">${unitRows(units)}</div><div class="showcase-source-register">${rows}</div>`;
}

function renderBody(input: {
  component: EditorialShowcaseComponentV1;
  material: ReportEditorialMaterialV1;
  evidenceManifest: EvidenceManifest;
  units: readonly ReportEditorialPresentationUnitV1[];
}): string {
  switch (input.component.kind) {
    case 'editorial-hero': return renderEditorialHero(input.component, input.material, input.units);
    case 'evidence-boundary': return renderEvidenceBoundary(input.material, input.units);
    case 'confidence-bars': return renderConfidence(input.component, input.material, input.units);
    case 'timeline': return renderStages(input.units, true);
    case 'profile-grid': return renderProfiles(input.units);
    case 'matrix': return renderMatrix(input.units);
    case 'stage-flow': return renderStages(input.units, false);
    case 'tension-map': return renderTensionMap(input.units, input.component.title);
    case 'principle-list': return renderPrinciples(input.units);
    case 'priority-lanes': return renderPriorityLanes(input.units);
    case 'validation-list': return `<div class="showcase-validation-list">${unitRows(input.units)}</div>`;
    case 'source-register': return renderSourceRegister(input.component, input.evidenceManifest, input.units);
    case 'narrative-list': return `<div class="showcase-narrative-list">${unitRows(input.units)}</div>`;
  }
}

function renderComponent(input: {
  component: EditorialShowcaseComponentV1;
  material: ReportEditorialMaterialV1;
  evidenceManifest: EvidenceManifest;
  units: ReadonlyMap<string, ReportEditorialPresentationUnitV1>;
}): string {
  const units = unitsFor(input.component, input.units);
  const body = renderBody({
    component: input.component,
    material: input.material,
    evidenceManifest: input.evidenceManifest,
    units,
  });
  return `<article class="showcase-component showcase-${escapeText(input.component.kind)} variant-${escapeText(input.component.variant)} emphasis-${escapeText(input.component.emphasis)} span-${escapeText(input.component.span)}" ${componentAttributes(input.component)}><div class="component-head"><h3>${escapeText(input.component.title)}</h3>${statusChip(input.component)}</div>${body}<div class="component-provenance">Leaf：${escapeText(input.component.sourceLeafIds.join(' · ') || 'none')}<br>Evidence：${escapeText(input.component.evidenceIds.join(' · ') || 'none')}</div></article>`;
}

function assertBindings(
  spec: EditorialPresentationSpecV1,
  material: ReportEditorialMaterialV1,
  evidenceManifest: EvidenceManifest,
  evidenceManifestArtifact?: { id: string; contentSha256: string },
): void {
  if (spec.profileId !== EDITORIAL_SHOWCASE_PROFILE_ID) throw new Error('Showcase profile is unsupported');
  const sectionIds = spec.sections.map(({ id }) => id);
  if (sectionIds.length !== new Set(sectionIds).size) {
    throw new Error('Showcase section IDs must be unique');
  }
  if (spec.showcaseOutlineSignature !== editorialShowcaseOutlineSignature(spec.sections)) {
    throw new Error('Showcase outline signature does not match its sections');
  }
  if (JSON.stringify(spec.notices) !== JSON.stringify(editorialShowcaseNotices(spec.generationMode))) {
    throw new Error('Showcase notices do not match its generation mode');
  }
  assertReportEditorialMaterialIntegrity(material);
  for (const key of ['taskId', 'planVersionId', 'attemptId', 'deliverableArtifactId', 'deliverableContentSha256', 'reportReviewArtifactId'] as const) {
    if (spec.binding[key] !== material.binding[key]) throw new Error(`Showcase binding ${key} does not match material`);
  }
  if (
    evidenceManifest.taskId !== spec.binding.taskId
    || evidenceManifest.planVersionId !== spec.binding.planVersionId
    || evidenceManifest.attemptId !== spec.binding.attemptId
  ) throw new Error('Showcase Evidence Manifest binding does not match');
  const evidenceBindingValues = [
    spec.binding.evidenceManifestArtifactId,
    spec.binding.evidenceManifestContentSha256,
    spec.binding.evidenceManifestHash,
  ];
  const hasAnyEvidenceBinding = evidenceBindingValues.some((value) => value !== undefined);
  if (hasAnyEvidenceBinding && evidenceBindingValues.some((value) => value === undefined)) {
    throw new Error('Showcase Evidence Manifest binding is incomplete');
  }
  if (hasAnyEvidenceBinding && !evidenceManifestArtifact) {
    throw new Error('Showcase bound Evidence Manifest requires Artifact identity');
  }
  if (
    spec.binding.evidenceManifestHash !== undefined
    && spec.binding.evidenceManifestHash !== evidenceManifest.manifestHash
  ) {
    throw new Error('Showcase Evidence Manifest semantic hash does not match');
  }
  if (evidenceManifestArtifact && (
    spec.binding.evidenceManifestArtifactId !== evidenceManifestArtifact.id
    || spec.binding.evidenceManifestContentSha256 !== evidenceManifestArtifact.contentSha256
    || spec.binding.evidenceManifestHash !== evidenceManifest.manifestHash
  )) {
    throw new Error('Showcase Evidence Manifest Artifact identity does not match');
  }
  const components = spec.sections.flatMap(({ components }) => components);
  const componentIds = components.map(({ id }) => id);
  if (componentIds.length !== new Set(componentIds).size) throw new Error('Showcase component IDs must be unique');
  const units = unitById(material);
  const ownedUnits = components.flatMap(({ ownedUnitIds }) => ownedUnitIds);
  if (
    !sameStringSet(ownedUnits, material.constraints.requiredPresentationUnitIds)
  ) throw new Error('Showcase rendered unit ownership is incomplete');
  for (const section of spec.sections) {
    if (section.title !== editorialShowcaseSectionTitle(section.purpose)) {
      throw new Error(`Showcase section ${section.id} section title does not match its purpose`);
    }
    for (const component of section.components) {
      const componentUnits = unitsFor(component, units);
      if (component.title !== editorialShowcaseComponentTitle(component.kind, componentUnits)) {
        throw new Error(`Showcase component ${component.id} component title does not match its units`);
      }
      const expectedOwnedLeaves = unique(componentUnits.flatMap(({ leafIds }) => leafIds));
      if (!sameStringSet(component.ownedLeafIds, expectedOwnedLeaves)) {
        throw new Error(`Showcase component ${component.id} owned leaves do not match its units`);
      }
      for (const leafId of component.sourceLeafIds) {
        if (!material.leafTraceIndex[leafId]) {
          throw new Error(`Showcase component ${component.id} references unknown source leaf ${leafId}`);
        }
      }
      if (component.ownedLeafIds.some((leafId) => !component.sourceLeafIds.includes(leafId))) {
        throw new Error(`Showcase component ${component.id} source leaves do not include its owned leaves`);
      }
      const expectedEvidenceIds = derivedEvidenceIds(material, component.sourceLeafIds);
      if (!sameStringSet(component.evidenceIds, expectedEvidenceIds)) {
        throw new Error(`Showcase component ${component.id} Evidence IDs do not match its source leaves`);
      }
      if (component.status !== derivedStatus(material, component.sourceLeafIds)) {
        throw new Error(`Showcase component ${component.id} status does not match its source leaves`);
      }
      if (component.confidence !== derivedConfidence(material, component.sourceLeafIds)) {
        throw new Error(`Showcase component ${component.id} confidence does not match its source leaves`);
      }
    }
  }
  const ownedLeaves = components.flatMap(({ ownedLeafIds }) => ownedLeafIds);
  if (
    ownedLeaves.length !== new Set(ownedLeaves).size
    || ownedLeaves.length !== material.constraints.requiredLeafUnitIds.length
    || material.constraints.requiredLeafUnitIds.some((leafId) => !ownedLeaves.includes(leafId))
  ) throw new Error('Showcase rendered leaf ownership is incomplete');
  const evidenceIds = new Set(evidenceManifest.entries.map(({ id }) => id));
  const simulationIds = new Set(evidenceManifest.entries
    .filter(({ evidenceClass }) => evidenceClass === 'simulation')
    .map(({ id }) => id));
  const blockedEvidenceIds = new Set(evidenceManifest.entries
    .filter(({ redaction }) => redaction === 'blocked')
    .map(({ id }) => id));
  for (const section of spec.sections) {
    for (const component of section.components) {
      const blockedEvidence = component.evidenceIds.filter((evidenceId) => blockedEvidenceIds.has(evidenceId));
      if (blockedEvidence.length > 0) {
        throw new Error(`Blocked Evidence ${blockedEvidence.join(', ')} cannot be rendered in Showcase`);
      }
      const simulationEvidence = component.evidenceIds.filter((evidenceId) => simulationIds.has(evidenceId));
      if (
        simulationEvidence.length > 0
        && !(section.prominence === 'appendix' && component.kind === 'source-register')
      ) {
        throw new Error(
          `Simulation Evidence ${simulationEvidence.join(', ')} must remain in an appendix source-register quarantine`,
        );
      }
    }
  }
  for (const evidenceId of components.flatMap(({ evidenceIds: ids }) => ids)) {
    if (!evidenceIds.has(evidenceId)) throw new Error(`Showcase references unknown Evidence ${evidenceId}`);
  }
}

export function renderEditorialShowcase(input: {
  spec: EditorialPresentationSpecV1;
  material: ReportEditorialMaterialV1;
  evidenceManifest: EvidenceManifest;
  evidenceManifestArtifact?: { id: string; contentSha256: string };
  sourceSpecContentSha256?: string;
}): EditorialShowcaseRenderResult {
  assertBindings(input.spec, input.material, input.evidenceManifest, input.evidenceManifestArtifact);
  const units = unitById(input.material);
  const navigation = input.spec.sections.map((section, index) => (
    `<li><a href="#${escapeText(section.id)}"><span class="index">${String(index + 1).padStart(2, '0')}</span>${escapeText(section.title)}</a></li>`
  )).join('');
  const sections = input.spec.sections.map((section, index) => {
    const header = `<div class="chapter-head"><div class="chapter-index">${String(index + 1).padStart(2, '0')} / ${escapeText(section.purpose.toUpperCase())}</div><div><h2>${escapeText(section.title)}</h2><p class="chapter-lead">内容由 Reviewed Canonical 与可追溯来源确定性编排。</p></div></div>`;
    const componentGrid = `<div class="component-grid">${section.components.map((component) => renderComponent({ component, material: input.material, evidenceManifest: input.evidenceManifest, units })).join('')}</div>`;
    const body = section.prominence === 'appendix'
      ? `<details class="appendix-disclosure"><summary>展开完整分析附件</summary>${componentGrid}</details>`
      : componentGrid;
    return `<section class="chapter chapter-${escapeText(section.prominence)} layout-${escapeText(section.layout)}" id="${escapeText(section.id)}" data-purpose="${escapeText(section.purpose)}">${header}${body}</section>`;
  }).join('');
  const primaryComponents = input.spec.sections
    .filter(({ prominence }) => prominence === 'primary')
    .flatMap(({ components }) => components);
  const primaryStatuses = primaryComponents
    .map(({ status }) => status)
    .filter((status): status is 'supported' | 'provisional' | 'unanswered' => status !== undefined);
  const coverStatus = primaryStatuses.includes('unanswered')
    ? 'unanswered'
    : primaryStatuses.includes('provisional')
      ? 'provisional'
      : primaryStatuses.includes('supported')
        ? 'supported'
        : undefined;
  const primaryConfidences = primaryComponents.map(({ confidence }) => confidence);
  const coverConfidence = primaryConfidences.some((value) => value === undefined)
    ? undefined
    : (primaryConfidences as number[]).sort((left, right) => left - right)[0];
  const confidenceNotice = '<p class="confidence-disclaimer">置信度仅表示来源支持强度，不代表用户占比、发生概率或效果预测。</p>';
  const cover = `<header class="cover"><div><p class="cover-kicker">EDITORIAL SHOWCASE · REVIEWED CANONICAL</p><h1>${escapeText(input.material.document.title)}</h1><p class="cover-deck">${escapeText(input.material.document.executiveAnswer ?? input.material.document.decisionContext ?? '本报告基于已审材料生成。')}</p><div class="cover-meta"><span class="cover-chip">${input.spec.sections.length} 个章节</span><span class="cover-chip">${primaryComponents.length} 个主展示组件</span><span class="cover-chip">${escapeText(input.spec.generationMode)}</span></div></div><aside class="cover-panel"><h2>证据约束</h2><p>所有正文均来自 Reviewed Canonical。状态、置信度和 Evidence 由 Compiler 派生，展示层不产生新的研究事实。</p>${confidenceNotice}${coverStatus ? `<span class="status status-${escapeText(coverStatus)}">${escapeText(coverStatus)}</span>` : ''}${coverConfidence === undefined ? '' : `<p>最低来源置信度：${coverConfidence.toFixed(2)}</p>`}</aside></header>`;
  const specBinding = input.sourceSpecContentSha256
    ? `<meta name="showcase-spec-sha256" content="${escapeText(input.sourceSpecContentSha256)}">`
    : '';
  const evidenceBinding = input.spec.binding.evidenceManifestArtifactId
    && input.spec.binding.evidenceManifestContentSha256
    && input.spec.binding.evidenceManifestHash
    ? `<meta name="source-evidence-manifest-id" content="${escapeText(input.spec.binding.evidenceManifestArtifactId)}"><meta name="source-evidence-manifest-sha256" content="${escapeText(input.spec.binding.evidenceManifestContentSha256)}"><meta name="source-evidence-manifest-hash" content="${escapeText(input.spec.binding.evidenceManifestHash)}">`
    : '';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=1440"><meta name="color-scheme" content="light"><meta name="showcase-profile" content="${escapeText(input.spec.profileId)}"><meta name="showcase-outline-signature" content="${escapeText(input.spec.showcaseOutlineSignature)}">${specBinding}${evidenceBinding}<meta name="source-deliverable-sha256" content="${escapeText(input.spec.binding.deliverableContentSha256)}"><meta name="showcase-renderer-version" content="${EDITORIAL_SHOWCASE_RENDERER_VERSION}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeText(input.material.document.title)}</title><style>${EDITORIAL_SHOWCASE_PROFILE_CSS}</style></head><body data-showcase-profile="${escapeText(input.spec.profileId)}" data-generation-mode="${escapeText(input.spec.generationMode)}"><a class="skip-link" href="#showcase-main">跳到正文</a><div class="shell"><nav class="toc" aria-label="报告目录"><div><div class="brand"><span class="brand-dot"></span>AI-X Research</div><small>Editorial showcase</small><ol>${navigation}</ol></div><p class="toc-note">Reviewed Canonical · ${escapeText(EDITORIAL_SHOWCASE_RENDERER_VERSION)}</p></nav><main class="report" id="showcase-main">${cover}${input.spec.notices.length === 0 ? '' : `<aside class="chapter"><h2>生成说明</h2><ul>${input.spec.notices.map(({ message }) => `<li>${escapeText(message)}</li>`).join('')}</ul></aside>`}${sections}<footer class="report-footer">${escapeText(input.material.document.title)} · ${escapeText(input.spec.profileId)}</footer></main></div></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > MAX_SHOWCASE_HTML_BYTES) {
    throw new Error(`Editorial Showcase HTML exceeds ${MAX_SHOWCASE_HTML_BYTES} bytes`);
  }
  const components = input.spec.sections.flatMap(({ components }) => components);
  return {
    html,
    renderManifest: {
      version: 'editorial-showcase-render-manifest-v1',
      rendererVersion: EDITORIAL_SHOWCASE_RENDERER_VERSION,
      profileId: EDITORIAL_SHOWCASE_PROFILE_V1,
      showcaseOutlineSignature: input.spec.showcaseOutlineSignature,
      componentIds: components.map(({ id }) => id),
      ownedLeafIds: components.flatMap(({ ownedLeafIds }) => ownedLeafIds),
      sourceLeafIds: unique(components.flatMap(({ sourceLeafIds }) => sourceLeafIds)),
      evidenceIds: unique(components.flatMap(({ evidenceIds }) => evidenceIds)),
    },
  };
}

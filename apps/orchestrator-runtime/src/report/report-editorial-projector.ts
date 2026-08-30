import type {
  EditorialScalar,
  ReportAuditAppendixMaterialV1,
  ReportEditorialBlueprintBlockV1,
  ReportEditorialBlueprintV1,
  ReportEditorialCopySelectionV2,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import type {
  ReportAnswerKindV3,
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
  ReportEditorialCopyFragmentV4,
  ReportListItemV3,
  ReportNoticeV1,
  ReportRecordTableBlockV3,
  ReportSectionV3,
  ReportSectionV4,
  ReportViewIdV1,
} from '../../../../packages/api-contract/report-document.ts';
import {
  assertReportAuditAppendixMaterialIntegrity,
  assertReportEditorialBlueprintIntegrity,
} from '../../../../packages/report-rendering/report-editorial-validation.ts';
import {
  assertReportDocumentV3Integrity,
  assertReportDocumentV4Integrity,
  collectReportDocumentV3Semantics,
  collectReportDocumentV4Semantics,
} from '../../../../packages/report-rendering/report-document-visitor.ts';
import {
  projectEditorialCardGridBlockV4,
  projectEditorialStageFlowBlockV4,
} from './report-editorial-rich-block-projector.ts';

const VIEW_LABELS: Record<ReportViewIdV1, string> = {
  answers: '答案概览 / Answer Overview',
  topics: '策略框架 / Strategy Framework',
  actions: '机会与行动 / Opportunities and Actions',
  evidence: '证据与局限 / Evidence and Limitations',
  analysis: '分析底稿 / Analysis Notes',
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function pad(index: number): string {
  return String(index + 1).padStart(3, '0');
}

function scalarText(value: EditorialScalar): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function unitTitle(units: readonly ReportEditorialPresentationUnitV1[]): string | undefined {
  const titles = unique(units.map(({ title }) => title?.trim()).filter((value): value is string => Boolean(value)));
  return titles.length === 1 ? titles[0] : undefined;
}

function fallbackBlockTitle(units: readonly ReportEditorialPresentationUnitV1[]): string {
  const kinds = unique(units.map(({ semanticKind }) => semanticKind));
  if (kinds.length !== 1) return '报告材料';
  switch (kinds[0]) {
    case 'direct_answer': return '直接答案';
    case 'comparison_matrix': return '比较矩阵';
    case 'strategy_map': return '策略地图';
    case 'mind_model': return '心智模型';
    case 'design_principle': return '设计原则';
    case 'opportunity': return '机会清单';
    case 'prioritized_action': return '优先行动';
    case 'action_plan': return '行动计划';
    case 'channel_strategy': return '渠道策略';
    case 'evidence_finding': return '证据发现';
    case 'limitation': return '局限';
    case 'open_question': return '待解决问题';
    case 'risk': return '风险';
    case 'requested_artifact_binding': return '请求交付物绑定';
    case 'visual_asset': return '视觉素材';
    case 'visual_comparison': return '视觉对比';
    case 'verified_chart': return '图表';
    case 'narrative': return '分析正文';
    default: return '报告材料';
  }
}

function blockTitle(units: readonly ReportEditorialPresentationUnitV1[]): string {
  return unitTitle(units) ?? fallbackBlockTitle(units);
}

function humanReadableSourceTitle(
  unit: ReportEditorialPresentationUnitV1,
): string | undefined {
  const title = unit.title?.trim();
  if (!title) return undefined;
  const normalizedTitle = title.toLocaleLowerCase('en-US');
  const sourceIdParts = unit.id
    .split(':')
    .map((part) => part.trim().toLocaleLowerCase('en-US'));
  if (sourceIdParts.includes(normalizedTitle)) return undefined;
  if (/^[a-z][a-z0-9]*(?:[-_:][a-z0-9]+)+$/u.test(title)) return undefined;
  if (/^(?:[0-9a-f]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(title)) return undefined;
  return title;
}

function answerKind(unit: ReportEditorialPresentationUnitV1): ReportAnswerKindV3 {
  switch (unit.semanticKind) {
    case 'direct_answer': return 'direct_answer';
    case 'evidence_finding': return 'evidence_finding';
    case 'comparison_matrix': return 'comparison_matrix';
    case 'strategy_map': return 'strategy_map';
    case 'mind_model': return 'mind_model';
    case 'design_principle': return 'design_principle';
    case 'opportunity': return 'opportunity';
    case 'prioritized_action': return 'priority_matrix';
    case 'action_plan': return 'action_plan';
    case 'channel_strategy': return 'channel_strategy';
    case 'limitation': return 'limitation';
    case 'open_question': return 'open_question';
    case 'risk': return 'risk';
    default: return 'evidence_finding';
  }
}

function recordText(unit: Extract<ReportEditorialPresentationUnitV1, { shape: 'record' }>): string {
  return unit.fields.map(({ label, value }) => `${label}：${scalarText(value)}`).join('；');
}

function listItems(
  units: readonly ReportEditorialPresentationUnitV1[],
  blockId: string,
): ReportListItemV3[] {
  const items: ReportListItemV3[] = [];
  for (const unit of units) {
    if (unit.shape === 'text') {
      items.push({ id: `${blockId}-item-${pad(items.length)}`, leafRef: unit.leafId, label: unit.title, text: unit.text });
    } else if (unit.shape === 'record') {
      items.push({ id: `${blockId}-item-${pad(items.length)}`, leafRef: unit.leafId, label: unit.title, text: recordText(unit) });
    } else if (unit.shape === 'matrix') {
      for (const cell of unit.cells) {
        items.push({
          id: `${blockId}-item-${pad(items.length)}`,
          leafRef: cell.leafId,
          label: `${cell.row} × ${cell.column}`,
          text: scalarText(cell.value),
        });
      }
    } else if (unit.shape === 'graph') {
      for (const node of unit.nodes) {
        items.push({
          id: `${blockId}-item-${pad(items.length)}`,
          leafRef: node.leafId,
          label: node.label,
          text: node.description,
        });
      }
      for (const edge of unit.edges) {
        items.push({
          id: `${blockId}-item-${pad(items.length)}`,
          leafRef: edge.leafId,
          label: `${edge.from} → ${edge.to}`,
          text: edge.label,
        });
      }
    } else if (unit.shape === 'actions') {
      for (const action of unit.actions) {
        items.push({
          id: `${blockId}-item-${pad(items.length)}`,
          leafRef: action.leafId,
          label: action.priority,
          text: [
            action.action,
            action.owner ? `Owner：${action.owner}` : '',
            action.rationale ? `依据：${action.rationale}` : '',
            action.validationMethod ? `验证：${action.validationMethod}` : '',
          ].filter(Boolean).join('；'),
        });
      }
    } else if (unit.shape === 'records') {
      for (const record of unit.records) {
        const fields = record.fields
          .map(({ label, value }) => `${label}：${scalarText(value)}`)
          .join('；');
        items.push({
          id: `${blockId}-item-${pad(items.length)}`,
          leafRef: record.leafId,
          label: record.title,
          text: [record.body, fields, record.status ? `状态：${record.status}` : '']
            .filter(Boolean)
            .join('；'),
        });
      }
    } else if (unit.shape === 'stages') {
      for (const stage of unit.stages) {
        items.push({
          id: `${blockId}-item-${pad(items.length)}`,
          leafRef: stage.leafId,
          label: stage.label,
          text: [
            stage.description,
            stage.timeLabel ? `周期：${stage.timeLabel}` : '',
            stage.activities.length > 0 ? `活动：${stage.activities.join('；')}` : '',
            stage.outputs.length > 0 ? `产出：${stage.outputs.join('；')}` : '',
          ].filter(Boolean).join('；'),
        });
      }
    } else {
      throw new Error(`presentation list cannot project ${unit.shape} unit ${unit.id}`);
    }
  }
  return items;
}

function recordTable(
  units: readonly ReportEditorialPresentationUnitV1[],
  base: Pick<ReportRecordTableBlockV3, 'id' | 'title' | 'visibility' | 'unitRefs' | 'leafRefs'>,
): ReportRecordTableBlockV3 {
  const first = units[0]!;
  if (first.shape === 'record' && units.every(({ shape }) => shape === 'record')) {
    const recordUnits = units as Array<Extract<ReportEditorialPresentationUnitV1, { shape: 'record' }>>;
    const fields = new Map<string, string>();
    for (const unit of recordUnits) for (const field of unit.fields) fields.set(field.key, field.label);
    const columns = [...fields].map(([key, label]) => ({ key, label }));
    return {
      ...base,
      type: 'record-table',
      columns,
      rows: recordUnits.map((unit, index) => ({
        id: `${base.id}-row-${pad(index)}`,
        label: unit.title,
        cells: columns.map(({ key }) => ({
          leafRef: unit.leafId,
          columnKey: key,
          value: unit.fields.find((field) => field.key === key)?.value ?? null,
        })),
      })),
    };
  }
  if (first.shape === 'matrix' && units.length === 1) {
    const cellsByRow = new Map<string, Map<string, (typeof first.cells)[number]>>();
    for (const cell of first.cells) {
      const row = cellsByRow.get(cell.row) ?? new Map<string, (typeof first.cells)[number]>();
      if (row.has(cell.column)) {
        throw new Error(`matrix ${first.id} contains duplicate cell ${cell.row} × ${cell.column}`);
      }
      row.set(cell.column, cell);
      cellsByRow.set(cell.row, row);
    }
    const columns = first.columns.map((label, index) => ({
      key: `column-${pad(index)}`,
      label,
    }));
    return {
      ...base,
      type: 'record-table',
      columns,
      rows: first.rows.map((rowLabel, index) => ({
        id: `${base.id}-row-${pad(index)}`,
        label: rowLabel,
        cells: columns.map(({ key }, columnIndex) => {
          const columnLabel = first.columns[columnIndex]!;
          const cell = cellsByRow.get(rowLabel)?.get(columnLabel);
          if (!cell) {
            throw new Error(`matrix ${first.id} is missing cell ${rowLabel} × ${columnLabel}`);
          }
          return { leafRef: cell.leafId, columnKey: key, value: cell.value };
        }),
      })),
    };
  }
  if (first.shape === 'actions' && units.every(({ shape }) => shape === 'actions')) {
    const actions = units.flatMap((unit) => unit.shape === 'actions' ? unit.actions : []);
    const columns = [
      { key: 'priority', label: '优先级' },
      { key: 'action', label: '行动' },
      { key: 'owner', label: 'Owner' },
      { key: 'rationale', label: '依据' },
      { key: 'validation', label: '验证方式' },
    ];
    return {
      ...base,
      type: 'record-table',
      columns,
      rows: actions.map((action, index) => ({
        id: `${base.id}-row-${pad(index)}`,
        cells: [
          { leafRef: action.leafId, columnKey: 'priority', value: action.priority ?? null },
          { leafRef: action.leafId, columnKey: 'action', value: action.action },
          { leafRef: action.leafId, columnKey: 'owner', value: action.owner ?? null },
          { leafRef: action.leafId, columnKey: 'rationale', value: action.rationale ?? null },
          { leafRef: action.leafId, columnKey: 'validation', value: action.validationMethod ?? null },
        ],
      })),
    };
  }
  if (first.shape === 'chart' && units.length === 1) {
    const columns = first.table.columns.map((label, index) => ({ key: `column-${pad(index)}`, label }));
    return {
      ...base,
      type: 'record-table',
      columns,
      rows: first.table.rows.map((row, rowIndex) => ({
        id: `${base.id}-row-${pad(rowIndex)}`,
        label: row.label,
        cells: columns.map(({ key }, cellIndex) => ({
          leafRef: first.leafId,
          columnKey: key,
          value: row.cells[cellIndex] ?? null,
        })),
      })),
    };
  }
  throw new Error(`record-table ${base.id} received incompatible source shapes`);
}

function assetCaption(unit: Extract<ReportEditorialPresentationUnitV1, { shape: 'asset' }>): string {
  if (unit.sourceSummary.kind === 'browser_capture') {
    return `${unit.sourceSummary.pageTitle}（${unit.sourceSummary.domain}，${unit.sourceSummary.capturedAt}）`;
  }
  if (unit.sourceSummary.kind === 'user_upload') {
    return `${unit.sourceSummary.role}：${unit.sourceSummary.fileName}`;
  }
  return unit.sourceSummary.role;
}

function projectBlock(input: {
  block: ReportEditorialBlueprintBlockV1;
  units: ReportEditorialPresentationUnitV1[];
  sectionIndex: number;
  blockIndex: number;
  material: ReportEditorialMaterialV1;
}): ReportBlockV3 {
  const id = `block-${pad(input.sectionIndex)}-${pad(input.blockIndex)}`;
  const unitRefs = input.units.map(({ id: unit }) => unit);
  const leafRefs = unique(input.units.flatMap(({ leafIds }) => leafIds));
  const title = blockTitle(input.units);
  const base = { id, title, visibility: input.block.visibility, unitRefs, leafRefs };
  const first = input.units[0]!;
  switch (input.block.presentation) {
    case 'paragraph':
    case 'fact': {
      if (input.units.length !== 1 || first.shape !== 'text') {
        throw new Error(`${input.block.presentation} ${id} requires one text unit`);
      }
      return { ...base, type: input.block.presentation, leafRef: first.leafId, text: first.text };
    }
    case 'answer': {
      if (input.units.length !== 1 || (first.shape !== 'text' && first.shape !== 'record')) {
        throw new Error(`answer ${id} requires one text or record unit`);
      }
      if (first.shape === 'text') {
        return {
          ...base,
          type: 'answer',
          kind: answerKind(first),
          textLeafRef: first.leafId,
          text: first.text,
          items: [],
          answerStatus: input.material.leafTraceIndex[first.leafId]?.support.status,
        };
      }
      const answerField = first.fields.find(({ key }) => key === 'answer')
        ?? first.fields.find(({ key }) => key === 'statement')
        ?? first.fields[0]!;
      const remaining = first.fields.filter(({ key }) => key !== answerField.key);
      return {
        ...base,
        type: 'answer',
        kind: answerKind(first),
        textLeafRef: first.leafId,
        text: scalarText(answerField.value),
        items: remaining.map((field, index) => ({
          id: `${id}-item-${pad(index)}`,
          leafRef: first.leafId,
          label: field.label,
          text: scalarText(field.value),
        })),
        answerStatus: input.material.leafTraceIndex[first.leafId]?.support.status,
      };
    }
    case 'list':
      return { ...base, type: 'list', ordered: false, items: listItems(input.units, id) };
    case 'record-table':
      return recordTable(input.units, base);
    case 'graph': {
      if (input.units.length !== 1 || first.shape !== 'graph' || input.block.variant === undefined) {
        throw new Error(`graph ${id} requires one graph unit and a variant`);
      }
      return {
        ...base,
        type: 'graph',
        variant: input.block.variant,
        nodes: first.nodes.map((node) => ({
          id: node.id,
          leafRef: node.leafId,
          label: node.label,
          ...(node.description ? { description: node.description } : {}),
        })),
        edges: first.edges.map((edge) => ({
          id: edge.id,
          leafRef: edge.leafId,
          from: edge.from,
          to: edge.to,
          ...(edge.label ? { label: edge.label } : {}),
        })),
      };
    }
    case 'priority-board': {
      if (input.units.some(({ shape }) => shape !== 'actions')) {
        throw new Error(`priority-board ${id} requires action units`);
      }
      const actions = input.units.flatMap((unit) => unit.shape === 'actions' ? unit.actions : []);
      const groups = (['P0', 'P1', 'P2'] as const).flatMap((priority) => {
        const members = actions.filter((action) => action.priority === priority);
        return members.length === 0 ? [] : [{
          priority,
          items: members.map((action, index) => ({
            id: `${id}-${priority.toLocaleLowerCase('en-US')}-${pad(index)}`,
            leafRef: action.leafId,
            action: action.action,
            ...(action.owner ? { owner: action.owner } : {}),
            ...(action.rationale ? { rationale: action.rationale } : {}),
            ...(action.validationMethod ? { validationMethod: action.validationMethod } : {}),
          })),
        }];
      });
      return { ...base, type: 'priority-board', groups };
    }
    case 'card-grid':
    case 'stage-flow':
      throw new Error(`${input.block.presentation} ${id} requires ReportDocument v4 projection`);
    case 'image': {
      if (input.units.length !== 1 || first.shape !== 'asset') throw new Error(`image ${id} requires one Asset unit`);
      const caption = assetCaption(first);
      return {
        ...base,
        type: 'image',
        leafRef: first.leafId,
        assetRef: {
          assetId: first.assetRef.assetId,
          manifestArtifactId: first.assetRef.manifestArtifactId,
        },
        caption,
        altText: caption,
      };
    }
    case 'image-comparison': {
      if (input.units.length !== 1 || first.shape !== 'asset_pair') {
        throw new Error(`image-comparison ${id} requires one Asset pair unit`);
      }
      return {
        ...base,
        type: 'image-comparison',
        beforeLeafRef: first.original.leafId,
        afterLeafRef: first.annotation.leafId,
        beforeAssetRef: {
          assetId: first.original.assetRef.assetId,
          manifestArtifactId: first.original.assetRef.manifestArtifactId,
        },
        afterAssetRef: {
          assetId: first.annotation.assetRef.assetId,
          manifestArtifactId: first.annotation.assetRef.manifestArtifactId,
        },
        caption: '原图与标注图对比',
        altText: '原图与标注图对比',
      };
    }
    case 'chart': {
      if (input.units.length !== 1 || first.shape !== 'chart') throw new Error(`chart ${id} requires one Chart unit`);
      return {
        ...base,
        type: 'chart',
        leafRef: first.leafId,
        chartRef: {
          chartId: first.chartRef.chartId,
          assetId: first.chartRef.assetId,
          manifestArtifactId: first.chartRef.manifestArtifactId,
        },
        specHash: first.specHash,
        spec: first.spec,
        table: first.table,
        caption: first.spec.title,
        altText: first.spec.title,
      };
    }
  }
}

function sectionTitle(input: {
  section: ReportEditorialBlueprintV1['sections'][number];
  units: ReportEditorialPresentationUnitV1[];
  viewOrdinal: number;
  usedTitles: Set<string>;
}): string {
  const viewLabel = VIEW_LABELS[input.section.view];
  const sourceTitle = input.section.headingMode === 'first_source_title'
    ? input.units.map(humanReadableSourceTitle).find((title) => title !== undefined)
    : undefined;
  let title = sourceTitle && !input.usedTitles.has(sourceTitle) ? sourceTitle : viewLabel;
  if (input.usedTitles.has(title)) title = `${viewLabel} ${input.viewOrdinal}`;
  input.usedTitles.add(title);
  return title;
}

function needsLinearizationNotice(
  unit: ReportEditorialPresentationUnitV1,
  presentation: ReportEditorialBlueprintBlockV1['presentation'],
): boolean {
  if (unit.semanticKind === 'comparison_matrix' || unit.semanticKind === 'strategy_map') {
    return presentation !== 'record-table';
  }
  if (unit.semanticKind === 'mind_model') return presentation !== 'graph';
  if (unit.semanticKind === 'opportunity' || unit.semanticKind === 'channel_strategy' || unit.semanticKind === 'action_plan') {
    return presentation !== 'record-table';
  }
  if (unit.semanticKind === 'prioritized_action') return presentation !== 'priority-board';
  if (unit.shape === 'records') return presentation !== 'card-grid';
  if (unit.shape === 'stages') return presentation !== 'stage-flow';
  return false;
}

function projectBlockV4(input: {
  block: ReportEditorialBlueprintBlockV1;
  units: ReportEditorialPresentationUnitV1[];
  sectionIndex: number;
  blockIndex: number;
  material: ReportEditorialMaterialV1;
}): ReportBlockV4 {
  const id = `block-${pad(input.sectionIndex)}-${pad(input.blockIndex)}`;
  const base = {
    id,
    title: blockTitle(input.units),
    visibility: input.block.visibility,
    unitRefs: input.units.map(({ id: unitId }) => unitId),
    leafRefs: unique(input.units.flatMap(({ leafIds }) => leafIds)),
  };
  if (input.block.presentation === 'card-grid') {
    const unit = input.units[0];
    if (input.units.length !== 1 || unit?.shape !== 'records') {
      throw new Error(`card-grid ${id} requires one records unit`);
    }
    return projectEditorialCardGridBlockV4(unit, base);
  }
  if (input.block.presentation === 'stage-flow') {
    const unit = input.units[0];
    if (input.units.length !== 1 || unit?.shape !== 'stages') {
      throw new Error(`stage-flow ${id} requires one stages unit`);
    }
    return projectEditorialStageFlowBlockV4(unit, base);
  }
  return projectBlock(input);
}

function copyTargetKey(target: ReportEditorialCopySelectionV2['fragments'][number]['target']): string {
  switch (target.kind) {
    case 'report_title':
    case 'executive_summary':
      return target.kind;
    case 'section_title':
    case 'section_lead':
    case 'section_transition':
      return `${target.kind}:${target.sectionIndex}`;
    case 'block_digest':
      return `${target.kind}:${target.sectionIndex}:${target.blockIndex}`;
  }
}

function copyFragmentId(targetKey: string): string {
  return `copy-${targetKey.replaceAll(':', '-')}`;
}

function modelCopyFragment(
  fragment: ReportEditorialCopySelectionV2['fragments'][number],
): ReportEditorialCopyFragmentV4 {
  const key = copyTargetKey(fragment.target);
  return {
    id: copyFragmentId(key),
    provenance: 'model',
    text: fragment.text,
    sourceLeafIds: [...fragment.sourceLeafIds],
  };
}

function fallbackCopyFragment(input: {
  targetKey: string;
  text: string;
  provenance: 'canonical' | 'system';
  sourceLeafIds?: string[];
}): ReportEditorialCopyFragmentV4 {
  return {
    id: copyFragmentId(input.targetKey),
    provenance: input.provenance,
    text: input.text,
    sourceLeafIds: input.sourceLeafIds ?? [],
  };
}

function copyMode(input: {
  acceptedKeys: ReadonlySet<string>;
  requiredKeys: readonly string[];
  rejectedCount: number;
}): ReportDocumentV4['copyMode'] {
  if (input.acceptedKeys.size === 0) return 'fallback';
  return input.rejectedCount === 0
    && input.requiredKeys.every((key) => input.acceptedKeys.has(key))
    ? 'model'
    : 'mixed';
}

export function assertReportEditorialProjectionCoverage(
  material: ReportEditorialMaterialV1,
  document: ReportDocumentV3,
): void {
  const semantics = collectReportDocumentV3Semantics(document);
  const sameSet = (left: readonly string[], right: readonly string[]) => {
    if (left.length !== right.length) return false;
    const expected = new Set(right);
    return left.every((value) => expected.has(value));
  };
  if (!sameSet(semantics.presentationUnitIds, material.constraints.requiredPresentationUnitIds)) {
    throw new Error('ReportDocument v3 presentation-unit coverage does not match Material');
  }
  if (!sameSet(semantics.leafUnitIds, material.constraints.requiredLeafUnitIds)) {
    throw new Error('ReportDocument v3 leaf coverage does not match Material');
  }
}

export function projectReportEditorialDocumentV3(input: {
  material: ReportEditorialMaterialV1;
  blueprint: ReportEditorialBlueprintV1;
  layoutMode?: 'model' | 'fallback';
  auditAppendix?: ReportAuditAppendixMaterialV1;
  notices?: ReportNoticeV1[];
}): ReportDocumentV3 {
  assertReportEditorialBlueprintIntegrity(input.material, input.blueprint);
  if (input.auditAppendix) assertReportAuditAppendixMaterialIntegrity(input.material, input.auditAppendix);
  const unitsById = new Map(input.material.presentationUnits.map((unit) => [unit.id, unit]));
  const viewCounts = new Map<ReportViewIdV1, number>();
  const usedTitles = new Set<string>();
  const linearizedUnitIds: string[] = [];
  const sections: ReportSectionV3[] = input.blueprint.sections.map((section, sectionIndex) => {
    const units = section.blocks.flatMap(({ unitRefs }) => unitRefs.map((id) => unitsById.get(id)!));
    const viewOrdinal = (viewCounts.get(section.view) ?? 0) + 1;
    viewCounts.set(section.view, viewOrdinal);
    const blocks = section.blocks.map((block, blockIndex) => {
      const blockUnits = block.unitRefs.map((id) => unitsById.get(id)!);
      const projected = projectBlock({ block, units: blockUnits, sectionIndex, blockIndex, material: input.material });
      const affected = blockUnits.filter((unit) => needsLinearizationNotice(unit, block.presentation));
      linearizedUnitIds.push(...affected.map(({ id }) => id));
      return projected;
    });
    return {
      id: `section-${pad(sectionIndex)}-${section.view}`,
      title: sectionTitle({ section, units, viewOrdinal, usedTitles }),
      view: section.view,
      prominence: section.prominence,
      blocks,
    };
  });
  const suppliedNotices = input.notices ?? [];
  const notices: ReportNoticeV1[] = [
    ...suppliedNotices,
    ...(linearizedUnitIds.length > 0 ? [{
      id: 'notice-visualization-linearized-001',
      code: 'visualization_linearized' as const,
      severity: 'info' as const,
      scope: 'report' as const,
      relatedUnitIds: unique(linearizedUnitIds),
    }] : []),
  ];
  if (new Set(notices.map(({ id }) => id)).size !== notices.length) {
    throw new Error('ReportDocument v3 Notice IDs must be unique');
  }
  const traceIndex = Object.fromEntries(input.material.constraints.requiredLeafUnitIds.map((id) => {
    const value = input.material.leafTraceIndex[id]!;
    return [id, {
      supportMode: value.supportMode,
      origins: value.origins.map((origin) => ({ ...origin, sourceNodeIds: [...origin.sourceNodeIds] })),
      questionIds: [...value.support.questionIds],
      evidenceIds: [...value.support.evidenceIds],
      findingIds: [...value.support.findingIds],
      summaryIds: [...value.support.summaryIds],
      ...(value.support.status === undefined ? {} : { status: value.support.status }),
      ...(value.support.confidence === undefined ? {} : { confidence: value.support.confidence }),
    }];
  }));
  const auditAppendix = input.auditAppendix
    ? {
        version: 'report-audit-appendix-v1' as const,
        visibility: 'collapsible' as const,
        sourceArtifactIds: unique(input.auditAppendix.records.map(({ contributionArtifactId }) => contributionArtifactId)),
        records: input.auditAppendix.records.map((record) => ({
          ...record,
          canonicalNodeIds: [...record.canonicalNodeIds],
          reviewIssueIds: [...record.reviewIssueIds],
        })),
      }
    : undefined;
  const document: ReportDocumentV3 = {
    version: 'report-document-v3',
    title: input.material.document.title,
    subtitle: input.material.document.decisionContext ?? 'Reviewed research strategy report',
    executiveSummary: input.material.document.executiveAnswer ?? input.material.document.title,
    style: input.blueprint.style,
    density: input.blueprint.density,
    sections,
    sourceDeliverableArtifactId: input.material.binding.deliverableArtifactId,
    sourceDeliverableContentSha256: input.material.binding.deliverableContentSha256,
    projectionMode: 'full',
    layoutMode: input.layoutMode ?? 'fallback',
    traceIndex,
    semanticManifest: {
      version: 'report-semantic-manifest-v1',
      presentationUnitIds: [],
      leafUnitIds: [],
      assetIds: [],
      auditRecordIds: [],
      noticeIds: [],
    },
    ...(auditAppendix ? { auditAppendix } : {}),
    notices,
  };
  document.semanticManifest = collectReportDocumentV3Semantics(document);
  assertReportDocumentV3Integrity(document);
  assertReportEditorialProjectionCoverage(input.material, document);
  return document;
}

export function assertReportEditorialProjectionCoverageV4(
  material: ReportEditorialMaterialV1,
  document: ReportDocumentV4,
): void {
  const semantics = collectReportDocumentV4Semantics(document);
  const sameSet = (left: readonly string[], right: readonly string[]) => {
    if (left.length !== right.length) return false;
    const expected = new Set(right);
    return left.every((value) => expected.has(value));
  };
  if (!sameSet(semantics.presentationUnitIds, material.constraints.requiredPresentationUnitIds)) {
    throw new Error('ReportDocument v4 presentation-unit coverage does not match Material');
  }
  if (!sameSet(semantics.leafUnitIds, material.constraints.requiredLeafUnitIds)) {
    throw new Error('ReportDocument v4 leaf coverage does not match Material');
  }
}

export function projectReportEditorialDocumentV4(input: {
  material: ReportEditorialMaterialV1;
  blueprint: ReportEditorialBlueprintV1;
  editorialCopy?: ReportEditorialCopySelectionV2;
  layoutMode?: 'model' | 'fallback';
  auditAppendix?: ReportAuditAppendixMaterialV1;
  notices?: ReportNoticeV1[];
}): ReportDocumentV4 {
  assertReportEditorialBlueprintIntegrity(input.material, input.blueprint);
  if (input.auditAppendix) assertReportAuditAppendixMaterialIntegrity(input.material, input.auditAppendix);

  const unitsById = new Map(input.material.presentationUnits.map((unit) => [unit.id, unit]));
  const acceptedCopy = new Map(
    (input.editorialCopy?.fragments ?? []).map((fragment) => [copyTargetKey(fragment.target), fragment]),
  );
  const acceptedKeys = new Set(acceptedCopy.keys());
  const viewCounts = new Map<ReportViewIdV1, number>();
  const usedTitles = new Set<string>();
  const linearizedUnitIds: string[] = [];

  const sections: ReportSectionV4[] = input.blueprint.sections.map((section, sectionIndex) => {
    const units = section.blocks.flatMap(({ unitRefs }) => unitRefs.map((id) => unitsById.get(id)!));
    const viewOrdinal = (viewCounts.get(section.view) ?? 0) + 1;
    viewCounts.set(section.view, viewOrdinal);
    const fallbackTitle = sectionTitle({ section, units, viewOrdinal, usedTitles });
    const sourceTitleUnit = units.find((unit) => humanReadableSourceTitle(unit) === fallbackTitle);
    const titleKey = `section_title:${sectionIndex}`;
    const modelTitle = acceptedCopy.get(titleKey);
    const lead = acceptedCopy.get(`section_lead:${sectionIndex}`);
    const transition = acceptedCopy.get(`section_transition:${sectionIndex}`);
    const blocks = section.blocks.map((block, blockIndex) => {
      const blockUnits = block.unitRefs.map((id) => unitsById.get(id)!);
      const projected = projectBlockV4({
        block,
        units: blockUnits,
        sectionIndex,
        blockIndex,
        material: input.material,
      });
      const digest = acceptedCopy.get(`block_digest:${sectionIndex}:${blockIndex}`);
      const affected = blockUnits.filter((unit) => needsLinearizationNotice(unit, block.presentation));
      linearizedUnitIds.push(...affected.map(({ id }) => id));
      return digest ? { ...projected, digest: modelCopyFragment(digest) } : projected;
    });
    return {
      id: `section-${pad(sectionIndex)}-${section.view}`,
      title: modelTitle
        ? modelCopyFragment(modelTitle)
        : fallbackCopyFragment({
            targetKey: titleKey,
            text: fallbackTitle,
            provenance: sourceTitleUnit ? 'canonical' : 'system',
            ...(sourceTitleUnit ? { sourceLeafIds: [...sourceTitleUnit.leafIds] } : {}),
          }),
      ...(lead ? { lead: modelCopyFragment(lead) } : {}),
      ...(transition ? { transition: modelCopyFragment(transition) } : {}),
      view: section.view,
      prominence: section.prominence,
      blocks,
    };
  });

  const reportTitle = acceptedCopy.get('report_title');
  const executiveSummary = acceptedCopy.get('executive_summary');
  const requiredCopyKeys = [
    'report_title',
    'executive_summary',
    ...sections.flatMap((section, sectionIndex) => (
      section.prominence === 'appendix' ? [] : [`section_title:${sectionIndex}`]
    )),
  ];
  const missingRequiredCopy = requiredCopyKeys.some((key) => !acceptedKeys.has(key));
  const suppliedNotices = input.notices ?? [];
  const rejectedCount = input.editorialCopy?.rejectedFragments.length ?? 0;
  const notices: ReportNoticeV1[] = [
    ...suppliedNotices,
    ...((rejectedCount > 0 || missingRequiredCopy)
      && !suppliedNotices.some(({ code }) => code === 'copy_fallback') ? [{
        id: 'notice-copy-fallback-001',
        code: 'copy_fallback' as const,
        severity: 'info' as const,
        scope: 'report' as const,
        relatedUnitIds: [],
      }] : []),
    ...(linearizedUnitIds.length > 0 ? [{
      id: 'notice-visualization-linearized-001',
      code: 'visualization_linearized' as const,
      severity: 'info' as const,
      scope: 'report' as const,
      relatedUnitIds: unique(linearizedUnitIds),
    }] : []),
  ];
  if (new Set(notices.map(({ id }) => id)).size !== notices.length) {
    throw new Error('ReportDocument v4 Notice IDs must be unique');
  }

  const traceIndex = Object.fromEntries(input.material.constraints.requiredLeafUnitIds.map((id) => {
    const value = input.material.leafTraceIndex[id]!;
    return [id, {
      supportMode: value.supportMode,
      origins: value.origins.map((origin) => ({ ...origin, sourceNodeIds: [...origin.sourceNodeIds] })),
      questionIds: [...value.support.questionIds],
      evidenceIds: [...value.support.evidenceIds],
      findingIds: [...value.support.findingIds],
      summaryIds: [...value.support.summaryIds],
      ...(value.support.status === undefined ? {} : { status: value.support.status }),
      ...(value.support.confidence === undefined ? {} : { confidence: value.support.confidence }),
    }];
  }));
  const auditAppendix = input.auditAppendix
    ? {
        version: 'report-audit-appendix-v1' as const,
        visibility: 'collapsible' as const,
        sourceArtifactIds: unique(input.auditAppendix.records.map(({ contributionArtifactId }) => contributionArtifactId)),
        records: input.auditAppendix.records.map((record) => ({
          ...record,
          canonicalNodeIds: [...record.canonicalNodeIds],
          reviewIssueIds: [...record.reviewIssueIds],
        })),
      }
    : undefined;
  const document: ReportDocumentV4 = {
    version: 'report-document-v4',
    title: reportTitle
      ? modelCopyFragment(reportTitle)
      : fallbackCopyFragment({
          targetKey: 'report_title',
          text: input.material.document.title,
          provenance: 'canonical',
        }),
    subtitle: input.material.document.decisionContext ?? 'Reviewed report',
    executiveSummary: executiveSummary
      ? modelCopyFragment(executiveSummary)
      : fallbackCopyFragment({
          targetKey: 'executive_summary',
          text: input.material.document.executiveAnswer ?? input.material.document.title,
          provenance: 'canonical',
        }),
    style: input.blueprint.style,
    density: input.blueprint.density,
    copyMode: copyMode({ acceptedKeys, requiredKeys: requiredCopyKeys, rejectedCount }),
    sections,
    sourceDeliverableArtifactId: input.material.binding.deliverableArtifactId,
    sourceDeliverableContentSha256: input.material.binding.deliverableContentSha256,
    projectionMode: 'full',
    layoutMode: input.layoutMode ?? 'fallback',
    traceIndex,
    semanticManifest: {
      version: 'report-semantic-manifest-v2',
      presentationUnitIds: [],
      leafUnitIds: [],
      assetIds: [],
      auditRecordIds: [],
      noticeIds: [],
      copyFragmentIds: [],
    },
    ...(auditAppendix ? { auditAppendix } : {}),
    notices,
  };
  document.semanticManifest = collectReportDocumentV4Semantics(document);
  assertReportDocumentV4Integrity(document);
  assertReportEditorialProjectionCoverageV4(input.material, document);
  return document;
}

import type {
  ReportAuditAppendixV1,
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
  ReportEditorialCopyFragmentV4,
  ReportNoticeV1,
  ReportSemanticManifestV1,
  ReportSemanticManifestV2,
  ReportSectionV3,
  ReportSectionV4,
} from '../api-contract/report-document.ts';

export class ReportDocumentV3IntegrityError extends Error {
  constructor(message: string) {
    super(`ReportDocument v3 integrity failed: ${message}`);
    this.name = 'ReportDocumentV3IntegrityError';
  }
}

function fail(message: string): never {
  throw new ReportDocumentV3IntegrityError(message);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} ${value} must be unique`);
    seen.add(value);
  }
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function displayedLeafRefs(block: ReportBlockV3): string[] {
  switch (block.type) {
    case 'paragraph':
    case 'fact':
    case 'metric':
    case 'image':
    case 'chart':
      return [block.leafRef];
    case 'image-comparison':
      return [block.beforeLeafRef, block.afterLeafRef];
    case 'list':
      return block.items.map(({ leafRef }) => leafRef);
    case 'answer':
      return [block.textLeafRef, ...block.items.map(({ leafRef }) => leafRef)];
    case 'record-table':
      return block.rows.flatMap(({ cells }) => cells.map(({ leafRef }) => leafRef));
    case 'graph':
      return [
        ...block.nodes.map(({ leafRef }) => leafRef),
        ...block.edges.map(({ leafRef }) => leafRef),
      ];
    case 'priority-board':
      return block.groups.flatMap(({ items }) => items.map(({ leafRef }) => leafRef));
  }
}

function assetIds(block: ReportBlockV3): string[] {
  if (block.type === 'image') return [block.assetRef.assetId];
  if (block.type === 'image-comparison') {
    return [block.beforeAssetRef.assetId, block.afterAssetRef.assetId];
  }
  if (block.type === 'chart') return [block.chartRef.assetId];
  return [];
}

function assertBlockShape(block: ReportBlockV3): void {
  assertUnique(block.unitRefs, `block ${block.id} unitRef`);
  assertUnique(block.leafRefs, `block ${block.id} leafRef`);
  if (block.unitRefs.length === 0) fail(`block ${block.id} must own at least one presentation unit`);
  if (block.leafRefs.length === 0) fail(`block ${block.id} must own at least one leaf`);
  const displayed = stableUnique(displayedLeafRefs(block));
  if (!sameSet(displayed, block.leafRefs)) {
    fail(`block ${block.id} leafRefs must equal its displayed leaf references`);
  }

  if (block.type === 'record-table') {
    if (block.columns.length === 0 || block.columns.length > 12) {
      fail(`record-table ${block.id} must contain 1..12 columns`);
    }
    if (block.rows.length === 0 || block.rows.length > 200) {
      fail(`record-table ${block.id} must contain 1..200 rows`);
    }
    const columnKeys = block.columns.map(({ key }) => key);
    assertUnique(columnKeys, `record-table ${block.id} column key`);
    assertUnique(block.rows.map(({ id }) => id), `record-table ${block.id} row id`);
    for (const row of block.rows) {
      const cellKeys = row.cells.map(({ columnKey }) => columnKey);
      assertUnique(cellKeys, `record-table ${block.id} row ${row.id} column key`);
      if (!sameSet(cellKeys, columnKeys)) {
        fail(`record-table ${block.id} row ${row.id} must contain every declared column exactly once`);
      }
    }
  }

  if (block.type === 'graph') {
    if (block.nodes.length === 0 || block.nodes.length > 50 || block.edges.length > 100) {
      fail(`graph ${block.id} exceeds its node or edge limits`);
    }
    const nodeIds = block.nodes.map(({ id }) => id);
    assertUnique(nodeIds, `graph ${block.id} node id`);
    assertUnique(block.edges.map(({ id }) => id), `graph ${block.id} edge id`);
    const nodes = new Set(nodeIds);
    for (const edge of block.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
        fail(`graph ${block.id} edge ${edge.id} references a node outside the block`);
      }
    }
  }

  if (block.type === 'priority-board') {
    if (block.groups.length === 0 || block.groups.length > 3) {
      fail(`priority-board ${block.id} must contain 1..3 groups`);
    }
    assertUnique(block.groups.map(({ priority }) => priority), `priority-board ${block.id} priority`);
    for (const group of block.groups) {
      if (group.items.length === 0 || group.items.length > 50) {
        fail(`priority-board ${block.id} group ${group.priority} must contain 1..50 items`);
      }
      assertUnique(group.items.map(({ id }) => id), `priority-board ${block.id} item id`);
    }
  }
}

export function collectReportDocumentV3Semantics(
  document: ReportDocumentV3,
): ReportSemanticManifestV1 {
  if (document.sections.length === 0) fail('document must contain at least one section');
  assertUnique(document.sections.map(({ id }) => id), 'section id');
  const blocks = document.sections.flatMap(({ blocks: sectionBlocks }) => sectionBlocks);
  assertUnique(blocks.map(({ id }) => id), 'block id');

  const presentationUnitIds: string[] = [];
  const leafUnitIds: string[] = [];
  const referencedAssetIds: string[] = [];
  for (const block of blocks) {
    assertBlockShape(block);
    presentationUnitIds.push(...block.unitRefs);
    leafUnitIds.push(...block.leafRefs);
    referencedAssetIds.push(...assetIds(block));
  }
  assertUnique(presentationUnitIds, 'presentation unit owner');
  assertUnique(leafUnitIds, 'leaf owner');
  assertUnique(referencedAssetIds, 'Asset id');

  const traceIds = Object.keys(document.traceIndex);
  assertUnique(traceIds, 'trace id');
  if (!sameSet(traceIds, leafUnitIds)) fail('traceIndex keys must exactly match displayed leaf IDs');
  for (const leafId of leafUnitIds) {
    const trace = document.traceIndex[leafId];
    if (!trace) fail(`leaf ${leafId} has no trace`);
    if (trace.origins.length === 0) fail(`leaf ${leafId} must retain at least one source origin`);
    assertUnique(
      trace.origins.map((origin) => [
        origin.artifactId,
        origin.contentSha256,
        origin.schemaVersion,
        origin.jsonPointer,
        ...origin.sourceNodeIds,
      ].join('\u0000')),
      `leaf ${leafId} origin`,
    );
  }

  const auditRecordIds = document.auditAppendix?.records.map(({ id }) => id) ?? [];
  assertUnique(auditRecordIds, 'audit record id');
  assertUnique(document.notices.map(({ id }) => id), 'notice id');

  return {
    version: 'report-semantic-manifest-v1',
    presentationUnitIds: stableUnique(presentationUnitIds),
    leafUnitIds: stableUnique(leafUnitIds),
    assetIds: stableUnique(referencedAssetIds),
    auditRecordIds: stableUnique(auditRecordIds),
    noticeIds: stableUnique(document.notices.map(({ id }) => id)),
  };
}

export function assertReportDocumentV3Integrity(document: ReportDocumentV3): void {
  const collected = collectReportDocumentV3Semantics(document);
  for (const key of [
    'presentationUnitIds',
    'leafUnitIds',
    'assetIds',
    'auditRecordIds',
    'noticeIds',
  ] as const) {
    const actual = document.semanticManifest[key];
    assertUnique(actual, `semanticManifest.${key}`);
    if (!sameSet(actual, collected[key])) {
      fail(`semanticManifest.${key} does not match the rendered document`);
    }
  }
}

type ReportAuditRecordV1 = ReportAuditAppendixV1['records'][number];

export interface ReportDocumentV3Visitor<
  TBlock,
  TSection,
  TNotice = unknown,
  TAuditRecord = unknown,
> {
  visitBlock(block: ReportBlockV3, section: ReportSectionV3): TBlock | null | undefined;
  visitSection(
    section: ReportSectionV3,
    blocks: TBlock[],
    index: number,
  ): TSection | null | undefined;
  visitNotice(notice: ReportNoticeV1, index: number): TNotice | null | undefined;
  visitAuditRecord(
    record: ReportAuditRecordV1,
    index: number,
  ): TAuditRecord | null | undefined;
}

export interface ReportDocumentV3Traversal<TSection, TNotice, TAuditRecord> {
  sections: TSection[];
  notices: TNotice[];
  auditRecords: TAuditRecord[];
  semantics: ReportSemanticManifestV1;
}

function appendBlockSemantics(
  semantics: ReportSemanticManifestV1,
  block: ReportBlockV3,
): void {
  semantics.presentationUnitIds.push(...block.unitRefs);
  semantics.leafUnitIds.push(...block.leafRefs);
  semantics.assetIds.push(...assetIds(block));
}

export function visitReportDocumentV3<TBlock, TSection, TNotice, TAuditRecord>(
  document: ReportDocumentV3,
  visitor: ReportDocumentV3Visitor<TBlock, TSection, TNotice, TAuditRecord>,
): ReportDocumentV3Traversal<TSection, TNotice, TAuditRecord> {
  assertReportDocumentV3Integrity(document);
  const sections: TSection[] = [];
  const notices: TNotice[] = [];
  const auditRecords: TAuditRecord[] = [];
  const semantics: ReportSemanticManifestV1 = {
    version: 'report-semantic-manifest-v1',
    presentationUnitIds: [],
    leafUnitIds: [],
    assetIds: [],
    auditRecordIds: [],
    noticeIds: [],
  };

  document.sections.forEach((section, index) => {
    const renderedBlocks: Array<{ block: ReportBlockV3; output: TBlock }> = [];
    for (const block of section.blocks) {
      const output = visitor.visitBlock(block, section);
      if (output !== null && output !== undefined) renderedBlocks.push({ block, output });
    }
    const renderedSection = visitor.visitSection(
      section,
      renderedBlocks.map(({ output }) => output),
      index,
    );
    if (renderedSection === null || renderedSection === undefined) return;
    sections.push(renderedSection);
    for (const { block } of renderedBlocks) appendBlockSemantics(semantics, block);
  });

  document.notices.forEach((notice, index) => {
    const output = visitor.visitNotice(notice, index);
    if (output === null || output === undefined) return;
    notices.push(output);
    semantics.noticeIds.push(notice.id);
  });

  document.auditAppendix?.records.forEach((record, index) => {
    const output = visitor.visitAuditRecord(record, index);
    if (output === null || output === undefined) return;
    auditRecords.push(output);
    semantics.auditRecordIds.push(record.id);
  });

  return { sections, notices, auditRecords, semantics };
}

export class ReportDocumentV4IntegrityError extends Error {
  constructor(message: string) {
    super(`ReportDocument v4 integrity failed: ${message}`);
    this.name = 'ReportDocumentV4IntegrityError';
  }
}

function failV4(message: string): never {
  throw new ReportDocumentV4IntegrityError(message);
}

function assertUniqueV4(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) failV4(`${label} ${value} must be unique`);
    seen.add(value);
  }
}

function isV4OnlyBlock(
  block: ReportBlockV4,
): block is Extract<ReportBlockV4, { type: 'card-grid' | 'stage-flow' }> {
  return block.type === 'card-grid' || block.type === 'stage-flow';
}

function displayedLeafRefsV4(block: ReportBlockV4): string[] {
  if (block.type === 'card-grid') return block.cards.flatMap(({ leafRefs }) => leafRefs);
  if (block.type === 'stage-flow') return block.stages.flatMap(({ leafRefs }) => leafRefs);
  return displayedLeafRefs(block);
}

function assetIdsV4(block: ReportBlockV4): string[] {
  return isV4OnlyBlock(block) ? [] : assetIds(block);
}

function assertV4OnlyBlockShape(
  block: Extract<ReportBlockV4, { type: 'card-grid' | 'stage-flow' }>,
): void {
  assertUniqueV4(block.unitRefs, `block ${block.id} unitRef`);
  assertUniqueV4(block.leafRefs, `block ${block.id} leafRef`);
  if (block.unitRefs.length === 0) failV4(`block ${block.id} must own at least one presentation unit`);
  if (block.leafRefs.length === 0) failV4(`block ${block.id} must own at least one leaf`);

  const items = block.type === 'card-grid' ? block.cards : block.stages;
  if (items.length === 0 || items.length > 50) {
    failV4(`${block.type} ${block.id} must contain 1..50 items`);
  }
  assertUniqueV4(items.map(({ id }) => id), `${block.type} ${block.id} item id`);
  const displayed = displayedLeafRefsV4(block);
  assertUniqueV4(displayed, `${block.type} ${block.id} displayed leaf`);
  if (items.some(({ leafRefs }) => leafRefs.length === 0)) {
    failV4(`${block.type} ${block.id} items must each reference at least one leaf`);
  }
  if (!sameSet(displayed, block.leafRefs)) {
    failV4(`block ${block.id} leafRefs must equal its displayed leaf references`);
  }
}

function assertCopyFragmentV4(
  fragment: ReportEditorialCopyFragmentV4,
  allowedLeafIds: ReadonlySet<string>,
  label: string,
): void {
  if (fragment.provenance === 'model' && fragment.sourceLeafIds.length === 0) {
    failV4(`${label} model copy must cite at least one source leaf`);
  }
  if (fragment.provenance === 'system' && fragment.sourceLeafIds.length > 0) {
    failV4(`${label} system copy cannot claim source leaf support`);
  }
  assertUniqueV4(fragment.sourceLeafIds, `${label} source leaf`);
  for (const leafId of fragment.sourceLeafIds) {
    if (!allowedLeafIds.has(leafId)) failV4(`${label} cites leaf ${leafId} outside its allowed scope`);
  }
}

function reportCopyFragmentsV4(document: ReportDocumentV4): ReportEditorialCopyFragmentV4[] {
  return [
    document.title,
    document.executiveSummary,
    ...document.sections.flatMap((section) => [
      section.title,
      ...(section.lead ? [section.lead] : []),
      ...(section.transition ? [section.transition] : []),
      ...section.blocks.flatMap((block) => block.digest ? [block.digest] : []),
    ]),
  ];
}

export function collectReportDocumentV4Semantics(
  document: ReportDocumentV4,
): ReportSemanticManifestV2 {
  if (document.sections.length === 0) failV4('document must contain at least one section');
  assertUniqueV4(document.sections.map(({ id }) => id), 'section id');
  const blocks = document.sections.flatMap(({ blocks: sectionBlocks }) => sectionBlocks);
  assertUniqueV4(blocks.map(({ id }) => id), 'block id');

  const presentationUnitIds: string[] = [];
  const leafUnitIds: string[] = [];
  const referencedAssetIds: string[] = [];
  for (const block of blocks) {
    if (isV4OnlyBlock(block)) assertV4OnlyBlockShape(block);
    else assertBlockShape(block);
    presentationUnitIds.push(...block.unitRefs);
    leafUnitIds.push(...block.leafRefs);
    referencedAssetIds.push(...assetIdsV4(block));
  }
  assertUniqueV4(presentationUnitIds, 'presentation unit owner');
  assertUniqueV4(leafUnitIds, 'leaf owner');
  assertUniqueV4(referencedAssetIds, 'Asset id');

  const traceIds = Object.keys(document.traceIndex);
  assertUniqueV4(traceIds, 'trace id');
  if (!sameSet(traceIds, leafUnitIds)) failV4('traceIndex keys must exactly match displayed leaf IDs');
  for (const leafId of leafUnitIds) {
    const trace = document.traceIndex[leafId];
    if (!trace) failV4(`leaf ${leafId} has no trace`);
    if (trace.origins.length === 0) failV4(`leaf ${leafId} must retain at least one source origin`);
    assertUniqueV4(
      trace.origins.map((origin) => [
        origin.artifactId,
        origin.contentSha256,
        origin.schemaVersion,
        origin.jsonPointer,
        ...origin.sourceNodeIds,
      ].join('\u0000')),
      `leaf ${leafId} origin`,
    );
  }

  const documentLeaves = new Set(leafUnitIds);
  assertCopyFragmentV4(document.title, documentLeaves, 'report title');
  assertCopyFragmentV4(document.executiveSummary, documentLeaves, 'executive summary');
  document.sections.forEach((section, sectionIndex) => {
    const sectionLeaves = new Set(section.blocks.flatMap(({ leafRefs }) => leafRefs));
    assertCopyFragmentV4(section.title, sectionLeaves, `section ${section.id} title`);
    if (section.lead) assertCopyFragmentV4(section.lead, sectionLeaves, `section ${section.id} lead`);
    if (section.transition) {
      const next = document.sections[sectionIndex + 1];
      if (!next) failV4(`last section ${section.id} cannot have a transition`);
      const transitionLeaves = new Set([
        ...sectionLeaves,
        ...next.blocks.flatMap(({ leafRefs }) => leafRefs),
      ]);
      assertCopyFragmentV4(section.transition, transitionLeaves, `section ${section.id} transition`);
    }
    for (const block of section.blocks) {
      if (block.digest) {
        assertCopyFragmentV4(block.digest, new Set(block.leafRefs), `block ${block.id} digest`);
      }
    }
  });

  const copyFragmentIds = reportCopyFragmentsV4(document).map(({ id }) => id);
  assertUniqueV4(copyFragmentIds, 'copy fragment id');
  const auditRecordIds = document.auditAppendix?.records.map(({ id }) => id) ?? [];
  assertUniqueV4(auditRecordIds, 'audit record id');
  assertUniqueV4(document.notices.map(({ id }) => id), 'notice id');

  return {
    version: 'report-semantic-manifest-v2',
    presentationUnitIds: stableUnique(presentationUnitIds),
    leafUnitIds: stableUnique(leafUnitIds),
    assetIds: stableUnique(referencedAssetIds),
    auditRecordIds: stableUnique(auditRecordIds),
    noticeIds: stableUnique(document.notices.map(({ id }) => id)),
    copyFragmentIds,
  };
}

export function assertReportDocumentV4Integrity(document: ReportDocumentV4): void {
  const collected = collectReportDocumentV4Semantics(document);
  for (const key of [
    'presentationUnitIds',
    'leafUnitIds',
    'assetIds',
    'auditRecordIds',
    'noticeIds',
    'copyFragmentIds',
  ] as const) {
    const actual = document.semanticManifest[key];
    assertUniqueV4(actual, `semanticManifest.${key}`);
    if (!sameSet(actual, collected[key])) {
      failV4(`semanticManifest.${key} does not match the rendered document`);
    }
  }
}

export interface ReportDocumentV4Visitor<
  TBlock,
  TSection,
  TNotice = unknown,
  TAuditRecord = unknown,
> {
  visitBlock(block: ReportBlockV4, section: ReportSectionV4): TBlock | null | undefined;
  visitSection(
    section: ReportSectionV4,
    blocks: TBlock[],
    index: number,
  ): TSection | null | undefined;
  visitNotice(notice: ReportNoticeV1, index: number): TNotice | null | undefined;
  visitAuditRecord(
    record: ReportAuditRecordV1,
    index: number,
  ): TAuditRecord | null | undefined;
}

export interface ReportDocumentV4Traversal<TSection, TNotice, TAuditRecord> {
  sections: TSection[];
  notices: TNotice[];
  auditRecords: TAuditRecord[];
  semantics: ReportSemanticManifestV2;
}

export function visitReportDocumentV4<TBlock, TSection, TNotice, TAuditRecord>(
  document: ReportDocumentV4,
  visitor: ReportDocumentV4Visitor<TBlock, TSection, TNotice, TAuditRecord>,
): ReportDocumentV4Traversal<TSection, TNotice, TAuditRecord> {
  assertReportDocumentV4Integrity(document);
  const sections: TSection[] = [];
  const notices: TNotice[] = [];
  const auditRecords: TAuditRecord[] = [];
  const semantics: ReportSemanticManifestV2 = {
    version: 'report-semantic-manifest-v2',
    presentationUnitIds: [],
    leafUnitIds: [],
    assetIds: [],
    auditRecordIds: [],
    noticeIds: [],
    copyFragmentIds: [document.title.id, document.executiveSummary.id],
  };

  document.sections.forEach((section, index) => {
    const renderedBlocks: Array<{ block: ReportBlockV4; output: TBlock }> = [];
    for (const block of section.blocks) {
      const output = visitor.visitBlock(block, section);
      if (output !== null && output !== undefined) renderedBlocks.push({ block, output });
    }
    const renderedSection = visitor.visitSection(
      section,
      renderedBlocks.map(({ output }) => output),
      index,
    );
    if (renderedSection === null || renderedSection === undefined) return;
    sections.push(renderedSection);
    semantics.copyFragmentIds.push(
      section.title.id,
      ...(section.lead ? [section.lead.id] : []),
      ...(section.transition ? [section.transition.id] : []),
    );
    for (const { block } of renderedBlocks) {
      semantics.presentationUnitIds.push(...block.unitRefs);
      semantics.leafUnitIds.push(...block.leafRefs);
      semantics.assetIds.push(...assetIdsV4(block));
      if (block.digest) semantics.copyFragmentIds.push(block.digest.id);
    }
  });

  document.notices.forEach((notice, index) => {
    const output = visitor.visitNotice(notice, index);
    if (output === null || output === undefined) return;
    notices.push(output);
    semantics.noticeIds.push(notice.id);
  });

  document.auditAppendix?.records.forEach((record, index) => {
    const output = visitor.visitAuditRecord(record, index);
    if (output === null || output === undefined) return;
    auditRecords.push(output);
    semantics.auditRecordIds.push(record.id);
  });

  return { sections, notices, auditRecords, semantics };
}

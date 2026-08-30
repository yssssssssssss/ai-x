import type {
  EditorialScalar,
  ReportEditorialBlueprintV1,
  ReportEditorialCopyFragmentV2,
  ReportEditorialCopyRejectionReasonV2,
  ReportEditorialCopySelectionV2,
  ReportEditorialCopyTargetV2,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
} from '../../../../packages/api-contract/report-editorial.ts';

export const REPORT_EDITORIAL_COPY_MAX_CHARS_V2 = {
  report_title: 80,
  executive_summary: 800,
  section_title: 60,
  section_lead: 320,
  section_transition: 240,
  block_digest: 280,
} as const;

type ProtectedTokenKind = 'url' | 'evidence' | 'priority' | 'date' | 'amount' | 'ratio' | 'number' | 'status';

interface CopyTargetScope {
  key: string;
  maxChars: number;
  leafIds: Set<string>;
}

function addValue(target: string[], value: EditorialScalar | undefined): void {
  if (value !== undefined && value !== null) target.push(String(value));
}

function addUnitSource(
  index: Map<string, string[]>,
  unit: ReportEditorialPresentationUnitV1,
): void {
  const append = (leafId: string, ...values: Array<EditorialScalar | undefined>) => {
    const target = index.get(leafId);
    if (!target) return;
    if (unit.title) target.push(unit.title);
    for (const value of values) addValue(target, value);
  };

  switch (unit.shape) {
    case 'text':
      append(unit.leafId, unit.text);
      return;
    case 'record':
      append(unit.leafId, ...unit.fields.flatMap(({ label, value }) => [label, value]));
      return;
    case 'matrix':
      for (const cell of unit.cells) append(cell.leafId, cell.row, cell.column, cell.value);
      return;
    case 'graph':
      for (const node of unit.nodes) append(node.leafId, node.label, node.description);
      for (const edge of unit.edges) append(edge.leafId, edge.label);
      return;
    case 'actions':
      for (const action of unit.actions) {
        append(
          action.leafId,
          action.priority,
          action.action,
          action.owner,
          action.rationale,
          action.validationMethod,
        );
      }
      return;
    case 'records':
      for (const record of unit.records) {
        append(
          record.leafId,
          record.title,
          record.body,
          record.status,
          ...record.fields.flatMap(({ label, value }) => [label, value]),
        );
      }
      return;
    case 'stages':
      for (const stage of unit.stages) {
        append(
          stage.leafId,
          stage.label,
          stage.description,
          stage.timeLabel,
          ...stage.activities,
          ...stage.outputs,
        );
      }
      return;
    case 'asset':
      append(unit.leafId, ...Object.values(unit.sourceSummary));
      return;
    case 'asset_pair':
      append(unit.original.leafId, ...Object.values(unit.original.sourceSummary));
      append(unit.annotation.leafId, 'annotation', ...unit.findingIds);
      return;
    case 'chart':
      append(
        unit.leafId,
        unit.spec.title,
        unit.spec.type,
        unit.spec.categories.length,
        unit.spec.series.length,
        unit.spec.series.reduce((count, series) => count + series.values.length, 0),
        ...unit.evidenceIds,
      );
  }
}

function buildLeafSourceIndex(material: ReportEditorialMaterialV1): Map<string, string> {
  const values = new Map(Object.keys(material.leafTraceIndex).map((leafId) => [leafId, [] as string[]]));
  for (const unit of material.presentationUnits) addUnitSource(values, unit);
  for (const [leafId, trace] of Object.entries(material.leafTraceIndex)) {
    const target = values.get(leafId);
    if (!target) continue;
    target.push(
      trace.supportMode,
      ...trace.support.questionIds,
      ...trace.support.evidenceIds,
      ...trace.support.findingIds,
      ...trace.support.summaryIds,
    );
    addValue(target, trace.support.status);
    addValue(target, trace.support.confidence);
  }
  return new Map([...values].map(([leafId, sourceValues]) => [leafId, sourceValues.join('\n')]));
}

function blockLeafIds(
  material: ReportEditorialMaterialV1,
  block: ReportEditorialBlueprintV1['sections'][number]['blocks'][number],
): string[] {
  const units = new Map(material.presentationUnits.map((unit) => [unit.id, unit]));
  return block.unitRefs.flatMap((unitId) => units.get(unitId)?.leafIds ?? []);
}

function sectionLeafIds(
  material: ReportEditorialMaterialV1,
  section: ReportEditorialBlueprintV1['sections'][number],
): string[] {
  return section.blocks.flatMap((block) => blockLeafIds(material, block));
}

function validIndex(value: number, length: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < length;
}

function targetScope(
  material: ReportEditorialMaterialV1,
  blueprint: ReportEditorialBlueprintV1,
  target: ReportEditorialCopyTargetV2,
): CopyTargetScope | undefined {
  if (target.kind === 'report_title' || target.kind === 'executive_summary') {
    const primarySections = blueprint.sections.filter(({ prominence }) => prominence === 'primary');
    const sourceSections = primarySections.length > 0 ? primarySections : blueprint.sections;
    return {
      key: target.kind,
      maxChars: REPORT_EDITORIAL_COPY_MAX_CHARS_V2[target.kind],
      leafIds: new Set(sourceSections.flatMap((section) => sectionLeafIds(material, section))),
    };
  }

  if (!validIndex(target.sectionIndex, blueprint.sections.length)) return undefined;
  const section = blueprint.sections[target.sectionIndex]!;
  if (target.kind === 'section_transition') {
    const nextSection = blueprint.sections[target.sectionIndex + 1];
    if (!nextSection) return undefined;
    return {
      key: `${target.kind}:${target.sectionIndex}`,
      maxChars: REPORT_EDITORIAL_COPY_MAX_CHARS_V2[target.kind],
      leafIds: new Set([
        ...sectionLeafIds(material, section),
        ...sectionLeafIds(material, nextSection),
      ]),
    };
  }
  if (target.kind === 'block_digest') {
    if (!validIndex(target.blockIndex, section.blocks.length)) return undefined;
    const block = section.blocks[target.blockIndex]!;
    if (section.prominence !== 'supporting' && block.visibility !== 'collapsible') {
      return undefined;
    }
    return {
      key: `${target.kind}:${target.sectionIndex}:${target.blockIndex}`,
      maxChars: REPORT_EDITORIAL_COPY_MAX_CHARS_V2[target.kind],
      leafIds: new Set(blockLeafIds(material, block)),
    };
  }
  return {
    key: `${target.kind}:${target.sectionIndex}`,
    maxChars: REPORT_EDITORIAL_COPY_MAX_CHARS_V2[target.kind],
    leafIds: new Set(sectionLeafIds(material, section)),
  };
}

function plainText(text: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    && !/<\s*\/?\s*[a-z][^>]*>/iu.test(text)
    && !/```|!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]*\)/u.test(text);
}

function normalizedNumber(value: string): string {
  const compact = value.replaceAll(',', '').replaceAll(' ', '');
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? String(parsed) : compact;
}

function normalizeProtectedToken(kind: ProtectedTokenKind, value: string): string {
  const compact = value.trim();
  if (kind === 'url') return compact.replace(/[.,;:!?，。；！？、）)\]}]+$/u, '');
  if (kind === 'evidence') return compact.toUpperCase().replace(/[\s_]/gu, '-');
  if (kind === 'priority') return compact.toUpperCase();
  if (kind === 'status') return compact.toLowerCase();
  if (kind === 'date') return [...compact.matchAll(/\d+/gu)]
    .map(({ 0: component }, index) => index === 0 ? component : component.padStart(2, '0'))
    .join('-');
  if (kind === 'amount') {
    const number = compact.match(/\d[\d,.]*/u)?.[0] ?? compact;
    const currency = /\$|USD|美元/iu.test(compact)
      ? 'USD'
      : /€|欧元/iu.test(compact)
        ? 'EUR'
        : /£|英镑/iu.test(compact)
          ? 'GBP'
          : /万元/u.test(compact)
            ? 'CNY_10000'
            : /亿元/u.test(compact)
              ? 'CNY_100000000'
              : 'CNY';
    return `${currency}:${normalizedNumber(number)}`;
  }
  if (kind === 'ratio') {
    return compact.replaceAll('％', '%').replaceAll('：', ':').replace(/\s/gu, '');
  }
  return normalizedNumber(compact);
}

function addMatches(
  target: Set<string>,
  kind: ProtectedTokenKind,
  value: string,
  pattern: RegExp,
): void {
  for (const match of value.matchAll(pattern)) {
    target.add(`${kind}:${normalizeProtectedToken(kind, match[0])}`);
  }
}

function protectedTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  let remaining = value;
  const capture = (kind: ProtectedTokenKind, pattern: RegExp) => {
    addMatches(tokens, kind, remaining, pattern);
    remaining = remaining.replace(pattern, ' ');
  };
  capture('url', /https?:\/\/[^\s<>"']+/giu);
  capture('evidence', /\b(?:EVIDENCE[-_ ]*\d+|E[-_]?\d+(?:[-_.]\d+)*)\b/giu);
  capture('priority', /\bP[0-3]\b/giu);
  capture('status', /\b(?:supported|provisional|unanswered)\b/giu);
  capture('date', /\b\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b|\d{4}年\d{1,2}月(?:\d{1,2}日)?/gu);
  capture(
    'amount',
    /(?:[$€£¥￥]\s*\d[\d,.]*|(?:USD|CNY|RMB)\s*\d[\d,.]*|\d[\d,.]*\s*(?:亿元|万元|元|美元|欧元|英镑))/giu,
  );
  capture('ratio', /\d+(?:\.\d+)?\s*(?:%|％)|\d+(?:\.\d+)?\s*[:：/]\s*\d+(?:\.\d+)?/gu);
  addMatches(
    tokens,
    'number',
    remaining,
    /(?<![\p{L}\p{N}_])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?![\p{L}\p{N}_])/gu,
  );
  return tokens;
}

function hasUnsupportedProtectedToken(text: string, citedSources: string[]): boolean {
  const allowed = protectedTokens(citedSources.join('\n'));
  return [...protectedTokens(text)].some((token) => !allowed.has(token));
}

function uniqueReasons(
  reasons: ReportEditorialCopyRejectionReasonV2[],
): ReportEditorialCopyRejectionReasonV2[] {
  return [...new Set(reasons)];
}

/**
 * Keeps the valid fragments and reports per-fragment failures. It deliberately
 * does not perform broad semantic review: Canonical content stays untouched and
 * protected factual tokens must already occur in the specifically cited leaves.
 */
export function validateReportEditorialCopyFragmentsV2(input: {
  material: ReportEditorialMaterialV1;
  blueprint: ReportEditorialBlueprintV1;
  fragments: readonly ReportEditorialCopyFragmentV2[];
  fragmentIndexes?: readonly number[];
}): ReportEditorialCopySelectionV2 {
  const sourceIndex = buildLeafSourceIndex(input.material);
  const acceptedTargets = new Set<string>();
  const fragments: ReportEditorialCopyFragmentV2[] = [];
  const rejectedFragments: ReportEditorialCopySelectionV2['rejectedFragments'] = [];

  input.fragments.forEach((fragment, fragmentIndex) => {
    const reportedFragmentIndex = input.fragmentIndexes?.[fragmentIndex] ?? fragmentIndex;
    const reasons: ReportEditorialCopyRejectionReasonV2[] = [];
    const scope = targetScope(input.material, input.blueprint, fragment.target);
    const text = fragment.text.trim();
    const uniqueSourceIds = new Set(fragment.sourceLeafIds);
    if (!scope) reasons.push('target_out_of_range');
    if (scope && acceptedTargets.has(scope.key)) reasons.push('duplicate_target');
    if (text.length === 0) reasons.push('empty_text');
    if (!plainText(text)) reasons.push('not_plain_text');
    if (scope && [...text].length > scope.maxChars) reasons.push('length_limit');
    if (fragment.sourceLeafIds.length === 0) reasons.push('empty_source_leaf_ids');
    if (uniqueSourceIds.size !== fragment.sourceLeafIds.length) {
      reasons.push('duplicate_source_leaf_id');
    }
    const unknownSource = fragment.sourceLeafIds.some((leafId) => !sourceIndex.has(leafId));
    if (unknownSource) reasons.push('unknown_source_leaf_id');
    if (scope && fragment.sourceLeafIds.some((leafId) => !scope.leafIds.has(leafId))) {
      reasons.push('source_scope_mismatch');
    }
    const citedSources = fragment.sourceLeafIds.flatMap((leafId) => {
      const source = sourceIndex.get(leafId);
      return source === undefined ? [] : [source];
    });
    if (hasUnsupportedProtectedToken(text, citedSources)) {
      reasons.push('unsupported_protected_token');
    }

    const reasonCodes = uniqueReasons(reasons);
    if (!scope || reasonCodes.length > 0) {
      rejectedFragments.push({
        fragmentIndex: reportedFragmentIndex,
        target: { ...fragment.target },
        reasonCodes,
      });
      return;
    }
    acceptedTargets.add(scope.key);
    fragments.push({
      target: { ...fragment.target },
      text,
      sourceLeafIds: [...fragment.sourceLeafIds],
    });
  });

  return { fragments, rejectedFragments };
}

import type {
  ReportEditorialPresentationUnitV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import type {
  ReportCardGridBlockV4,
  ReportStageFlowBlockV4,
} from '../../../../packages/api-contract/report-document.ts';

type RecordsUnit = Extract<ReportEditorialPresentationUnitV1, { shape: 'records' }>;
type StagesUnit = Extract<ReportEditorialPresentationUnitV1, { shape: 'stages' }>;
type CardGridBase = Pick<
  ReportCardGridBlockV4,
  'id' | 'title' | 'visibility' | 'unitRefs' | 'leafRefs'
>;
type StageFlowBase = Pick<
  ReportStageFlowBlockV4,
  'id' | 'title' | 'visibility' | 'unitRefs' | 'leafRefs'
>;

function scalarText(value: string | number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function projectEditorialCardGridBlockV4(
  unit: RecordsUnit,
  base: CardGridBase,
): ReportCardGridBlockV4 {
  return {
    ...base,
    type: 'card-grid',
    cards: unit.records.map((record) => {
      const fieldText = record.fields
        .map(({ label, value }) => `${label}：${scalarText(value)}`)
        .join('\n');
      const body = [record.body, fieldText].filter(Boolean).join('\n');
      return {
        id: record.id,
        title: record.title,
        ...(body ? { body } : {}),
        ...(record.status ? { status: record.status } : {}),
        leafRefs: [record.leafId],
      };
    }),
  };
}

export function projectEditorialStageFlowBlockV4(
  unit: StagesUnit,
  base: StageFlowBase,
): ReportStageFlowBlockV4 {
  return {
    ...base,
    type: 'stage-flow',
    stages: unit.stages.map((stage) => {
      const activityText = stage.activities.length > 0
        ? `活动：${stage.activities.join('；')}`
        : '';
      const outputText = stage.outputs.length > 0
        ? `产出：${stage.outputs.join('；')}`
        : '';
      const description = [stage.description, activityText, outputText].filter(Boolean).join('\n');
      return {
        id: stage.id,
        label: stage.label,
        ...(description ? { description } : {}),
        ...(stage.timeLabel ? { timeLabel: stage.timeLabel } : {}),
        leafRefs: [stage.leafId],
      };
    }),
  };
}

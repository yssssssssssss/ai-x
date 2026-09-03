import type { DatasetUpload, PendingUpload, Upload } from '../../api/client.ts';
import { pendingImageUploads } from '../../pending-upload-values.ts';

type DatasetMetadata = DatasetUpload['metadata'];

export function parseDatasetColumns(content: string): string[] {
  const source = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  let reachedRecordEnd = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      fields.push(field.trim());
      field = '';
    } else if (character === '\n' || character === '\r') {
      fields.push(field.trim());
      reachedRecordEnd = true;
      break;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV 表头存在未闭合的引号');
  if (!reachedRecordEnd && (field.length > 0 || fields.length > 0)) fields.push(field.trim());
  if (fields.length === 0 || fields.some((column) => column.length === 0)) {
    throw new Error('CSV 表头必须包含非空字段名');
  }
  if (new Set(fields).size !== fields.length) throw new Error('CSV 表头字段名不能重复');
  return fields;
}

export function reconcileDatasetColumnMetadata(
  metadata: DatasetMetadata,
  columns: readonly string[],
): DatasetMetadata {
  return {
    ...metadata,
    fieldNotes: Object.fromEntries(columns.map((column) => [column, metadata.fieldNotes[column] ?? ''])),
    units: Object.fromEntries(columns.map((column) => [column, metadata.units[column] ?? ''])),
  };
}

export interface PlanConfirmationPayload {
  confirmationAnswers: Record<string, unknown>;
  inputValues: Record<string, unknown>;
  uploads: Upload[];
  datasetUploads: DatasetUpload[];
}

export function buildPlanConfirmationPayload(input: {
  confirmationAnswers: Readonly<Record<string, string>>;
  pending: readonly PendingUpload[];
  values: Readonly<Record<string, string>>;
  images: Readonly<Record<string, readonly string[]>>;
  datasets?: Readonly<Record<string, DatasetUpload | undefined>>;
}): PlanConfirmationPayload {
  const inputValues: Record<string, unknown> = {};
  for (const pendingInput of input.pending) {
    if (pendingInput.kind !== 'value') continue;
    const raw = input.values[pendingInput.role] ?? '';
    inputValues[pendingInput.role] = pendingInput.multiple
      ? raw.split('\n').map((item) => item.trim()).filter(Boolean)
      : raw.trim();
  }
  return {
    confirmationAnswers: { ...input.confirmationAnswers },
    inputValues,
    uploads: pendingImageUploads(
      input.pending.filter((pendingInput) => pendingInput.kind === 'visual'),
      input.images,
    ),
    datasetUploads: input.pending.flatMap((pendingInput) => {
      if (pendingInput.kind !== 'dataset') return [];
      const upload = input.datasets?.[pendingInput.role];
      return upload ? [upload] : [];
    }),
  };
}

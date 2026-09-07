import type { DatasetUpload, DocumentUpload, PendingUpload, VisualUpload } from '../../api/client.ts';

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
  visualUploads: VisualUpload[];
  datasetUploads: DatasetUpload[];
  documentUploads?: DocumentUpload[];
  waivedInputKeys?: string[];
}

export function buildPlanConfirmationPayload(input: {
  confirmationAnswers: Readonly<Record<string, string>>;
  pending: readonly PendingUpload[];
  values: Readonly<Record<string, string>>;
  images: Readonly<Record<string, readonly File[]>>;
  datasets?: Readonly<Record<string, DatasetUpload | undefined>>;
  documents?: Readonly<Record<string, readonly File[] | undefined>>;
  waivedInputKeys?: readonly string[];
}): PlanConfirmationPayload {
  const waived = new Set(input.waivedInputKeys ?? []);
  const inputValues: Record<string, unknown> = {};
  for (const pendingInput of input.pending) {
    if (pendingInput.kind !== 'value' || waived.has(pendingInput.role)) continue;
    const raw = input.values[pendingInput.role] ?? '';
    inputValues[pendingInput.role] = pendingInput.multiple
      ? raw.split('\n').map((item) => item.trim()).filter(Boolean)
      : raw.trim();
  }
  const documentUploads = input.pending.flatMap((pendingInput) => {
    if (pendingInput.kind !== 'document' || waived.has(pendingInput.role)) return [];
    const files = input.documents?.[pendingInput.role];
    return files && files.length > 0 ? [{ role: pendingInput.role, files: [...files] }] : [];
  });
  return {
    confirmationAnswers: { ...input.confirmationAnswers },
    inputValues,
    visualUploads: input.pending.flatMap((pendingInput) => {
      if (pendingInput.kind !== 'visual' || waived.has(pendingInput.role)) return [];
      const files = input.images[pendingInput.role] ?? [];
      return files.length > 0 ? [{ role: pendingInput.role, files: [...files] }] : [];
    }),
    datasetUploads: input.pending.flatMap((pendingInput) => {
      if (pendingInput.kind !== 'dataset' || waived.has(pendingInput.role)) return [];
      const upload = input.datasets?.[pendingInput.role];
      return upload ? [upload] : [];
    }),
    ...(documentUploads.length === 0 ? {} : { documentUploads }),
    ...(waived.size === 0 ? {} : { waivedInputKeys: [...waived] }),
  };
}

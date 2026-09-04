import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { parse } from 'csv-parse/sync';

import { redactString } from '../runtime/redaction.ts';

import type { ControlArtifact, ControlGateRecord } from '../../../../database/control-plane.ts';
import type { PendingInput } from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ArtifactWriteInput,
  CsvArtifactWriteInput,
} from './artifact-store.ts';

const CSV_MEDIA_TYPE = 'text/csv; charset=utf-8' as const;
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_VIEW_BYTES = 512 * 1024;
const RAW_KIND = 'dataset_input_csv';
const RAW_SCHEMA = 'dataset-input-csv-v1';
const PROFILE_KIND = 'dataset_input_profile';
const PROFILE_SCHEMA = 'dataset-input-profile-v1';
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PII_COLUMN = /^(?:full_?name|contact_?name|name|姓名|email|邮箱|phone|mobile|手机号|电话|身份证|id_?card|address|地址|order_?id|订单号)$/iu;

export interface DatasetInputMetadataV1 {
  rowMeaning: string;
  timeRange: string;
  fieldNotes: Record<string, string>;
  units: Record<string, string>;
  sampling: string;
  piiConfirmedAbsent: boolean;
}

export interface DatasetInputProfileV1 {
  version: typeof PROFILE_SCHEMA;
  taskId: string;
  planVersionId: string;
  ownerUserId: string;
  gateKey: string;
  fileName: string;
  mediaType: typeof CSV_MEDIA_TYPE;
  byteSize: number;
  contentSha256: string;
  rawArtifactId: string;
  columns: Array<{ index: number; name: string }>;
  columnProfiles: Array<{
    index: number;
    name: string;
    nonEmptyCount: number;
    uniqueCount: number;
    numericCount: number;
    numericMin: number | null;
    numericMax: number | null;
    numericMean: number | null;
  }>;
  rows: Array<{
    index: number;
    evidenceId: string;
    values: string[];
  }>;
  rowCount: number;
  metadata: DatasetInputMetadataV1;
}

interface DatasetArtifactPort {
  writeCsv(input: CsvArtifactWriteInput): Promise<ControlArtifact>;
  writeJson(input: ArtifactWriteInput): Promise<ControlArtifact>;
  readVerifiedBoundCsv(artifactId: string): Promise<{ artifact: ControlArtifact; content: string }>;
  readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }>;
  invalidateArtifactPublication(artifactId: string, reason: string): Promise<void>;
}

export interface DatasetUploadResult {
  datasetInputId: string;
  fileName: string;
  contentSha256: string;
  byteSize: number;
  rowCount: number;
  columns: string[];
}

export interface ResolvedDatasetInput {
  gateKey: string;
  artifact: ControlArtifact;
  profile: DatasetInputProfileV1;
}

export interface DatasetModelViewV1 {
  version: 'dataset-model-view-v1';
  datasetInputId: string;
  profileEvidenceId: string;
  role: string;
  columns: DatasetInputProfileV1['columns'];
  columnProfiles: DatasetInputProfileV1['columnProfiles'];
  rows: DatasetInputProfileV1['rows'];
  rowCount: number;
  metadata: DatasetInputMetadataV1;
}

export interface ResolvedDatasetInputGates {
  gates: ControlGateRecord[];
  datasets: ResolvedDatasetInput[];
}

export interface PreparedDatasetInputGate {
  gateKey: string;
  evidenceRef: string;
  artifactIds: string[];
}

export class DatasetInputGateError extends Error {
  constructor(message: string, readonly code = 'dataset_input_invalid') {
    super(`dataset input gate is invalid: ${message}`);
    this.name = 'DatasetInputGateError';
  }
}

function cleanText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DatasetInputGateError(`${field} is required`);
  return value.trim();
}

function safeFileName(value: string): string {
  const name = cleanText(value, 'fileName');
  if (basename(name) !== name || name.includes('/') || name.includes('\\') || !name.toLowerCase().endsWith('.csv')) {
    throw new DatasetInputGateError('fileName must be one local .csv name');
  }
  return name;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(Buffer.from(bytes))) {
    throw new DatasetInputGateError('CSV must be valid UTF-8');
  }
  if (!value || value.includes('\0')) throw new DatasetInputGateError('CSV is empty or contains NUL');
  return value;
}

function parseRows(content: string): { columns: string[]; rows: string[][] } {
  let records: string[][];
  try {
    records = parse(content, {
      bom: true,
      columns: false,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as string[][];
  } catch (error) {
    throw new DatasetInputGateError(`CSV parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (records.length < 2) throw new DatasetInputGateError('CSV requires a header and at least one data record');
  const columns = records[0]!.map((value) => cleanText(value, 'column name'));
  if (new Set(columns).size !== columns.length) throw new DatasetInputGateError('CSV column names must be unique');
  const rows = records.slice(1);
  if (rows.some((row) => row.length !== columns.length)) {
    throw new DatasetInputGateError('CSV records must match the header width');
  }
  return { columns, rows };
}

function profileColumns(columns: readonly string[], rows: readonly string[][]): DatasetInputProfileV1['columnProfiles'] {
  return columns.map((name, index) => {
    const values = rows.map((row) => row[index] ?? '');
    const nonEmpty = values.filter((value) => value.trim() !== '');
    const numeric = nonEmpty
      .filter((value) => /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim()))
      .map((value) => Number(value));
    const numericMean = numeric.length === 0
      ? null
      : Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 1_000_000) / 1_000_000;
    return {
      index,
      name,
      nonEmptyCount: nonEmpty.length,
      uniqueCount: new Set(nonEmpty).size,
      numericCount: numeric.length,
      numericMin: numeric.length === 0 ? null : Math.min(...numeric),
      numericMax: numeric.length === 0 ? null : Math.max(...numeric),
      numericMean,
    };
  });
}

function assertNoDetectedPii(columns: readonly string[], rows: readonly string[][]): void {
  const sensitiveColumn = columns.find((column) => PII_COLUMN.test(column.trim()));
  if (sensitiveColumn) {
    throw new DatasetInputGateError(
      `CSV contains a direct-identifier column: ${sensitiveColumn}`,
      'dataset_pii_detected',
    );
  }
  for (const row of rows) {
    for (const value of row) {
      if (redactString(value) !== value) {
        throw new DatasetInputGateError('CSV contains a direct identifier pattern', 'dataset_pii_detected');
      }
    }
  }
}

function assertArtifact(input: {
  artifact: ControlArtifact;
  taskId: string;
  planVersionId: string;
  kind: string;
  schemaVersion: string;
  mediaType?: string | null;
}): void {
  const artifact = input.artifact;
  if (
    artifact.state !== 'SEALED'
    || artifact.taskId !== input.taskId
    || artifact.planVersionId !== input.planVersionId
    || artifact.attemptId !== null
    || artifact.kind !== input.kind
    || artifact.schemaVersion !== input.schemaVersion
    || !artifact.contentSha256
    || (input.mediaType !== undefined && artifact.mediaType !== input.mediaType)
  ) throw new DatasetInputGateError(`${input.kind} Artifact binding is invalid`);
}

function parseProfile(value: unknown): DatasetInputProfileV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatasetInputGateError('profile must be an object');
  }
  const profile = value as DatasetInputProfileV1;
  if (
    profile.version !== PROFILE_SCHEMA
    || typeof profile.taskId !== 'string'
    || typeof profile.planVersionId !== 'string'
    || typeof profile.ownerUserId !== 'string'
    || typeof profile.gateKey !== 'string'
    || typeof profile.fileName !== 'string'
    || profile.mediaType !== CSV_MEDIA_TYPE
    || !Number.isSafeInteger(profile.byteSize)
    || profile.byteSize <= 0
    || typeof profile.rawArtifactId !== 'string'
    || !SHA256.test(profile.contentSha256)
    || !Array.isArray(profile.columns)
    || !Array.isArray(profile.columnProfiles)
    || profile.columnProfiles.length !== profile.columns.length
    || !Array.isArray(profile.rows)
    || profile.rows.length !== profile.rowCount
    || profile.metadata?.piiConfirmedAbsent !== true
  ) throw new DatasetInputGateError('profile fields are malformed');
  return profile;
}

export class DatasetInputGateStore {
  constructor(private readonly artifacts: DatasetArtifactPort) {}

  async upload(input: {
    taskId: string;
    planVersionId: string;
    role: string;
    ownerUserId: string;
    taskSensitivity: 'public' | 'internal' | 'confidential';
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
    metadata: DatasetInputMetadataV1;
  }): Promise<DatasetUploadResult> {
    if (input.taskSensitivity === 'confidential') {
      throw new DatasetInputGateError('confidential Dataset cannot enter the model analysis path');
    }
    if (input.metadata.piiConfirmedAbsent !== true) {
      throw new DatasetInputGateError('PII absence must be explicitly confirmed');
    }
    if (input.mediaType !== 'text/csv' && input.mediaType !== CSV_MEDIA_TYPE) {
      throw new DatasetInputGateError('mediaType must be text/csv');
    }
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_CSV_BYTES) {
      throw new DatasetInputGateError('CSV byte size must be between 1 byte and 10 MiB');
    }
    const fileName = safeFileName(input.fileName);
    const content = decodeUtf8(input.bytes);
    const parsed = parseRows(content);
    assertNoDetectedPii(parsed.columns, parsed.rows);
    const rawHash = sha256(input.bytes);
    let raw: ControlArtifact | null = null;
    let sealedProfile: ControlArtifact | null = null;
    try {
      raw = await this.artifacts.writeCsv({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: RAW_KIND,
        relativePath: `inputs/datasets/${randomUUID()}.csv`,
        schemaVersion: RAW_SCHEMA,
        sensitivity: input.taskSensitivity,
        redactionPolicyVersion: 'v1',
        content,
        mediaType: CSV_MEDIA_TYPE,
        maxByteSize: MAX_CSV_BYTES,
        metadata: { role: input.role, fileName, ownerUserId: input.ownerUserId },
      });
      assertArtifact({
        artifact: raw,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: RAW_KIND,
        schemaVersion: RAW_SCHEMA,
        mediaType: CSV_MEDIA_TYPE,
      });
      if (raw.contentSha256 !== rawHash) throw new DatasetInputGateError('raw CSV Artifact hash is invalid');
      const profile: DatasetInputProfileV1 = {
        version: PROFILE_SCHEMA,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        ownerUserId: input.ownerUserId,
        gateKey: input.role,
        fileName,
        mediaType: CSV_MEDIA_TYPE,
        byteSize: input.bytes.byteLength,
        contentSha256: rawHash,
        rawArtifactId: raw.id,
        columns: parsed.columns.map((name, index) => ({ index, name })),
        columnProfiles: profileColumns(parsed.columns, parsed.rows),
        rows: parsed.rows.map((values, index) => ({
          index,
          evidenceId: `dataset:${input.role}:row:${index + 1}`,
          values,
        })),
        rowCount: parsed.rows.length,
        metadata: structuredClone(input.metadata),
      };
      const profileBytes = Buffer.byteLength(JSON.stringify(profile), 'utf8');
      if (profileBytes > MAX_MODEL_VIEW_BYTES) {
        throw new DatasetInputGateError(
          'normalized Dataset exceeds the bounded model analysis view; reduce or aggregate the CSV',
          'dataset_too_large_for_analysis',
        );
      }
      sealedProfile = await this.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: PROFILE_KIND,
        relativePath: `inputs/datasets/${randomUUID()}.json`,
        schemaVersion: PROFILE_SCHEMA,
        sensitivity: input.taskSensitivity,
        redactionPolicyVersion: 'v1',
        metadata: { role: input.role, ownerUserId: input.ownerUserId, rawArtifactId: raw.id },
        value: profile,
      });
      assertArtifact({
        artifact: sealedProfile,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: PROFILE_KIND,
        schemaVersion: PROFILE_SCHEMA,
      });
      return {
        datasetInputId: sealedProfile.id,
        fileName,
        contentSha256: rawHash,
        byteSize: input.bytes.byteLength,
        rowCount: parsed.rows.length,
        columns: parsed.columns,
      };
    } catch (error) {
      for (const artifact of [sealedProfile, raw]) {
        if (!artifact) continue;
        try {
          await this.artifacts.invalidateArtifactPublication(artifact.id, 'dataset input publication failed');
        } catch {
          // Preserve the authoritative upload failure.
        }
      }
      throw error;
    }
  }

  async prepareBinding(input: {
    taskId: string;
    planVersionId: string;
    gateKey: string;
    ownerUserId: string;
    datasetInputId: string;
  }): Promise<PreparedDatasetInputGate> {
    const verified = await this.artifacts.readVerifiedBoundJson<DatasetInputProfileV1>(input.datasetInputId);
    assertArtifact({
      artifact: verified.artifact,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: PROFILE_KIND,
      schemaVersion: PROFILE_SCHEMA,
    });
    const profile = parseProfile(verified.value);
    if (
      profile.taskId !== input.taskId
      || profile.planVersionId !== input.planVersionId
      || profile.ownerUserId !== input.ownerUserId
      || profile.gateKey !== input.gateKey
    ) throw new DatasetInputGateError(`dataset ${input.gateKey} profile binding is invalid`);
    const raw = await this.artifacts.readVerifiedBoundCsv(profile.rawArtifactId);
    assertArtifact({
      artifact: raw.artifact,
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      kind: RAW_KIND,
      schemaVersion: RAW_SCHEMA,
      mediaType: CSV_MEDIA_TYPE,
    });
    if (
      raw.artifact.contentSha256 !== profile.contentSha256
      || Buffer.byteLength(raw.content, 'utf8') !== profile.byteSize
    ) throw new DatasetInputGateError(`dataset ${input.gateKey} raw Artifact is invalid`);
    return {
      gateKey: input.gateKey,
      evidenceRef: verified.artifact.id,
      artifactIds: [raw.artifact.id, verified.artifact.id],
    };
  }

  async invalidate(input: PreparedDatasetInputGate, reason: string): Promise<void> {
    await Promise.all(input.artifactIds.map((artifactId) => (
      this.artifacts.invalidateArtifactPublication(artifactId, reason)
    )));
  }

  async resolve(input: {
    taskId: string;
    planVersionId: string;
    ownerUserId: string;
    gates: readonly ControlGateRecord[];
    pendingInputs: readonly PendingInput[];
  }): Promise<ResolvedDatasetInputGates> {
    const pendingByRole = new Map(
      input.pendingInputs.filter(({ kind }) => kind === 'dataset').map((pending) => [pending.role, pending]),
    );
    const resolved: ResolvedDatasetInput[] = [];
    const gates = await Promise.all(input.gates.map(async (gate) => {
      const pending = pendingByRole.get(gate.gateKey);
      if (!pending || gate.decision === 'waived') return structuredClone(gate);
      if (gate.value !== null && gate.value !== undefined) {
        throw new DatasetInputGateError(`dataset gate ${gate.gateKey} must not contain an inline value`);
      }
      if (!gate.evidenceRef) throw new DatasetInputGateError(`dataset gate ${gate.gateKey} has no evidence reference`);
      const verified = await this.artifacts.readVerifiedBoundJson<DatasetInputProfileV1>(gate.evidenceRef);
      assertArtifact({
        artifact: verified.artifact,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: PROFILE_KIND,
        schemaVersion: PROFILE_SCHEMA,
      });
      const profile = parseProfile(verified.value);
      if (
        profile.taskId !== input.taskId
        || profile.planVersionId !== input.planVersionId
        || profile.ownerUserId !== input.ownerUserId
        || profile.gateKey !== gate.gateKey
      ) throw new DatasetInputGateError(`dataset gate ${gate.gateKey} profile binding is invalid`);
      const raw = await this.artifacts.readVerifiedBoundCsv(profile.rawArtifactId);
      assertArtifact({
        artifact: raw.artifact,
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        kind: RAW_KIND,
        schemaVersion: RAW_SCHEMA,
        mediaType: CSV_MEDIA_TYPE,
      });
      if (
        raw.artifact.contentSha256 !== profile.contentSha256
        || Buffer.byteLength(raw.content, 'utf8') !== profile.byteSize
      ) throw new DatasetInputGateError(`dataset gate ${gate.gateKey} raw Artifact is invalid`);
      const modelView: DatasetModelViewV1 = {
        version: 'dataset-model-view-v1',
        datasetInputId: verified.artifact.id,
        profileEvidenceId: `dataset:${gate.gateKey}:profile`,
        role: gate.gateKey,
        columns: structuredClone(profile.columns),
        columnProfiles: structuredClone(profile.columnProfiles),
        rows: structuredClone(profile.rows),
        rowCount: profile.rowCount,
        metadata: structuredClone(profile.metadata),
      };
      resolved.push({ gateKey: gate.gateKey, artifact: verified.artifact, profile });
      return {
        ...structuredClone(gate),
        value: modelView,
      };
    }));
    return { gates, datasets: resolved };
  }
}

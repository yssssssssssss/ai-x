export const ZERO_PUBLICATION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

export type ZeroPublicationStatus = typeof ZERO_PUBLICATION_STATUSES[number];

export const ZERO_PUBLICATION_STAGES = [
  'checking_zero',
  'reading_report',
  'rendering_html',
  'creating_draft',
  'transcoding_images',
  'writing_images',
  'verifying_metadata',
  'verifying_fills',
  'capturing_screenshots',
  'finalizing_receipt',
] as const;

export type ZeroPublicationStage = typeof ZERO_PUBLICATION_STAGES[number];

export interface ZeroIntegrationStatusResponse {
  available: boolean;
  authenticated: boolean;
  version?: string;
  currentFileKey?: string;
  currentPageId?: string;
  currentPageName?: string;
  reason?: 'offline' | 'unauthenticated' | 'no_design_tab' | 'protocol_error';
}

export interface CreateZeroPublicationRequest {
  expectedTaskState: 'completed' | 'completed_with_gaps';
  target: { mode: 'current_page' };
  updatePublicationId?: string;
}

export interface CreateZeroPublicationResponse {
  publicationId: string;
  status: ZeroPublicationStatus;
}

export interface ZeroPublicationFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ZeroPublicationResponse {
  id: string;
  taskId: string;
  status: ZeroPublicationStatus;
  stage: ZeroPublicationStage;
  progress: number;
  rootNodeId?: string;
  pageId?: string;
  pageName?: string;
  fileKey?: string;
  screenshotAssetIds?: string[];
  failure?: ZeroPublicationFailure;
  createdAt: string;
  updatedAt: string;
}

export interface ZeroPublicationReceipt {
  version: 'zero-publication-receipt-v1';
  publicationId: string;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPackageArtifactId: string;
  reportPackageHash: string;
  templateVersion: string;
  zero: {
    fileKey: string | null;
    pageId: string;
    pageName: string;
    rootNodeId: string;
  };
  nodeMap: Record<string, string>;
  imageManifest: Array<{
    key: string;
    nodeId: string;
    imageHash: string;
    contentSha256: string;
  }>;
  screenshotArtifactIds: string[];
  publishedAt: string;
}

export class ZeroPublicationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroPublicationContractError';
  }
}

const CREATE_REQUEST_KEYS = new Set([
  'expectedTaskState',
  'target',
  'updatePublicationId',
]);
const TARGET_KEYS = new Set(['mode']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ZERO_NODE_ID = /^\d+:\d+$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isZeroNodeId(value: unknown): value is string {
  return typeof value === 'string' && ZERO_NODE_ID.test(value);
}

export function parseCreateZeroPublicationRequest(value: unknown): CreateZeroPublicationRequest {
  const input = record(value);
  if (!input) throw new ZeroPublicationContractError('Zero publication request must be an object');
  const unknownKey = Object.keys(input).find((key) => !CREATE_REQUEST_KEYS.has(key));
  if (unknownKey) {
    throw new ZeroPublicationContractError(`Zero publication request contains unsupported field ${unknownKey}`);
  }
  if (input.expectedTaskState !== 'completed' && input.expectedTaskState !== 'completed_with_gaps') {
    throw new ZeroPublicationContractError('expectedTaskState must be a completed state');
  }
  const target = record(input.target);
  if (!target || Object.keys(target).some((key) => !TARGET_KEYS.has(key)) || target.mode !== 'current_page') {
    throw new ZeroPublicationContractError('target must select the current Zero page');
  }
  if (
    input.updatePublicationId !== undefined
    && (typeof input.updatePublicationId !== 'string' || !UUID.test(input.updatePublicationId))
  ) {
    throw new ZeroPublicationContractError('updatePublicationId must be a UUID');
  }
  return {
    expectedTaskState: input.expectedTaskState,
    target: { mode: 'current_page' },
    ...(typeof input.updatePublicationId === 'string'
      ? { updatePublicationId: input.updatePublicationId }
      : {}),
  };
}

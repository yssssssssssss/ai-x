import type {
  CreateZeroPublicationRequest,
  ZeroPublicationStage,
} from '../../../packages/api-contract/zero-publication.ts';

export type ZeroPublicationUiState = 'idle' | 'creating' | 'running' | 'completed' | 'failed';

export interface ZeroPublicationRequestIdentity {
  body: CreateZeroPublicationRequest;
  idempotencyKey: string;
}

export function zeroPublicationRequestForSubmit(input: {
  uiState: ZeroPublicationUiState;
  previousRequest: ZeroPublicationRequestIdentity | null;
  expectedTaskState: CreateZeroPublicationRequest['expectedTaskState'];
  idempotencyKey: string;
  updatePublicationId?: string;
}): ZeroPublicationRequestIdentity {
  if (input.uiState === 'failed' && input.previousRequest) return input.previousRequest;
  return {
    body: {
      expectedTaskState: input.expectedTaskState,
      target: { mode: 'current_page' },
      ...(input.updatePublicationId ? { updatePublicationId: input.updatePublicationId } : {}),
    },
    idempotencyKey: input.idempotencyKey,
  };
}

export type ZeroPublicationConfirmationState = 'closed' | 'open';
export type ZeroPublicationConfirmationAction = 'request' | 'cancel' | 'confirm';

export interface ZeroPublicationConfirmationTransition {
  state: ZeroPublicationConfirmationState;
  submit: boolean;
}

export function transitionZeroPublicationConfirmation(
  state: ZeroPublicationConfirmationState,
  action: ZeroPublicationConfirmationAction,
): ZeroPublicationConfirmationTransition {
  if (action === 'request') return { state: 'open', submit: false };
  if (action === 'cancel') return { state: 'closed', submit: false };
  return state === 'open'
    ? { state: 'closed', submit: true }
    : { state, submit: false };
}

export function zeroPublicationButtonLabel(state: ZeroPublicationUiState): string {
  if (state === 'creating') return '正在创建…';
  if (state === 'running') return '正在发送…';
  if (state === 'completed') return '更新 Zero 稿件';
  if (state === 'failed') return '重试发送到 Zero';
  return '发送到 Zero';
}

const ZERO_STAGE_LABELS: Record<ZeroPublicationStage, string> = {
  checking_zero: '正在连接 Zero',
  reading_report: '正在读取报告',
  rendering_html: '正在生成长页',
  creating_draft: '正在创建长页',
  transcoding_images: '正在处理图片',
  writing_images: '正在写入图片',
  verifying_metadata: '正在验证结构',
  verifying_fills: '正在验证图片',
  capturing_screenshots: '正在保存验收截图',
  finalizing_receipt: '正在完成发布',
};

export function zeroPublicationProgressLabel(stage: ZeroPublicationStage, progress: number): string {
  return `${ZERO_STAGE_LABELS[stage]} · ${Math.max(0, Math.min(100, Math.round(progress)))}%`;
}

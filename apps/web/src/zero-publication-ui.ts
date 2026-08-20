import type { ZeroPublicationStage } from './api/client.ts';

export type ZeroPublicationUiState = 'idle' | 'creating' | 'running' | 'completed' | 'failed';

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

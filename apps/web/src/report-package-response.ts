import type { CurrentReportPackageResponse } from '../../../packages/api-contract/control-workflow.ts';
import type { ResearchPlanPayload } from '../../../packages/api-contract/research-deliverable.ts';

export type ControlDeliverableResponse = CurrentReportPackageResponse<ResearchPlanPayload>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseControlDeliverableResponse(value: unknown): ControlDeliverableResponse {
  if (!isRecord(value)) throw new Error('report package response must be an object');
  if (value.presentationMode === 'legacy_text') return value as unknown as ControlDeliverableResponse;
  if (value.presentationMode !== 'current_text' && value.presentationMode !== 'multimodal') {
    throw new Error('report package presentationMode is unsupported');
  }
  if (!isRecord(value.reportReview) || value.reportReview.verdict !== 'pass') {
    throw new Error('final report package Review verdict must be pass');
  }
  return value as unknown as ControlDeliverableResponse;
}

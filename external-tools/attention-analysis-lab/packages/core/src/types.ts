export type AttentionMode = 'heuristic' | 'semantic' | 'hybrid';

export type AttentionStatus = 'available' | 'failed' | 'insufficient_inputs';

export interface UploadedImageRef {
  id?: string;
  fileName?: string;
  path?: string;
  url?: string;
  dataUrl?: string;
}

export interface RoiInput {
  id?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AttentionAnalyzeRequest {
  image?: UploadedImageRef;
  rois?: RoiInput[];
  mode?: AttentionMode;
  includeCenterBias?: boolean;
}

export interface AttentionHotspot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  reason: string;
  label?: string;
  attentionShare?: number;
}

export interface RoiAttentionResult {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  attentionAverage: number;
  attentionPeak: number;
  attentionShare: number;
  attentionRank: number;
}

export interface AttentionAnalyzeResult {
  status: AttentionStatus;
  mode: AttentionMode;
  engine?: 'vlm' | 'heuristic';
  degraded?: boolean;
  reasonCode?: 'vlm_not_configured' | 'vlm_failed';
  model?: string;
  attempts?: number;
  summary: string;
  heatmap: number[][];
  heatmapImage?: string;
  hotspots: AttentionHotspot[];
  peakAttentionScore: number;
  focusBalanceScore: number;
  distractionRiskScore: number;
  roiAttentionRanking: RoiAttentionResult[];
  warnings: string[];
  boundaryNotes: string[];
}

export type AestheticProfileId = 'balanced' | 'readability_first' | 'marketing_impact';

export type AestheticDepth = 'lite' | 'standard' | 'deep';

export type AestheticStatus = 'available' | 'failed' | 'insufficient_inputs';

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

export interface AestheticAnalyzeRequest {
  designImage?: UploadedImageRef;
  rois?: RoiInput[];
  foregroundImage?: UploadedImageRef;
  backgroundImage?: UploadedImageRef;
  profileId?: AestheticProfileId;
  depth?: AestheticDepth;
  enableAttention?: boolean;
  includeAttentionInOverallScore?: boolean;
}

export interface AestheticProfileDefinition {
  id: AestheticProfileId;
  label: string;
  description: string;
  defaultDepth: AestheticDepth;
  defaults: {
    enableAttention: boolean;
    includeAttentionInOverallScore: boolean;
  };
}

export interface WholeImageResult {
  width: number;
  height: number;
  edgeDensity: number;
  textureComplexity: number;
  colorComplexity: number;
  dominantColor: string;
  brightness: number;
  saturation: number;
  textRecommendation: string;
  score: number;
}

export interface RoiResult {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  brightness: number;
  saturation: number;
  edgeDensity: number;
  attentionAverage?: number;
  attentionPeak?: number;
  attentionShare?: number;
  attentionRank?: number;
}

export interface PairResult {
  contrastRatio: number;
  brightnessDelta: number;
  saturationDelta: number;
  harmonyTheory: string;
  score: number;
}

export interface AttentionHotspot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  reason: string;
}

export interface AttentionResult {
  heatmap: number[][];
  hotspots: AttentionHotspot[];
  peakAttentionScore: number;
  focusBalanceScore: number;
  distractionRiskScore: number;
  summary: string;
}

export interface AestheticAnalyzeResult {
  status: AestheticStatus;
  summary: string;
  profileId: AestheticProfileId;
  depth: AestheticDepth;
  overallScore?: number;
  dimensionScores: {
    overallColorScore: number;
    temperatureScore: number;
    colorfulnessScore: number;
    harmonyScore: number;
    attentionFocusScore?: number;
  };
  wholeImage?: WholeImageResult;
  roiResults: RoiResult[];
  pairResult?: PairResult;
  attentionResult?: AttentionResult;
  findings: string[];
  recommendations: string[];
  warnings: string[];
  boundaryNotes: string[];
  confidence: {
    level: 'low' | 'medium' | 'high';
    score: number;
    notes: string[];
  };
}

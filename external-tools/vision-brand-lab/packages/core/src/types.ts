export interface UploadedImageRef {
  id?: string;
  fileName?: string;
  path?: string;
  url?: string;
  dataUrl?: string;
}

export interface VisionBrandAnalyzeRequest {
  designImages?: UploadedImageRef[];
  brandReferenceImages?: UploadedImageRef[];
  businessGoal?: string;
  reviewFocus?: string[];
  targetBrandName?: string;
  enabledModules?: {
    visualReview?: boolean;
    brandAssociation?: boolean;
  };
}

export interface ReviewerDimension {
  name: string;
  score?: number;      // 0-10
  evidence?: string;
  suggestion?: string;
}

export interface ReviewerIssue {
  severity: 'low' | 'medium' | 'high';
  issue: string;
  suggestion?: string;
}

export interface VisualReviewerResult {
  role: string;
  score: number;                    // 归一化 0-1(兼容旧结构);LLM 路径由 overallScore/10 得
  findings: string[];
  suggestions: string[];
  // LLM(VLM)路径的丰富字段(启发式路径可不填):
  roleLabel?: string;
  dimensions?: ReviewerDimension[];
  issues?: ReviewerIssue[];
  overallScore?: number;            // 0-10
  topSuggestion?: string;
  actualModel?: string;
}

export interface BrandAssociationResult {
  status: 'available' | 'insufficient_inputs' | 'failed';
  score?: number;
  vectorScore?: number;
  summary: string;
  referenceSampleCount: number;
  designSampleCount: number;
  warnings: string[];
  vectorBackend?: 'vlm_descriptor' | 'dinov2_l_1024';
  vectorDimension?: number;
}

export interface VisionBrandAnalyzeResult {
  status: 'available' | 'partial_failed' | 'failed' | 'insufficient_inputs';
  summary: string;
  engine?: 'vlm' | 'heuristic';     // 本次分析用真实 VLM 还是降级启发式
  visualReview?: {
    reviewers: VisualReviewerResult[];
    consensus: string[];
    conflicts: string[];
    priorityActions: string[];
  };
  brandAssociation?: BrandAssociationResult;
  findings: string[];
  recommendations: string[];
  warnings: string[];
  boundaryNotes: string[];
}

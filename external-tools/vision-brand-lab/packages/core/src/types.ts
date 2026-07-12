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

export interface VisualReviewerResult {
  role: string;
  score: number;
  findings: string[];
  suggestions: string[];
}

export interface BrandAssociationResult {
  status: 'available' | 'insufficient_inputs' | 'failed';
  score?: number;
  vectorScore?: number;
  summary: string;
  referenceSampleCount: number;
  designSampleCount: number;
  warnings: string[];
}

export interface VisionBrandAnalyzeResult {
  status: 'available' | 'partial_failed' | 'failed' | 'insufficient_inputs';
  summary: string;
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

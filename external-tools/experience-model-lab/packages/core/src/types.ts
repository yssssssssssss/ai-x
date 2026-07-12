export interface ExperienceModelProfile {
  id: string;
  name: string;
  filename: string;
  description: string;
  tags: string[];
  bestFor: string[];
}

export interface ExperienceAnalyzeRequest {
  query?: string;
  taskMode?: string;
  inputType?: string;
  preferredModelIds?: string[];
  manualOverrideModelIds?: string[];
}

export interface ExperienceModelSelection {
  id: string;
  name: string;
  filename: string;
  score: number;
  reasons: string[];
}

export interface ExperienceModelChunkTrace {
  modelId: string;
  filename: string;
  source: string;
  matchedTerms: string[];
}

export interface ExperienceAnalyzeResult {
  status: 'available' | 'failed' | 'insufficient_inputs';
  summary: string;
  selectedModels: ExperienceModelSelection[];
  rejectedModels: ExperienceModelSelection[];
  frameworkSummary: string;
  modelRationale: string[];
  questionTemplates: string[];
  evidenceChunks: ExperienceModelChunkTrace[];
  warnings: string[];
  boundaryNotes: string[];
}

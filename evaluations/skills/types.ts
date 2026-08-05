import type { KBAssessment } from './kb/assessment.ts';

export interface SkillEvaluationCase {
  skill_id: string;
  title: string;
  research_goal: string;
  input_materials: Record<string, unknown>;
  tool_outputs: Record<string, unknown>[];
  expected_deliverables: string[];
  risk_checks: string[];
}

export interface LoadedEvaluationCase {
  data: SkillEvaluationCase;
  sourcePath: string;
  caseHash: string;
}

export type EvaluationVerdict = 'pass' | 'needs_review' | 'fail';
export type EvaluationStatus = 'succeeded' | 'needs_review' | 'failed' | 'skipped';

export interface ScoreDimension {
  id: string;
  score: number;
  max_score: number;
  evidence: string[];
  defects: string[];
}

export interface SkillScorecard {
  skill_id: string;
  total_score: number | null;
  verdict: EvaluationVerdict;
  dimensions: ScoreDimension[];
  critical_defects: string[];
  review_notes: string[];
}

export interface EvaluationTokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export type EvaluationErrorStage = 'generation' | 'schema_validation' | 'scoring';

export interface SkillEvaluationRecord {
  skillId: string;
  skillHash: string;
  caseHash: string;
  generationPromptHash?: string;
  scoringPromptHash?: string;
  modelName?: string;
  modelVersion?: string;
  generationTraceId?: string;
  scoringTraceId?: string;
  generationTokens?: EvaluationTokenUsage;
  scoringTokens?: EvaluationTokenUsage;
  elapsedMs: number;
  status: EvaluationStatus;
  errorStage?: EvaluationErrorStage;
  errorMessage?: string;
  output?: Record<string, unknown>;
  scorecard?: SkillScorecard;
  kbAssessment?: KBAssessment;
  knowledgeContextRef?: {
    mode: 'gold' | 'live';
    snapshot_id: string;
    required_source_ids: string[];
    selected_source_ids: string[];
    retrieval_recall: number | null;
  };
}

export type EvaluationManifestStatus =
  | 'running'
  | 'completed'
  | 'completed_with_failures';

export interface EvaluationManifestCounts {
  succeeded: number;
  needs_review: number;
  failed: number;
  skipped: number;
}

export interface EvaluationManifest {
  runId: string;
  status: EvaluationManifestStatus;
  startedAt: string;
  completedAt?: string;
  provider: string;
  modelName?: string;
  modelVersion?: string;
  activeSkillCount: number;
  activeSkillIds: string[];
  records: SkillEvaluationRecord[];
  counts: EvaluationManifestCounts;
}

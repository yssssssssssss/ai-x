export const SKILL_NATIVE_PLAN_VERSION = 'skill-native-plan-v2' as const;
export const SKILL_PACKAGE_SNAPSHOT_VERSION = 'skill-package-snapshot-v1' as const;

export type OrchestrationMode = 'single_skill' | 'multi_skill';
export type SkillOutcomeStatus = 'complete' | 'partial' | 'incompatible' | 'failed';
export type ArtifactRole = 'working' | 'output' | 'report';

export interface SkillPackageFile {
  path: string;
  byteSize: number;
  contentSha256: string;
  executable: boolean;
}

export interface SkillPackageDescriptor {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  sourcePath: string;
  packageHash: string;
  fileCount: number;
  byteSize: number;
  frontmatter: Record<string, unknown>;
}

export interface SkillPackageSnapshot {
  version: typeof SKILL_PACKAGE_SNAPSHOT_VERSION;
  package: SkillPackageDescriptor;
  packageHash: string;
  files: SkillPackageFile[];
  directories: string[];
  snapshotPath: string;
  createdAt: string;
}

export interface ExternalKnowledgeSnapshot {
  mountId: string;
  logicalPath: string;
  contentHash: string;
  files: SkillPackageFile[];
  directories: string[];
  snapshotPath: string;
  createdAt: string;
}

export interface SkillTaskMaterial {
  id: string;
  label: string;
  source: 'conversation' | 'upload' | 'artifact';
  value: unknown;
  artifactIds: string[];
}

export interface RequirementBrief {
  version: 'requirement-brief-v1';
  goal: string;
  desiredOutputs: string[];
  scope: string[];
  constraints: string[];
  assumptions: string[];
  openQuestions: string[];
}

export interface RequirementContext extends Omit<RequirementBrief, 'version'> {
  version: 'requirement-context-v2';
  materials: SkillTaskMaterial[];
}

export interface SkillPlanInvocation {
  id: string;
  package: SkillPackageSnapshot;
  dependsOn: string[];
}

export type FinalReportOwner =
  | { kind: 'skill'; invocationId: string }
  | { kind: 'platform_default' };

export interface SkillNativeCandidate {
  id: string;
  title: string;
  description: string;
  rationale: string;
  tradeoffs: string;
  mode: OrchestrationMode;
  recommended: boolean;
  packages: SkillPackageDescriptor[];
  finalReport: { kind: 'skill'; packageId: string } | { kind: 'platform_default' };
}

export interface ExecutionPlan {
  version: typeof SKILL_NATIVE_PLAN_VERSION;
  taskId: string;
  candidateId: string;
  title: string;
  rationale: string;
  tradeoffs: string;
  mode: OrchestrationMode;
  requirement: RequirementContext;
  invocations: SkillPlanInvocation[];
  finalReport: FinalReportOwner;
}

export interface PendingQuestion {
  id: string;
  prompt: string;
  required: boolean;
  answerType: 'text' | 'choice' | 'file';
  options?: string[];
}

export interface RuntimeCheckpoint {
  invocationIndex: number;
  invocationId: string;
  turn: number;
  toolCalls: number;
  stateSummary: string;
  recentResult?: unknown;
  pendingQuestions: PendingQuestion[];
  answers: Record<string, unknown>;
}

export interface TaskArtifact {
  id: string;
  invocationId?: string;
  relativePath: string;
  fileName: string;
  mediaType: string;
  role: ArtifactRole;
  byteSize: number;
  contentSha256: string;
  sourceArtifactIds: string[];
  createdAt?: string;
}

export interface SkillOutcome {
  status: SkillOutcomeStatus;
  summary: string;
  primaryArtifactId?: string;
  artifactIds: string[];
  gaps: string[];
  missingCapabilities: string[];
}

export interface SkillNativeExecutionStepView {
  invocationId: string;
  skillId: string;
  state: 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'skipped';
  turn: number;
  outcome?: SkillOutcome;
  error?: string;
}

export interface SkillNativeExecutionState {
  steps: SkillNativeExecutionStepView[];
  checkpoint: RuntimeCheckpoint | null;
  externalKnowledge: ExternalKnowledgeSnapshot[];
}

export interface SkillNativeExecutionResult {
  state: 'waiting_for_user' | 'completed' | 'completed_with_gaps' | 'failed';
  execution: SkillNativeExecutionState;
  outcome: SkillOutcome | null;
  warnings: string[];
}

export type SkillNativeTaskState =
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'ready'
  | 'executing'
  | 'waiting_for_user'
  | 'paused'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled';

export interface SkillNativeCandidateView {
  candidateId: string;
  title: string;
  description: string;
  rationale: string;
  tradeoffs: string;
  mode: OrchestrationMode;
  recommended: boolean;
  skills: Array<{
    skillId: string;
    name: string;
    description: string;
    packageHash: string;
  }>;
  finalReport: { kind: 'skill'; packageId: string } | { kind: 'platform_default' };
}

export interface SkillNativePlanView {
  version: typeof SKILL_NATIVE_PLAN_VERSION;
  taskId: string;
  candidateId: string;
  title: string;
  rationale: string;
  tradeoffs: string;
  mode: OrchestrationMode;
  requirement: Omit<RequirementContext, 'materials'> & {
    materials: Array<Omit<SkillTaskMaterial, 'value'> & { preview: string }>;
  };
  invocations: Array<{
    id: string;
    skillId: string;
    name: string;
    dependsOn: string[];
    packageHash: string;
  }>;
  finalReport: FinalReportOwner;
}

export interface SkillNativeTaskView {
  id: string;
  projectId: string;
  originalInput: string;
  orchestrationMode: OrchestrationMode;
  state: SkillNativeTaskState;
  stateVersion: number;
  selectedCandidateId: string | null;
  currentAttemptId: string | null;
  requirement: RequirementBrief;
  candidates: SkillNativeCandidateView[];
  plan: SkillNativePlanView | null;
  executionSteps: SkillNativeExecutionStepView[];
  pendingQuestions: PendingQuestion[];
  artifacts: TaskArtifact[];
  result: SkillOutcome | null;
  warnings: string[];
  failure: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillNativeInputAnswer {
  source: 'conversation' | 'upload';
  value: unknown;
}

export interface CreateSkillNativeTaskRequest {
  originalInput: string;
  orchestrationMode: OrchestrationMode;
  projectId?: string;
  inputs?: Record<string, SkillNativeInputAnswer>;
}

export interface ConfirmSkillNativeTaskRequest {
  expectedVersion: number;
  answers?: Record<string, SkillNativeInputAnswer>;
}

export interface ResumeSkillNativeTaskRequest {
  expectedVersion: number;
  answers: Record<string, SkillNativeInputAnswer>;
}

export interface PublishSkillNativeReportRequest {
  expectedVersion: number;
  target: { mode: 'current_page' };
}

export interface SkillNativeZeroPublication {
  taskId: string;
  fileKey: string | null;
  pageId: string;
  pageName: string;
  rootNodeId: string;
}

export interface SkillNativeZeroPublicationDraft {
  taskId: string;
  fileKey: string | null;
  pageId: string;
  pageName: string;
  draftRootNodeId: string;
  finalName: string;
}

export interface SkillNativeTaskSummary {
  id: string;
  originalInput: string;
  orchestrationMode: OrchestrationMode;
  state: SkillNativeTaskState;
  createdAt: string;
  updatedAt: string;
}

export interface SkillNativeCatalogResponse {
  skills: Array<{
    id: string;
    name: string;
    description: string;
    packageHash: string;
    fileCount: number;
    byteSize: number;
    available: true;
  }>;
  unavailableSkills: Array<{ id: string; sourcePath: string; reason: string }>;
}

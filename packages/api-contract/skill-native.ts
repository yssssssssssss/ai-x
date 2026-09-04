export const SKILL_NATIVE_PLAN_VERSION = 'skill-native-plan-v1' as const;
export const REPORT_RESULT_VERSION = 'report-result-v1' as const;

export type OrchestrationMode = 'single_skill' | 'multi_skill';
export type InputSourceKind = 'conversation' | 'upload' | 'database' | 'knowledge' | 'tool';
export type MissingInputPolicy = 'stop' | 'replace' | 'gap';
export type SkillFailurePolicy = 'stop' | 'replace' | 'gap';
export type ReportStatus = 'complete' | 'partial' | 'failed';

export interface SkillInputDefinition {
  id: string;
  label: string;
  description: string;
  required: boolean;
  multiple: boolean;
  acceptedSources: InputSourceKind[];
  toolIds: string[];
  question: string;
  missingPolicy: MissingInputPolicy;
}

export interface SkillResourceDefinition {
  id: string;
  required: boolean;
}

export interface SkillKnowledgeDefinition extends SkillResourceDefinition {
  title: string;
  sourcePath: string;
  contentHash: string;
  status: 'approved' | 'draft';
  content: string;
  inputId?: string;
}

export interface SkillReportDefinition {
  title: string;
  summaryInstruction: string;
  sections: string[];
}

export interface SkillDefinition {
  version: 'skill-definition-v1';
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  inputs: SkillInputDefinition[];
  knowledge: SkillKnowledgeDefinition[];
  tools: SkillResourceDefinition[];
  report: SkillReportDefinition;
  allowPartial: boolean;
  body: string;
  sourcePath: string;
  contentHash: string;
}

export interface ResolvedInput {
  inputId: string;
  source: InputSourceKind;
  value: unknown;
  referenceId?: string;
  skillIds: string[];
}

export interface ResolvedInputView {
  inputId: string;
  source: InputSourceKind;
  preview: string;
  referenceId?: string;
  skillIds: string[];
}

export interface ReportGap {
  id: string;
  message: string;
  skillIds: string[];
}

export interface RequirementContext {
  version: 'requirement-context-v1';
  goal: string;
  scope: string[];
  inputs: ResolvedInput[];
  assumptions: string[];
  gaps: ReportGap[];
}

export interface SkillInvocation {
  id: string;
  skill: SkillDefinition;
  dependsOn: string[];
  failurePolicy: SkillFailurePolicy;
  replacementSkill?: SkillDefinition;
  replacedSkillId?: string;
}

export interface SolutionSkillDefinition {
  skillId: string;
  dependsOn: string[];
  failurePolicy: SkillFailurePolicy;
  replacementSkillId?: string;
}

export interface SolutionDefinition {
  version: 'solution-definition-v1';
  id: string;
  title: string;
  description: string;
  whenToUse: string;
  mode: OrchestrationMode;
  recommended: boolean;
  skills: SolutionSkillDefinition[];
  finalReportSkillId: string;
  sourcePath: string;
  contentHash: string;
}

export interface InputQuestion {
  inputId: string;
  label: string;
  question: string;
  description: string;
  required: boolean;
  multiple: boolean;
  acceptedSources: InputSourceKind[];
  missingPolicy: MissingInputPolicy;
  skillIds: string[];
}

export interface SolutionPlan {
  version: typeof SKILL_NATIVE_PLAN_VERSION;
  taskId: string;
  solutionId: string;
  title: string;
  rationale: string;
  tradeoffs: string;
  mode: OrchestrationMode;
  requirement: RequirementContext;
  invocations: SkillInvocation[];
  finalReportInvocationId: string;
  questions: InputQuestion[];
}

interface ReportBlockBase {
  sourceIds?: string[];
}

export interface ReportTextBlock extends ReportBlockBase {
  type: 'text';
  text: string;
}

export interface ReportListBlock extends ReportBlockBase {
  type: 'list';
  items: string[];
}

export interface ReportTableBlock extends ReportBlockBase {
  type: 'table';
  columns: string[];
  rows: string[][];
}

export interface ReportImageBlock extends ReportBlockBase {
  type: 'image';
  artifactId: string;
  alt: string;
  caption?: string;
}

export type ReportBlock = ReportTextBlock | ReportListBlock | ReportTableBlock | ReportImageBlock;

export interface ReportSection {
  id: string;
  title: string;
  blocks: ReportBlock[];
}

export interface ReportSource {
  id: string;
  kind: InputSourceKind;
  label: string;
  url?: string;
  artifactId?: string;
}

export interface ReportResult {
  version: typeof REPORT_RESULT_VERSION;
  title: string;
  summary: string;
  status: ReportStatus;
  sections: ReportSection[];
  sources: ReportSource[];
  gaps: ReportGap[];
}

export interface SkillNativeExecutionResult {
  status: ReportStatus;
  report: ReportResult | null;
  skillResults: Array<{
    invocationId: string;
    skillId: string;
    status: ReportStatus;
    report?: ReportResult;
    error?: string;
  }>;
  warnings: string[];
}

export type SkillNativeTaskState =
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled';

export interface SkillNativeCandidateView {
  solutionId: string;
  title: string;
  description: string;
  whenToUse: string;
  mode: OrchestrationMode;
  recommended: boolean;
  skills: Array<{
    skillId: string;
    name: string;
    dependsOn: string[];
    failurePolicy: SkillFailurePolicy;
    replacementSkillId?: string;
    replacementSkillName?: string;
    replacementContentHash?: string;
    replacedSkillId?: string;
  }>;
  finalReportSkillId: string;
  inputRequirements: InputQuestion[];
  resolvedInputs: ResolvedInputView[];
  questions: InputQuestion[];
  gaps: ReportGap[];
}

export interface SkillNativePlanView {
  version: typeof SKILL_NATIVE_PLAN_VERSION;
  taskId: string;
  solutionId: string;
  title: string;
  rationale: string;
  tradeoffs: string;
  mode: OrchestrationMode;
  requirement: Omit<RequirementContext, 'inputs'> & { inputs: ResolvedInputView[] };
  invocations: Array<{
    id: string;
    skillId: string;
    name: string;
    dependsOn: string[];
    failurePolicy: SkillFailurePolicy;
    replacementSkillId?: string;
    replacementSkillName?: string;
    replacementContentHash?: string;
    replacedSkillId?: string;
    contentHash: string;
  }>;
  finalReportInvocationId: string;
  questions: InputQuestion[];
}

export interface SkillNativeTaskView {
  id: string;
  projectId: string;
  originalInput: string;
  orchestrationMode: OrchestrationMode;
  state: SkillNativeTaskState;
  stateVersion: number;
  selectedSolutionId: string | null;
  currentAttemptId: string | null;
  candidates: SkillNativeCandidateView[];
  plan: SkillNativePlanView | null;
  executionSteps: SkillNativeExecutionStepView[];
  report: ReportResult | null;
  warnings: string[];
  failure: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillNativeExecutionStepView {
  invocationId: string;
  skillId: string;
  state: 'running' | 'succeeded' | 'failed' | 'skipped';
  report?: ReportResult;
  error?: string;
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
  answers: Record<string, SkillNativeInputAnswer | null>;
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

export const REPORT_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'title', 'summary', 'status', 'sections', 'sources', 'gaps'],
  properties: {
    version: { const: REPORT_RESULT_VERSION },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    status: { enum: ['complete', 'partial', 'failed'] },
    sections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'blocks'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          blocks: {
            type: 'array',
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'text'],
                  properties: {
                    type: { const: 'text' },
                    text: { type: 'string', minLength: 1 },
                    sourceIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'items'],
                  properties: {
                    type: { const: 'list' },
                    items: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                    sourceIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'columns', 'rows'],
                  properties: {
                    type: { const: 'table' },
                    columns: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                    rows: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'array', minItems: 1, items: { type: 'string' } },
                    },
                    sourceIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'artifactId', 'alt'],
                  properties: {
                    type: { const: 'image' },
                    artifactId: { type: 'string', minLength: 1 },
                    alt: { type: 'string', minLength: 1 },
                    caption: { type: 'string' },
                    sourceIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
                  },
                },
              ],
            },
          },
        },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'label'],
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { enum: ['conversation', 'upload', 'database', 'knowledge', 'tool'] },
          label: { type: 'string', minLength: 1 },
          url: { type: 'string' },
          artifactId: { type: 'string' },
        },
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'message', 'skillIds'],
        properties: {
          id: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
          skillIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        },
      },
    },
  },
} as const;

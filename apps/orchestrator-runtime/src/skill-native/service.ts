import { createHash, randomUUID } from 'node:crypto';
import type {
  ConfirmSkillNativeTaskRequest,
  CreateSkillNativeTaskRequest,
  OrchestrationMode,
  SkillNativeCandidateView,
  SkillNativeExecutionStepView,
  SkillNativeInputAnswer,
  SkillNativePlanView,
  ResolvedInput,
  ResolvedInputView,
  SkillNativeTaskView,
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
  SkillDefinition,
  SolutionDefinition,
  SolutionPlan,
} from '../../../../packages/api-contract/skill-native.ts';
import { SkillNativeCatalog, type SkillNativeCatalogSnapshot } from './catalog.ts';
import {
  SkillNativeExecutionEngine,
  type FrozenSkillNativeToolMaterial,
  type SkillNativeToolPort,
} from './execution.ts';
import { renderReportHtml, renderReportMarkdown } from './html-renderer.ts';
import {
  collectSkillInputQuestions,
  resolveSkillInputs,
  type InputMaterial,
} from './input-resolution.ts';
import { buildSolutionPlan } from './plan.ts';
import { parseVisualInputDataUrls } from '../report/visual-input-data-url.ts';
import { redactString } from '../runtime/redaction.ts';
import type {
  SkillNativeArtifactInput,
  SkillNativeArtifactRecord,
  SkillNativeTaskRecord,
  SkillNativeTaskStore,
  StoredSkillNativeCandidate,
} from './store.ts';

const MAX_ORIGINAL_INPUT_CHARS = 20_000;
const MAX_CONVERSATION_ANSWER_CHARS = 20_000;
const MAX_CONVERSATION_ANSWER_ITEMS = 100;
const MAX_UPLOAD_ITEMS = 20;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_PIXELS = 40_000_000;
const JSON_MEDIA_TYPE = 'application/json';
const MAX_PROJECT_ID_CHARS = 255;
const TEXT_UPLOAD_MEDIA_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/tab-separated-values',
  JSON_MEDIA_TYPE,
]);

export interface SkillNativeReportPublisher {
  prepare(input: {
    taskId: string;
    title: string;
    html: string;
  }): Promise<SkillNativeZeroPublicationDraft>;
  finalize(draft: SkillNativeZeroPublicationDraft): Promise<SkillNativeZeroPublication>;
  cleanup(draft: SkillNativeZeroPublicationDraft): Promise<void>;
}

export class SkillNativeWorkflowError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'not_found' | 'conflict' | 'unavailable' | 'input_required',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SkillNativeWorkflowError';
  }
}

function safeError(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function materialId(prefix: string, inputId: string, value: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
  return `${prefix}:${inputId}:${digest}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uploadName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\r\n]/u.test(value)) {
    throw new SkillNativeWorkflowError('invalid_request', '上传文件名无效');
  }
  return value.trim();
}

function conversationAnswer(value: unknown): string | string[] {
  if (Array.isArray(value) && value.length > MAX_CONVERSATION_ANSWER_ITEMS) {
    throw new SkillNativeWorkflowError(
      'invalid_request',
      `对话输入不能超过 ${MAX_CONVERSATION_ANSWER_ITEMS} 项`,
    );
  }
  const values = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.length > 0
      ? value
      : null;
  if (!values || !values.every((item) => typeof item === 'string' && item.trim())) {
    throw new SkillNativeWorkflowError('invalid_request', '对话输入必须是非空字符串或非空字符串数组');
  }
  const prepared = values.map((item) => (item as string).trim());
  if (prepared.reduce((total, item) => total + item.length, 0) > MAX_CONVERSATION_ANSWER_CHARS) {
    throw new SkillNativeWorkflowError(
      'invalid_request',
      `对话输入不能超过 ${MAX_CONVERSATION_ANSWER_ITEMS} 项且总计不能超过 ${MAX_CONVERSATION_ANSWER_CHARS} 个字符`,
    );
  }
  return typeof value === 'string' ? prepared[0]! : prepared;
}

async function materialFromAnswer(input: {
  taskId: string;
  ownerUserId: string;
  projectId: string;
  inputId: string;
  answer: SkillNativeInputAnswer;
  imageBudget: { pixels: number };
}): Promise<{ material: InputMaterial; artifacts: SkillNativeArtifactInput[] }> {
  if (input.answer.source === 'conversation') {
    const value = conversationAnswer(input.answer.value);
    return {
      material: {
        id: materialId('conversation', input.inputId, value),
        inputId: input.inputId,
        source: 'conversation',
        value,
      },
      artifacts: [],
    };
  }
  const values = Array.isArray(input.answer.value) ? input.answer.value : [input.answer.value];
  if (values.length === 0) throw new SkillNativeWorkflowError('invalid_request', '上传内容不能为空');
  const artifacts: SkillNativeArtifactInput[] = [];
  const prepared: unknown[] = [];
  for (const value of values) {
    const file = record(value);
    if (!file) throw new SkillNativeWorkflowError('invalid_request', '上传内容格式无效');
    const fileName = uploadName(file.name);
    if (typeof file.mediaType !== 'string' || !file.mediaType.trim()) {
      throw new SkillNativeWorkflowError('invalid_request', '上传文件类型无效');
    }
    const mediaType = file.mediaType.trim().toLowerCase();
    if (Object.hasOwn(file, 'dataUrl')) {
      let parsed;
      try {
        parsed = (await parseVisualInputDataUrls({ dataUrl: file.dataUrl }))[0];
      } catch {
        throw new SkillNativeWorkflowError('invalid_request', '图片必须是有效的 PNG、JPEG 或 WebP，且不超过 10 MiB');
      }
      if (!parsed || parsed.contentType !== mediaType) {
        throw new SkillNativeWorkflowError('invalid_request', '图片声明类型与实际内容不一致');
      }
      input.imageBudget.pixels += parsed.pixelCount;
      if (input.imageBudget.pixels > MAX_UPLOAD_PIXELS) {
        throw new SkillNativeWorkflowError('invalid_request', '一次请求的图片总像素不能超过 4000 万');
      }
      const artifactId = randomUUID();
      artifacts.push({
        id: artifactId,
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        inputId: input.inputId,
        fileName,
        mediaType: parsed.contentType,
        bytes: parsed.bytes,
        contentSha256: `sha256:${createHash('sha256').update(parsed.bytes).digest('hex')}`,
      });
      prepared.push({ name: fileName, mediaType: parsed.contentType, artifactId });
      continue;
    }
    if (!TEXT_UPLOAD_MEDIA_TYPES.has(mediaType)) {
      throw new SkillNativeWorkflowError('invalid_request', '文本上传的文件类型无效');
    }
    if (
      typeof file.content !== 'string'
      || !file.content.trim()
      || Buffer.byteLength(file.content, 'utf8') > 2 * 1024 * 1024
    ) {
      throw new SkillNativeWorkflowError('invalid_request', '文本上传必须非空且小于或等于 2 MiB');
    }
    prepared.push({ name: fileName, mediaType, content: file.content });
  }
  const value = Array.isArray(input.answer.value) ? prepared : prepared[0];
  return {
    material: {
      id: materialId('upload', input.inputId, value),
      inputId: input.inputId,
      source: 'upload',
      value,
    },
    artifacts,
  };
}

async function materialsFromAnswers(input: {
  taskId: string;
  ownerUserId: string;
  projectId: string;
  answers: Record<string, SkillNativeInputAnswer>;
}): Promise<{ materials: InputMaterial[]; artifacts: SkillNativeArtifactInput[] }> {
  let uploadItems = 0;
  let uploadBytes = 0;
  for (const answer of Object.values(input.answers)) {
    if (answer.source !== 'upload') continue;
    const values = Array.isArray(answer.value) ? answer.value : [answer.value];
    uploadItems += values.length;
    for (const value of values) {
      const file = record(value);
      if (typeof file?.content === 'string') uploadBytes += Buffer.byteLength(file.content, 'utf8');
      if (typeof file?.dataUrl === 'string') {
        const comma = file.dataUrl.indexOf(',');
        const encodedLength = comma >= 0 ? file.dataUrl.length - comma - 1 : file.dataUrl.length;
        const padding = file.dataUrl.endsWith('==') ? 2 : file.dataUrl.endsWith('=') ? 1 : 0;
        uploadBytes += Math.max(0, Math.floor(encodedLength * 3 / 4) - padding);
      }
    }
  }
  if (uploadItems > MAX_UPLOAD_ITEMS) {
    throw new SkillNativeWorkflowError('invalid_request', `一次请求不能超过 ${MAX_UPLOAD_ITEMS} 个上传文件`);
  }
  if (uploadBytes > MAX_UPLOAD_BYTES) {
    throw new SkillNativeWorkflowError('invalid_request', '一次请求的上传内容不能超过 10 MiB');
  }

  const prepared: Array<Awaited<ReturnType<typeof materialFromAnswer>>> = [];
  const imageBudget = { pixels: 0 };
  for (const [inputId, answer] of Object.entries(input.answers)) {
    prepared.push(await materialFromAnswer({ ...input, inputId, answer, imageBudget }));
  }
  return {
    materials: prepared.map(({ material }) => material),
    artifacts: prepared.flatMap(({ artifacts }) => artifacts),
  };
}

function initialConversationMaterials(
  originalInput: string,
  inputIds: ReadonlySet<string>,
): InputMaterial[] {
  return ['research_goal']
    .filter((inputId) => inputIds.has(inputId))
    .map((inputId) => ({
      id: materialId('conversation', inputId, originalInput),
      inputId,
      source: 'conversation' as const,
      value: originalInput,
    }));
}

function replanMaterials(task: SkillNativeTaskRecord): InputMaterial[] {
  const planMaterials = task.plan?.requirement.inputs
    .filter(({ source }) => source === 'conversation' || source === 'upload')
    .map((input) => ({
      id: input.referenceId ?? materialId(input.source, input.inputId, input.value),
      inputId: input.inputId,
      source: input.source,
      value: structuredClone(input.value),
      skillIds: [...input.skillIds],
    })) ?? [];
  if (task.plan) return planMaterials;
  const candidateMaterials = task.candidates
    .filter(({ solution }) => !task.selectedSolutionId || solution.id === task.selectedSolutionId)
    .flatMap(({ initialMaterials }) => initialMaterials)
    .filter(({ source }) => source === 'conversation' || source === 'upload')
    .map((material) => structuredClone(material));
  return [...new Map(candidateMaterials
    .map((material) => [`${material.source}:${material.id}`, material])).values()];
}

function inputPreview(input: ResolvedInput): string {
  const values = Array.isArray(input.value) ? input.value : [input.value];
  const text = values.flatMap((value) => {
    if (typeof value === 'string') return [value];
    const item = record(value);
    if (!item) return [];
    if (typeof item.name === 'string') return [item.name];
    if (Array.isArray(item.sources)) {
      return item.sources.flatMap((source) => {
        const candidate = record(source);
        return typeof candidate?.label === 'string' ? [candidate.label] : [];
      });
    }
    return [];
  }).map((value) => redactString(value).trim()).filter(Boolean);
  const preview = text.length > 0 ? text.slice(0, 4).join('、') : '已绑定';
  return preview.length > 240 ? `${preview.slice(0, 240)}…` : preview;
}

function resolvedInputView(input: ResolvedInput): ResolvedInputView {
  return {
    inputId: input.inputId,
    source: input.source,
    preview: inputPreview(input),
    ...(input.referenceId ? { referenceId: input.referenceId } : {}),
    skillIds: [...input.skillIds],
  };
}

function planView(plan: SolutionPlan): SkillNativePlanView {
  return {
    version: plan.version,
    taskId: plan.taskId,
    solutionId: plan.solutionId,
    title: plan.title,
    rationale: plan.rationale,
    tradeoffs: plan.tradeoffs,
    mode: plan.mode,
    requirement: {
      ...structuredClone(plan.requirement),
      inputs: plan.requirement.inputs.map(resolvedInputView),
    },
    invocations: plan.invocations.map((invocation) => ({
      id: invocation.id,
      skillId: invocation.skill.id,
      name: invocation.skill.name,
      dependsOn: [...invocation.dependsOn],
      failurePolicy: invocation.failurePolicy,
      ...(invocation.replacementSkill ? {
        replacementSkillId: invocation.replacementSkill.id,
        replacementSkillName: invocation.replacementSkill.name,
        replacementContentHash: invocation.replacementSkill.contentHash,
      } : {}),
      ...(invocation.replacedSkillId ? { replacedSkillId: invocation.replacedSkillId } : {}),
      contentHash: invocation.skill.contentHash,
    })),
    finalReportInvocationId: plan.finalReportInvocationId,
    questions: structuredClone(plan.questions),
  };
}

function candidateView(candidate: StoredSkillNativeCandidate): SkillNativeCandidateView {
  const skills = new Map(candidate.skills.map((skill) => [skill.id, skill]));
  const replacements = new Map((candidate.replacementSkills ?? []).map((skill) => [skill.id, skill]));
  return {
    solutionId: candidate.solution.id,
    title: candidate.solution.title,
    description: candidate.solution.description,
    whenToUse: candidate.solution.whenToUse,
    mode: candidate.solution.mode,
    recommended: candidate.solution.recommended,
    skills: candidate.solution.skills.map((item) => {
      const replacement = item.replacementSkillId
        ? replacements.get(item.replacementSkillId)
        : undefined;
      return {
        skillId: item.skillId,
        name: skills.get(item.skillId)?.name ?? item.skillId,
        dependsOn: [...item.dependsOn],
        failurePolicy: item.failurePolicy,
        ...(replacement ? {
          replacementSkillId: replacement.id,
          replacementSkillName: replacement.name,
          replacementContentHash: replacement.contentHash,
        } : {}),
      };
    }),
    finalReportSkillId: candidate.solution.finalReportSkillId,
    inputRequirements: collectSkillInputQuestions(candidate.skills),
    resolvedInputs: candidate.resolution.inputs.map(resolvedInputView),
    questions: structuredClone(candidate.resolution.questions),
    gaps: structuredClone(candidate.resolution.gaps),
  };
}

function taskView(task: SkillNativeTaskRecord): SkillNativeTaskView {
  const finalReportInvocationId = task.plan?.finalReportInvocationId;
  return {
    id: task.id,
    projectId: task.projectId,
    originalInput: task.originalInput,
    orchestrationMode: task.orchestrationMode,
    state: task.state,
    stateVersion: task.stateVersion,
    selectedSolutionId: task.selectedSolutionId,
    currentAttemptId: task.currentAttemptId,
    candidates: task.candidates.map(candidateView),
    plan: task.plan ? planView(task.plan) : null,
    executionSteps: task.executionSteps.map((step) => ({
      invocationId: step.invocationId,
      skillId: step.skillId,
      state: step.state,
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.report !== undefined && step.invocationId === finalReportInvocationId
        ? { report: structuredClone(step.report) }
        : {}),
    })),
    report: task.report ? structuredClone(task.report) : null,
    warnings: [...task.warnings],
    failure: task.failure,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function scopeFromInputs(inputs: SolutionPlan['requirement']['inputs']): string[] {
  const value = inputs.find(({ inputId }) => inputId === 'industry_scope')?.value;
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map(String).map((item) => item.trim()).filter(Boolean);
}

function directSkillRequest(originalInput: string): { skillId: string; goal: string } | null {
  const match = /^\s*\$([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/iu.exec(originalInput);
  if (!match) return null;
  return { skillId: match[1]!, goal: match[2]?.trim() ?? '' };
}

function requirementGoal(
  originalInput: string,
  inputs: readonly SolutionPlan['requirement']['inputs'][number][],
): string {
  const direct = directSkillRequest(originalInput);
  if (direct?.goal) return direct.goal;
  const value = inputs.find(({ inputId }) => inputId === 'research_goal')?.value;
  const resolved = (Array.isArray(value) ? value : [value])
    .find((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  if (resolved) return resolved.trim();
  return direct ? '' : originalInput;
}

function directSolution(skill: SkillDefinition): SolutionDefinition {
  return {
    version: 'solution-definition-v1',
    id: `direct-${skill.id}`,
    title: skill.report.title,
    description: skill.description,
    whenToUse: skill.whenToUse,
    mode: 'single_skill',
    recommended: false,
    skills: [{ skillId: skill.id, dependsOn: [], failurePolicy: 'stop' }],
    finalReportSkillId: skill.id,
    sourcePath: skill.sourcePath,
    contentHash: `sha256:${createHash('sha256').update(`direct:${skill.contentHash}`).digest('hex')}`,
  };
}

function normalizedTerms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const terms = new Set(normalized.split(/\s+/u).filter((term) => term.length > 1));
  const compact = normalized.replaceAll(' ', '');
  for (let size = 2; size <= Math.min(6, compact.length); size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      terms.add(compact.slice(index, index + size));
    }
  }
  return terms;
}

function rankSolutions(
  solutions: readonly SolutionDefinition[],
  query: string,
): SolutionDefinition[] {
  const queryTerms = normalizedTerms(query);
  const ranked = solutions
    .map((solution) => {
      const rawSearchable = `${solution.id} ${solution.title} ${solution.description} ${solution.whenToUse}`;
      const boundary = ['边界：', '边界:', '不适用', '若用户要的是', '注意区分边界']
        .map((marker) => rawSearchable.indexOf(marker))
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      const searchable = boundary === undefined ? rawSearchable : rawSearchable.slice(0, boundary);
      const candidateTerms = normalizedTerms(searchable);
      const titleTerms = normalizedTerms(solution.title);
      let score = 0;
      for (const term of queryTerms) {
        if (candidateTerms.has(term)) score += term.length * term.length;
        if (titleTerms.has(term)) score += term.length * term.length * 20;
      }
      if (searchable.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) score += 20;
      return { solution, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || Number(right.solution.recommended) - Number(left.solution.recommended)
      || left.solution.id.localeCompare(right.solution.id))
    .slice(0, 6);
  if (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score) return [];
  return ranked.map(({ solution }, index) => ({ ...structuredClone(solution), recommended: index === 0 }));
}

function knowledgeMaterials(skills: readonly SkillDefinition[]): InputMaterial[] {
  return skills.flatMap((skill) => skill.knowledge.flatMap((knowledge) => knowledge.inputId
    ? [{
        id: `knowledge:${knowledge.id}:${knowledge.contentHash}`,
        inputId: knowledge.inputId,
        source: 'knowledge' as const,
        value: knowledge.content,
        skillIds: [skill.id],
      }]
    : []));
}

export class SkillNativeTaskService {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly dependencies: {
    store: SkillNativeTaskStore;
    catalog: SkillNativeCatalog;
    execution: SkillNativeExecutionEngine;
    tools: SkillNativeToolPort;
    zeroPublisher?: SkillNativeReportPublisher;
  }) {}

  async create(ownerUserId: string, request: CreateSkillNativeTaskRequest): Promise<SkillNativeTaskView> {
    const originalInput = request.originalInput.trim();
    if (!originalInput) throw new SkillNativeWorkflowError('invalid_request', 'originalInput 必须是非空字符串');
    if (originalInput.length > MAX_ORIGINAL_INPUT_CHARS) {
      throw new SkillNativeWorkflowError('invalid_request', `originalInput 不能超过 ${MAX_ORIGINAL_INPUT_CHARS} 个字符`);
    }
    if (request.orchestrationMode !== 'single_skill' && request.orchestrationMode !== 'multi_skill') {
      throw new SkillNativeWorkflowError('invalid_request', 'orchestrationMode 必须是 single_skill 或 multi_skill');
    }
    const taskId = randomUUID();
    const requestedProjectId = request.projectId?.trim();
    if (requestedProjectId && requestedProjectId.length > MAX_PROJECT_ID_CHARS) {
      throw new SkillNativeWorkflowError('invalid_request', `projectId 不能超过 ${MAX_PROJECT_ID_CHARS} 个字符`);
    }
    const projectId = requestedProjectId || `task:${taskId}`;
    const direct = directSkillRequest(originalInput);
    if (direct && request.orchestrationMode !== 'single_skill') {
      throw new SkillNativeWorkflowError('invalid_request', '显式 $Skill 只能使用 single_skill 模式');
    }
    const selection = this.loadCandidateSelection({
      originalInput: direct?.goal ?? originalInput,
      mode: request.orchestrationMode,
      requestedSkillId: direct?.skillId,
    });
    const knownInputIds = new Set(selection.solutions.flatMap((solution) => solution.skills.flatMap(({ skillId }) => (
      selection.catalog.skills.find(({ id }) => id === skillId)?.inputs.map(({ id }) => id) ?? []
    ))));
    const unknownInputs = Object.keys(request.inputs ?? {}).filter((inputId) => !knownInputIds.has(inputId));
    if (unknownInputs.length > 0) {
      throw new SkillNativeWorkflowError('invalid_request', 'inputs 包含未知字段', unknownInputs);
    }
    const prepared = await materialsFromAnswers({
      taskId,
      ownerUserId,
      projectId,
      answers: request.inputs ?? {},
    });
    const candidates = await this.createCandidates({
      taskId,
      ownerUserId,
      projectId,
      originalInput: direct?.goal ?? originalInput,
      mode: request.orchestrationMode,
      providedMaterials: prepared.materials,
      requestedSkillId: direct?.skillId,
      selection,
    });
    return taskView(await this.dependencies.store.create({
      id: taskId,
      ownerUserId,
      projectId,
      originalInput,
      orchestrationMode: request.orchestrationMode,
      candidates,
      materials: prepared.materials,
      artifacts: prepared.artifacts,
    }));
  }

  async list(ownerUserId: string) {
    return this.dependencies.store.listOwned(ownerUserId);
  }

  async get(taskId: string, ownerUserId: string): Promise<SkillNativeTaskView> {
    return taskView(await this.requireOwned(taskId, ownerUserId));
  }

  async select(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
  }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    const selected = task.candidates.find(({ solution }) => solution.id === input.solutionId);
    if (!selected) {
      throw new SkillNativeWorkflowError('invalid_request', `方案 ${input.solutionId} 不属于当前任务`);
    }
    const reserved = await this.dependencies.store.reserveSelection(input);
    const resolved = await this.resolveCandidateTools(reserved, selected);
    const candidates = reserved.candidates.map((candidate) => (
      candidate.solution.id === input.solutionId ? resolved : candidate
    ));
    return taskView(await this.dependencies.store.completeSelection({
      ...input,
      expectedVersion: reserved.stateVersion,
      candidates,
    }));
  }

  async confirm(input: {
    taskId: string;
    ownerUserId: string;
    body: ConfirmSkillNativeTaskRequest;
  }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    const candidate = task.candidates.find(({ solution }) => solution.id === task.selectedSolutionId);
    if (!candidate) throw new SkillNativeWorkflowError('conflict', '请先选择方案');
    const knownInputIds = new Set(candidate.skills.flatMap((skill) => skill.inputs.map(({ id }) => id)));
    const unknown = Object.keys(input.body.answers).filter((inputId) => !knownInputIds.has(inputId));
    if (unknown.length > 0) {
      throw new SkillNativeWorkflowError('invalid_request', 'answers 包含未知输入', unknown);
    }
    const unanswered = candidate.resolution.questions
      .map(({ inputId }) => inputId)
      .filter((inputId) => !Object.hasOwn(input.body.answers, inputId));
    if (unanswered.length > 0) {
      throw new SkillNativeWorkflowError('input_required', '仍有输入未确认', unanswered);
    }
    const prepared = await materialsFromAnswers({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      projectId: task.projectId,
      answers: Object.fromEntries(Object.entries(input.body.answers)
        .filter((entry): entry is [string, SkillNativeInputAnswer] => entry[1] !== null)),
    });
    const answerMaterials = prepared.materials;
    const unavailableInputIds = Object.entries(input.body.answers)
      .filter(([, answer]) => answer === null)
      .map(([inputId]) => inputId);
    const unavailable = new Set(unavailableInputIds);
    const replacementSkills = new Map((candidate.replacementSkills ?? []).map((skill) => [skill.id, skill]));
    const replaceSkillIds = new Set(candidate.solution.skills.flatMap((definition) => {
      const primary = candidate.skills.find(({ id }) => id === definition.skillId);
      return definition.replacementSkillId && primary?.inputs.some((item) => (
        item.missingPolicy === 'replace' && unavailable.has(item.id)
      )) ? [definition.skillId] : [];
    }));
    const activeSkills: SkillDefinition[] = [];
    for (const definition of candidate.solution.skills) {
      const skill = replaceSkillIds.has(definition.skillId)
        ? replacementSkills.get(definition.replacementSkillId!)
        : candidate.skills.find(({ id }) => id === definition.skillId);
      if (!skill) throw new SkillNativeWorkflowError('unavailable', `Skill ${definition.skillId} 的替换定义不可用`);
      activeSkills.push(skill);
    }
    const replacementOnlyInputs = activeSkills.flatMap((skill) => skill.inputs
      .filter(({ id }) => !knownInputIds.has(id))
      .map(({ id }) => id));
    const automaticallyBoundInputIds = new Set(
      candidate.resolution.inputs.map(({ inputId }) => inputId),
    );
    const overriddenInputIds = new Set(Object.entries(input.body.answers)
      .filter(([inputId, answer]) => answer !== null || automaticallyBoundInputIds.has(inputId))
      .map(([inputId]) => inputId));
    const resolution = resolveSkillInputs({
      skills: activeSkills,
      materials: [
        ...answerMaterials,
        ...candidate.initialMaterials.filter(({ inputId }) => !overriddenInputIds.has(inputId)),
      ],
      unavailableInputIds: [...unavailableInputIds, ...replacementOnlyInputs],
      scope: { ownerUserId: task.ownerUserId, projectId: task.projectId },
    });
    if (resolution.questions.length > 0) {
      throw new SkillNativeWorkflowError(
        'input_required',
        '输入来源不被 Skill 接受',
        resolution.questions.map(({ inputId }) => inputId),
      );
    }
    if (resolution.blockedInputIds.length > 0) {
      throw new SkillNativeWorkflowError('input_required', '必需输入不可缺失', resolution.blockedInputIds);
    }
    for (const skillId of replaceSkillIds) {
      const definition = candidate.solution.skills.find((item) => item.skillId === skillId)!;
      const replacement = replacementSkills.get(definition.replacementSkillId!)!;
      resolution.gaps.push({
        id: `replacement:${skillId}`,
        message: `${candidate.skills.find(({ id }) => id === skillId)!.name}因资料缺失，已按方案替换为${replacement.name}`,
        skillIds: [skillId, replacement.id],
      });
    }
    const requirementBase = {
      version: 'requirement-context-v1' as const,
      goal: requirementGoal(task.originalInput, resolution.inputs),
      scope: scopeFromInputs(resolution.inputs),
      assumptions: [] as string[],
    };
    const plan = buildSolutionPlan({
      taskId: task.id,
      solution: candidate.solution,
      catalog: { skills: [...candidate.skills, ...(candidate.replacementSkills ?? [])] },
      requirement: requirementBase,
      resolution,
      questions: candidate.resolution.questions,
      replaceSkillIds,
    });
    return taskView(await this.dependencies.store.confirm({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      expectedVersion: input.body.expectedVersion,
      plan,
      materials: answerMaterials,
      artifacts: prepared.artifacts,
    }));
  }

  async execute(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeTaskView> {
    const before = await this.requireOwned(input.taskId, input.ownerUserId);
    if (!before.plan) throw new SkillNativeWorkflowError('conflict', '任务没有已确认 Plan');
    const attemptId = randomUUID();
    const executing = await this.dependencies.store.beginExecution({ ...input, attemptId });
    const controller = new AbortController();
    this.active.set(input.taskId, controller);
    const steps = new Map<string, SkillNativeExecutionStepView>(
      executing.executionSteps.map((step) => [step.invocationId, step]),
    );
    const priorResults = new Map(
      executing.executionSteps
        .filter((step): step is SkillNativeExecutionStepView & { report: NonNullable<SkillNativeExecutionStepView['report']> } => step.state === 'succeeded' && Boolean(step.report))
        .map((step) => [step.invocationId, { skillId: step.skillId, report: step.report }] as const),
    );
    try {
      const result = await this.dependencies.execution.execute({
        plan: before.plan,
        attemptId,
        ownerUserId: before.ownerUserId,
        projectId: before.projectId,
        readArtifact: (artifactId) => this.dependencies.store.getArtifactOwned({
          artifactId,
          taskId: before.id,
          ownerUserId: before.ownerUserId,
          projectId: before.projectId,
        }),
        signal: controller.signal,
        priorResults,
        onStep: async (step) => {
          steps.set(step.invocationId, step);
          const saved = await this.dependencies.store.saveExecutionSteps({
            taskId: input.taskId,
            ownerUserId: input.ownerUserId,
            attemptId,
            steps: [...steps.values()],
          });
          if (!saved) controller.abort('task_state_changed');
        },
      });
      const html = result.report
        ? renderReportHtml(result.report, {
            artifactUrl: (artifactId) => `/api/research-tasks/${encodeURIComponent(input.taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
          })
        : null;
      const finished = await this.dependencies.store.finishExecution({
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        attemptId,
        state: result.status === 'failed' ? 'failed' : result.status === 'partial' ? 'completed_with_gaps' : 'completed',
        steps: [...steps.values()],
        report: result.report,
        html,
        markdown: result.report ? renderReportMarkdown(result.report) : null,
        warnings: result.warnings,
        failure: result.status === 'failed' ? '没有 Skill 形成可用结果' : null,
      });
      return taskView(finished ?? await this.requireOwned(input.taskId, input.ownerUserId));
    } catch (error) {
      const current = await this.requireOwned(input.taskId, input.ownerUserId);
      if (current.state === 'cancelled') return taskView(current);
      const failed = await this.dependencies.store.finishExecution({
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        attemptId,
        state: 'failed',
        steps: [...steps.values()],
        report: null,
        html: null,
        markdown: null,
        warnings: [],
        failure: safeError(error),
      });
      return taskView(failed ?? await this.requireOwned(input.taskId, input.ownerUserId));
    } finally {
      if (this.active.get(input.taskId) === controller) this.active.delete(input.taskId);
    }
  }

  async cancel(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskView> {
    const task = await this.dependencies.store.cancel(input);
    this.active.get(input.taskId)?.abort('user_cancelled');
    return taskView(task);
  }

  async resume(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskView> {
    return taskView(await this.dependencies.store.resume(input));
  }

  async replan(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    const direct = directSkillRequest(task.originalInput);
    const candidates = await this.createCandidates({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      projectId: task.projectId,
      originalInput: direct?.goal ?? task.originalInput,
      mode: task.orchestrationMode,
      providedMaterials: replanMaterials(task),
      requestedSkillId: direct?.skillId,
    });
    return taskView(await this.dependencies.store.replan({ ...input, candidates }));
  }

  async html(taskId: string, ownerUserId: string): Promise<string | null> {
    const task = await this.requireOwned(taskId, ownerUserId);
    if (!task.report) return null;
    return this.renderHtml(task, task.report);
  }

  async markdown(taskId: string, ownerUserId: string): Promise<string | null> {
    const task = await this.requireOwned(taskId, ownerUserId);
    if (!task.report) return null;
    const urls = await this.artifactDataUrls(task, task.report);
    return renderReportMarkdown(task.report, { artifactUrl: (artifactId) => urls.get(artifactId) ?? null });
  }

  async artifact(taskId: string, ownerUserId: string, artifactId: string): Promise<SkillNativeArtifactRecord | null> {
    const task = await this.requireOwned(taskId, ownerUserId);
    return this.dependencies.store.getArtifactOwned({
      artifactId,
      taskId: task.id,
      ownerUserId,
      projectId: task.projectId,
    });
  }

  async skillResult(taskId: string, ownerUserId: string, invocationId: string) {
    const task = await this.requireOwned(taskId, ownerUserId);
    const report = task.executionSteps.find((step) => step.invocationId === invocationId)?.report;
    return report ? structuredClone(report) : null;
  }

  async publishZero(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeZeroPublication> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    if (!this.dependencies.zeroPublisher) {
      throw new SkillNativeWorkflowError('unavailable', 'Zero 发布当前不可用');
    }
    const reservation = await this.dependencies.store.reserveZeroPublication(input);
    if (reservation.status === 'completed') return reservation.publication;
    if (!task.report) throw new SkillNativeWorkflowError('conflict', '报告尚未完成');
    let draft = reservation.status === 'prepared' ? reservation.draft : null;
    let persistedDraft = draft !== null;
    try {
      if (!draft) {
        draft = await this.dependencies.zeroPublisher.prepare({
          taskId: task.id,
          title: task.report.title,
          html: await this.renderHtml(task, task.report),
        });
        try {
          await this.dependencies.store.prepareZeroPublication({
            taskId: task.id,
            ownerUserId: task.ownerUserId,
            draft,
          });
          persistedDraft = true;
        } catch (error) {
          await this.dependencies.zeroPublisher.cleanup(draft).catch(() => undefined);
          throw error;
        }
      }
      const publication = await this.dependencies.zeroPublisher.finalize(draft);
      await this.dependencies.store.completeZeroPublication({
        taskId: task.id,
        ownerUserId: task.ownerUserId,
        publication,
      });
      return publication;
    } catch (error) {
      const failure = safeError(error);
      if (!persistedDraft) {
        await this.dependencies.store.failZeroPublication({
          taskId: task.id,
          ownerUserId: task.ownerUserId,
          failure,
        }).catch(() => undefined);
      }
      throw new SkillNativeWorkflowError('unavailable', `Zero 发布失败：${failure}`);
    }
  }

  catalog() {
    const catalog = this.dependencies.catalog.load();
    return {
      skills: catalog.skills.map(({ id, name, description, contentHash }) => ({ id, name, description, contentHash, available: true as const })),
      unavailableSkills: catalog.unavailableSkills,
      solutions: catalog.solutions.map(({ id, title, description, mode, recommended, contentHash }) => ({
        id, title, description, mode, recommended, contentHash,
      })),
      invalidSolutions: catalog.invalidSolutions,
    };
  }

  async recoverInterrupted(): Promise<number> {
    return this.dependencies.store.recoverInterrupted();
  }

  private async createCandidates(input: {
    taskId: string;
    ownerUserId: string;
    projectId: string;
    originalInput: string;
    mode: OrchestrationMode;
    providedMaterials: InputMaterial[];
    requestedSkillId?: string;
    selection?: { catalog: SkillNativeCatalogSnapshot; solutions: SolutionDefinition[] };
  }): Promise<StoredSkillNativeCandidate[]> {
    const { catalog, solutions } = input.selection ?? this.loadCandidateSelection(input);
    const candidateInputIds = [...new Set(solutions.flatMap((solution) => solution.skills.flatMap((definition) => (
      [definition.skillId, definition.replacementSkillId]
        .filter((skillId): skillId is string => Boolean(skillId))
        .flatMap((skillId) => catalog.skills.find(({ id }) => id === skillId)?.inputs.map(({ id }) => id) ?? [])
    ))))];
    const databaseMaterials = await this.dependencies.store.listReusableMaterials({
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      inputIds: candidateInputIds,
    });
    const candidates = solutions.map((solution): StoredSkillNativeCandidate => {
      const skills = solution.skills.map(({ skillId }) => catalog.skills.find(({ id }) => id === skillId)!);
      const replacementSkills = solution.skills.flatMap(({ replacementSkillId }) => {
        if (!replacementSkillId) return [];
        const replacement = catalog.skills.find(({ id }) => id === replacementSkillId);
        return replacement ? [replacement] : [];
      });
      const knownInputIds = new Set([...skills, ...replacementSkills]
        .flatMap((skill) => skill.inputs.map(({ id }) => id)));
      const provided = input.providedMaterials.filter(({ inputId }) => knownInputIds.has(inputId));
      const initialMaterials = [
        ...provided,
        ...initialConversationMaterials(input.originalInput, knownInputIds),
        ...databaseMaterials.filter(({ inputId }) => knownInputIds.has(inputId)),
        ...knowledgeMaterials([...skills, ...replacementSkills]),
      ];
      return {
        solution: structuredClone(solution),
        skills: structuredClone(skills),
        ...(replacementSkills.length > 0 ? { replacementSkills: structuredClone(replacementSkills) } : {}),
        initialMaterials,
        resolution: resolveSkillInputs({
          skills,
          materials: initialMaterials,
          scope: { ownerUserId: input.ownerUserId, projectId: input.projectId },
        }),
      };
    });
    return candidates;
  }

  private loadCandidateSelection(input: {
    originalInput: string;
    mode: OrchestrationMode;
    requestedSkillId?: string;
  }): { catalog: SkillNativeCatalogSnapshot; solutions: SolutionDefinition[] } {
    const catalog = this.dependencies.catalog.load();
    const requestedSkill = input.requestedSkillId
      ? catalog.skills.find(({ id }) => id === input.requestedSkillId)
      : undefined;
    if (input.requestedSkillId && !requestedSkill) {
      throw new SkillNativeWorkflowError('unavailable', `Skill ${input.requestedSkillId} 当前不可用`);
    }
    const configured = catalog.solutions.filter(({ mode }) => mode === input.mode);
    const direct = input.mode === 'single_skill'
      ? catalog.skills
        .filter((skill) => !configured.some((solution) => (
          solution.skills.length === 1 && solution.skills[0]?.skillId === skill.id
        )))
        .filter((skill) => !skill.inputs.some(({ missingPolicy }) => missingPolicy === 'replace'))
        .map(directSolution)
      : [];
    const requestedSolution = requestedSkill
      ? catalog.solutions.find((solution) => (
          solution.mode === 'single_skill'
          && solution.skills.length === 1
          && solution.skills[0]?.skillId === requestedSkill.id
        ))
      : undefined;
    if (requestedSkill?.inputs.some(({ missingPolicy }) => missingPolicy === 'replace') && !requestedSolution) {
      throw new SkillNativeWorkflowError('unavailable', `Skill ${requestedSkill.id} 缺少明确的替换方案`);
    }
    const solutions = requestedSkill
      ? [requestedSolution ?? directSolution(requestedSkill)]
      : rankSolutions([...configured, ...direct], input.originalInput);
    if (solutions.length === 0) {
      throw new SkillNativeWorkflowError(
        'input_required',
        '无法根据当前描述可靠匹配执行方案，请补充研究目标、范围、对象或期望交付物',
        catalog.invalidSolutions,
      );
    }
    return { catalog, solutions };
  }

  private async resolveCandidateTools(
    task: SkillNativeTaskRecord,
    candidate: StoredSkillNativeCandidate,
  ): Promise<StoredSkillNativeCandidate> {
    let materials = structuredClone(candidate.initialMaterials);
    let resolution = resolveSkillInputs({
      skills: candidate.skills,
      materials,
      scope: { ownerUserId: task.ownerUserId, projectId: task.projectId },
    });
    if (!requirementGoal(task.originalInput, resolution.inputs)) return candidate;
    const warnings = [...resolution.warnings];
    const calls = new Map<string, {
      toolId: string;
      inputId: string;
      skill: SkillDefinition;
      skillIds: string[];
    }>();
    for (const question of resolution.questions.filter(({ acceptedSources }) => acceptedSources.includes('tool'))) {
      const definitions = question.skillIds.map((skillId) => {
        const skill = candidate.skills.find(({ id }) => id === skillId);
        const definition = skill?.inputs.find(({ id }) => id === question.inputId);
        return skill && definition ? { skill, definition } : null;
      }).filter((item): item is { skill: SkillDefinition; definition: SkillDefinition['inputs'][number] } => item !== null);
      if (definitions.length !== question.skillIds.length) continue;
      const commonToolIds = definitions[0]!.definition.toolIds.filter((toolId) => (
        definitions.every(({ definition }) => definition.toolIds.includes(toolId))
      ));
      for (const toolId of commonToolIds) {
        calls.set(`${toolId}:${question.inputId}`, {
          toolId,
          inputId: question.inputId,
          skill: definitions[0]!.skill,
          skillIds: [...question.skillIds],
        });
      }
    }

    for (const call of calls.values()) {
      try {
        const result = await this.dependencies.tools.invoke({
          toolId: call.toolId,
          invocationId: `planning:${call.skill.id}`,
          skill: call.skill,
          requirement: {
            version: 'requirement-context-v1',
            goal: requirementGoal(task.originalInput, resolution.inputs),
            scope: scopeFromInputs(resolution.inputs),
            inputs: structuredClone(resolution.inputs),
            assumptions: [],
            gaps: structuredClone(resolution.gaps),
          },
          signal: new AbortController().signal,
          scope: { taskId: task.id, ownerUserId: task.ownerUserId, projectId: task.projectId },
          readArtifact: (artifactId) => this.dependencies.store.getArtifactOwned({
            artifactId,
            taskId: task.id,
            ownerUserId: task.ownerUserId,
            projectId: task.projectId,
          }),
        });
        if (!result.sources?.length) continue;
        const value: FrozenSkillNativeToolMaterial = {
          version: 'skill-native-tool-material-v1',
          toolId: call.toolId,
          output: structuredClone(result.output),
          sources: structuredClone(result.sources),
          ...(result.receipt ? { receipt: structuredClone(result.receipt) } : {}),
        };
        materials.push({
          id: materialId(`tool:${call.toolId}`, call.inputId, value),
          inputId: call.inputId,
          source: 'tool',
          value,
          skillIds: call.skillIds,
        });
        const nextResolution = resolveSkillInputs({
          skills: candidate.skills,
          materials,
          scope: { ownerUserId: task.ownerUserId, projectId: task.projectId },
        });
        warnings.push(...nextResolution.warnings);
        resolution = { ...nextResolution, warnings: [...new Set(warnings)] };
      } catch (error) {
        warnings.push(`${call.toolId} input resolution failed: ${safeError(error)}`);
        resolution = { ...resolution, warnings: [...new Set(warnings)] };
      }
    }
    return {
      ...structuredClone(candidate),
      initialMaterials: materials,
      resolution,
    };
  }

  private async requireOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord> {
    const task = await this.dependencies.store.getOwned(taskId, ownerUserId);
    if (!task) throw new SkillNativeWorkflowError('not_found', '任务不存在');
    return task;
  }

  private async renderHtml(task: SkillNativeTaskRecord, report: NonNullable<SkillNativeTaskRecord['report']>): Promise<string> {
    const urls = await this.artifactDataUrls(task, report);
    return renderReportHtml(report, { artifactUrl: (artifactId) => urls.get(artifactId) ?? null });
  }

  private async artifactDataUrls(
    task: SkillNativeTaskRecord,
    report: NonNullable<SkillNativeTaskRecord['report']>,
  ): Promise<Map<string, string>> {
    const ids = new Set(report.sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
      block.type === 'image' ? [block.artifactId] : []
    ))));
    const artifacts = await Promise.all([...ids].map(async (artifactId) => [
      artifactId,
      await this.dependencies.store.getArtifactOwned({
        artifactId,
        taskId: task.id,
        ownerUserId: task.ownerUserId,
        projectId: task.projectId,
      }),
    ] as const));
    const urls = new Map(artifacts.flatMap(([artifactId, artifact]) => artifact
      ? [[artifactId, `data:${artifact.mediaType};base64,${artifact.bytes.toString('base64')}`] as const]
      : []));
    return urls;
  }
}

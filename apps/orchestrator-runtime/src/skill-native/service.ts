import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  ConfirmSkillNativeTaskRequest,
  CreateSkillNativeTaskRequest,
  ExecutionPlan,
  ResumeSkillNativeTaskRequest,
  SkillNativeCandidate,
  SkillNativeCandidateView,
  SkillNativeInputAnswer,
  SkillNativePlanView,
  SkillNativeTaskView,
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
  SkillTaskMaterial,
} from '../../../../packages/api-contract/skill-native.ts';
import { LLMInvocationError } from '../runtime/llm-client.ts';
import { redactString } from '../runtime/redaction.ts';
import { SkillNativeCatalog } from './catalog.ts';
import { SkillNativeExecutionEngine } from './execution.ts';
import { previewHtmlArtifact, renderMarkdownHtml } from './html-renderer.ts';
import { decodeUploadedImage } from './image-upload.ts';
import { buildExecutionPlan } from './plan.ts';
import { RequirementPlanner, RequirementPlanningError } from './requirement-planner.ts';
import type {
  SkillNativeArtifactInput,
  SkillNativeArtifactRecord,
  SkillNativeTaskRecord,
  SkillNativeTaskStore,
} from './store.ts';

const MAX_ORIGINAL_INPUT_CHARS = 20_000;
const MAX_CONVERSATION_ANSWER_CHARS = 20_000;
const MAX_CONVERSATION_ANSWER_ITEMS = 100;
const MAX_UPLOAD_ITEMS = 20;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_PIXELS = 40_000_000;
const MAX_PROJECT_ID_CHARS = 255;
const TEXT_UPLOAD_MEDIA_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/tab-separated-values',
  'application/json',
]);

export interface SkillNativeReportPublisher {
  prepare(input: { taskId: string; title: string; html: string }): Promise<SkillNativeZeroPublicationDraft>;
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

function valueHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
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
  const name = basename(value.trim());
  if (!name || name === '.' || name === '..') throw new SkillNativeWorkflowError('invalid_request', '上传文件名无效');
  return name;
}

function conversationAnswer(value: unknown): string | string[] {
  if (Array.isArray(value) && value.length > MAX_CONVERSATION_ANSWER_ITEMS) {
    throw new SkillNativeWorkflowError('invalid_request', `对话输入不能超过 ${MAX_CONVERSATION_ANSWER_ITEMS} 项`);
  }
  const values = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.length > 0 ? value : null;
  if (!values || !values.every((item) => typeof item === 'string' && item.trim())) {
    throw new SkillNativeWorkflowError('invalid_request', '对话输入必须是非空字符串或非空字符串数组');
  }
  const prepared = values.map((item) => (item as string).trim());
  if (prepared.reduce((total, item) => total + item.length, 0) > MAX_CONVERSATION_ANSWER_CHARS) {
    throw new SkillNativeWorkflowError('invalid_request', `对话输入总计不能超过 ${MAX_CONVERSATION_ANSWER_CHARS} 个字符`);
  }
  return typeof value === 'string' ? prepared[0]! : prepared;
}

async function materialFromAnswer(input: {
  taskId: string;
  ownerUserId: string;
  projectId: string;
  label: string;
  answer: SkillNativeInputAnswer;
  imageBudget: { pixels: number };
}): Promise<{ material: SkillTaskMaterial; artifacts: SkillNativeArtifactInput[] }> {
  if (!input.label.trim() || input.label.length > 255) {
    throw new SkillNativeWorkflowError('invalid_request', '输入名称无效');
  }
  if (input.answer.source === 'conversation') {
    const value = conversationAnswer(input.answer.value);
    return {
      material: {
        id: `conversation:${input.label}:${valueHash(value)}`,
        label: input.label,
        source: 'conversation',
        value,
        artifactIds: [],
      },
      artifacts: [],
    };
  }

  const values = Array.isArray(input.answer.value) ? input.answer.value : [input.answer.value];
  if (values.length === 0) throw new SkillNativeWorkflowError('invalid_request', '上传内容不能为空');
  const artifacts: SkillNativeArtifactInput[] = [];
  const prepared: Array<{ name: string; mediaType: string; artifactId: string }> = [];
  for (const value of values) {
    const file = record(value);
    if (!file) throw new SkillNativeWorkflowError('invalid_request', '上传内容格式无效');
    const fileName = uploadName(file.name);
    if (typeof file.mediaType !== 'string' || !file.mediaType.trim()) {
      throw new SkillNativeWorkflowError('invalid_request', '上传文件类型无效');
    }
    const mediaType = file.mediaType.trim().toLowerCase();
    let bytes: Buffer;
    if (Object.hasOwn(file, 'dataUrl')) {
      let parsed;
      try {
        parsed = await decodeUploadedImage(file.dataUrl);
      } catch {
        throw new SkillNativeWorkflowError('invalid_request', '图片必须是有效的 PNG、JPEG 或 WebP，且不超过 10 MiB');
      }
      if (parsed.mediaType !== mediaType) {
        throw new SkillNativeWorkflowError('invalid_request', '图片声明类型与实际内容不一致');
      }
      input.imageBudget.pixels += parsed.pixelCount;
      if (input.imageBudget.pixels > MAX_UPLOAD_PIXELS) {
        throw new SkillNativeWorkflowError('invalid_request', '一次请求的图片总像素不能超过 4000 万');
      }
      bytes = parsed.bytes;
    } else {
      if (!TEXT_UPLOAD_MEDIA_TYPES.has(mediaType)) {
        throw new SkillNativeWorkflowError('invalid_request', '文本上传的文件类型无效');
      }
      if (typeof file.content !== 'string' || !file.content.trim()) {
        throw new SkillNativeWorkflowError('invalid_request', '文本上传必须非空');
      }
      bytes = Buffer.from(file.content, 'utf8');
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new SkillNativeWorkflowError('invalid_request', '单个上传不能超过 10 MiB');
    const artifactId = randomUUID();
    artifacts.push({
      id: artifactId,
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      relativePath: `uploads/${input.label}/${artifactId}-${fileName}`,
      fileName,
      mediaType,
      role: 'working',
      bytes,
      contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sourceArtifactIds: [],
    });
    prepared.push({ name: fileName, mediaType, artifactId });
  }
  return {
    material: {
      id: `upload:${input.label}:${valueHash(prepared)}`,
      label: input.label,
      source: 'upload',
      value: Array.isArray(input.answer.value) ? prepared : prepared[0],
      artifactIds: prepared.map(({ artifactId }) => artifactId),
    },
    artifacts,
  };
}

async function materialsFromAnswers(input: {
  taskId: string;
  ownerUserId: string;
  projectId: string;
  answers: Record<string, SkillNativeInputAnswer>;
}): Promise<{ materials: SkillTaskMaterial[]; artifacts: SkillNativeArtifactInput[] }> {
  const uploadCount = Object.values(input.answers)
    .filter(({ source }) => source === 'upload')
    .reduce((count, answer) => count + (Array.isArray(answer.value) ? answer.value.length : 1), 0);
  if (uploadCount > MAX_UPLOAD_ITEMS) {
    throw new SkillNativeWorkflowError('invalid_request', `一次请求不能超过 ${MAX_UPLOAD_ITEMS} 个上传文件`);
  }
  const imageBudget = { pixels: 0 };
  const prepared = [];
  for (const [label, answer] of Object.entries(input.answers)) {
    prepared.push(await materialFromAnswer({ ...input, label, answer, imageBudget }));
  }
  const artifacts = prepared.flatMap(({ artifacts: files }) => files);
  if (artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0) > MAX_UPLOAD_BYTES) {
    throw new SkillNativeWorkflowError('invalid_request', '一次请求的上传内容不能超过 10 MiB');
  }
  return { materials: prepared.map(({ material }) => material), artifacts };
}

function preview(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((item) => typeof item === 'string' ? item : record(item)?.name).filter(Boolean).join('、')
      : record(value)?.name;
  const prepared = redactString(typeof text === 'string' ? text : '已绑定').trim();
  return prepared.length > 240 ? `${prepared.slice(0, 240)}…` : prepared;
}

function candidateView(candidate: SkillNativeCandidate): SkillNativeCandidateView {
  return {
    candidateId: candidate.id,
    title: candidate.title,
    description: candidate.description,
    rationale: candidate.rationale,
    tradeoffs: candidate.tradeoffs,
    mode: candidate.mode,
    recommended: candidate.recommended,
    skills: candidate.packages.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      packageHash: skill.packageHash,
    })),
    finalReport: structuredClone(candidate.finalReport),
  };
}

function planView(plan: ExecutionPlan): SkillNativePlanView {
  return {
    version: plan.version,
    taskId: plan.taskId,
    candidateId: plan.candidateId,
    title: plan.title,
    rationale: plan.rationale,
    tradeoffs: plan.tradeoffs,
    mode: plan.mode,
    requirement: {
      ...structuredClone(plan.requirement),
      materials: plan.requirement.materials.map(({ value, ...material }) => ({
        ...material,
        preview: preview(value),
      })),
    },
    invocations: plan.invocations.map((invocation) => ({
      id: invocation.id,
      skillId: invocation.package.package.id,
      name: invocation.package.package.name,
      dependsOn: [...invocation.dependsOn],
      packageHash: invocation.package.packageHash,
    })),
    finalReport: structuredClone(plan.finalReport),
  };
}

function taskView(task: SkillNativeTaskRecord): SkillNativeTaskView {
  return {
    id: task.id,
    projectId: task.projectId,
    originalInput: task.originalInput,
    orchestrationMode: task.orchestrationMode,
    state: task.state,
    stateVersion: task.stateVersion,
    selectedCandidateId: task.selectedCandidateId,
    currentAttemptId: task.currentAttemptId,
    requirement: structuredClone(task.requirement),
    candidates: task.candidates.map(candidateView),
    plan: task.plan ? planView(task.plan) : null,
    executionSteps: structuredClone(task.execution.steps),
    pendingQuestions: structuredClone(task.execution.checkpoint?.pendingQuestions ?? []),
    artifacts: structuredClone(task.artifacts),
    result: task.result ? structuredClone(task.result) : null,
    warnings: [...task.warnings],
    failure: task.failure,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function directSkillRequest(originalInput: string): { skillId: string; goal: string } | null {
  const match = /^\s*\$([^\s]+)(?:\s+([\s\S]*))?$/u.exec(originalInput);
  return match ? { skillId: match[1]!, goal: match[2]?.trim() ?? '' } : null;
}

export class SkillNativeTaskService {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly dependencies: {
    store: SkillNativeTaskStore;
    catalog: SkillNativeCatalog;
    planner: Pick<RequirementPlanner, 'plan'>;
    execution: SkillNativeExecutionEngine;
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
    const projectId = request.projectId?.trim() || `task:${taskId}`;
    if (projectId.length > MAX_PROJECT_ID_CHARS) {
      throw new SkillNativeWorkflowError('invalid_request', `projectId 不能超过 ${MAX_PROJECT_ID_CHARS} 个字符`);
    }
    const direct = directSkillRequest(originalInput);
    if (direct && request.orchestrationMode !== 'single_skill') {
      throw new SkillNativeWorkflowError('invalid_request', '显式 $Skill 只能使用 single_skill 模式');
    }
    const prepared = await materialsFromAnswers({
      taskId,
      ownerUserId,
      projectId,
      answers: request.inputs ?? {},
    });
    const requestMaterial: SkillTaskMaterial = {
      id: `conversation:task-request:${valueHash(originalInput)}`,
      label: 'task-request',
      source: 'conversation',
      value: direct?.goal || originalInput,
      artifactIds: [],
    };
    const materials = [requestMaterial, ...prepared.materials];
    const planning = await this.planRequirement({
      originalInput: direct ? direct.goal : originalInput,
      mode: request.orchestrationMode,
      materials,
      ...(direct ? { requestedSkillId: direct.skillId } : {}),
    });
    return taskView(await this.dependencies.store.create({
      id: taskId,
      ownerUserId,
      projectId,
      originalInput,
      orchestrationMode: request.orchestrationMode,
      requirement: planning.requirement,
      candidates: planning.candidates,
      materials,
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
    candidateId: string;
  }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    if (!task.candidates.some(({ id }) => id === input.candidateId)) {
      throw new SkillNativeWorkflowError('invalid_request', `方案 ${input.candidateId} 不属于当前任务`);
    }
    return taskView(await this.dependencies.store.select(input));
  }

  async confirm(input: {
    taskId: string;
    ownerUserId: string;
    body: ConfirmSkillNativeTaskRequest;
  }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    const candidate = task.candidates.find(({ id }) => id === task.selectedCandidateId);
    if (!candidate) throw new SkillNativeWorkflowError('conflict', '请先选择方案');
    const prepared = await materialsFromAnswers({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      projectId: task.projectId,
      answers: input.body.answers ?? {},
    });
    const overridden = new Set(prepared.materials.map(({ label }) => label));
    const materials = [
      ...task.materials.filter(({ label }) => !overridden.has(label)),
      ...prepared.materials,
    ];
    let plan: ExecutionPlan;
    try {
      plan = buildExecutionPlan({
        taskId: task.id,
        candidate,
        snapshots: candidate.packages.map((descriptor) => this.dependencies.catalog.packages.snapshot(task.id, descriptor)),
        requirement: {
          ...structuredClone(task.requirement),
          version: 'requirement-context-v2',
          materials,
        },
      });
    } catch (error) {
      throw new SkillNativeWorkflowError('unavailable', safeError(error));
    }
    return taskView(await this.dependencies.store.confirm({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      expectedVersion: input.body.expectedVersion,
      plan,
      materials,
      artifacts: prepared.artifacts,
    }));
  }

  async execute(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeTaskView> {
    return this.run({ ...input, from: 'ready', answers: {} });
  }

  async resume(input: {
    taskId: string;
    ownerUserId: string;
    body: ResumeSkillNativeTaskRequest;
  }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    if (task.state !== 'waiting_for_user' && task.state !== 'paused') {
      throw new SkillNativeWorkflowError('conflict', '任务当前不可恢复');
    }
    const pending = task.execution.checkpoint?.pendingQuestions ?? [];
    const unknown = Object.keys(input.body.answers).filter((id) => !pending.some((question) => question.id === id));
    if (unknown.length > 0) throw new SkillNativeWorkflowError('invalid_request', 'answers 包含未知问题', unknown);
    const missing = pending.filter(({ required, id }) => required && !Object.hasOwn(input.body.answers, id)).map(({ id }) => id);
    if (missing.length > 0) throw new SkillNativeWorkflowError('input_required', '仍有必答问题未回答', missing);
    const prepared = await materialsFromAnswers({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      projectId: task.projectId,
      answers: input.body.answers,
    });
    const answerValues = Object.fromEntries(prepared.materials.map(({ label, value }) => [label, value]));
    const overridden = new Set(prepared.materials.map(({ label }) => label));
    return this.run({
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      expectedVersion: input.body.expectedVersion,
      from: task.state,
      answers: answerValues,
      materials: [...task.materials.filter(({ label }) => !overridden.has(label)), ...prepared.materials],
      artifacts: prepared.artifacts,
    });
  }

  async cancel(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskView> {
    const task = await this.dependencies.store.cancel(input);
    this.active.get(input.taskId)?.abort('user_cancelled');
    return taskView(task);
  }

  async replan(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskView> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    const direct = directSkillRequest(task.originalInput);
    const planning = await this.planRequirement({
      originalInput: direct ? direct.goal : task.originalInput,
      mode: task.orchestrationMode,
      materials: task.materials,
      ...(direct ? { requestedSkillId: direct.skillId } : {}),
    });
    return taskView(await this.dependencies.store.replan({
      ...input,
      requirement: planning.requirement,
      candidates: planning.candidates,
    }));
  }

  async html(taskId: string, ownerUserId: string): Promise<string | null> {
    const task = await this.requireOwned(taskId, ownerUserId);
    const artifact = await this.primaryArtifact(task);
    if (!artifact) return null;
    const content = artifact.bytes.toString('utf8');
    if (artifact.mediaType === 'text/html') return previewHtmlArtifact(content);
    if (artifact.mediaType === 'text/markdown' || artifact.mediaType === 'text/plain') {
      return renderMarkdownHtml(content, task.plan?.title ?? '研究报告', {
        artifactUrl: (artifactId) => `/api/research-tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifactId)}`,
      });
    }
    return null;
  }

  async markdown(taskId: string, ownerUserId: string): Promise<string | null> {
    const task = await this.requireOwned(taskId, ownerUserId);
    const artifact = await this.primaryArtifact(task);
    return artifact && (artifact.mediaType === 'text/markdown' || artifact.mediaType === 'text/plain')
      ? artifact.bytes.toString('utf8')
      : null;
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
    return structuredClone(task.execution.steps.find((step) => step.invocationId === invocationId)?.outcome ?? null);
  }

  async publishZero(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeZeroPublication> {
    const task = await this.requireOwned(input.taskId, input.ownerUserId);
    if (!this.dependencies.zeroPublisher) throw new SkillNativeWorkflowError('unavailable', 'Zero 发布当前不可用');
    const html = await this.html(task.id, task.ownerUserId);
    if (!task.result || !html) throw new SkillNativeWorkflowError('conflict', '可发布的 HTML 报告尚未完成');
    const reservation = await this.dependencies.store.reserveZeroPublication(input);
    if (reservation.status === 'completed') return reservation.publication;
    let draft = reservation.status === 'prepared' ? reservation.draft : null;
    let persistedDraft = draft !== null;
    try {
      if (!draft) {
        draft = await this.dependencies.zeroPublisher.prepare({
          taskId: task.id,
          title: task.plan?.title ?? task.result.summary,
          html,
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
      skills: catalog.skills.map(({ id, name, description, packageHash, fileCount, byteSize }) => ({
        id, name, description, packageHash, fileCount, byteSize, available: true as const,
      })),
      unavailableSkills: catalog.unavailableSkills,
    };
  }

  async recoverInterrupted(): Promise<number> {
    return this.dependencies.store.recoverInterrupted();
  }

  private async run(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    from: 'ready' | 'waiting_for_user' | 'paused';
    answers: Record<string, unknown>;
    materials?: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskView> {
    const before = await this.requireOwned(input.taskId, input.ownerUserId);
    if (!before.plan) throw new SkillNativeWorkflowError('conflict', '任务没有已确认 Plan');
    const attemptId = randomUUID();
    const executing = await this.dependencies.store.beginExecution({
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      expectedVersion: input.expectedVersion,
      attemptId,
      from: input.from,
      materials: input.materials ?? before.materials,
      artifacts: input.artifacts ?? [],
    });
    const controller = new AbortController();
    this.active.set(input.taskId, controller);
    let latestExecution = structuredClone(executing.execution);
    try {
      const result = await this.dependencies.execution.execute({
        plan: before.plan,
        attemptId,
        ownerUserId: before.ownerUserId,
        projectId: before.projectId,
        execution: executing.execution,
        answers: input.answers,
        signal: controller.signal,
        onExecution: async (execution) => {
          latestExecution = structuredClone(execution);
          const saved = await this.dependencies.store.saveExecution({
            taskId: input.taskId,
            ownerUserId: input.ownerUserId,
            attemptId,
            execution,
          });
          if (!saved) controller.abort('task_state_changed');
        },
      });
      const finished = result.state === 'waiting_for_user'
        ? await this.dependencies.store.waitForUser({
            taskId: input.taskId,
            ownerUserId: input.ownerUserId,
            attemptId,
            execution: result.execution,
            warnings: result.warnings,
          })
        : await this.dependencies.store.finishExecution({
            taskId: input.taskId,
            ownerUserId: input.ownerUserId,
            attemptId,
            state: result.state,
            execution: result.execution,
            result: result.outcome,
            warnings: result.warnings,
            failure: result.state === 'failed' ? result.outcome?.summary ?? '没有 Skill 形成可用结果' : null,
          });
      return taskView(finished ?? await this.requireOwned(input.taskId, input.ownerUserId));
    } catch (error) {
      const current = await this.requireOwned(input.taskId, input.ownerUserId);
      if (current.state === 'cancelled') return taskView(current);
      const infrastructure = error instanceof LLMInvocationError && error.retryable;
      const failure = safeError(error);
      const finished = infrastructure
        ? await this.dependencies.store.pauseExecution({
            taskId: input.taskId,
            ownerUserId: input.ownerUserId,
            attemptId,
            execution: latestExecution,
            failure,
          })
        : await this.dependencies.store.finishExecution({
            taskId: input.taskId,
            ownerUserId: input.ownerUserId,
            attemptId,
            state: 'failed',
            execution: latestExecution,
            result: null,
            warnings: [],
            failure,
          });
      return taskView(finished ?? await this.requireOwned(input.taskId, input.ownerUserId));
    } finally {
      if (this.active.get(input.taskId) === controller) this.active.delete(input.taskId);
    }
  }

  private async primaryArtifact(task: SkillNativeTaskRecord): Promise<SkillNativeArtifactRecord | null> {
    const artifactId = task.result?.primaryArtifactId;
    if (!artifactId) return null;
    return this.dependencies.store.getArtifactOwned({
      artifactId,
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      projectId: task.projectId,
    });
  }

  private async planRequirement(input: Omit<Parameters<RequirementPlanner['plan']>[0], 'skills'>) {
    try {
      const catalog = this.dependencies.catalog.load();
      return await this.dependencies.planner.plan({ ...input, skills: catalog.skills });
    } catch (error) {
      if (error instanceof RequirementPlanningError) {
        throw new SkillNativeWorkflowError(error.code, error.message, error.details);
      }
      if (error instanceof LLMInvocationError) {
        throw new SkillNativeWorkflowError('unavailable', `需求规划服务暂不可用：${safeError(error)}`);
      }
      throw error;
    }
  }

  private async requireOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord> {
    const task = await this.dependencies.store.getOwned(taskId, ownerUserId);
    if (!task) throw new SkillNativeWorkflowError('not_found', '任务不存在');
    return task;
  }
}

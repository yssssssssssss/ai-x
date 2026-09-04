import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import type {
  OrchestrationMode,
  ReportResult,
  SkillNativeInputAnswer,
  SkillNativeExecutionStepView,
  SkillNativeTaskSummary,
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
  SkillDefinition,
  SolutionDefinition,
  SolutionPlan,
} from '../packages/api-contract/skill-native.ts';
import { SkillNativeCatalog } from '../apps/orchestrator-runtime/src/skill-native/catalog.ts';
import {
  SkillNativeExecutionEngine,
  type SkillNativeToolPort,
} from '../apps/orchestrator-runtime/src/skill-native/execution.ts';
import { SkillNativeTaskService } from '../apps/orchestrator-runtime/src/skill-native/service.ts';
import type {
  SkillNativeArtifactInput,
  SkillNativeArtifactRecord,
  SkillNativeTaskRecord,
  SkillNativeTaskStore,
  StoredSkillNativeCandidate,
} from '../apps/orchestrator-runtime/src/skill-native/store.ts';
import type { InputMaterial } from '../apps/orchestrator-runtime/src/skill-native/input-resolution.ts';
import type {
  LLMClient,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryStore implements SkillNativeTaskStore {
  private readonly tasks = new Map<string, SkillNativeTaskRecord>();
  private readonly materials: InputMaterial[] = [];
  private readonly artifacts = new Map<string, SkillNativeArtifactInput>();
  private readonly zeroPublications = new Map<string, SkillNativeZeroPublication | SkillNativeZeroPublicationDraft | 'publishing' | 'failed'>();
  failNextZeroCompletion = false;

  async create(input: {
    id: string;
    ownerUserId: string;
    projectId: string;
    originalInput: string;
    orchestrationMode: OrchestrationMode;
    candidates: StoredSkillNativeCandidate[];
    materials?: InputMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    const now = new Date();
    const task: SkillNativeTaskRecord = {
      ...input,
      state: 'awaiting_selection',
      stateVersion: 0,
      selectedSolutionId: null,
      plan: null,
      executionSteps: [],
      report: null,
      reportHtml: null,
      reportMarkdown: null,
      warnings: [],
      failure: null,
      currentAttemptId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, clone(task));
    for (const artifact of input.artifacts ?? []) this.artifacts.set(artifact.id, clone(artifact));
    return clone(task);
  }

  async getOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord | null> {
    const task = this.tasks.get(taskId);
    return task?.ownerUserId === ownerUserId ? clone(task) : null;
  }

  async listOwned(ownerUserId: string): Promise<SkillNativeTaskSummary[]> {
    return [...this.tasks.values()].filter((task) => task.ownerUserId === ownerUserId).map((task) => ({
      id: task.id,
      originalInput: task.originalInput,
      orchestrationMode: task.orchestrationMode,
      state: task.state,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
  }

  async reserveSelection(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
  }): Promise<SkillNativeTaskRecord> {
    return this.change(input, (task) => {
      if (task.state !== 'awaiting_selection' || task.selectedSolutionId !== null) throw new Error('conflict');
      task.selectedSolutionId = input.solutionId;
    });
  }

  async completeSelection(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
    candidates: StoredSkillNativeCandidate[];
  }): Promise<SkillNativeTaskRecord> {
    return this.change(input, (task) => {
      if (task.state !== 'awaiting_selection' || task.selectedSolutionId !== input.solutionId) throw new Error('conflict');
      task.state = 'awaiting_confirmation';
      task.candidates = clone(input.candidates);
    });
  }

  async confirm(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    plan: SolutionPlan;
    materials: InputMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    const confirmed = await this.change(input, (task) => { task.state = 'ready'; task.plan = clone(input.plan); });
    this.materials.push(...input.materials.filter(({ source }) => source === 'upload').map((item) => ({
      ...clone(item), ownerUserId: confirmed.ownerUserId, projectId: confirmed.projectId,
    })));
    for (const artifact of input.artifacts ?? []) this.artifacts.set(artifact.id, clone(artifact));
    return confirmed;
  }

  async replan(input: { taskId: string; ownerUserId: string; expectedVersion: number; candidates: StoredSkillNativeCandidate[] }): Promise<SkillNativeTaskRecord> {
    const publication = this.zeroPublications.get(input.taskId);
    if (publication === 'publishing' || (publication && typeof publication !== 'string' && 'draftRootNodeId' in publication)) {
      throw new Error('conflict');
    }
    this.zeroPublications.delete(input.taskId);
    return this.change(input, (task) => {
      task.state = 'awaiting_selection'; task.selectedSolutionId = null; task.candidates = clone(input.candidates); task.plan = null;
    });
  }

  async beginExecution(input: { taskId: string; ownerUserId: string; expectedVersion: number; attemptId: string }): Promise<SkillNativeTaskRecord> {
    return this.change(input, (task) => { task.state = 'executing'; task.currentAttemptId = input.attemptId; });
  }

  async saveExecutionSteps(input: { taskId: string; ownerUserId: string; attemptId: string; steps: SkillNativeExecutionStepView[] }): Promise<boolean> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.ownerUserId !== input.ownerUserId || task.state !== 'executing' || task.currentAttemptId !== input.attemptId) return false;
    task.executionSteps = clone(input.steps);
    return true;
  }

  async finishExecution(input: {
    taskId: string; ownerUserId: string; attemptId: string; state: 'completed' | 'completed_with_gaps' | 'failed';
    steps: SkillNativeExecutionStepView[]; report: ReportResult | null; html: string | null; markdown: string | null; failure: string | null;
    warnings: string[];
  }): Promise<SkillNativeTaskRecord | null> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.ownerUserId !== input.ownerUserId || task.state !== 'executing' || task.currentAttemptId !== input.attemptId) return null;
    task.state = input.state;
    task.executionSteps = clone(input.steps);
    task.report = clone(input.report);
    task.reportHtml = input.html;
    task.reportMarkdown = input.markdown;
    task.warnings = clone(input.warnings);
    task.failure = input.failure;
    task.stateVersion += 1;
    return clone(task);
  }

  async cancel(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord> {
    return this.change(input, (task) => { task.state = 'cancelled'; });
  }

  async resume(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord> {
    return this.change(input, (task) => { task.state = 'ready'; });
  }

  async listReusableMaterials(input: {
    ownerUserId: string;
    projectId: string;
    inputIds: readonly string[];
  }): Promise<InputMaterial[]> {
    return clone(this.materials.filter((item) => (
      item.ownerUserId === input.ownerUserId
      && item.projectId === input.projectId
      && input.inputIds.includes(item.inputId)
    )));
  }

  async getArtifactOwned(input: {
    artifactId: string;
    taskId: string;
    ownerUserId: string;
    projectId: string;
  }): Promise<SkillNativeArtifactRecord | null> {
    const artifact = this.artifacts.get(input.artifactId);
    if (
      !artifact
      || artifact.taskId !== input.taskId
      || artifact.ownerUserId !== input.ownerUserId
      || artifact.projectId !== input.projectId
    ) return null;
    return { ...clone(artifact), bytes: Buffer.from(artifact.bytes) };
  }

  async writeArtifact(input: SkillNativeArtifactInput): Promise<void> {
    this.artifacts.set(input.id, clone(input));
  }

  async reserveZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }) {
    const task = this.tasks.get(input.taskId);
    if (
      !task
      || task.ownerUserId !== input.ownerUserId
      || task.stateVersion !== input.expectedVersion
      || (task.state !== 'completed' && task.state !== 'completed_with_gaps')
      || !task.report
    ) throw new Error('conflict');
    const current = this.zeroPublications.get(task.id);
    if (current && current !== 'publishing' && current !== 'failed' && 'rootNodeId' in current) {
      return { status: 'completed' as const, publication: clone(current) };
    }
    if (current && current !== 'publishing' && current !== 'failed') {
      return { status: 'prepared' as const, draft: clone(current) };
    }
    if (current === 'publishing') throw new Error('conflict');
    this.zeroPublications.set(task.id, 'publishing');
    return { status: 'reserved' as const };
  }

  async prepareZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    draft: SkillNativeZeroPublicationDraft;
  }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.ownerUserId !== input.ownerUserId || this.zeroPublications.get(task.id) !== 'publishing') {
      throw new Error('conflict');
    }
    this.zeroPublications.set(task.id, clone(input.draft));
  }

  async completeZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    publication: SkillNativeZeroPublication;
  }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    const current = task ? this.zeroPublications.get(task.id) : undefined;
    if (!task || task.ownerUserId !== input.ownerUserId || !current || typeof current === 'string' || !('draftRootNodeId' in current)) {
      throw new Error('conflict');
    }
    if (this.failNextZeroCompletion) {
      this.failNextZeroCompletion = false;
      throw new Error('receipt write failed');
    }
    this.zeroPublications.set(task.id, clone(input.publication));
  }

  async failZeroPublication(input: { taskId: string; ownerUserId: string }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (task?.ownerUserId === input.ownerUserId && this.zeroPublications.get(task.id) === 'publishing') {
      this.zeroPublications.set(task.id, 'failed');
    }
  }

  async recoverInterrupted(): Promise<number> {
    let count = 0;
    for (const task of this.tasks.values()) if (task.state === 'executing') { task.state = 'paused'; count += 1; }
    for (const task of this.tasks.values()) {
      if (task.state === 'awaiting_selection' && task.selectedSolutionId !== null) {
        task.selectedSolutionId = null;
        task.stateVersion += 1;
        count += 1;
      }
    }
    return count;
  }

  private async change(
    input: { taskId: string; ownerUserId: string; expectedVersion: number },
    update: (task: SkillNativeTaskRecord) => void,
  ): Promise<SkillNativeTaskRecord> {
    const task = this.tasks.get(input.taskId);
    if (!task || task.ownerUserId !== input.ownerUserId || task.stateVersion !== input.expectedVersion) throw new Error('conflict');
    update(task);
    task.stateVersion += 1;
    task.updatedAt = new Date();
    return clone(task);
  }
}

class ReportLlm implements LLMClient {
  readonly calls: string[] = [];
  readonly identity = { provider: 'test', endpointHost: 'local', requestedModel: 'test', mode: 'mock' as const, eligibleAsReal: false };
  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options.schemaName);
    const context = options.context as { reportDefinition: { title: string; sections: string[] }; allowedSources: ReportResult['sources'] };
    const source = context.allowedSources[0];
    const report: ReportResult = {
      version: 'report-result-v1',
      title: context.reportDefinition.title,
      summary: '完成',
      status: 'complete',
      sections: context.reportDefinition.sections.map((title, index) => ({
        id: String(index), title, blocks: [{ type: 'text', text: title, ...(source ? { sourceIds: [source.id] } : {}) }],
      })),
      sources: source ? [source] : [],
      gaps: [],
    };
    return { data: report as T, promptHash: 'sha256:test', modelName: 'test', modelVersion: '1', traceId: 'trace' };
  }
  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> { throw new Error('not used'); }
}

const tools: SkillNativeToolPort = {
  async invoke() {
    return {
      output: { results: [{ url: 'https://example.com', title: 'Example' }] },
      sources: [{ id: 'tool:source', kind: 'tool', label: 'Example', url: 'https://example.com' }],
    };
  },
};

class TwoToolCatalog extends SkillNativeCatalog {
  override load() {
    const catalog = super.load();
    const skill = catalog.skills.find(({ id }) => id === 'industry-market-analysis');
    const input = skill?.inputs.find(({ id }) => id === 'competitors');
    assert.ok(input);
    input.toolIds = ['unavailable-search', 'tavily-web-search'];
    return catalog;
  }
}

class TwoSkillCatalog extends SkillNativeCatalog {
  override load() {
    const makeSkill = (id: string): SkillDefinition => ({
      version: 'skill-definition-v1',
      id,
      name: id,
      description: `${id} research`,
      whenToUse: `${id} research`,
      inputs: [],
      knowledge: [],
      tools: [],
      report: { title: `${id} report`, summaryInstruction: 'summary', sections: ['Result'] },
      allowPartial: true,
      body: `# ${id}`,
      sourcePath: `skills/${id}/SKILL.md`,
      contentHash: `sha256:${id}`,
    });
    const skills = [makeSkill('support'), makeSkill('final')];
    const solution: SolutionDefinition = {
      version: 'solution-definition-v1',
      id: 'two-skill',
      title: 'Two skill research',
      description: 'support final research',
      whenToUse: 'support final research',
      mode: 'multi_skill',
      recommended: true,
      skills: [
        { skillId: 'support', dependsOn: [], failurePolicy: 'gap' },
        { skillId: 'final', dependsOn: ['support'], failurePolicy: 'stop' },
      ],
      finalReportSkillId: 'final',
      sourcePath: 'orchestrator/solutions/two-skill.yaml',
      contentHash: 'sha256:two-skill',
    };
    return { skills, unavailableSkills: [], solutions: [solution], invalidSolutions: [] };
  }
}

class ReplacementKnowledgeCatalog extends SkillNativeCatalog {
  override load() {
    const primary: SkillDefinition = {
      version: 'skill-definition-v1',
      id: 'visual-primary',
      name: 'Visual Primary',
      description: 'visual primary research',
      whenToUse: 'visual primary research',
      inputs: [{
        id: 'research_goal', label: 'Goal', description: 'Goal', required: true, multiple: false,
        acceptedSources: ['conversation'], toolIds: [], question: 'Goal?', missingPolicy: 'stop',
      }, {
        id: 'screenshot', label: 'Screenshot', description: 'Screenshot', required: true, multiple: false,
        acceptedSources: ['upload'], toolIds: [], question: 'Screenshot?', missingPolicy: 'replace',
      }, {
        id: 'method_context', label: 'Method', description: 'Method', required: false, multiple: false,
        acceptedSources: ['upload'], toolIds: [], question: 'Method?', missingPolicy: 'gap',
      }],
      knowledge: [], tools: [],
      report: { title: 'Visual report', summaryInstruction: 'summary', sections: ['Result'] },
      allowPartial: true, body: '# Visual', sourcePath: 'skills/visual-primary/SKILL.md', contentHash: 'sha256:visual',
    };
    const replacement: SkillDefinition = {
      ...clone(primary),
      id: 'knowledge-fallback',
      name: 'Knowledge Fallback',
      description: 'knowledge fallback research',
      whenToUse: 'knowledge fallback research',
      inputs: [primary.inputs[0]!, {
        ...primary.inputs[2]!, acceptedSources: ['upload', 'knowledge'],
      }],
      knowledge: [{
        id: 'fallback-method', required: true, title: 'Fallback method', sourcePath: 'knowledge/fallback.md',
        contentHash: 'sha256:fallback', status: 'approved', content: 'Frozen fallback method', inputId: 'method_context',
      }],
      report: { title: 'Fallback report', summaryInstruction: 'summary', sections: ['Result'] },
      body: '# Fallback', sourcePath: 'skills/knowledge-fallback/SKILL.md', contentHash: 'sha256:fallback-skill',
    };
    const solution: SolutionDefinition = {
      version: 'solution-definition-v1', id: 'visual-with-fallback', title: 'Visual fallback',
      description: 'visual primary research', whenToUse: 'visual primary research', mode: 'single_skill', recommended: true,
      skills: [{ skillId: primary.id, dependsOn: [], failurePolicy: 'replace', replacementSkillId: replacement.id }],
      finalReportSkillId: primary.id, sourcePath: 'orchestrator/solutions/visual.yaml', contentHash: 'sha256:solution',
    };
    return { skills: [primary, replacement], unavailableSkills: [], solutions: [solution], invalidSolutions: [] };
  }
}

test('tool input resolution keeps an earlier failure warning after a later tool succeeds', async () => {
  const store = new MemoryStore();
  const toolCalls: string[] = [];
  const planningTools: SkillNativeToolPort = {
    async invoke(input) {
      toolCalls.push(input.toolId);
      if (input.toolId === 'unavailable-search') throw new Error('adapter unavailable');
      return {
        output: { results: [{ url: 'https://example.com/competitor', title: '公开竞品资料' }] },
        sources: [{ id: 'tool:source', kind: 'tool', label: '公开竞品资料', url: 'https://example.com/competitor' }],
      };
    },
  };
  const service = new SkillNativeTaskService({
    store,
    catalog: new TwoToolCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools: planningTools }),
    tools: planningTools,
  });
  const created = await service.create('owner', {
    originalInput: '研究京东众筹频道的用户与增长策略',
    orchestrationMode: 'single_skill',
    projectId: 'project',
  });
  const industry = created.candidates.find(({ solutionId }) => solutionId === 'industry-market-single');
  assert.ok(industry);

  await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: industry.solutionId,
  });
  const persisted = await store.getOwned(created.id, 'owner');
  const candidate = persisted?.candidates.find(({ solution }) => solution.id === industry.solutionId);
  assert.ok(candidate);
  assert.deepEqual(toolCalls, ['unavailable-search', 'tavily-web-search']);
  assert.ok(candidate.resolution.warnings.some((warning) => warning.includes('unavailable-search input resolution failed')));
  assert.ok(candidate.resolution.inputs.some(({ inputId, source }) => inputId === 'competitors' && source === 'tool'));
});

test('selection CAS is reserved before any Tool call', async () => {
  const store = new MemoryStore();
  let releaseTool!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseTool = resolve; });
  let calls = 0;
  const blockingTools: SkillNativeToolPort = {
    async invoke() {
      calls += 1;
      markStarted();
      await blocked;
      return { output: { results: [] }, sources: [] };
    },
  };
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools: blockingTools }),
    tools: blockingTools,
  });
  const created = await service.create('owner', {
    originalInput: '研究京东众筹频道的用户与增长策略',
    orchestrationMode: 'single_skill',
  });
  const solutionId = created.candidates.find(({ solutionId: id }) => id === 'industry-market-single')!.solutionId;
  const first = service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId,
  });
  await started;
  await assert.rejects(service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId,
  }), /conflict/u);
  assert.equal(calls, 1);
  releaseTool();
  assert.equal((await first).state, 'awaiting_confirmation');
});

test('service completes the selected Single Skill through questions, execution, and the same HTML report', async () => {
  const store = new MemoryStore();
  const llm = new ReportLlm();
  const toolCalls: string[] = [];
  const planningTools: SkillNativeToolPort = {
    async invoke(input) {
      toolCalls.push(input.toolId);
      return {
        output: { results: [{ url: 'https://example.com/competitor', title: '公开竞品资料' }] },
        sources: [{ id: 'tool:source', kind: 'tool', label: '公开竞品资料', url: 'https://example.com/competitor' }],
      };
    },
  };
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm, tools: planningTools }),
    tools: planningTools,
  });
  const created = await service.create('owner', {
    originalInput: '研究京东众筹频道的用户与增长策略',
    orchestrationMode: 'single_skill',
    projectId: 'project',
  });
  assert.equal(created.state, 'awaiting_selection');
  assert.ok(created.candidates.length > 1);
  const industry = created.candidates.find(({ solutionId }) => solutionId === 'industry-market-single');
  assert.ok(industry);
  assert.ok(industry.questions.every(({ inputId }) => inputId !== 'research_goal'));
  assert.ok(industry.questions.some(({ inputId }) => inputId === 'industry_scope'));

  const selected = await service.select({
    taskId: created.id, ownerUserId: 'owner', expectedVersion: created.stateVersion,
    solutionId: industry.solutionId,
  });
  const selectedCandidate = selected.candidates.find(({ solutionId }) => solutionId === industry.solutionId)!;
  assert.deepEqual(toolCalls, ['tavily-web-search']);
  assert.ok(selectedCandidate.resolvedInputs.some(({ inputId, source }) => inputId === 'competitors' && source === 'tool'));
  assert.ok(selectedCandidate.questions.every(({ inputId }) => inputId !== 'competitors'));
  const answers = Object.fromEntries(selectedCandidate.questions.map(({ inputId, required }) => [
    inputId,
    required ? { source: 'conversation' as const, value: '京东众筹，中国市场，未来三年' } : null,
  ]));
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers },
  });
  assert.equal(confirmed.state, 'ready');
  assert.equal(confirmed.plan?.invocations.length, 1);

  const completed = await service.execute({
    taskId: created.id, ownerUserId: 'owner', expectedVersion: confirmed.stateVersion,
  });
  assert.equal(completed.state, 'completed_with_gaps');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(
    toolCalls,
    ['tavily-web-search', 'tavily-web-search'],
    'input discovery and Skill execution must remain distinct Tool calls',
  );
  assert.equal(completed.report?.title, '行业市场分析报告');
  assert.match(await service.html(created.id, 'owner') ?? '', /^<!doctype html>/u);
  assert.match(await service.markdown(created.id, 'owner') ?? '', /^# 行业市场分析报告/u);
  assert.equal((await service.list('owner')).length, 1);
  await assert.rejects(service.get(created.id, 'other'), /任务不存在/u);
});

test('a user can replace screenshot analysis with the declared Web Skill', async () => {
  const store = new MemoryStore();
  const llm = new ReportLlm();
  const toolCalls: string[] = [];
  const replacementTools: SkillNativeToolPort = {
    async invoke(input) {
      toolCalls.push(`${input.skill.id}:${input.toolId}`);
      return {
        output: { results: [{ url: 'https://example.com', title: '公开资料' }] },
        sources: [{ id: 'tool:source', kind: 'tool', label: '公开资料', url: 'https://example.com' }],
      };
    },
  };
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm, tools: replacementTools }),
    tools: replacementTools,
  });
  const created = await service.create('owner', {
    originalInput: '$competitive-app-analysis 对比直播间界面设计',
    orchestrationMode: 'single_skill',
  });
  const candidate = created.candidates[0]!;
  assert.equal(candidate.skills[0]?.replacementSkillId, 'competitive-web-research');
  assert.equal(candidate.questions.find(({ inputId }) => inputId === 'competitor_screenshots')?.missingPolicy, 'replace');
  assert.ok(candidate.resolvedInputs.every((item) => !Object.hasOwn(item, 'value')));

  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: candidate.solutionId,
  });
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: {
      expectedVersion: selected.stateVersion,
      answers: { competitor_screenshots: null },
    },
  });
  assert.equal(confirmed.state, 'ready');
  assert.equal(confirmed.plan?.invocations[0]?.skillId, 'competitive-web-research');
  assert.equal(confirmed.plan?.invocations[0]?.replacedSkillId, 'competitive-app-analysis');
  assert.ok(confirmed.plan?.requirement.gaps.some(({ id }) => id === 'replacement:competitive-app-analysis'));
  assert.ok(confirmed.plan?.requirement.inputs.every((item) => !Object.hasOwn(item, 'value')));

  const completed = await service.execute({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: confirmed.stateVersion,
  });
  assert.equal(completed.state, 'completed_with_gaps');
  assert.equal(completed.report?.title, '竞品公开资料研究');
  assert.deepEqual(toolCalls, ['competitive-web-research:tavily-web-search']);
});

test('replacement Skill Knowledge participates in confirmation-time input resolution', async () => {
  const store = new MemoryStore();
  const service = new SkillNativeTaskService({
    store,
    catalog: new ReplacementKnowledgeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: '$visual-primary research goal',
    orchestrationMode: 'single_skill',
  });
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: 'visual-with-fallback',
  });
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: {
      expectedVersion: selected.stateVersion,
      answers: { screenshot: null, method_context: null },
    },
  });
  const stored = await store.getOwned(created.id, 'owner');
  assert.equal(confirmed.plan?.invocations[0]?.skillId, 'knowledge-fallback');
  assert.equal(stored?.plan?.requirement.inputs.find(({ inputId }) => inputId === 'method_context')?.source, 'knowledge');
});

test('Zero publication retries a transient prepare failure and replays the completed receipt', async () => {
  const store = new MemoryStore();
  let publishCalls = 0;
  let failPrepare = true;
  const publication: SkillNativeZeroPublication = {
    taskId: 'filled-at-runtime',
    fileKey: 'file-1',
    pageId: 'page-1',
    pageName: '报告',
    rootNodeId: 'node-1',
  };
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
    zeroPublisher: {
      async prepare(input) {
        publishCalls += 1;
        if (failPrepare) {
          failPrepare = false;
          throw new Error('Zero unavailable');
        }
        return {
          taskId: input.taskId,
          fileKey: publication.fileKey,
          pageId: publication.pageId,
          pageName: publication.pageName,
          draftRootNodeId: publication.rootNodeId,
          finalName: input.title,
        };
      },
      async finalize(draft) { return { ...publication, taskId: draft.taskId }; },
      async cleanup() {},
    },
  });
  const created = await service.create('owner', {
    originalInput: '$generate-research-plan 制定新用户研究计划',
    orchestrationMode: 'single_skill',
  });
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: created.candidates[0]!.solutionId,
  });
  const answers = Object.fromEntries(selected.candidates[0]!.questions.map((question) => [
    question.inputId,
    question.required
      ? { source: 'conversation' as const, value: question.multiple ? ['已确认'] : '已确认' }
      : null,
  ]));
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers },
  });
  const completed = await service.execute({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: confirmed.stateVersion,
  });
  await assert.rejects(service.publishZero({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: completed.stateVersion,
  }), /Zero unavailable/u);
  const first = await service.publishZero({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: completed.stateVersion,
  });
  const replay = await service.publishZero({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: completed.stateVersion,
  });
  assert.equal(publishCalls, 2);
  assert.deepEqual(replay, first);
});

test('Zero finalization is replayed from the persisted draft when the local receipt write fails', async () => {
  const store = new MemoryStore();
  let prepareCalls = 0;
  let finalizeCalls = 0;
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
    zeroPublisher: {
      async prepare(input) {
        prepareCalls += 1;
        return {
          taskId: input.taskId,
          fileKey: 'file-1',
          pageId: 'page-1',
          pageName: '报告',
          draftRootNodeId: 'node-1',
          finalName: input.title,
        };
      },
      async finalize(draft) {
        finalizeCalls += 1;
        return {
          taskId: draft.taskId,
          fileKey: draft.fileKey,
          pageId: draft.pageId,
          pageName: draft.pageName,
          rootNodeId: draft.draftRootNodeId,
        };
      },
      async cleanup() {},
    },
  });
  const created = await service.create('owner', {
    originalInput: '$generate-research-plan 制定新用户研究计划',
    orchestrationMode: 'single_skill',
  });
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: created.candidates[0]!.solutionId,
  });
  const answers = Object.fromEntries(selected.candidates[0]!.questions.map((question) => [
    question.inputId,
    question.required
      ? { source: 'conversation' as const, value: question.multiple ? ['已确认'] : '已确认' }
      : null,
  ]));
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers },
  });
  const completed = await service.execute({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: confirmed.stateVersion,
  });
  store.failNextZeroCompletion = true;
  await assert.rejects(service.publishZero({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: completed.stateVersion,
  }), /receipt write failed/u);
  const recovered = await service.publishZero({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: completed.stateVersion,
  });
  assert.equal(recovered.rootNodeId, 'node-1');
  assert.equal(prepareCalls, 1);
  assert.equal(finalizeCalls, 2);
});

test('public task progress hides support Skill reports while preserving the final report step', async () => {
  const store = new MemoryStore();
  const service = new SkillNativeTaskService({
    store,
    catalog: new TwoSkillCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: 'support final research',
    orchestrationMode: 'multi_skill',
  });
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: created.candidates[0]!.solutionId,
  });
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers: {} },
  });
  const completed = await service.execute({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: confirmed.stateVersion,
  });
  assert.equal(completed.executionSteps.length, 2);
  assert.equal(completed.executionSteps[0]?.report, undefined);
  assert.equal(completed.executionSteps[1]?.report?.title, 'final report');
  const stored = await store.getOwned(created.id, 'owner');
  assert.equal(stored?.executionSteps[0]?.report?.title, 'support report');
  assert.equal((await service.skillResult(created.id, 'owner', 'skill-1-support'))?.title, 'support report');
  await assert.rejects(service.skillResult(created.id, 'other', 'skill-1-support'), /任务不存在/u);
});

test('an explicit confirmation answer replaces an automatically bound value', async () => {
  const store = new MemoryStore();
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: '研究京东众筹频道的用户与增长策略',
    orchestrationMode: 'single_skill',
    projectId: 'project',
    inputs: {
      industry_scope: { source: 'conversation', value: '错误范围' },
    },
  });
  const industry = created.candidates.find(({ solutionId }) => solutionId === 'industry-market-single')!;
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: industry.solutionId,
  });
  const candidate = selected.candidates.find(({ solutionId }) => solutionId === industry.solutionId)!;
  const answers: Record<string, SkillNativeInputAnswer | null> = Object.fromEntries(
    candidate.questions.map(({ inputId }) => [inputId, null]),
  );
  answers.industry_scope = { source: 'conversation', value: '京东众筹，中国市场，未来三年' };
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers },
  });
  assert.equal(confirmed.plan?.requirement.inputs.find(({ inputId }) => inputId === 'industry_scope')?.preview, '京东众筹，中国市场，未来三年');
  const stored = await store.getOwned(created.id, 'owner');
  const scopes = stored?.plan?.requirement.inputs.filter(({ inputId }) => inputId === 'industry_scope') ?? [];
  assert.deepEqual(scopes.map(({ source, value }) => ({ source, value })), [{
    source: 'conversation',
    value: '京东众筹，中国市场，未来三年',
  }]);
});

test('an explicit null answer removes an automatically bound optional value', async () => {
  const store = new MemoryStore();
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: '$generate-interview-guide 新用户流失研究',
    orchestrationMode: 'single_skill',
    inputs: {
      target_users: { source: 'conversation', value: ['首周流失的新用户'] },
    },
  });
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: created.candidates[0]!.solutionId,
  });
  const answers = Object.fromEntries(selected.candidates[0]!.questions.map(({ inputId }) => [inputId, null]));
  answers.target_users = null;
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers },
  });
  const stored = await store.getOwned(created.id, 'owner');
  assert.ok(stored?.plan?.requirement.inputs.every(({ inputId }) => inputId !== 'target_users'));
  assert.ok(confirmed.plan?.requirement.gaps.some(({ id }) => id === 'input:target_users'));
  await service.replan({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: confirmed.stateVersion,
  });
  const replanned = await store.getOwned(created.id, 'owner');
  assert.ok(replanned?.candidates[0]?.resolution.inputs.every(({ inputId }) => inputId !== 'target_users'));
});

test('Replan keeps same-task conversation bindings from the frozen Plan', async () => {
  const store = new MemoryStore();
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: '$generate-interview-guide 新用户流失研究',
    orchestrationMode: 'single_skill',
  });
  const selected = await service.select({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: created.stateVersion,
    solutionId: created.candidates[0]!.solutionId,
  });
  const answers = Object.fromEntries(selected.candidates[0]!.questions.map(({ inputId }) => [
    inputId,
    { source: 'conversation' as const, value: `${inputId} 已确认` },
  ]));
  const confirmed = await service.confirm({
    taskId: created.id,
    ownerUserId: 'owner',
    body: { expectedVersion: selected.stateVersion, answers },
  });
  const replanned = await service.replan({
    taskId: created.id,
    ownerUserId: 'owner',
    expectedVersion: confirmed.stateVersion,
  });
  const rebound = (await store.getOwned(replanned.id, 'owner'))!.candidates[0]!.resolution.inputs;
  for (const inputId of Object.keys(answers)) {
    const multiple = selected.candidates[0]!.questions.find((question) => question.inputId === inputId)?.multiple;
    const expected = multiple ? [`${inputId} 已确认`] : `${inputId} 已确认`;
    assert.ok(
      rebound.some((item) => item.inputId === inputId && JSON.stringify(item.value) === JSON.stringify(expected)),
      `${inputId}: ${JSON.stringify(rebound)}`,
    );
  }
});

test('natural-language requests rank a matching native Skill instead of defaulting to industry analysis', async () => {
  const store = new MemoryStore();
  const service = new SkillNativeTaskService({
    store,
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: '请为这次新用户流失研究设计一份可直接执行的深度访谈提纲',
    orchestrationMode: 'single_skill',
    projectId: 'project',
  });
  assert.equal(created.candidates[0]?.skills[0]?.skillId, 'generate-interview-guide');
  assert.equal(created.candidates[0]?.recommended, true);
  assert.ok(created.candidates.some(({ skills }) => skills[0]?.skillId !== 'industry-market-analysis'));
});

test('service rejects empty answers and oversized task input at its trusted boundary', async () => {
  const service = new SkillNativeTaskService({
    store: new MemoryStore(),
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  await assert.rejects(service.create('owner', {
    originalInput: '$industry-market-analysis 研究京东众筹',
    orchestrationMode: 'single_skill',
    inputs: { research_goal: { source: 'conversation', value: {} } },
  }), /非空字符串/u);
  await assert.rejects(service.create('owner', {
    originalInput: '$industry-market-analysis 研究京东众筹',
    orchestrationMode: 'single_skill',
    inputs: {
      user_research_dataset: {
        source: 'upload',
        value: { name: 'empty.txt', mediaType: 'text/plain', content: '   ' },
      },
    },
  }), /文本上传必须非空/u);
  await assert.rejects(service.create('owner', {
    originalInput: 'x'.repeat(20_001),
    orchestrationMode: 'single_skill',
  }), /20000/u);
  await assert.rejects(service.create('owner', {
    originalInput: '$industry-market-analysis 研究京东众筹',
    orchestrationMode: 'single_skill',
    inputs: { research_goal: { source: 'conversation', value: 'x'.repeat(20_001) } },
  }), /总计不能超过 20000/u);
  await assert.rejects(service.create('owner', {
    originalInput: '$industry-market-analysis 研究京东众筹',
    orchestrationMode: 'single_skill',
    inputs: { research_goal: { source: 'conversation', value: Array.from({ length: 101 }, () => 'x') } },
  }), /不能超过 100 项/u);
  await assert.rejects(service.create('owner', {
    originalInput: '$industry-market-analysis 研究京东众筹',
    orchestrationMode: 'single_skill',
    projectId: 'x'.repeat(256),
  }), /projectId 不能超过 255 个字符/u);
  await assert.rejects(service.create('owner', {
    originalInput: '$industry-market-analysis 研究京东众筹',
    orchestrationMode: 'single_skill',
    inputs: {
      user_research_dataset: {
        source: 'upload',
        value: { name: 'notes.txt', mediaType: `text/${'x'.repeat(1024)}`, content: 'content' },
      },
    },
  }), /文本上传的文件类型无效/u);
  const largePng = await sharp({
    create: { width: 4_000, height: 4_000, channels: 3, background: '#fff' },
  }).png().toBuffer();
  await assert.rejects(service.create('owner', {
    originalInput: '$competitive-app-analysis 对比直播间界面设计',
    orchestrationMode: 'single_skill',
    inputs: {
      competitor_screenshots: {
        source: 'upload',
        value: Array.from({ length: 3 }, (_, index) => ({
          name: `large-${index + 1}.png`,
          mediaType: 'image/png',
          dataUrl: `data:image/png;base64,${largePng.toString('base64')}`,
        })),
      },
    },
  }), /图片总像素不能超过 4000 万/u);
});

test('service rejects unknown and excessive image inputs before unbounded decoding', async () => {
  const service = new SkillNativeTaskService({
    store: new MemoryStore(),
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const invalidImage = {
    name: 'invalid.png',
    mediaType: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
  };
  await assert.rejects(service.create('owner', {
    originalInput: '$competitive-app-analysis 对比直播间界面设计',
    orchestrationMode: 'single_skill',
    inputs: { unknown_input: { source: 'upload', value: invalidImage } },
  }), /inputs 包含未知字段/u);

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await assert.rejects(service.create('owner', {
    originalInput: '$competitive-app-analysis 对比直播间界面设计',
    orchestrationMode: 'single_skill',
    inputs: {
      competitor_screenshots: {
        source: 'upload',
        value: Array.from({ length: 21 }, (_, index) => ({
          name: `screenshot-${index + 1}.png`,
          mediaType: 'image/png',
          dataUrl: `data:image/png;base64,${png}`,
        })),
      },
    },
  }), /不能超过 20 个上传文件/u);
});

test('a bare direct Skill command keeps research_goal unresolved', async () => {
  const service = new SkillNativeTaskService({
    store: new MemoryStore(),
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  const created = await service.create('owner', {
    originalInput: '$industry-market-analysis',
    orchestrationMode: 'single_skill',
  });
  assert.equal(created.candidates.length, 1);
  assert.ok(created.candidates[0]?.questions.some(({ inputId }) => inputId === 'research_goal'));
});

test('an unrelated request asks for clarification instead of recommending a zero-score solution', async () => {
  const service = new SkillNativeTaskService({
    store: new MemoryStore(),
    catalog: new SkillNativeCatalog(),
    execution: new SkillNativeExecutionEngine({ llm: new ReportLlm(), tools }),
    tools,
  });
  await assert.rejects(service.create('owner', {
    originalInput: '🫠🫠🫠',
    orchestrationMode: 'single_skill',
  }), /无法根据当前描述可靠匹配/u);
});

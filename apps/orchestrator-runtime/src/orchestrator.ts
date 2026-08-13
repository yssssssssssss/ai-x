import { AgentRuntime, buildRuntime } from './runtime/agent-runtime.ts';
import { RunWorkspace } from './run-workspace.ts';
import {
  loadToolManifest,
  hashFile,
  CONFIG_PATHS,
} from './runtime/config-loader.ts';
import type {
  PendingUpload,
  PlanCandidate,
  PlanResult,
  PlanProgress,
  SelectResult,
  PlanStep,
  ExecuteResult,
} from './plan-types.ts';
import type { ActorRunner, StepArtifact } from './runners/actor-runner.ts';
import { ToolActorRunner } from './runners/tool-runner.ts';
import { SkillActorRunner } from './runners/skill-runner.ts';
import { LlmActorRunner } from './runners/llm-runner.ts';
import { ReviewerActorRunner } from './runners/reviewer-runner.ts';
import { ResearchPlanningService } from './planners/research-planning-service.ts';
import { sanitizeCandidateToPlan } from './planners/plan-sanitizer.ts';
import { ToolRouter } from './runtime/tool-adapter.ts';

// 对外契约集中在 plan-types.ts,这里 re-export 让老 import 路径继续可用。
export type {
  GuidanceRef,
  ResearchTaskData,
  PendingUpload,
  PlanCandidate,
  PlanResult,
  PlanPhaseKey,
  PlanProgress,
  SelectResult,
  PlanStep,
  ExecuteResult,
} from './plan-types.ts';

// retrieveGuidance 已随 routed 支路移入 planners/routed-planner.ts(唯一使用者)。
// 此处 re-export 保住老 import 路径('./orchestrator.ts'),tests 与外部调用零改动(D3)。
export { retrieveGuidance } from './planners/routed-planner.ts';

// 四段流编排壳(方案 §五)。判断全在 skill/配置/LLM,壳只做装配、校验、留痕。
// 严禁在此写 `if task_type == 'competitive_research'` 类领域分支:
//   节点激活 = 纯数据过滤(applies_to.includes(task_type)),加 task_type 只需改 YAML。

export class LegacyRealExecutionBlockedError extends Error {
  constructor(capability: string) {
    super(`legacy execution cannot invoke real ${capability}; use TaskWorkflowService + LeaseExecutionEngine`);
    this.name = 'LegacyRealExecutionBlockedError';
  }
}

export class Orchestrator {
  private readonly runners: Record<PlanStep['actor_type'], ActorRunner>;
  private readonly planningService: ResearchPlanningService;

  constructor(private readonly rt: AgentRuntime) {
    const { llm, validator, skillLoader, toolAdapter } = rt.deps;
    this.runners = {
      tool: new ToolActorRunner(skillLoader, toolAdapter, validator),
      skill: new SkillActorRunner(llm, skillLoader, validator),
      llm: new LlmActorRunner(llm),
      reviewer: new ReviewerActorRunner(llm),
    };
    this.planningService = new ResearchPlanningService({ llm, validator, skillLoader });
  }

  // ---- 段1 + 段2:理解 → 计划 → 停(HITL 闸门,不执行)----
  // onProgress:可选阶段进度回调(SSE 流式用);不传则非流式,现有调用不受影响。
  async planPhase(input: {
    originalInput: string;
    conversationId: string;
    ownerUserId: string;
  }, onProgress?: (ev: PlanProgress) => void): Promise<PlanResult> {
    const { checkpointStore } = this.rt.deps;
    const emit = onProgress ?? (() => {});
    const {
      task,
      activatedNodes,
      decisionStates,
      candidates,
      guidanceSources,
      provenance,
    } = await this.planningService.plan({ originalInput: input.originalInput }, onProgress);

    const graphHash = hashFile(CONFIG_PATHS.decisionGraph);

    // 落库:研究任务
    emit({ phase: 'persist', status: 'start', label: '归档计划' });
    const taskRow = await checkpointStore.createTask({
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      originalInput: input.originalInput,
      taskType: task.task_type,
      structuredTask: task,
      assumptions: task.assumptions,
      confirmations: task.confirmations,
      blockingIssues: task.blocking_issues,
      runWorkspaceUri: 'pending',
      sensitivity: task.sensitivity,
      piiDetected: task.pii_detected,
    });

    // 用真实 task_id 建 workspace,落候选(尚未选中,故不 writePlan)
    const ws = new RunWorkspace(taskRow.id);
    ws.ensure();
    ws.writeCandidates({ task_id: taskRow.id, candidates });

    // 落库:决策状态 + context_manifest(计划文件在 selectPlan 里落)
    for (const s of decisionStates) {
      await checkpointStore.writeDecisionState({
        taskId: taskRow.id,
        nodeKey: s.node_key,
        state: s.state,
        reason: s.reason,
        confidence: s.confidence,
        userOverride: s.user_override,
        finalState: s.final_state,
      });
    }
    ws.writeDecisionStates(decisionStates);
    const loadedSources: Array<{ type: string; ref: string; hash?: string }> = [
      { type: 'research_task', ref: `research_tasks.${taskRow.id}` },
      { type: 'registry', ref: 'orchestrator/skill-registry.yaml', hash: hashFile(CONFIG_PATHS.skillRegistry) },
      { type: 'decision_graph', ref: 'orchestrator/decision-graph.yaml', hash: graphHash },
      ...guidanceSources.map((source) => ({
        type: 'knowledge',
        ref: source.source_path,
        hash: source.content_hash,
      })),
    ];
    const sourceKeys = new Set<string>();

    ws.writeContextManifest({
      run_id: taskRow.id,
      stage: 'planning',
      loaded_sources: loadedSources.filter((source) => {
        const key = JSON.stringify([source.ref, source.hash]);
        if (sourceKeys.has(key)) return false;
        sourceKeys.add(key);
        return true;
      }),
      model_name: provenance.modelName,
      model_version: provenance.modelVersion,
      prompt_hash: provenance.promptHash,
      trace_id: provenance.traceId,
    });

    // 更新状态:候选已生成,等用户选一份
    await checkpointStore.updateTaskStatus(taskRow.id, 'planned', 'awaiting_selection');
    emit({ phase: 'persist', status: 'done', label: '归档计划', detail: '候选已就绪' });

    return {
      taskId: taskRow.id,
      task,
      activatedNodes,
      candidates,
      workspaceUri: ws.uri,
    };
  }

  // ---- selectPlan:用户从候选中选中一份 → finalize 出可执行 plan + pendingUploads ----
  async selectPlan(input: { taskId: string; candidateId: PlanCandidate['id'] }): Promise<SelectResult> {
    const { validator, checkpointStore, skillLoader } = this.rt.deps;
    const ws = new RunWorkspace(input.taskId);
    const raw = ws.readCandidates<{ task_id: string; candidates: PlanCandidate[] }>();
    const cand = raw.candidates.find((c) => c.id === input.candidateId);
    if (!cand) {
      throw new Error(`候选 ${input.candidateId} 不存在,可选:${raw.candidates.map((c) => c.id).join(', ')}`);
    }

    // 候选阶段 schema 不严格,LLM 输出常带漂移;sanitizeCandidateToPlan 白名单清洗成合规 plan。
    const taskRow = await checkpointStore.getTask(input.taskId);
    const taskType = taskRow?.task_type ?? '';
    const plan = sanitizeCandidateToPlan(cand, input.taskId, taskType);
    validator.validateOrThrow('execution-plan', plan);

    // 扫描 tool 步图像入参,聚合 pendingUploads(每候选可能不同,选中后才知道要什么图)。
    const hasRealImage = (v: unknown): boolean => {
      const one = (e: unknown) => !!(e && typeof e === 'object' && ((e as { dataUrl?: string }).dataUrl || (e as { url?: string }).url));
      return Array.isArray(v) ? v.some(one) : one(v);
    };
    const roleLabels: Record<string, string> = { design: '设计稿', brand_reference: '品牌参考图' };
    const byRole = new Map<string, PendingUpload>();
    for (const s of cand.steps) {
      if (s.actor_type !== 'tool') continue;
      const tool = skillLoader.getTool(s.actor_id);
      if (!tool) continue;
      const manifest = loadToolManifest(tool.path);
      for (const f of manifest.image_input_fields ?? []) {
        const provided = (s.input as Record<string, unknown> | undefined)?.[f.field];
        if (hasRealImage(provided)) continue;
        const role = f.role ?? f.field;
        if (!byRole.has(role)) byRole.set(role, { role, label: roleLabels[role] ?? role, multiple: false, targets: [] });
        const pu = byRole.get(role)!;
        pu.targets.push({ step_no: s.step_no, tool_id: s.actor_id, field: f.field, multiple: !!f.multiple });
        if (f.multiple) pu.multiple = true;
      }
    }
    const pendingUploads: PendingUpload[] = [...byRole.values()];

    ws.writePlan(plan);
    await checkpointStore.updateTaskStatus(input.taskId, 'planned', 'awaiting_confirmation');

    return { taskId: input.taskId, candidateId: cand.id, plan, pendingUploads };
  }

  // ---- 段3 + 段4:执行 → 交付(用户确认后)----
  // 融合·MVP 容错(方案 §2.5①·补):遇失败步停在该步(paused),不整体崩;
  // 用户 resume(skip) 从下一步续跑,失败/跳过维度的缺口如实进报告 risks_and_open_issues。
  async executePhase(input: { taskId: string; conversationId: string; uploads?: Array<{ role: string; dataUrl: string }> }): Promise<ExecuteResult> {
    const { checkpointStore } = this.rt.deps;
    const ws = new RunWorkspace(input.taskId);
    const plan = ws.readPlan<{ steps: PlanStep[]; task_id: string }>();
    this.assertLegacyExecutionIsHermetic(plan.steps);
    const taskRow = await checkpointStore.getTask(input.taskId);
    const researchGoal =
      (taskRow?.structured_task as { research_goal?: string } | undefined)?.research_goal ??
      taskRow?.original_input ?? '';

    await checkpointStore.updateTaskStatus(input.taskId, 'executing', 'confirmed');

    const ctx: ExecCtx = {
      taskId: input.taskId, conversationId: input.conversationId, researchGoal, ws, plan,
      graphHash: hashFile(CONFIG_PATHS.decisionGraph),
      uploads: input.uploads,
      toolOutputs: [], reviewNotes: [], stepFailures: [], usedCapabilities: [], toolOutputRefs: [],
    };
    return this.runFrom(0, ctx);
  }

  // ---- resume:失败步 skip(续跑) / abort(收尾)----
  async resumePhase(input: { taskId: string; conversationId: string; action: 'skip' | 'abort' }): Promise<ExecuteResult> {
    const { checkpointStore } = this.rt.deps;
    const ws = new RunWorkspace(input.taskId);
    const state = ws.readRunState<RunState>();

    if (input.action === 'abort') {
      await checkpointStore.updateTaskStatus(input.taskId, 'failed');
      return { status: 'failed', failedStepNo: state.failedStepNo, failedStepName: state.failedStepName };
    }

    // skip:失败步标 skipped,从各步已落盘 output 重建 toolOutputs,从下一步续跑。
    const plan = ws.readPlan<{ steps: PlanStep[]; task_id: string }>();
    this.assertLegacyExecutionIsHermetic(plan.steps);
    const taskRow = await checkpointStore.getTask(input.taskId);
    const researchGoal =
      (taskRow?.structured_task as { research_goal?: string } | undefined)?.research_goal ??
      taskRow?.original_input ?? '';

    await checkpointStore.writeExecutionLog({
      taskId: input.taskId, stepNo: state.failedStepNo, stepName: state.failedStepName,
      actorType: state.failedActorType, actorId: state.failedActorId, status: 'skipped',
      finishedAt: new Date(), decisionGraphHash: hashFile(CONFIG_PATHS.decisionGraph),
    });

    const ctx: ExecCtx = {
      taskId: input.taskId, conversationId: input.conversationId, researchGoal, ws, plan,
      graphHash: hashFile(CONFIG_PATHS.decisionGraph),
      uploads: state.uploads,
      // 从落盘重建已完成步的上下文(不重放前序步)
      toolOutputs: state.toolOutputRefs.map((r) => ({ toolId: r.toolId, output: ws.readToolOutput<unknown>(r.stepNo) })),
      reviewNotes: state.reviewNotes, stepFailures: state.stepFailures,
      usedCapabilities: state.usedCapabilities, toolOutputRefs: state.toolOutputRefs,
    };

    await checkpointStore.updateTaskStatus(input.taskId, 'executing');
    const failedIdx = plan.steps.findIndex((s) => s.step_no === state.failedStepNo);
    return this.runFrom(failedIdx + 1, ctx);
  }

  // 从 startIdx 顺序执行剩余步:遇失败停在该步(paused + 落 run_state);全过 → finalizeReport。
  private async runFrom(startIdx: number, ctx: ExecCtx): Promise<ExecuteResult> {
    const { checkpointStore } = this.rt.deps;
    for (let i = startIdx; i < ctx.plan.steps.length; i++) {
      const step = ctx.plan.steps[i];
      try {
        await this.runStep(step, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 失败:标 failed、写 failures.jsonl、停在该步(不整体崩、不重跑)
        await checkpointStore.writeExecutionLog({
          taskId: ctx.taskId, stepNo: step.step_no, stepName: step.step_name,
          actorType: step.actor_type, actorId: step.actor_id, status: 'failed',
          errorJson: { message }, finishedAt: new Date(),
          contextManifestRef: `${ctx.ws.uri}/context_manifest.json`,
        });
        ctx.ws.appendFailure({
          task_id: ctx.taskId, stage: 'execution',
          selected_skill: step.actor_type === 'skill' ? step.actor_id : undefined,
          selected_tool: step.actor_type === 'tool' ? step.actor_id : undefined,
          error_type: err instanceof Error ? err.name : 'Error',
          error_message: message,
          context_manifest_ref: `${ctx.ws.uri}/context_manifest.json`,
        });
        ctx.stepFailures.push({ stepNo: step.step_no, stepName: step.step_name, actorType: step.actor_type, actorId: step.actor_id, message });
        // 落断点:resume 据此重建上下文
        const runState: RunState = {
          failedStepNo: step.step_no, failedStepName: step.step_name,
          failedActorType: step.actor_type, failedActorId: step.actor_id,
          toolOutputRefs: ctx.toolOutputRefs, reviewNotes: ctx.reviewNotes,
          stepFailures: ctx.stepFailures, usedCapabilities: ctx.usedCapabilities,
          uploads: ctx.uploads,
        };
        ctx.ws.writeRunState(runState);
        await checkpointStore.updateTaskStatus(ctx.taskId, 'paused');
        return { status: 'paused', failedStepNo: step.step_no, failedStepName: step.step_name };
      }
    }
    return this.finalizeReport(ctx);
  }

  // 单步执行:装配 → 分派到 Runner → 落 artifact 累积 → 写 execution_log(succeeded)。
  // Runner 只负责"这一步做什么";这里负责编排、日志、累积。失败一律 throw(由 runFrom 处理)。
  private async runStep(step: PlanStep, ctx: ExecCtx): Promise<void> {
    const { checkpointStore } = this.rt.deps;
    const startedAt = new Date();
    await checkpointStore.writeExecutionLog({
      taskId: ctx.taskId, stepNo: step.step_no, stepName: step.step_name,
      actorType: step.actor_type, actorId: step.actor_id, status: 'running',
      startedAt, decisionGraphHash: ctx.graphHash,
    });

    const runner = this.runners[step.actor_type];
    const artifact = await runner.run(step, ctx);
    const { outputRef, tokens, manifestHashes } = this.commitArtifact(step, ctx, artifact);

    await checkpointStore.writeExecutionLog({
      taskId: ctx.taskId, stepNo: step.step_no, stepName: step.step_name,
      actorType: step.actor_type, actorId: step.actor_id, status: 'succeeded',
      outputRef, startedAt, finishedAt: new Date(),
      tokensJson: tokens,
      contextManifestRef: `${ctx.ws.uri}/context_manifest.json`,
      decisionGraphHash: ctx.graphHash,
      skillManifestHashes: step.actor_type === 'skill' ? manifestHashes : [],
      toolManifestHashes: step.actor_type === 'tool' ? manifestHashes : [],
    });
  }

  // 累积单点:Runner 只回 artifact,这里按 kind 分派到 toolOutputs / reviewNotes / usedCapabilities,
  // 让 4 支 Runner 都不用碰 ctx 的可变数组(局部性)。
  private commitArtifact(
    step: PlanStep,
    ctx: ExecCtx,
    artifact: StepArtifact,
  ): { outputRef: string; tokens?: { prompt: number; completion: number; total: number }; manifestHashes: string[] } {
    switch (artifact.kind) {
      case 'tool_output':
        ctx.toolOutputs.push({ toolId: artifact.actorId, output: artifact.output });
        ctx.toolOutputRefs.push({ stepNo: step.step_no, toolId: artifact.actorId });
        ctx.usedCapabilities.push({ id: artifact.actorId, type: 'tool' });
        return { outputRef: artifact.outputRef, tokens: artifact.tokens, manifestHashes: [artifact.manifestHash] };
      case 'skill_output':
        ctx.toolOutputs.push({ toolId: artifact.actorId, output: artifact.output });
        ctx.toolOutputRefs.push({ stepNo: step.step_no, toolId: artifact.actorId });
        ctx.usedCapabilities.push({ id: artifact.actorId, type: 'skill' });
        return { outputRef: artifact.outputRef, tokens: artifact.tokens, manifestHashes: [artifact.manifestHash] };
      case 'llm_note':
        ctx.toolOutputs.push({ toolId: artifact.actorId, output: artifact.output });
        ctx.toolOutputRefs.push({ stepNo: step.step_no, toolId: artifact.actorId });
        return { outputRef: artifact.outputRef, tokens: artifact.tokens, manifestHashes: [] };
      case 'review_note':
        ctx.reviewNotes.push(artifact.review);
        return { outputRef: artifact.outputRef, tokens: artifact.tokens, manifestHashes: [] };
    }
  }

  // 段4:synthesis → report → 过 schema → 写 artifact。失败/跳过步的缺口 + 复核意见注入 prompt。
  private async finalizeReport(ctx: ExecCtx): Promise<ExecuteResult> {
    const { llm, validator, checkpointStore } = this.rt.deps;

    // 数据闸门:无任何成功产出则不硬合成(research-report.findings minItems:1,空数据合不出合法报告)。
    if (ctx.toolOutputs.length === 0) {
      await checkpointStore.updateTaskStatus(ctx.taskId, 'failed');
      throw new AllStepsFailedError(ctx.stepFailures);
    }

    const gapNote =
      ctx.stepFailures.length > 0
        ? `\n以下步骤失败或被跳过,其覆盖维度数据缺失,必须在 risks_and_open_issues 中如实说明缺口,不得假装有数据:` +
          ctx.stepFailures.map((f) => `[step ${f.stepNo} ${f.actorType}:${f.actorId} — ${f.message}]`).join('; ')
        : '';
    const reviewNote =
      ctx.reviewNotes.length > 0
        ? `\n以下为质量复核意见,未解决项写入 risks_and_open_issues:` + ctx.reviewNotes.map((r, i) => `[复核${i + 1}] ${r}`).join('; ')
        : '';

    const reportGen = await llm.generateStructured<Record<string, unknown>>({
      prompt:
        '基于以下真实执行结果生成需求驱动的研究报告(非竞品对比矩阵)。' +
        '先把研究需求拆成若干研究子问题(sub_questions);' +
        'findings 为全局证据池,每条分配全局唯一 id(F1、F2…),凡来自 tool_outputs 检索数据的结论 source 必须标 tool_result 并在 statement 引用具体竞品名称/来源;' +
        '每个子问题挂相关 finding_ids、给出 analysis(每条 based_on 引用其依据的发现 id)与 summary;' +
        'overall_conclusion 汇总各子问题小结;method_summary 用一句话概述所用检索/分析能力;' +
        '无数据支撑的判断标 llm_inference,不得冒充事实;若 tool_outputs 为空则如实说明数据缺口。' +
        gapNote + reviewNote,
      schema: {}, schemaName: 'research-report',
      context: {
        task_id: ctx.taskId, research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs,
        step_failures: ctx.stepFailures, review_notes: ctx.reviewNotes,
      },
      receipt: {
        stage: 'synthesis',
        attemptId: ctx.attemptId,
        stepNo: ctx.plan.steps.length + 1,
        contextManifestHash: ctx.contextManifestHash,
        expectedModel: ctx.expectedModel,
      },
    });
    const report = { ...reportGen.data, task_id: ctx.taskId };
    validator.validateOrThrow('research-report', report);

    const synthStepNo = ctx.plan.steps.length + 1;
    await checkpointStore.writeExecutionLog({
      taskId: ctx.taskId, stepNo: synthStepNo, stepName: '报告合成', actorType: 'llm',
      actorId: 'synthesis', status: 'succeeded',
      tokensJson: reportGen.tokens,
      promptHash: reportGen.promptHash,
      modelName: reportGen.modelName, modelVersion: reportGen.modelVersion,
      traceId: reportGen.traceId,
      contextManifestRef: `${ctx.ws.uri}/context_manifest.json`,
      finishedAt: new Date(),
    });

    const reportPath = ctx.ws.writeArtifactFile('report.json', JSON.stringify(report, null, 2));
    const artifact = await checkpointStore.writeArtifact({
      taskId: ctx.taskId, conversationId: ctx.conversationId,
      artifactType: 'report', title: '竞品研究方案', storageUri: reportPath,
      contentSummary: (report as { research_goal?: string }).research_goal,
      sourceRefs: ctx.usedCapabilities,
    });

    const gapCount = ctx.stepFailures.length;
    const status: ExecuteResult['status'] = gapCount > 0 ? 'completed_with_gaps' : 'completed';
    await checkpointStore.updateTaskStatus(ctx.taskId, status);
    return { status, reportArtifactId: artifact.id, gapCount };
  }
  private assertLegacyExecutionIsHermetic(steps: PlanStep[]): void {
    const { skillLoader, toolAdapter } = this.rt.deps;
    const llmIdentity = this.rt.deps.llm.identity;
    if (llmIdentity.mode === 'real' && llmIdentity.eligibleAsReal) {
      throw new LegacyRealExecutionBlockedError(`LLM ${llmIdentity.provider}`);
    }
    for (const step of steps) {
      if (step.actor_type !== 'tool') continue;
      const tool = skillLoader.getTool(step.actor_id);
      if (!tool) continue;
      const manifest = loadToolManifest(tool.path);
      const mode = toolAdapter instanceof ToolRouter
        ? toolAdapter.resolve(manifest)?.executionMode
        : toolAdapter.executionMode;
      if (mode === 'real') throw new LegacyRealExecutionBlockedError(`Tool ${step.actor_id}`);
    }
  }

}

// 执行累积上下文与 StepFailure:契约见 runners/actor-runner.ts,orchestrator 在此
// 落 run_state / commit artifact 时消费,不额外再声明。
import type { ExecCtx, StepFailure } from './runners/actor-runner.ts';

// run_state.json:停在失败步时落盘的断点,resume 据此重建上下文并从下一步续跑。
interface RunState {
  failedStepNo: number;
  failedStepName: string;
  failedActorType: PlanStep['actor_type'];
  failedActorId: string;
  toolOutputRefs: Array<{ stepNo: number; toolId: string }>;
  reviewNotes: string[];
  stepFailures: StepFailure[];
  usedCapabilities: Array<{ id: string; type: string }>;
  uploads?: Array<{ role: string; dataUrl: string }>;
}

// executePhase / resumePhase 的返回类型见 plan-types.ts。

export class StepFailedError extends Error {
  constructor(public readonly stepNo: number, public readonly actorId: string, message: string) {
    super(`step ${stepNo} (${actorId}) 执行失败: ${message}`);
    this.name = 'StepFailedError';
  }
}

// 全部步骤失败/跳过后无任何成功产出:数据闸门拦下,不硬合成空报告。
export class AllStepsFailedError extends Error {
  constructor(public readonly failures: Array<{ stepNo: number; actorId: string; message: string }>) {
    super(`所有执行步骤均失败或被跳过,无数据可合成报告(失败 ${failures.length} 步)`);
    this.name = 'AllStepsFailedError';
  }
}

export function buildOrchestrator(overrides = {}): Orchestrator {
  return new Orchestrator(buildRuntime(overrides));
}

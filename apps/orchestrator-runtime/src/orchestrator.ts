import { AgentRuntime, buildRuntime } from './runtime/agent-runtime.ts';
import { RunWorkspace } from './run-workspace.ts';
import {
  loadDecisionGraph,
  loadToolManifest,
  loadToolInputSchema,
  hashFile,
  getConfigRoot,
  CONFIG_PATHS,
  type DecisionNode,
} from './runtime/config-loader.ts';
import { join } from 'node:path';

// 四段流编排壳(方案 §五)。判断全在 skill/配置/LLM,壳只做装配、校验、留痕。
// 严禁在此写 `if task_type == 'competitive_research'` 类领域分支:
//   节点激活 = 纯数据过滤(applies_to.includes(task_type)),加 task_type 只需改 YAML。

export interface ResearchTaskData {
  task_type: string;
  business_domain: string;
  research_goal: string;
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
  confirmations: unknown[];
  blocking_issues: unknown[];
  sensitivity: string;
  pii_detected: boolean;
}

export interface PendingUpload {
  step_no: number;
  tool_id: string;
  tool_name: string;
  field: string;
  multiple: boolean;
  label: string;
}

export interface PlanResult {
  taskId: string;
  task: ResearchTaskData;
  activatedNodes: string[];
  plan: unknown;
  pendingUploads: PendingUpload[];
  workspaceUri: string;
}

export class Orchestrator {
  constructor(private readonly rt: AgentRuntime) {}

  // ---- 段1 + 段2:理解 → 计划 → 停(HITL 闸门,不执行)----
  async planPhase(input: {
    originalInput: string;
    conversationId: string;
    ownerUserId: string;
  }): Promise<PlanResult> {
    const { llm, validator, checkpointStore, skillLoader } = this.rt.deps;

    // 段1 任务理解:一句话 → ResearchTask,过 schema
    const taskGen = await llm.generateStructured<ResearchTaskData>({
      prompt: `将用户需求结构化为 ResearchTask:${input.originalInput}`,
      schema: {},
      schemaName: 'research-task',
      context: { input: input.originalInput },
    });
    validator.validateOrThrow('research-task', taskGen.data);
    const task = taskGen.data;

    // 段2a 决策节点激活:按 applies_to 过滤(数据驱动,非领域分支)
    const graph = loadDecisionGraph();
    const activated: DecisionNode[] = graph.nodes.filter((n) =>
      n.applies_to.includes(task.task_type),
    );
    const graphHash = hashFile(CONFIG_PATHS.decisionGraph);

    // 段2b 决策状态判定:LLM 对激活节点逐一判 6 态,过 schema
    const statesGen = await llm.generateStructured<
      Array<{ node_key: string; state: string; reason: string; confidence?: number; user_override: unknown; final_state: string }>
    >({
      prompt: `对以下激活的决策节点逐一判定状态:${activated.map((n) => n.key).join(', ')}`,
      schema: {},
      schemaName: 'decision-states',
      context: { activated: activated.map((n) => n.key), task },
    });
    // 只保留本次实际激活的节点状态(防 fixture 含多余节点)
    const activatedKeys = new Set(activated.map((n) => n.key));
    const decisionStates = statesGen.data.filter((s) => activatedKeys.has(s.node_key));
    for (const s of decisionStates) validator.validateOrThrow('decision-state', s);

    // 段2c 能力路由 + 计划生成:LLM 读 skill 摘要选候选,生成 execution-plan
    const activeSkills = skillLoader.listActiveSkills();
    const activeTools = skillLoader.listActiveTools();
    const skillIds = activeSkills.map((s) => s.id);
    const toolIds = activeTools.map((t) => t.id);
    // 喂给 LLM 每个 tool 的 input.schema,让它按 schema 为 tool 步生成 input 入参。
    const toolCtx = activeTools.map((t) => {
      const manifest = loadToolManifest(t.path);
      return { id: t.id, name: t.name, input_schema: loadToolInputSchema(manifest.input_schema) };
    });
    const planGen = await llm.generateStructured<Record<string, unknown>>({
      prompt:
        `基于任务与候选能力生成待确认执行计划。\n` +
        `硬约束:actor_type=skill 的步骤,actor_id 只能取以下 skill id 之一:[${skillIds.join(', ')}];\n` +
        `actor_type=tool 的步骤,actor_id 只能取以下 tool id 之一:[${toolIds.join(', ')}]。\n` +
        `禁止编造不在上述清单中的 skill/tool id。若需 LLM 自身推理步骤(如汇总/提炼),用 actor_type=llm。\n` +
        `tool 步必须在 step.input 里按该 tool 的 input_schema(见 context.tools[].input_schema)生成入参。\n` +
        `若某 tool 需要图像但任务未提供图像(dataUrl/url),不要编造 base64:把该图像字段留空,并在 assumptions 标注『需用户提供设计稿』。`,
      schema: {},
      schemaName: 'execution-plan',
      context: {
        task,
        skills: activeSkills.map((s) => ({ id: s.id, when_to_use: s.when_to_use, required_tools: s.required_tools })),
        tools: toolCtx,
      },
    });

    // 落库:研究任务
    const workspace = new RunWorkspace('__pending__');
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

    // 用真实 task_id 建 workspace,回填 plan 的 task_id
    const ws = new RunWorkspace(taskRow.id);
    ws.ensure();
    const plan = { ...planGen.data, task_id: taskRow.id };
    validator.validateOrThrow('execution-plan', plan);

    // 能力真实性校验:真实 LLM 可能编造不存在的 skill/tool id(幻觉)。
    // skill/tool 步的 actor_id 必须命中 registry active 能力,否则在计划阶段就拦下,
    // 而非等到 execute 才崩。llm/reviewer 步是 LLM 内部动作,无 registry id,不校验。
    const planSteps = (plan as { steps?: PlanStep[] }).steps ?? [];
    const badCaps = planSteps.filter((s) => {
      if (s.actor_type === 'skill') return !skillLoader.getSkill(s.actor_id);
      if (s.actor_type === 'tool') return !skillLoader.getTool(s.actor_id);
      return false;
    });
    if (badCaps.length > 0) {
      throw new Error(
        `计划包含 registry 中不存在的能力(疑似 LLM 幻觉),请重规划: ` +
          badCaps.map((s) => `${s.actor_type}:${s.actor_id}`).join(', '),
      );
    }

    // 扫描 tool 步的图像入参:manifest 声明 image_input_fields 且 step.input 未提供图 → 待用户在确认闸门上传。
    const pendingUploads: PendingUpload[] = [];
    for (const s of planSteps) {
      if (s.actor_type !== 'tool') continue;
      const tool = skillLoader.getTool(s.actor_id);
      if (!tool) continue;
      const manifest = loadToolManifest(tool.path);
      for (const f of manifest.image_input_fields ?? []) {
        const provided = (s.input as Record<string, unknown> | undefined)?.[f.field];
        const hasImage = Array.isArray(provided)
          ? provided.length > 0
          : !!(provided && ((provided as { dataUrl?: string; url?: string }).dataUrl || (provided as { url?: string }).url));
        if (!hasImage) {
          pendingUploads.push({
            step_no: s.step_no, tool_id: s.actor_id, tool_name: tool.name,
            field: f.field, multiple: !!f.multiple,
            label: `步骤${s.step_no} · ${tool.name} 需要设计稿`,
          });
        }
      }
    }

    // 落库:决策状态 + 计划落盘 + context_manifest
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
    ws.writePlan(plan);
    ws.writeContextManifest({
      run_id: taskRow.id,
      stage: 'planning',
      loaded_sources: [
        { type: 'research_task', ref: `research_tasks.${taskRow.id}` },
        { type: 'registry', ref: 'orchestrator/skill-registry.yaml', hash: hashFile(CONFIG_PATHS.skillRegistry) },
        { type: 'decision_graph', ref: 'orchestrator/decision-graph.yaml', hash: graphHash },
      ],
      model_name: planGen.modelName,
      model_version: planGen.modelVersion,
      prompt_hash: planGen.promptHash,
      trace_id: planGen.traceId,
    });

    // 更新 run_workspace_uri + 状态(等待确认)
    await checkpointStore.updateTaskStatus(taskRow.id, 'planned', 'awaiting_confirmation');

    void workspace; // 占位变量清理
    return {
      taskId: taskRow.id,
      task,
      activatedNodes: activated.map((n) => n.key),
      plan,
      pendingUploads,
      workspaceUri: ws.uri,
    };
  }

  // ---- 段3 + 段4:执行 → 交付(用户确认后)----
  async executePhase(input: { taskId: string; conversationId: string; uploads?: Array<{ step_no: number; field: string; dataUrl: string }> }): Promise<{ reportArtifactId: string }> {
    const { llm, validator, checkpointStore, skillLoader, toolAdapter } = this.rt.deps;
    const ws = new RunWorkspace(input.taskId);
    const plan = ws.readPlan<{ steps: PlanStep[]; task_id: string }>();
    // 读回结构化任务,供 synthesis 用真实研究目标 + 检索词
    const taskRow = await checkpointStore.getTask(input.taskId);
    const researchGoal =
      (taskRow?.structured_task as { research_goal?: string } | undefined)?.research_goal ??
      taskRow?.original_input ?? '';

    await checkpointStore.updateTaskStatus(input.taskId, 'executing', 'confirmed');

    const graphHash = hashFile(CONFIG_PATHS.decisionGraph);
    const usedCapabilities: Array<{ id: string; type: string }> = [];
    // 累积各 tool 步的真实输出,段4 synthesis 据此生成引用真实数据的报告
    const toolOutputs: Array<{ toolId: string; output: unknown }> = [];

    // 段3:逐步执行,每步写 execution_log + tool 输出;失败停在该步、写 failures.jsonl
    for (const step of plan.steps) {
      const startedAt = new Date();
      await checkpointStore.writeExecutionLog({
        taskId: input.taskId, stepNo: step.step_no, stepName: step.step_name,
        actorType: step.actor_type, actorId: step.actor_id, status: 'running',
        startedAt, decisionGraphHash: graphHash,
      });

      try {
        let outputRef: string | undefined;
        const manifestHashes: string[] = [];
        let stepTokens: { prompt: number; completion: number; total: number } | undefined;

        if (step.actor_type === 'tool') {
          const tool = skillLoader.getTool(step.actor_id);
          if (!tool) throw new Error(`tool 非 active 或不存在: ${step.actor_id}`);
          const manifest = loadToolManifest(tool.path);
          // 入参:优先用计划里 LLM 生成的 step.input;缺省回落 {query}(兼容 o2/ai-spider 检索类)。
          const toolInput: Record<string, unknown> = { ...(step.input ?? { query: researchGoal || '直播 数字人 竞品' }) };
          // 回填用户在确认闸门上传的图:按 manifest.image_input_fields 注入(multiple 包成数组)。
          const stepUploads = (input.uploads ?? []).filter((u) => u.step_no === step.step_no);
          for (const f of manifest.image_input_fields ?? []) {
            const up = stepUploads.find((u) => u.field === f.field);
            if (up) toolInput[f.field] = f.multiple ? [{ dataUrl: up.dataUrl }] : { dataUrl: up.dataUrl };
          }
          // 调用前按该 tool 的 input.schema 校验:非法入参在计划质量层拦下,不打到工具。
          validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
          const res = await toolAdapter.invoke({ toolId: step.actor_id, input: toolInput, manifest });
          // tool 的 output schema 在 tool 目录下,按文件路径校验
          // output_schema 是相对项目根的路径(如 tools/xxx/output.schema.json)
          const outSchemaPath = join(getConfigRoot(), manifest.output_schema);
          validator.validateFileOrThrow(outSchemaPath, res.output);
          outputRef = ws.writeToolOutput(step.step_no, res.output);
          toolOutputs.push({ toolId: step.actor_id, output: res.output });
          manifestHashes.push(hashFile(tool.path));
          usedCapabilities.push({ id: step.actor_id, type: 'tool' });
        } else if (step.actor_type === 'skill') {
          // skill 真执行:加载 SKILL.md 全文 + output schema,调 LLM 按工作流基于已有 tool 输出产出结构化结果。
          const skillEntry = skillLoader.getSkill(step.actor_id);
          if (!skillEntry) throw new Error(`skill 非 active 或不存在: ${step.actor_id}`);
          const { body } = skillLoader.loadSkillBody(step.actor_id);
          const { output } = skillLoader.loadSkillSchemas(step.actor_id);
          const skillGen = await llm.generateStructured<object>({
            prompt:
              `你是「${skillEntry.name}」能力。严格按以下 SKILL.md 的工作流与质量门禁执行,` +
              `基于提供的检索数据(tool_outputs)产出结构化结果;无数据支撑的判断标 llm_inference,不得冒充事实。\n\n${body}`,
            schema: output,
            schemaName: `skill:${step.actor_id}`,
            context: { research_goal: researchGoal, tool_outputs: toolOutputs },
          });
          validator.validateFileOrThrow(join(getConfigRoot(), skillEntry.output_schema), skillGen.data);
          outputRef = ws.writeToolOutput(step.step_no, skillGen.data);
          toolOutputs.push({ toolId: step.actor_id, output: skillGen.data });
          manifestHashes.push(hashFile(skillEntry.path));
          stepTokens = skillGen.tokens;
          usedCapabilities.push({ id: step.actor_id, type: 'skill' });
        } else if (step.actor_type === 'llm') {
          // 中间 LLM 步:基于已累积的 tool/skill 输出产出简洁小结,push 进 toolOutputs 供后续 + synthesis
          const gen = await llm.generateText({
            prompt:
              `你是研究编排中的一步:「${step.step_name}」。${step.purpose ?? ''}\n` +
              `基于已有执行结果(检索数据 + 竞品分析)完成这一步,产出简洁小结;` +
              `凡引用数据的结论标明来源,无据推断需说明。`,
            context: { research_goal: researchGoal, tool_outputs: toolOutputs },
          });
          outputRef = ws.writeToolOutput(step.step_no, { text: gen.text });
          toolOutputs.push({ toolId: step.actor_id, output: { note: gen.text } });
          stepTokens = gen.tokens;
        } else if (step.actor_type === 'reviewer') {
          // reviewer 步:轻量复核——检查来源标注/数据缺口,产出复核意见(只留痕,不改前序产出,不进 toolOutputs)
          const gen = await llm.generateText({
            prompt:
              `你是质量复核者:「${step.step_name}」。审查已有执行结果的来源标注是否完整、` +
              `有无把推断当事实、数据缺口是否说明。产出复核意见,不改写前序结论。`,
            context: { research_goal: researchGoal, tool_outputs: toolOutputs },
          });
          outputRef = ws.writeToolOutput(step.step_no, { review: gen.text });
          stepTokens = gen.tokens;
        }

        await checkpointStore.writeExecutionLog({
          taskId: input.taskId, stepNo: step.step_no, stepName: step.step_name,
          actorType: step.actor_type, actorId: step.actor_id, status: 'succeeded',
          outputRef, startedAt, finishedAt: new Date(),
          tokensJson: stepTokens,
          contextManifestRef: `${ws.uri}/context_manifest.json`,
          decisionGraphHash: graphHash,
          skillManifestHashes: step.actor_type === 'skill' ? manifestHashes : [],
          toolManifestHashes: step.actor_type === 'tool' ? manifestHashes : [],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 失败:标 failed、写 failures.jsonl、停止后续步骤(不整体重跑)
        await checkpointStore.writeExecutionLog({
          taskId: input.taskId, stepNo: step.step_no, stepName: step.step_name,
          actorType: step.actor_type, actorId: step.actor_id, status: 'failed',
          errorJson: { message }, startedAt, finishedAt: new Date(),
          contextManifestRef: `${ws.uri}/context_manifest.json`,
        });
        ws.appendFailure({
          task_id: input.taskId, stage: 'execution',
          selected_skill: step.actor_type === 'skill' ? step.actor_id : undefined,
          selected_tool: step.actor_type === 'tool' ? step.actor_id : undefined,
          error_type: err instanceof Error ? err.name : 'Error',
          error_message: message,
          context_manifest_ref: `${ws.uri}/context_manifest.json`,
        });
        await checkpointStore.updateTaskStatus(input.taskId, 'failed');
        throw new StepFailedError(step.step_no, step.actor_id, message);
      }
    }

    // 段4:synthesis → report → 过 schema → 写 artifact
    // 把段3 真实 tool 输出喂给 LLM,报告据此生成引用真实数据的结论
    const reportGen = await llm.generateStructured<Record<string, unknown>>({
      prompt:
        '基于以下真实执行结果生成可落地竞品研究方案报告。' +
        'findings 中凡来自 tool_outputs 检索数据的结论,source 必须标 tool_result,' +
        '并在 statement 中引用具体竞品名称/来源;无数据支撑的判断标 llm_inference,不得冒充事实;' +
        '若 tool_outputs 为空则如实说明数据缺口。',
      schema: {}, schemaName: 'research-report',
      context: { task_id: input.taskId, research_goal: researchGoal, tool_outputs: toolOutputs },
    });
    const report = { ...reportGen.data, task_id: input.taskId };
    validator.validateOrThrow('research-report', report);

    // synthesis 是 LLM 步,单独记一条 execution_log(落 token/model/prompt_hash 追溯)
    const synthStepNo = plan.steps.length + 1;
    await checkpointStore.writeExecutionLog({
      taskId: input.taskId, stepNo: synthStepNo, stepName: '报告合成', actorType: 'llm',
      actorId: 'synthesis', status: 'succeeded',
      tokensJson: reportGen.tokens,
      promptHash: reportGen.promptHash,
      modelName: reportGen.modelName, modelVersion: reportGen.modelVersion,
      traceId: reportGen.traceId,
      contextManifestRef: `${ws.uri}/context_manifest.json`,
      finishedAt: new Date(),
    });

    const reportPath = ws.writeArtifactFile('report.json', JSON.stringify(report, null, 2));
    const artifact = await checkpointStore.writeArtifact({
      taskId: input.taskId, conversationId: input.conversationId,
      artifactType: 'report', title: '竞品研究方案', storageUri: reportPath,
      contentSummary: (report as { research_goal?: string }).research_goal,
      sourceRefs: usedCapabilities,
    });

    await checkpointStore.updateTaskStatus(input.taskId, 'completed');
    return { reportArtifactId: artifact.id };
  }
}

interface PlanStep {
  step_no: number;
  step_name: string;
  actor_type: 'skill' | 'tool' | 'llm' | 'reviewer';
  actor_id: string;
  purpose?: string;
  input?: Record<string, unknown>;
  requires_approval?: boolean;
}

export class StepFailedError extends Error {
  constructor(public readonly stepNo: number, public readonly actorId: string, message: string) {
    super(`step ${stepNo} (${actorId}) 执行失败: ${message}`);
    this.name = 'StepFailedError';
  }
}

export function buildOrchestrator(overrides = {}): Orchestrator {
  return new Orchestrator(buildRuntime(overrides));
}

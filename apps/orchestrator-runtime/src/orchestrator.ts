import { AgentRuntime, buildRuntime } from './runtime/agent-runtime.ts';
import { RunWorkspace } from './run-workspace.ts';
import { parseDirectInvoke } from './runtime/direct-invoke.ts';
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
import { readFileSync, existsSync } from 'node:fs';
import { searchKnowledge } from './knowledge/index.ts';

// user_research 域 skill 运行时读到的 KB 导航(collection/analysis/models/assets 四区叶子索引)。
// 只喂索引不喂正文——129 篇正文全喂会触发 gateway 超时(见交接文档踩过的坑);
// SKILL.md 里已点出关键方法名,LLM 有导航即可引用具体方法路径,不需要现读全文。
// 只在 skillEntry.domain 含 user_research 时注入,避免污染竞品/设计走查 skill。
let _kbIndexCache: string | null = null;
function loadResearchWikiIndex(): string {
  if (_kbIndexCache !== null) return _kbIndexCache;
  const root = getConfigRoot();
  const parts: string[] = [];
  const indexPaths: Array<[string, string]> = [
    ['methods/toolbox/collection', 'knowledge-base/methods/toolbox/collection/index.md'],
    ['methods/toolbox/analysis',   'knowledge-base/methods/toolbox/analysis/index.md'],
    ['models',                     'knowledge-base/models/index.md'],
    ['assets',                     'knowledge-base/assets/index.md'],
  ];
  for (const [label, rel] of indexPaths) {
    const p = join(root, rel);
    if (existsSync(p)) parts.push(`## ${label}\n\n${readFileSync(p, 'utf8')}`);
  }
  _kbIndexCache = parts.join('\n\n---\n\n');
  return _kbIndexCache;
}

// 引导召回:对每个激活的决策节点,用其 related_tags 从知识库召回方法论/模型(每节点 top-3),
// 供"决策状态判定"与"计划生成"两个 LLM 调用作正典依据,并进 context_manifest 溯源。纯函数,可测。
export interface GuidanceRef {
  node: string;
  id: string;
  title: string;
  summary: string;
  source_path: string;
  content_hash: string;
}

export function retrieveGuidance(nodes: DecisionNode[]): GuidanceRef[] {
  const out: GuidanceRef[] = [];
  for (const n of nodes) {
    const tags = n.related_tags ?? [];
    if (tags.length === 0) continue;
    for (const h of searchKnowledge({ guide_tags: tags, limit: 3 })) {
      out.push({
        node: n.key,
        id: h.id,
        title: h.title,
        summary: h.summary ?? '',
        source_path: h.source_path,
        content_hash: h.content_hash,
      });
    }
  }
  return out;
}

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
  role: string;                 // 图像角色(如 design=主设计稿);同 role 只需上传一次
  label: string;
  multiple: boolean;            // 该 role 是否有 multiple 字段(展示提示用)
  targets: Array<{ step_no: number; tool_id: string; field: string; multiple: boolean }>;
}

// 候选计划:planPhase 一次产 N 份(当前 2 份,depth/speed);用户选中后再 finalize。
export interface PlanCandidate {
  id: 'depth' | 'speed';
  title: string;              // 展示名,如"深度优先方案"
  rationale: string;          // 为什么这样组合(方法论理由)
  tradeoffs: string;          // 明显的代价(耗时长/覆盖窄等)
  steps: PlanStep[];
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
  activated_nodes: string[];
}

export interface PlanResult {
  taskId: string;
  task: ResearchTaskData;
  activatedNodes: string[];
  candidates: PlanCandidate[];   // 用户从中选一;直呼支路也统一走这里(只有 1 个)
  workspaceUri: string;
}

// planPhase 阶段进度事件(SSE 流式用):不传 onProgress 时非流式调用不受影响。
export type PlanPhaseKey = 'understand' | 'activate' | 'guidance' | 'states' | 'candidates' | 'persist';
export interface PlanProgress {
  phase: PlanPhaseKey;
  status: 'start' | 'done';
  label: string;      // 中文阶段名
  detail?: string;    // 简要内容(如 task_type、节点数)
}

// executePhase/resumePhase 阶段进度事件(SSE 流式用):同步回调,事件发出时对应日志/状态已落库。
export interface ExecuteProgress {
  type: 'step_started' | 'step_succeeded' | 'step_failed' | 'step_skipped' | 'synthesis_started' | 'completed' | 'paused' | 'failed';
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'completed' | 'completed_with_gaps' | 'paused';
  stepNo?: number;
  stepName?: string;
  actorType?: PlanStep['actor_type'];
  actorId?: string;
  detail?: string;
}

// selectPlan 返回:选中后 finalize 出的可执行 plan + 该 plan 需要的图像上传项。
export interface SelectResult {
  taskId: string;
  candidateId: PlanCandidate['id'];
  plan: unknown;
  pendingUploads: PendingUpload[];
}

export class Orchestrator {
  constructor(private readonly rt: AgentRuntime) {}

  // ---- 段1 + 段2:理解 → 计划 → 停(HITL 闸门,不执行)----
  // onProgress:可选阶段进度回调(SSE 流式用);不传则非流式,现有调用不受影响。
  async planPhase(input: {
    originalInput: string;
    conversationId: string;
    ownerUserId: string;
  }, onProgress?: (ev: PlanProgress) => void): Promise<PlanResult> {
    const { llm, validator, checkpointStore, skillLoader } = this.rt.deps;
    const emit = onProgress ?? (() => {});

    // $ 直呼:命中则跳过引导循环 + 路由 LLM,确定性产出单步 skill 计划(仍走确认闸门)。
    // 对"参数文字"(rest)做任务理解,无参数时退回 skillName;非直呼时理解原始输入。
    const direct = parseDirectInvoke(input.originalInput);
    const understandInput = direct ? (direct.rest || direct.skillName) : input.originalInput;

    // 段1 任务理解:一句话 → ResearchTask,过 schema
    // task_type 判定带语义引导 + 反"默认竞品"偏置(此前设计走查易被误判为 competitive_research)。
    emit({ phase: 'understand', status: 'start', label: '理解任务需求' });
    const taskGen = await llm.generateStructured<ResearchTaskData>({
      prompt:
        `把用户需求结构化为 ResearchTask。\n` +
        `【task_type 按"用户想做什么"选最贴切的一个,不要默认竞品】:\n` +
        `- design_audit:对已有设计稿/页面/界面做走查·评估·审查(美学/视觉/注意力/品牌一致性/可用性)。信号:"走查/评估设计稿/看这个页面/UI 审查/视觉评估"。\n` +
        `- competitive_research:分析对标竞品、比较各家能力差异。信号:"竞品/对标/各家/横评/差异化"。\n` +
        `- user_research_planning:规划一次用户研究(找谁/用什么方法/问什么)。信号:"规划研究/研究方案/怎么调研/招募"。\n` +
        `- voc_diagnosis:分析用户反馈/评论/舆情。信号:"用户之声/差评/反馈/VOC"。\n` +
        `- a11y_audit:无障碍/可访问性审查。\n` +
        `【硬规则】用户明确说"不做竞品/对设计稿评估"时绝不选 competitive_research;有设计稿评估诉求优先 design_audit。\n` +
        `【缺失信息三级】可假设→assumptions(给默认值);需用户确认→confirmations;涉敏感/合规/授权→blocking_issues。\n` +
        `用户需求:${understandInput}`,
      schema: {},
      schemaName: 'research-task',
      context: { input: understandInput },
    });
    validator.validateOrThrow('research-task', taskGen.data);
    const task = taskGen.data;
    emit({ phase: 'understand', status: 'done', label: '理解任务需求', detail: `${task.task_type} · ${task.business_domain}` });

    const graphHash = hashFile(CONFIG_PATHS.decisionGraph);

    // 两支路统一产出:activated / decisionStates / candidates / planProvenance,落库段共用。
    type DecisionStateRec = { node_key: string; state: string; reason: string; confidence?: number; user_override: unknown; final_state: string };
    let activated: DecisionNode[];
    let decisionStates: DecisionStateRec[];
    let candidates: PlanCandidate[];
    let planProvenance: { modelName: string; modelVersion: string; promptHash: string; traceId: string };
    // 引导召回的知识来源(仅 else 支路;去重后进 context_manifest 溯源)。direct 支路留空。
    let guidanceSources: Array<{ type: 'knowledge'; ref: string; hash: string }> = [];

    if (direct) {
      // 直呼支路:确定性单步计划,不激活决策节点、不判状态、不走路由 LLM。
      // 直呼场景下只产 1 份候选,前端仍走"选中"流程但只有一个选项。
      const skill = skillLoader.getSkill(direct.skillName);
      if (!skill) {
        throw new Error(
          `未知 skill "$${direct.skillName}"。可用 skill: ${skillLoader.listActiveSkills().map((s) => s.id).join(', ')}`,
        );
      }
      activated = [];
      decisionStates = [];
      candidates = [
        {
          id: 'depth',
          title: `直呼 ${skill.name}`,
          rationale: `用户 $ 直呼技能 ${skill.name},跳过路由。`,
          tradeoffs: '仅执行该技能,不做横向对比。',
          steps: [
            {
              step_no: 1,
              step_name: `直呼 ${skill.id}`,
              actor_type: 'skill',
              actor_id: skill.id,
              purpose: `用户 $ 直呼技能 ${skill.name}`,
              input: { research_goal: task.research_goal, brief: direct.rest },
            } as PlanStep,
          ],
          assumptions: task.assumptions ?? [],
          activated_nodes: [],
        },
      ];
      // 直呼无路由 LLM(planGen),provenance 用段1 taskGen 兜底。
      planProvenance = {
        modelName: taskGen.modelName, modelVersion: taskGen.modelVersion,
        promptHash: taskGen.promptHash, traceId: taskGen.traceId,
      };
      emit({ phase: 'candidates', status: 'done', label: '生成候选方案', detail: `直呼 ${direct.skillName}` });
    } else {
      // 段2a 决策节点激活:按 applies_to 过滤(数据驱动,非领域分支)
      const graph = loadDecisionGraph();
      activated = graph.nodes.filter((n) => n.applies_to.includes(task.task_type));
      emit({ phase: 'activate', status: 'done', label: '激活决策节点', detail: `${activated.length} 个 · ${activated.map((n) => n.key).join(' / ')}` });

      // 引导召回:按激活节点的 related_tags 从知识库取方法论,喂给下面两个 LLM 调用作正典依据。
      const guidance = retrieveGuidance(activated);
      guidanceSources = guidance
        .filter((g, i, arr) => arr.findIndex((x) => x.id === g.id) === i) // 按 id 去重
        .map((g) => ({ type: 'knowledge' as const, ref: g.source_path, hash: g.content_hash }));
      emit({ phase: 'guidance', status: 'done', label: '召回方法论知识', detail: `${guidanceSources.length} 条方法卡片` });

      // 段2b 决策状态判定:LLM 对激活节点逐一判 6 态,过 schema
      emit({ phase: 'states', status: 'start', label: '判定节点状态' });
      const statesGen = await llm.generateStructured<DecisionStateRec[]>({
        prompt:
          `对以下激活的决策节点逐一判定状态:${activated.map((n) => n.key).join(', ')}\n` +
          `结合 context.guidance 里按节点召回的用研方法论/模型判断每个节点状态与 reason,引用方法论时点名(如 JTBD/5W2H)。`,
        schema: {},
        schemaName: 'decision-states',
        context: { activated: activated.map((n) => n.key), task, guidance },
      });
      // 只保留本次实际激活的节点状态(防 fixture 含多余节点)
      const activatedKeys = new Set(activated.map((n) => n.key));
      decisionStates = statesGen.data.filter((s) => activatedKeys.has(s.node_key));
      for (const s of decisionStates) validator.validateOrThrow('decision-state', s);
      emit({ phase: 'states', status: 'done', label: '判定节点状态', detail: `${decisionStates.length} 个节点已判定` });

      // 段2c 能力路由 + 候选计划生成:一次 LLM 产出 2 份候选(depth / speed)。
      // depth = 覆盖广、有交叉验证/复核,步骤数偏多;speed = 最短路径拿关键结论,可略过 reviewer/合成型 LLM 步。
      // 两份候选应有明显 skill/tool 差异,不能只是同一计划步骤数缩水。
      emit({ phase: 'candidates', status: 'start', label: '生成候选方案' });
      // 按 task_type 数据驱动预筛能力池,收敛候选发散(不写场景特判):
      // 保留 domain 命中 task_type 或 cross_cutting 的 skill,再保留这些 skill 的 required_tools 覆盖的 tool。
      // 预筛为空(未知 task_type)则回退全集,不破坏原路径。
      const allSkills = skillLoader.listActiveSkills();
      const allTools = skillLoader.listActiveTools();
      const relevantSkills = allSkills.filter(
        (s) => (s.domain ?? []).includes(task.task_type) || (s.domain ?? []).includes('cross_cutting'),
      );
      const activeSkills = relevantSkills.length > 0 ? relevantSkills : allSkills;
      const neededTools = new Set(activeSkills.flatMap((s) => s.required_tools ?? []));
      const relevantTools = allTools.filter((t) => neededTools.has(t.id));
      const activeTools = relevantTools.length > 0 ? relevantTools : allTools;
      const skillIds = activeSkills.map((s) => s.id);
      const toolIds = activeTools.map((t) => t.id);
      const toolCtx = activeTools.map((t) => {
        const manifest = loadToolManifest(t.path);
        return { id: t.id, name: t.name, input_schema: loadToolInputSchema(manifest.input_schema) };
      });
      const planGen = await llm.generateStructured<{ candidates: Array<Omit<PlanCandidate, 'activated_nodes'>> }>({
        prompt:
          `基于任务与候选能力,生成 2 份"待用户挑选"的执行计划候选,分别对应 depth 与 speed 两种取向。\n` +
          `硬约束:\n` +
          `- 顶层结构 { candidates: [ {id, title, rationale, tradeoffs, steps, assumptions}, ... ] },且必须恰好 2 项。\n` +
          `- 每个 step 必须含字段:step_no(从 1 递增的整数)、step_name(该步中文简述)、actor_type、actor_id;可选 purpose/input/requires_approval。禁止用 step_id,禁止省略 step_no 或 step_name。\n` +
          `- 第 1 项 id="depth"(深度优先:方法论完整、覆盖广、含复核/交叉验证),第 2 项 id="speed"(速度优先:最短路径拿关键结论)。\n` +
          `- 两份 steps 必须在 skill/tool 组合上存在明显差异(不同能力或不同顺序),不允许只是 speed 版把 depth 版删几行。\n` +
          `- actor_type=skill 步的 actor_id 只能取:[${skillIds.join(', ')}];actor_type=tool 步的 actor_id 只能取:[${toolIds.join(', ')}];禁止编造清单外 id。\n` +
          `- 若需 LLM 自身推理步骤(汇总/提炼)用 actor_type=llm;质量复核用 actor_type=reviewer。\n` +
          `- tool 步必须在 step.input 里按该 tool 的 input_schema(见 context.tools[].input_schema)生成入参;无图字段留空,并在 assumptions 标注『需用户提供设计稿』。\n` +
          `- rationale(为什么这样组合,引用方法论点名如 JTBD/5W2H)与 tradeoffs(明显代价,如"耗时约翻倍"/"覆盖窄可能漏点")必填,各控制在 1-2 句。\n` +
          `- title 用中文短语,例如"深度优先·方法论覆盖" / "速度优先·关键结论"。\n` +
          `选方法/排步骤时参考 context.guidance 召回的方法卡片,使方法选择有正典依据。`,
        schema: {},
        schemaName: 'execution-plan-candidates',
        context: {
          task,
          skills: activeSkills.map((s) => ({ id: s.id, when_to_use: s.when_to_use, required_tools: s.required_tools })),
          tools: toolCtx,
          guidance,
        },
      });
      // 严格取 2 份;LLM 极端情况下产出 0/1/3+ 时兜底(截取前 2 或补空报错)。
      const raw = Array.isArray(planGen.data.candidates) ? planGen.data.candidates : [];
      if (raw.length < 2) {
        throw new Error(`候选计划生成失败:期望 2 份,实际 ${raw.length} 份`);
      }
      const activatedNodeKeys = activated.map((n) => n.key);
      candidates = raw.slice(0, 2).map((c, i) => ({
        id: (c.id === 'speed' || c.id === 'depth' ? c.id : i === 0 ? 'depth' : 'speed') as PlanCandidate['id'],
        title: c.title || (i === 0 ? '深度优先方案' : '速度优先方案'),
        rationale: c.rationale ?? '',
        tradeoffs: c.tradeoffs ?? '',
        steps: c.steps ?? [],
        assumptions: c.assumptions ?? task.assumptions ?? [],
        activated_nodes: activatedNodeKeys,
      }));
      // 幻觉能力校验:每份候选独立过一遍
      for (const cand of candidates) {
        const bad = cand.steps.filter((s) => {
          if (s.actor_type === 'skill') return !skillLoader.getSkill(s.actor_id);
          if (s.actor_type === 'tool') return !skillLoader.getTool(s.actor_id);
          return false;
        });
        if (bad.length > 0) {
          throw new Error(
            `候选 ${cand.id} 包含 registry 中不存在的能力(疑似 LLM 幻觉): ` +
              bad.map((s) => `${s.actor_type}:${s.actor_id}`).join(', '),
          );
        }
      }
      planProvenance = {
        modelName: planGen.modelName, modelVersion: planGen.modelVersion,
        promptHash: planGen.promptHash, traceId: planGen.traceId,
      };
      emit({ phase: 'candidates', status: 'done', label: '生成候选方案', detail: `${candidates.length} 份 · ${candidates.map((c) => c.id).join(' / ')}` });
    }

    // 落库:研究任务
    emit({ phase: 'persist', status: 'start', label: '归档计划' });
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
    ws.writeContextManifest({
      run_id: taskRow.id,
      stage: 'planning',
      loaded_sources: [
        { type: 'research_task', ref: `research_tasks.${taskRow.id}` },
        { type: 'registry', ref: 'orchestrator/skill-registry.yaml', hash: hashFile(CONFIG_PATHS.skillRegistry) },
        { type: 'decision_graph', ref: 'orchestrator/decision-graph.yaml', hash: graphHash },
        ...guidanceSources,
      ],
      model_name: planProvenance.modelName,
      model_version: planProvenance.modelVersion,
      prompt_hash: planProvenance.promptHash,
      trace_id: planProvenance.traceId,
    });

    // 更新状态:候选已生成,等用户选一份
    await checkpointStore.updateTaskStatus(taskRow.id, 'planned', 'awaiting_selection');
    emit({ phase: 'persist', status: 'done', label: '归档计划', detail: '候选已就绪' });

    void workspace; // 占位变量清理
    return {
      taskId: taskRow.id,
      task,
      activatedNodes: activated.map((n) => n.key),
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

    // 组装 plan(与旧 execution-plan schema 同形)。
    // 候选生成时 schema:{} 不严格校验,真实 LLM 常给 step 用 step_id/漏 step_name/多塞字段;
    // 这里按 execution-plan schema 白名单清洗并兜底:step_no 一律用数组顺序(不信 LLM 编号),
    // step_name 缺失用 actor_id 兜底,丢弃 step_id 等非法字段,避免 additionalProperties:false 校验失败。
    const taskRow = await checkpointStore.getTask(input.taskId);
    const taskType = taskRow?.task_type ?? '';
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v);
    const cleanStep = (s: PlanStep, i: number): PlanStep => ({
      step_no: i + 1,
      step_name: s.step_name || s.actor_id || `步骤 ${i + 1}`,
      actor_type: s.actor_type,
      // llm/reviewer 步 LLM 常不给 actor_id,兜底用 actor_type 名(如 "llm" / "reviewer");skill/tool 必须有真实 id
      actor_id: s.actor_id || (s.actor_type === 'llm' ? 'llm' : s.actor_type === 'reviewer' ? 'reviewer' : `unknown-${i + 1}`),
      ...(typeof s.purpose === 'string' ? { purpose: s.purpose } : {}),
      ...(isPlainObject(s.input) ? { input: s.input } : {}),   // 非纯对象(字符串/数组/null)丢弃,执行时回落 {query}
      ...(typeof s.requires_approval === 'boolean' ? { requires_approval: s.requires_approval } : {}),
    });
    const cleanAssumption = (a: unknown, i: number): { key: string; value: string; editable: boolean } => {
      if (typeof a === 'string') return { key: `假设 ${i + 1}`, value: a, editable: true };
      const o = (a ?? {}) as { key?: string; value?: string; editable?: boolean; name?: string; description?: string; assumption?: string };
      return {
        key: o.key ?? o.name ?? `假设 ${i + 1}`,
        value: o.value ?? o.description ?? o.assumption ?? JSON.stringify(a),
        editable: o.editable ?? true,
      };
    };
    const plan = {
      task_id: input.taskId,
      task_type: taskType,
      steps: cand.steps.map(cleanStep),
      activated_nodes: cand.activated_nodes,
      assumptions: (cand.assumptions ?? []).map(cleanAssumption),
    };
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
  async executePhase(input: { taskId: string; conversationId: string; uploads?: Array<{ role: string; dataUrl: string }> }, onProgress?: (ev: ExecuteProgress) => void): Promise<ExecuteResult> {
    const { checkpointStore } = this.rt.deps;
    const ws = new RunWorkspace(input.taskId);
    const plan = ws.readPlan<{ steps: PlanStep[]; task_id: string }>();
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
    return this.runFrom(0, ctx, onProgress);
  }

  // ---- resume:失败步 skip(续跑) / abort(收尾)----
  async resumePhase(input: { taskId: string; conversationId: string; action: 'skip' | 'abort' }, onProgress?: (ev: ExecuteProgress) => void): Promise<ExecuteResult> {
    const { checkpointStore } = this.rt.deps;
    const ws = new RunWorkspace(input.taskId);
    const state = ws.readRunState<RunState>();

    if (input.action === 'abort') {
      await checkpointStore.updateTaskStatus(input.taskId, 'failed');
      const result: ExecuteResult = { status: 'failed', failedStepNo: state.failedStepNo, failedStepName: state.failedStepName };
      onProgress?.({ type: 'failed', status: 'failed', stepNo: state.failedStepNo, stepName: state.failedStepName, actorType: state.failedActorType, actorId: state.failedActorId });
      return result;
    }

    // skip:失败步标 skipped,从各步已落盘 output 重建 toolOutputs,从下一步续跑。
    const plan = ws.readPlan<{ steps: PlanStep[]; task_id: string }>();
    const taskRow = await checkpointStore.getTask(input.taskId);
    const researchGoal =
      (taskRow?.structured_task as { research_goal?: string } | undefined)?.research_goal ??
      taskRow?.original_input ?? '';

    await checkpointStore.writeExecutionLog({
      taskId: input.taskId, stepNo: state.failedStepNo, stepName: state.failedStepName,
      actorType: state.failedActorType, actorId: state.failedActorId, status: 'skipped',
      finishedAt: new Date(), decisionGraphHash: hashFile(CONFIG_PATHS.decisionGraph),
    });
    onProgress?.({
      type: 'step_skipped', status: 'skipped', stepNo: state.failedStepNo, stepName: state.failedStepName,
      actorType: state.failedActorType, actorId: state.failedActorId,
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
    return this.runFrom(failedIdx + 1, ctx, onProgress);
  }

  // 从 startIdx 顺序执行剩余步:遇失败停在该步(paused + 落 run_state);全过 → finalizeReport。
  private async runFrom(startIdx: number, ctx: ExecCtx, onProgress?: (ev: ExecuteProgress) => void): Promise<ExecuteResult> {
    const { checkpointStore } = this.rt.deps;
    for (let i = startIdx; i < ctx.plan.steps.length; i++) {
      const step = ctx.plan.steps[i];
      try {
        await this.runStep(step, ctx, onProgress);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 失败:标 failed、写 failures.jsonl、停在该步(不整体崩、不重跑)
        await checkpointStore.writeExecutionLog({
          taskId: ctx.taskId, stepNo: step.step_no, stepName: step.step_name,
          actorType: step.actor_type, actorId: step.actor_id, status: 'failed',
          errorJson: { message }, finishedAt: new Date(),
          contextManifestRef: `${ctx.ws.uri}/context_manifest.json`,
        });
        onProgress?.({
          type: 'step_failed', status: 'failed', stepNo: step.step_no, stepName: step.step_name,
          actorType: step.actor_type, actorId: step.actor_id, detail: message,
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
        const result: ExecuteResult = { status: 'paused', failedStepNo: step.step_no, failedStepName: step.step_name };
        onProgress?.({
          type: 'paused', status: 'paused', stepNo: step.step_no, stepName: step.step_name,
          actorType: step.actor_type, actorId: step.actor_id, detail: message,
        });
        return result;
      }
    }
    return this.finalizeReport(ctx, onProgress);
  }

  // 单步执行:成功则写 execution_log(succeeded) 并累积产出;失败 throw(由 runFrom 处理)。
  private async runStep(step: PlanStep, ctx: ExecCtx, onProgress?: (ev: ExecuteProgress) => void): Promise<void> {
    const { llm, validator, skillLoader, toolAdapter, checkpointStore } = this.rt.deps;
    const startedAt = new Date();
    await checkpointStore.writeExecutionLog({
      taskId: ctx.taskId, stepNo: step.step_no, stepName: step.step_name,
      actorType: step.actor_type, actorId: step.actor_id, status: 'running',
      startedAt, decisionGraphHash: ctx.graphHash,
    });
    onProgress?.({
      type: 'step_started', status: 'running', stepNo: step.step_no, stepName: step.step_name,
      actorType: step.actor_type, actorId: step.actor_id,
    });

    let outputRef: string | undefined;
    const manifestHashes: string[] = [];
    let stepTokens: { prompt: number; completion: number; total: number } | undefined;

    if (step.actor_type === 'tool') {
      const tool = skillLoader.getTool(step.actor_id);
      if (!tool) throw new Error(`tool 非 active 或不存在: ${step.actor_id}`);
      const manifest = loadToolManifest(tool.path);
      // 入参:优先用计划里 LLM 生成的 step.input;缺省回落 {query}(兼容 o2/ai-spider 检索类)。
      const toolInput: Record<string, unknown> = { ...(step.input ?? { query: ctx.researchGoal || '直播 数字人 竞品' }) };
      // 回填用户在确认闸门上传的图:按字段 role 匹配上传项(同 role 一次上传回填到所有步骤)。
      for (const f of manifest.image_input_fields ?? []) {
        const up = (ctx.uploads ?? []).find((u) => u.role === (f.role ?? f.field));
        if (up) toolInput[f.field] = f.multiple ? [{ dataUrl: up.dataUrl }] : { dataUrl: up.dataUrl };
      }
      // 清理 LLM 生成的空占位:①空对象 ②数组内空对象 ③"字段全空"的假对象(键有值全为 ""/null/undefined)。
      // 场景:LLM 常生成 `{id:"",fileName:"",path:"",url:"",dataUrl:""}` 这种"看起来是图对象、其实字段全空"的假图,
      // 服务端会当真图解码而 throw。清理后无图字段缺省,工具按无图优雅降级(返回 insufficient_inputs 等)。
      const isBlank = (v: unknown): boolean =>
        v === null || v === undefined || (typeof v === 'string' && v === '');
      const isEmptyLikeObject = (v: unknown): boolean => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const entries = Object.entries(v as Record<string, unknown>);
        return entries.length === 0 || entries.every(([, val]) => isBlank(val));
      };
      for (const k of Object.keys(toolInput)) {
        const v = toolInput[k];
        if (Array.isArray(v)) {
          const filtered = v.filter((e) => !isEmptyLikeObject(e));
          if (filtered.length === 0) delete toolInput[k];
          else toolInput[k] = filtered;
        } else if (isEmptyLikeObject(v)) {
          delete toolInput[k];
        }
      }
      // 调用前按该 tool 的 input.schema 校验:非法入参在计划质量层拦下,不打到工具。
      validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
      const res = await toolAdapter.invoke({ toolId: step.actor_id, input: toolInput, manifest });
      const outSchemaPath = join(getConfigRoot(), manifest.output_schema);
      validator.validateFileOrThrow(outSchemaPath, res.output);
      outputRef = ctx.ws.writeToolOutput(step.step_no, res.output);
      ctx.toolOutputs.push({ toolId: step.actor_id, output: res.output });
      ctx.toolOutputRefs.push({ stepNo: step.step_no, toolId: step.actor_id });
      manifestHashes.push(hashFile(tool.path));
      ctx.usedCapabilities.push({ id: step.actor_id, type: 'tool' });
    } else if (step.actor_type === 'skill') {
      // skill 真执行:加载 SKILL.md 全文 + output schema,调 LLM 按工作流基于已有 tool 输出产出结构化结果。
      const skillEntry = skillLoader.getSkill(step.actor_id);
      if (!skillEntry) throw new Error(`skill 非 active 或不存在: ${step.actor_id}`);
      const { body, hash: skillManifestHash } = skillLoader.loadSkillBody(step.actor_id);
      const { output } = skillLoader.loadSkillSchemas(step.actor_id);
      // user_materials 预处理:text 类 dataUrl 解码成明文(LLM 直读,省推理时间);image/pdf 保留 dataUrl。
      // 避免把 base64 直接喂 LLM——它得先解码再理解,浪费 token 且触发 gateway 超时。
      const decodedMaterials = (ctx.uploads ?? []).map((u) => {
        if (!u.dataUrl) return { role: u.role };
        const mimeMatch = u.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!mimeMatch) return { role: u.role, dataUrl: u.dataUrl };
        const [, mime, b64] = mimeMatch;
        // text/plain / text/markdown / application/json 等文本类 → 解成明文
        if (mime.startsWith('text/') || mime === 'application/json') {
          try { return { role: u.role, mime, text: Buffer.from(b64, 'base64').toString('utf8') }; }
          catch { return { role: u.role, dataUrl: u.dataUrl }; }
        }
        // 图片/PDF/其它二进制:保留 dataUrl 让 skill/VLM 自行处理
        return { role: u.role, mime, dataUrl: u.dataUrl };
      });
      const skillGen = await llm.generateStructured<object>({
        prompt:
          `你是「${skillEntry.name}」能力。严格按以下 SKILL.md 的工作流与质量门禁执行,` +
          `基于提供的检索数据(tool_outputs)与用户上传资料(user_materials)产出结构化结果;` +
          `user_materials 是用户在确认闸门附上的原始素材(按 role 归类,text 字段是明文,dataUrl 是图片/PDF 的 base64),` +
          `凡引用其内容需明确来源;无数据支撑的判断标 llm_inference,不得冒充事实。` +
          ((skillEntry.domain ?? []).includes('user_research')
            ? `\n\ncontext.research_wiki_index 是用研知识库(research-wiki)的方法/模型/素材导航;` +
              `SKILL.md 中提到的"实时调用 research-wiki 里的 XX 方法/模型"就是查这个索引,` +
              `引用某方法时请写清其名称与相对路径(如 knowledge-base/methods/toolbox/collection/deep-interview.md),` +
              `不要凭记忆虚构方法名。`
            : '') +
          `\n\n${body}`,
        schema: output ?? {},
        schemaName: `skill:${step.actor_id}`,
        context: {
          research_goal: ctx.researchGoal,
          tool_outputs: ctx.toolOutputs,
          user_materials: decodedMaterials,
          ...((skillEntry.domain ?? []).includes('user_research')
            ? { research_wiki_index: loadResearchWikiIndex() }
            : {}),
        },
      });
      if (skillEntry.output_schema) {
        validator.validateFileOrThrow(join(getConfigRoot(), skillEntry.output_schema), skillGen.data);
      }
      outputRef = ctx.ws.writeToolOutput(step.step_no, skillGen.data);
      ctx.toolOutputs.push({ toolId: step.actor_id, output: skillGen.data });
      ctx.toolOutputRefs.push({ stepNo: step.step_no, toolId: step.actor_id });
      manifestHashes.push(skillManifestHash);
      stepTokens = skillGen.tokens;
      ctx.usedCapabilities.push({ id: step.actor_id, type: 'skill' });
    } else if (step.actor_type === 'llm') {
      // 中间 LLM 步:基于已累积输出产出简洁小结,push 进 toolOutputs 供后续 + synthesis
      const gen = await llm.generateText({
        prompt:
          `你是研究编排中的一步:「${step.step_name}」。${step.purpose ?? ''}\n` +
          `基于已有执行结果(检索数据 + 竞品分析)完成这一步,产出简洁小结;` +
          `凡引用数据的结论标明来源,无据推断需说明。`,
        context: { research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs },
      });
      // 落盘与内存保持同一结构(供 resume 重建一致)
      const out = { note: gen.text };
      outputRef = ctx.ws.writeToolOutput(step.step_no, out);
      ctx.toolOutputs.push({ toolId: step.actor_id, output: out });
      ctx.toolOutputRefs.push({ stepNo: step.step_no, toolId: step.actor_id });
      stepTokens = gen.tokens;
    } else if (step.actor_type === 'reviewer') {
      // reviewer 步:轻量复核,收进 reviewNotes 供 synthesis(不改前序产出,不进 toolOutputs)
      const gen = await llm.generateText({
        prompt:
          `你是质量复核者:「${step.step_name}」。审查已有执行结果的来源标注是否完整、` +
          `有无把推断当事实、数据缺口是否说明。产出复核意见,不改写前序结论。`,
        context: { research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs },
      });
      outputRef = ctx.ws.writeToolOutput(step.step_no, { review: gen.text });
      ctx.reviewNotes.push(gen.text);
      stepTokens = gen.tokens;
    }

    await checkpointStore.writeExecutionLog({
      taskId: ctx.taskId, stepNo: step.step_no, stepName: step.step_name,
      actorType: step.actor_type, actorId: step.actor_id, status: 'succeeded',
      outputRef, startedAt, finishedAt: new Date(),
      tokensJson: stepTokens,
      contextManifestRef: `${ctx.ws.uri}/context_manifest.json`,
      decisionGraphHash: ctx.graphHash,
      skillManifestHashes: step.actor_type === 'skill' ? manifestHashes : [],
      toolManifestHashes: step.actor_type === 'tool' ? manifestHashes : [],
    });
    onProgress?.({
      type: 'step_succeeded', status: 'succeeded', stepNo: step.step_no, stepName: step.step_name,
      actorType: step.actor_type, actorId: step.actor_id,
    });
  }

  // 段4:synthesis → report → 过 schema → 写 artifact。失败/跳过步的缺口 + 复核意见注入 prompt。
  private async finalizeReport(ctx: ExecCtx, onProgress?: (ev: ExecuteProgress) => void): Promise<ExecuteResult> {
    const { llm, validator, checkpointStore } = this.rt.deps;

    // 数据闸门:无任何成功产出则不硬合成(research-report.findings minItems:1,空数据合不出合法报告)。
    if (ctx.toolOutputs.length === 0) {
      await checkpointStore.updateTaskStatus(ctx.taskId, 'failed');
      throw new AllStepsFailedError(ctx.stepFailures);
    }

    onProgress?.({ type: 'synthesis_started', status: 'running', stepName: '报告合成', actorType: 'llm', actorId: 'synthesis' });

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
        '基于以下真实执行结果生成可落地竞品研究方案报告。' +
        'findings 中凡来自 tool_outputs 检索数据的结论,source 必须标 tool_result,' +
        '并在 statement 中引用具体竞品名称/来源;无数据支撑的判断标 llm_inference,不得冒充事实;' +
        '若 tool_outputs 为空则如实说明数据缺口。' +
        gapNote + reviewNote,
      schema: {}, schemaName: 'research-report',
      context: {
        task_id: ctx.taskId, research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs,
        step_failures: ctx.stepFailures, review_notes: ctx.reviewNotes,
        // synthesis 只需知道"用户提供了什么类型的资料",完整 dataUrl 已被 skill/tool 消费,无需重传省 context
        user_materials_summary: (ctx.uploads ?? []).map((u) => ({
          role: u.role,
          has_data: !!u.dataUrl,
          data_size: u.dataUrl?.length ?? 0,
        })),
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
    const result: ExecuteResult = { status, reportArtifactId: artifact.id, gapCount };
    onProgress?.({ type: 'completed', status, detail: artifact.id });
    return result;
  }
}

// 执行累积上下文:execute 与 resume 共用,携带跨步的产出/缺口/复核/溯源。
interface ExecCtx {
  taskId: string;
  conversationId: string;
  researchGoal: string;
  ws: RunWorkspace;
  plan: { steps: PlanStep[]; task_id: string };
  graphHash: string;
  uploads?: Array<{ role: string; dataUrl: string }>;
  toolOutputs: Array<{ toolId: string; output: unknown }>;
  reviewNotes: string[];
  stepFailures: StepFailure[];
  usedCapabilities: Array<{ id: string; type: string }>;
  toolOutputRefs: Array<{ stepNo: number; toolId: string }>;
}

interface StepFailure {
  stepNo: number;
  stepName: string;
  actorType: PlanStep['actor_type'];
  actorId: string;
  message: string;
}

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

// executePhase / resumePhase 的返回:paused=停在失败步待用户决策;completed_with_gaps=有缺口但已合成。
export interface ExecuteResult {
  status: 'completed' | 'completed_with_gaps' | 'paused' | 'failed';
  reportArtifactId?: string;
  failedStepNo?: number;
  failedStepName?: string;
  gapCount?: number;
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ReportEditorialBlueprintV1,
  ReportEditorialCopySelectionV2,
  ReportEditorialIntentV1,
  ReportEditorialMaterialV1,
  ReportEditorialPlannerInputV1,
  ReportEditorialPlannerPresentationUnitV1,
  ReportEditorialPresentationUnitV1,
  ReportPresentationV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import type {
  EditorialPresentationSpecV1,
  ReportEditorialIntentV2,
} from '../../../../packages/api-contract/report-editorial-showcase.ts';
import type { LayoutFallbackReasonCode } from '../../../../packages/api-contract/report-package.ts';
import {
  assertReportEditorialBlueprintIntegrity,
  assertReportEditorialMaterialIntegrity,
  reportEditorialRequiredVisibilityForUnit,
  reportEditorialViewForUnit,
} from '../../../../packages/report-rendering/report-editorial-validation.ts';
import type {
  LLMClient,
  LLMResult,
  LLMProviderIdentity,
  TokenUsage,
} from '../runtime/llm-client.ts';
import { LLMInvocationError } from '../runtime/llm-client.ts';
import {
  MissingModelReceiptError,
  ModelDriftError,
} from '../runtime/receipt-llm-client.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';
import { SchemaValidator } from '../schema/validator.ts';
import {
  createDeterministicReportEditorialBlueprintV1,
  type DeterministicEditorialBlueprintOptions,
} from './report-editorial-blueprint.ts';
import {
  REPORT_EDITORIAL_COPY_MAX_CHARS_V2,
  validateReportEditorialCopyFragmentsV2,
} from './report-editorial-copy-validator.ts';
import {
  compileReportEditorialIntent,
  createDeterministicReportEditorialIntentCompilation,
  type IntentCompilerDiagnostics,
} from './report-editorial-intent-compiler.ts';
import {
  compileEditorialShowcase,
  createDeterministicEditorialShowcaseSpec,
} from './report-editorial-showcase-compiler.ts';
import {
  deriveEditorialPlacementPolicy,
} from './report-editorial-placement-policy.ts';

const BLUEPRINT_SCHEMA_PATH = 'schemas/report-editorial-blueprint-v1.schema.json';
const EDITORIAL_INTENT_V1_SCHEMA_PATH = 'schemas/report-editorial-intent-v1.schema.json';
const EDITORIAL_INTENT_V2_SCHEMA_PATH = 'schemas/report-editorial-intent-v2.schema.json';

export const REPORT_EDITORIAL_PLANNER_LIMITS = {
  serializedInputBytes: 512 * 1024,
  presentationUnits: 500,
  leafUnits: 5_000,
  promptTokens: 64_000,
  outputBytes: 64 * 1024,
} as const;

export const REPORT_EDITORIAL_PLANNER_PROMPT = [
  '你是一名专业的报告编辑与信息架构师。',
  '',
  '你的任务是把系统提供的、已经审校的 Canonical 报告材料组织成更易读、逻辑更清楚、结构更明确的报告蓝图。你可以根据材料性质和分析目标选择章节顺序、分组、信息层级、受控标题模式，以及系统允许的表格、结构图、优先级看板、卡片网格、阶段流或正文形式。',
  '',
  '你不得输出可见标题、字段标签、正文、摘要或 DOM ID；不得创建或修改任何 ID，只能把输入提供的 presentation-unit ID 原样写入 unitRefs；不得改写、总结、补全或创造任何事实性内容；不得新增数字、关系、结论、行动、证据或来源；不得修正看似错误的 Evidence 绑定。所有可见内容必须由系统通过 unitRefs 从输入材料中确定性生成。',
  '',
  '每个 presentation unit 必须恰好有一个主归属。核心结论、关键行动和关键风险必须默认可见；Evidence、provenance 与方法信息可以折叠，但 requested_artifact_binding 不能放入 appendix。没有明确结构或数据时使用正文或列表，不得为了视觉效果猜测表格字段、流程关系、阶段或图表数值。只有明确 priority 时才能使用优先级看板；只有 records shape 才能使用 card-grid；只有 stages shape 才能使用 stage-flow。本合同不支持 lanes 或指标组。',
  '',
  '输入中每个 unit 的 requiredView、requiredVisibility 与 allowedPresentations 都是硬约束：Section.view 必须等于 requiredView，presentation 必须来自 allowedPresentations；requiredVisibility 为 always 时不得折叠。answer、paragraph、fact、graph、card-grid、stage-flow、image、image-comparison、chart 每个 Block 只能引用一个 unit；graph 还必须给出 variant。list、record-table、priority-board 可以引用多个兼容 unit，但 record-table 不得混合 source shape，matrix/chart 的 record-table 仍只能引用一个 unit。',
  '',
  '只返回符合 report-editorial-blueprint-v1 Schema 的 JSON，不要返回 HTML、Markdown、CSS、JavaScript 或额外说明。',
].join('\n');

/** Legacy Plan-v2 prompt retained for compatibility tests; plan() no longer selects it. */
export const REPORT_EDITORIAL_PLANNER_V2_PROMPT = [
  '你是一名专业的报告编辑与信息架构师。',
  '',
  '请在一次结构化输出中完成两件事：先生成完整的 report-editorial-blueprint-v1；再按需生成报告标题、执行摘要、章节标题、章节导语、相邻章节过渡语和 Block 摘要。目标是在不修改原资料内容和意思的前提下，提高报告的可读性、条理和结构感。',
  '',
  'Blueprint 规则与 v1 相同：不得创建或修改任何 presentation-unit ID；每个 unit 必须恰好有一个主归属；Section.view、Block.visibility 和 presentation 必须服从输入中的 requiredView、requiredVisibility 与 allowedPresentations。核心结论、关键行动和关键风险默认可见；没有明确数据或关系时不得猜测表格、流程或图表。',
  '',
  '输出前做机械自检：unitRefs 的 ID 集必须与输入 presentationUnits 的 ID 集完全相同，每个 ID 恰好出现一次。只有 requiredView 与 requiredVisibility 都相同的 unit 才能合并到同一 Block；不同值必须拆开。Section.view 必须匹配其中所有 unit 的 requiredView，Block.visibility 必须匹配其中所有 unit 的 requiredVisibility；包含 requested_artifact_binding 的 Section.prominence 不能是 appendix。无法安全合并时，每个 unit 单独生成一个 Block，不得遗漏、重复或跨 view 放置。',
  '',
  'copyFragments 是可选增强，可以为空。每个 fragment 必须包含 target、纯文本 text 和非空 sourceLeafIds。只能引用输入中真实存在、且属于目标范围的 leaf ID：section_title 与 section_lead 仅能引用本节；section_transition 仅能引用本节和下一节；block_digest 仅能引用本 Block；report_title 与 executive_summary 仅能引用 primary Section。sectionIndex、blockIndex 均从 0 开始，section_transition 的 sectionIndex 指向前一节。每个 target 最多输出一个 fragment。',
  '',
  `字符上限：report_title ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.report_title}；executive_summary ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.executive_summary}；section_title ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.section_title}；section_lead ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.section_lead}；section_transition ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.section_transition}；block_digest ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.block_digest}。`,
  '',
  'Copy 可以压缩和重组表达，但不得修改 Canonical unit，不得增加原引用 leaf 中不存在的事实、数字、日期、金额、比例、P0/P1/P2/P3、Evidence ID 或 URL，不得改变状态、范围、因果、优先级和证据含义。不要输出 HTML、Markdown、CSS、JavaScript 或额外说明。',
  '',
  '只返回符合 report-editorial-plan-v2 Schema 的 JSON。',
].join('\n');

export const REPORT_EDITORIAL_INTENT_V1_PROMPT = [
  '你是一名专业的报告编辑与信息架构师。',
  '',
  '你的任务是从系统提供的已审校 Canonical 报告材料中，选择主报告应呈现的内容，并生成受控标题、摘要、导语和过渡文案。你不需要把所有材料都放入主报告——未选择的内容会由系统自动归入完整分析附件，不会丢失。',
  '',
  '主报告应该：先回答问题，再呈现关键分析、机会和行动。大量 Evidence、风险、局限和审计信息可以留给附件。有明确数据结构时优先使用表格、图、卡片、阶段流或优先级看板；没有结构时使用正文或列表。',
  '',
  '你不得创建或修改任何 presentation-unit ID，只能把输入提供的 ID 原样写入 unitRefs。不得改写、总结、补全或创造任何事实性内容；不得新增数字、关系、结论、行动、证据或来源。所有可见内容必须由系统通过 unitRefs 从输入材料中确定性生成。',
  '',
  '输入中每个 unit 的 requiredView、requiredVisibility 与 allowedPresentations 都是硬约束：Section.view 必须等于 requiredView，presentation 必须来自 allowedPresentations；requiredVisibility 为 always 时不得折叠。answer、paragraph、fact、graph、card-grid、stage-flow、image、image-comparison、chart 每个 Block 只能引用一个 unit；graph 还必须给出 variant。list、record-table、priority-board 可以引用多个兼容 unit。',
  '',
  'placementPolicy 是系统确定性派生的放置策略，你只能读取不能覆盖：mandatoryBodyUnitIds 必须出现在 primary section；systemSupportingUnitIds 必须出现在 supporting section，不能提升为 primary 也不能放入 appendix。mainCoverageGroups 中每组至少选择一个 unit 放入 primary。',
  '',
  'mainSections 只描述主报告（primary）和必要 supporting，prominence 只能是 primary 或 supporting。未引用的 unit 会自动进入 appendix。允许只引用 Material 的一部分 unit。',
  '',
  'copyFragments 是 soft-required：report_title 和 executive_summary 必须生成；每个非 appendix section 的 section_title 必须生成；primary section 的 section_lead 建议生成；section_transition 和 block_digest 可选。缺失时系统会使用 Canonical 标题和摘要，并显示 copy_fallback 提示。',
  '',
  `字符上限：report_title ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.report_title}；executive_summary ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.executive_summary}；section_title ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.section_title}；section_lead ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.section_lead}；section_transition ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.section_transition}；block_digest ${REPORT_EDITORIAL_COPY_MAX_CHARS_V2.block_digest}。`,
  '',
  'Copy 可以压缩和重组表达，但不得修改 Canonical unit，不得增加原引用 leaf 中不存在的事实、数字、日期、金额、比例、P0/P1/P2/P3、Evidence ID 或 URL，不得改变状态、范围、因果、优先级和证据含义。不要输出 HTML、Markdown、CSS、JavaScript 或额外说明。',
  '',
  '只返回符合 report-editorial-intent-v1 Schema 的 JSON。',
].join('\n');

export const REPORT_EDITORIAL_INTENT_V2_PROMPT = [
  REPORT_EDITORIAL_INTENT_V1_PROMPT.replace(
    '\n只返回符合 report-editorial-intent-v1 Schema 的 JSON。',
    '',
  ),
  '',
  '同时输出 showcase。showcase 只描述桌面 Editorial Showcase 的内容选择与组合，不输出 HTML、CSS、JavaScript、SVG、Canvas 或图片。profileId 固定为 editorial-showcase-v1。',
  '',
  'Showcase 不是固定模板：章节 purpose、layout、组件 kind、variant、emphasis 和 span 应根据 Material 的真实 semanticKind 与 shape 选择。不同内容应产生不同的有序组件组合。不得为了丰富度强行创建不合格组件。',
  '',
  '组件只能引用输入中存在的 unitRefs 和 sourceLeafIds。unitRefs 决定正文 ownership，每个 unit 只能出现一次；sourceLeafIds 必须包含 unitRefs 拥有的全部 leaf，也可为标题或聚合判断重复引用其他 Canonical leaf，但不会改变 ownership、status 或 confidence。Evidence 由系统从全部 sourceLeafIds 派生。profile-grid 只用于 graph/records；matrix 只用于 matrix/records；timeline 和 stage-flow 只用于 stages；tension-map 只用于 graph；principle-list 只用于 design_principle；priority-lanes 只用于具有明确 P0/P1/P2 的 actions；confidence-bars 只引用带 confidence 的 leaf。其余情况使用 narrative-list。',
  '',
  '组件与 variant 的合法组合固定为：editorial-hero=statement；evidence-boundary=split；confidence-bars=ledger；timeline=horizontal；profile-grid=asymmetric/columns/list；matrix=table；stage-flow=stepped；tension-map=two-sided；principle-list=columns；priority-lanes=lanes；validation-list=ledger；source-register=register；narrative-list=list。不得输出其他组合。',
  '',
  'showcase 不包含 Appendix。未选择的 unit 会由系统确定性加入完整分析附件。不得输出 status、confidence、Evidence ID、Contribution ID 或业务字段，这些由 Compiler 从 Canonical Trace 派生。',
  '',
  '只返回符合 report-editorial-intent-v2 Schema 的 JSON。',
].join('\n');

type PlannerFallbackReasonCode = Exclude<LayoutFallbackReasonCode, 'planner_disabled'>;

export interface ReportEditorialPlannerDiagnostics {
  plannerInputSha256: string;
  serializedInputBytes: number;
  presentationUnitCount: number;
  leafUnitCount: number;
  estimatedPromptTokens: number;
  outputBytes?: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  receiptId?: string;
  intentCompiler?: IntentCompilerDiagnostics;
}

export type ReportEditorialPlanResult =
  | {
      blueprint: ReportEditorialBlueprintV1;
      mode: 'model';
      reasonCode?: never;
      warnings: [];
      diagnostics: ReportEditorialPlannerDiagnostics;
      editorialCopy?: ReportEditorialCopySelectionV2;
      showcaseSpec?: EditorialPresentationSpecV1;
    }
  | {
      blueprint: ReportEditorialBlueprintV1;
      mode: 'fallback';
      reasonCode: PlannerFallbackReasonCode;
      warnings: PlannerFallbackReasonCode[];
      diagnostics: ReportEditorialPlannerDiagnostics;
      editorialCopy?: ReportEditorialCopySelectionV2;
      showcaseSpec?: EditorialPresentationSpecV1;
    };

export interface ReportEditorialPlanInput {
  material: ReportEditorialMaterialV1;
  attemptId: string;
  stepNo: number;
  expectedModel: string;
  dataClassification?: ReportEditorialPlannerDataClassification;
  presentationOptions?: DeterministicEditorialBlueprintOptions;
  /** Default false: keeps the v1 Blueprint-only request and response contract. */
  enableEditorialCopy?: boolean;
  /** Adds Showcase intent to the same structured call; implies editorial Copy. */
  enableEditorialShowcase?: boolean;
  cancellationSignal?: AbortSignal;
}

export interface ReportEditorialPlannerDataClassification {
  taskSensitivity: 'public' | 'internal' | 'confidential';
  piiDetected: boolean;
  hasSensitiveOrBlockedEvidence: boolean;
}

export type ReportEditorialPlannerDataPolicy = (
  input: ReportEditorialPlannerInputV1,
  provider: LLMProviderIdentity,
  classification: ReportEditorialPlannerDataClassification | undefined,
) => boolean | Promise<boolean>;

export const productionReportEditorialPlannerDataPolicy: ReportEditorialPlannerDataPolicy = (
  _input,
  provider,
  classification,
) => provider.mode === 'real'
  && provider.eligibleAsReal
  && classification !== undefined
  && (classification.taskSensitivity === 'public' || classification.taskSensitivity === 'internal')
  && !classification.piiDetected
  && !classification.hasSensitiveOrBlockedEvidence;

interface ReportEditorialPlannerDependencies {
  llm: Pick<LLMClient, 'identity' | 'generateStructured'>;
  validator?: Pick<SchemaValidator, 'validateFileOrThrow'>;
  dataPolicy?: ReportEditorialPlannerDataPolicy;
  estimatePromptTokens?: (text: string) => number;
  now?: () => number;
}

class IncompatibleEditorialPresentationError extends Error {
  constructor(unitId: string, presentation: string) {
    super(`presentation ${presentation} is not enabled for unit ${unitId}`);
    this.name = 'IncompatibleEditorialPresentationError';
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function enabledOptions(
  options: DeterministicEditorialBlueprintOptions = {},
): Required<DeterministicEditorialBlueprintOptions> {
  return {
    recordTable: options.recordTable ?? true,
    graph: options.graph ?? true,
    priorityBoard: options.priorityBoard ?? true,
    cardGrid: options.cardGrid ?? true,
    stageFlow: options.stageFlow ?? true,
  };
}

function presentationEnabled(
  presentation: ReportPresentationV1,
  options: Required<DeterministicEditorialBlueprintOptions>,
): boolean {
  if (presentation === 'record-table') return options.recordTable;
  if (presentation === 'graph') return options.graph;
  if (presentation === 'priority-board') return options.priorityBoard;
  if (presentation === 'card-grid') return options.cardGrid;
  if (presentation === 'stage-flow') return options.stageFlow;
  return true;
}

function plannerUnit(
  material: ReportEditorialMaterialV1,
  unit: ReportEditorialPresentationUnitV1,
  options: Required<DeterministicEditorialBlueprintOptions>,
): ReportEditorialPlannerPresentationUnitV1 {
  const common = {
    id: unit.id,
    semanticKind: unit.semanticKind,
    ...(unit.title === undefined ? {} : { title: unit.title }),
    leafIds: [...unit.leafIds],
    requiredView: reportEditorialViewForUnit(unit),
    requiredVisibility: reportEditorialRequiredVisibilityForUnit(unit),
    allowedPresentations: (material.constraints.projectionProfilesByUnitId[unit.id] ?? [])
      .filter((presentation) => presentationEnabled(presentation, options)),
  };
  switch (unit.shape) {
    case 'text':
      return { ...common, shape: unit.shape, text: unit.text };
    case 'record':
      return {
        ...common,
        shape: unit.shape,
        fields: unit.fields.map((field) => ({ ...field })),
      };
    case 'matrix':
      return {
        ...common,
        shape: unit.shape,
        rows: [...unit.rows],
        columns: [...unit.columns],
        cells: unit.cells.map((cell) => ({ ...cell })),
      };
    case 'graph':
      return {
        ...common,
        shape: unit.shape,
        nodes: unit.nodes.map((node) => ({ ...node })),
        edges: unit.edges.map((edge) => ({ ...edge })),
      };
    case 'actions':
      return {
        ...common,
        shape: unit.shape,
        actions: unit.actions.map((action) => ({ ...action })),
      };
    case 'records':
      return {
        ...common,
        shape: unit.shape,
        records: unit.records.map((record) => ({
          ...record,
          fields: record.fields.map((field) => ({ ...field })),
        })),
      };
    case 'stages':
      return {
        ...common,
        semanticKind: 'research_plan_execution',
        shape: unit.shape,
        stages: unit.stages.map((stage) => ({
          ...stage,
          activities: [...stage.activities],
          outputs: [...stage.outputs],
        })),
      };
    case 'asset':
      return {
        ...common,
        semanticKind: 'visual_asset',
        shape: unit.shape,
        sourceSummary: { ...unit.sourceSummary },
        canonicalBindingIds: [...unit.canonicalBindingIds],
      };
    case 'asset_pair':
      return {
        ...common,
        semanticKind: 'visual_comparison',
        shape: unit.shape,
        originalSourceSummary: { ...unit.original.sourceSummary },
        annotationRole: 'annotation',
        findingIds: [...unit.findingIds],
        canonicalBindingIds: [...unit.canonicalBindingIds],
      };
    case 'chart':
      return {
        ...common,
        semanticKind: 'verified_chart',
        shape: unit.shape,
        chart: {
          title: unit.spec.title,
          type: unit.spec.type,
          categoryCount: unit.spec.categories.length,
          seriesCount: unit.spec.series.length,
          pointCount: unit.spec.series.reduce((count, series) => count + series.values.length, 0),
          evidenceIds: [...unit.evidenceIds],
          canonicalBindingIds: [...unit.canonicalBindingIds],
        },
      };
  }
}

export function buildReportEditorialPlannerInputV1(
  material: ReportEditorialMaterialV1,
  presentationOptions: DeterministicEditorialBlueprintOptions = {},
): ReportEditorialPlannerInputV1 {
  assertReportEditorialMaterialIntegrity(material);
  const options = enabledOptions(presentationOptions);
  const presentationUnits = material.presentationUnits.map((unit) => plannerUnit(material, unit, options));
  for (const unit of presentationUnits) {
    if (unit.allowedPresentations.length === 0) {
      throw new Error(`presentation unit ${unit.id} has no enabled Planner presentation`);
    }
  }
  return {
    version: 'report-editorial-planner-input-v1',
    document: {
      title: material.document.title,
      ...(material.document.decisionContext === undefined
        ? {}
        : { decisionContext: material.document.decisionContext }),
      ...(material.document.executiveAnswer === undefined
        ? {}
        : { executiveAnswer: material.document.executiveAnswer }),
      deliverableType: material.document.deliverableType,
      requestedArtifactTypes: [...material.document.requestedArtifactTypes],
    },
    presentationUnits,
    leafSupportIndex: Object.fromEntries(Object.entries(material.leafTraceIndex).map(
      ([leafId, trace]) => [leafId, {
        supportMode: trace.supportMode,
        support: {
          questionIds: [...trace.support.questionIds],
          evidenceIds: [...trace.support.evidenceIds],
          findingIds: [...trace.support.findingIds],
          summaryIds: [...trace.support.summaryIds],
          ...(trace.support.status === undefined ? {} : { status: trace.support.status }),
          ...(trace.support.confidence === undefined ? {} : { confidence: trace.support.confidence }),
        },
      }],
    )),
    constraints: {
      requiredQuestionIds: [...material.constraints.requiredQuestionIds],
      requiredPresentationUnitIds: [...material.constraints.requiredPresentationUnitIds],
      allowedViews: [...material.constraints.allowedViews],
    },
    placementPolicy: deriveEditorialPlacementPolicy(material),
  };
}

/** A deterministic, model-agnostic estimate that counts non-ASCII text conservatively. */
export function estimateReportEditorialPromptTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii + 512;
}

export function assertReportEditorialModelPresentationsEnabled(
  input: ReportEditorialPlannerInputV1,
  blueprint: ReportEditorialBlueprintV1,
): void {
  const units = new Map(input.presentationUnits.map((unit) => [unit.id, unit]));
  for (const section of blueprint.sections) {
    for (const block of section.blocks) {
      for (const unitId of block.unitRefs) {
        const unit = units.get(unitId);
        if (unit && !unit.allowedPresentations.includes(block.presentation)) {
          throw new IncompatibleEditorialPresentationError(unitId, block.presentation);
        }
      }
    }
  }
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof LLMInvocationError && error.kind === 'cancelled') return true;
  return error instanceof DOMException && error.name === 'AbortError';
}

function usageDiagnostics(usage: TokenUsage | undefined): Pick<
  ReportEditorialPlannerDiagnostics,
  'promptTokens' | 'completionTokens'
> {
  return usage === undefined
    ? {}
    : { promptTokens: usage.prompt, completionTokens: usage.completion };
}

export class ReportEditorialPlanner {
  private readonly validator: Pick<SchemaValidator, 'validateFileOrThrow'>;
  private readonly estimatePromptTokens: (text: string) => number;
  private readonly now: () => number;

  constructor(private readonly dependencies: ReportEditorialPlannerDependencies) {
    this.validator = dependencies.validator ?? new SchemaValidator();
    this.estimatePromptTokens = dependencies.estimatePromptTokens
      ?? estimateReportEditorialPromptTokens;
    this.now = dependencies.now ?? Date.now;
  }

  async plan(input: ReportEditorialPlanInput): Promise<ReportEditorialPlanResult> {
    this.throwIfCancelled(input.cancellationSignal);
    const enableEditorialShowcase = input.enableEditorialShowcase ?? false;
    const enableEditorialCopy = (input.enableEditorialCopy ?? false) || enableEditorialShowcase;
    const plannerInput = buildReportEditorialPlannerInputV1(
      input.material,
      input.presentationOptions,
    );
    const serializedInput = JSON.stringify(plannerInput);
    const schemaPath = join(
      getConfigRoot(),
      enableEditorialShowcase
        ? EDITORIAL_INTENT_V2_SCHEMA_PATH
        : enableEditorialCopy
          ? EDITORIAL_INTENT_V1_SCHEMA_PATH
          : BLUEPRINT_SCHEMA_PATH,
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const prompt = enableEditorialShowcase
      ? REPORT_EDITORIAL_INTENT_V2_PROMPT
      : enableEditorialCopy
        ? REPORT_EDITORIAL_INTENT_V1_PROMPT
        : REPORT_EDITORIAL_PLANNER_PROMPT;
    const serializedInputBytes = Buffer.byteLength(serializedInput, 'utf8');
    const estimatedPromptTokens = this.estimatePromptTokens([
      prompt,
      serializedInput,
      JSON.stringify(schema),
    ].join('\n'));
    const baseDiagnostics: ReportEditorialPlannerDiagnostics = {
      plannerInputSha256: sha256(serializedInput),
      serializedInputBytes,
      presentationUnitCount: plannerInput.presentationUnits.length,
      leafUnitCount: plannerInput.presentationUnits.reduce(
        (count, unit) => count + unit.leafIds.length,
        0,
      ),
      estimatedPromptTokens,
      latencyMs: 0,
    };
    const options = input.presentationOptions ?? {};

    if (
      baseDiagnostics.serializedInputBytes > REPORT_EDITORIAL_PLANNER_LIMITS.serializedInputBytes
      || baseDiagnostics.presentationUnitCount > REPORT_EDITORIAL_PLANNER_LIMITS.presentationUnits
      || baseDiagnostics.leafUnitCount > REPORT_EDITORIAL_PLANNER_LIMITS.leafUnits
      || baseDiagnostics.estimatedPromptTokens > REPORT_EDITORIAL_PLANNER_LIMITS.promptTokens
    ) {
      return this.fallback(
        input.material,
        options,
        'material_budget_exceeded',
        baseDiagnostics,
        input.cancellationSignal,
        enableEditorialCopy,
        enableEditorialShowcase,
      );
    }

    if (this.dependencies.dataPolicy) {
      let allowed = false;
      try {
        allowed = await this.dependencies.dataPolicy(
          plannerInput,
          this.dependencies.llm.identity,
          input.dataClassification,
        );
      } catch (error) {
        if (isCancellation(error, input.cancellationSignal)) {
          this.rethrowCancellation(error, input.cancellationSignal);
        }
      }
      this.throwIfCancelled(input.cancellationSignal);
      if (!allowed) {
        return this.fallback(
          input.material,
          options,
          'data_policy_denied',
          baseDiagnostics,
          input.cancellationSignal,
          enableEditorialCopy,
          enableEditorialShowcase,
        );
      }
    }

    const startedAt = this.now();
    let generated: LLMResult<ReportEditorialBlueprintV1 | ReportEditorialIntentV1 | ReportEditorialIntentV2>;
    try {
      generated = await this.dependencies.llm.generateStructured<
        ReportEditorialBlueprintV1 | ReportEditorialIntentV1 | ReportEditorialIntentV2
      >({
        prompt,
        schema,
        schemaName: enableEditorialShowcase
          ? 'report-editorial-intent-v2'
          : enableEditorialCopy
            ? 'report-editorial-intent-v1'
            : 'report-editorial-blueprint-v1',
        context: plannerInput,
        ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
        receipt: {
          stage: 'report_editorial_planner',
          attemptId: input.attemptId,
          stepNo: input.stepNo,
          contextManifestHash: baseDiagnostics.plannerInputSha256,
          expectedModel: input.expectedModel,
        },
      });
    } catch (error) {
      if (isCancellation(error, input.cancellationSignal)) {
        this.rethrowCancellation(error, input.cancellationSignal);
      }
      if (error instanceof ModelDriftError || error instanceof MissingModelReceiptError) {
        throw error;
      }
      const reasonCode = error instanceof LLMInvocationError && error.kind === 'schema'
        ? 'invalid_blueprint'
        : 'provider_failure';
      return this.fallback(input.material, options, reasonCode, {
        ...baseDiagnostics,
        latencyMs: Math.max(0, this.now() - startedAt),
      }, input.cancellationSignal, enableEditorialCopy, enableEditorialShowcase);
    }

    this.throwIfCancelled(input.cancellationSignal);
    let serializedOutput: string;
    try {
      serializedOutput = JSON.stringify(generated.data);
    } catch {
      return this.fallback(input.material, options, 'invalid_blueprint', {
        ...baseDiagnostics,
        ...usageDiagnostics(generated.tokens),
        latencyMs: Math.max(0, this.now() - startedAt),
        ...(generated.receiptId ? { receiptId: generated.receiptId } : {}),
      }, input.cancellationSignal, enableEditorialCopy, enableEditorialShowcase);
    }
    const outputBytes = Buffer.byteLength(serializedOutput, 'utf8');
    const modelDiagnostics: ReportEditorialPlannerDiagnostics = {
      ...baseDiagnostics,
      ...usageDiagnostics(generated.tokens),
      outputBytes,
      latencyMs: Math.max(0, this.now() - startedAt),
      ...(generated.receiptId ? { receiptId: generated.receiptId } : {}),
    };
    if (
      outputBytes > REPORT_EDITORIAL_PLANNER_LIMITS.outputBytes
      || (generated.tokens?.prompt ?? 0) > REPORT_EDITORIAL_PLANNER_LIMITS.promptTokens
    ) {
      return this.fallback(
        input.material,
        options,
        'material_budget_exceeded',
        modelDiagnostics,
        input.cancellationSignal,
        enableEditorialCopy,
        enableEditorialShowcase,
      );
    }

    let blueprint: ReportEditorialBlueprintV1;
    let editorialCopy: ReportEditorialCopySelectionV2 | undefined;
    let showcaseSpec: EditorialPresentationSpecV1 | undefined;
    let intentCompilerDiagnostics: IntentCompilerDiagnostics | undefined;
    try {
      this.validator.validateFileOrThrow(schemaPath, generated.data);
      const output = generated.data;
      if (enableEditorialCopy) {
        // Intent path: compile partial selection into full Blueprint.
        const intent = output as ReportEditorialIntentV1 | ReportEditorialIntentV2;
        const reportIntent: ReportEditorialIntentV1 = intent.version === 'report-editorial-intent-v2'
          ? {
              version: 'report-editorial-intent-v1',
              style: intent.style,
              density: intent.density,
              mainSections: intent.mainSections,
              copyFragments: intent.copyFragments,
            }
          : intent;
        const compiled = compileReportEditorialIntent(input.material, reportIntent, options);
        blueprint = compiled.blueprint;
        editorialCopy = compiled.editorialCopy;
        intentCompilerDiagnostics = compiled.diagnostics;
        if (enableEditorialShowcase) {
          if (intent.version !== 'report-editorial-intent-v2') {
            throw new Error('Showcase-enabled Planner did not return Intent v2');
          }
          showcaseSpec = compileEditorialShowcase(input.material, intent.showcase, 'model').spec;
        }
      } else {
        // v1 path: model returns full Blueprint directly.
        blueprint = output as ReportEditorialBlueprintV1;
        assertReportEditorialModelPresentationsEnabled(plannerInput, blueprint);
        assertReportEditorialBlueprintIntegrity(input.material, blueprint);
      }
    } catch (error) {
      this.throwIfCancelled(input.cancellationSignal);
      const reasonCode = error instanceof IncompatibleEditorialPresentationError
        ? 'incompatible_presentation'
        : 'invalid_blueprint';
      return this.fallback(
        input.material,
        options,
        reasonCode,
        modelDiagnostics,
        input.cancellationSignal,
        enableEditorialCopy,
        enableEditorialShowcase,
      );
    }

    return {
      blueprint,
      mode: 'model',
      warnings: [],
      diagnostics: intentCompilerDiagnostics
        ? { ...modelDiagnostics, intentCompiler: intentCompilerDiagnostics }
        : modelDiagnostics,
      ...(editorialCopy === undefined ? {} : { editorialCopy }),
      ...(showcaseSpec === undefined ? {} : { showcaseSpec }),
    };
  }

  private fallback(
    material: ReportEditorialMaterialV1,
    options: DeterministicEditorialBlueprintOptions,
    reasonCode: PlannerFallbackReasonCode,
    diagnostics: ReportEditorialPlannerDiagnostics,
    signal?: AbortSignal,
    enableEditorialCopy = false,
    enableEditorialShowcase = false,
  ): ReportEditorialPlanResult {
    this.throwIfCancelled(signal);
    if (enableEditorialCopy) {
      const compiled = createDeterministicReportEditorialIntentCompilation(material, options);
      return {
        blueprint: compiled.blueprint,
        mode: 'fallback',
        reasonCode,
        warnings: [reasonCode],
        diagnostics: { ...diagnostics, intentCompiler: compiled.diagnostics },
        editorialCopy: compiled.editorialCopy,
        ...(enableEditorialShowcase
          ? { showcaseSpec: createDeterministicEditorialShowcaseSpec(material) }
          : {}),
      };
    }
    return {
      blueprint: createDeterministicReportEditorialBlueprintV1(material, options),
      mode: 'fallback',
      reasonCode,
      warnings: [reasonCode],
      diagnostics,
    };
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }

  private rethrowCancellation(error: unknown, signal: AbortSignal | undefined): never {
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  }
}

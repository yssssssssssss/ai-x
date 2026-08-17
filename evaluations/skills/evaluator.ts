import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  hashPrompt,
  type LLMClient,
  type LLMResult,
} from '../../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ModelDriftError } from '../../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import type { SkillLoader } from '../../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import type { SchemaValidator } from '../../apps/orchestrator-runtime/src/schema/validator.ts';
import { assessKnowledgeUsage } from './kb/assessment.ts';
import type { KnowledgeContext, RetrievalRecord } from './kb/types.ts';
import type {
  LoadedEvaluationCase,
  SkillEvaluationRecord,
  SkillScorecard,
} from './types.ts';

const DIMENSION_WEIGHTS = {
  workflow_adherence: 20,
  method_correctness: 20,
  completeness_structure: 20,
  evidence_boundaries: 15,
  actionability: 15,
  risk_boundary_handling: 10,
} as const;

const DEFAULT_SCORECARD_SCHEMA_PATH = fileURLToPath(
  new URL('./scorecard.schema.json', import.meta.url),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectScalarLeaves(value: unknown, leaves: string[]): void {
  if (value === null) {
    leaves.push('null');
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    leaves.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScalarLeaves(item, leaves);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectScalarLeaves(item, leaves);
  }
}

export function validateScorecardEvidence(
  scorecard: SkillScorecard,
  generatedOutput: Record<string, unknown>,
): void {
  const scalarLeaves: string[] = [];
  collectScalarLeaves(generatedOutput, scalarLeaves);
  for (const dimension of scorecard.dimensions) {
    for (const evidence of dimension.evidence) {
      const excerpt = evidence.trim();
      if (excerpt.length === 0) {
        throw new Error(`score dimension evidence must not be blank: ${dimension.id}`);
      }
      if (!scalarLeaves.some((leaf) => leaf.includes(excerpt))) {
        throw new Error(
          `score dimension evidence is not a verbatim generated output excerpt: ${dimension.id}`,
        );
      }
    }
  }
}

function normalizeScorecard(
  scorecard: SkillScorecard,
  skillId: string,
  generatedOutput: Record<string, unknown>,
): SkillScorecard {
  if (scorecard.skill_id !== skillId) {
    throw new Error(
      `scorecard skill_id mismatch: expected ${skillId}, received ${scorecard.skill_id}`,
    );
  }

  const expectedIds = Object.keys(DIMENSION_WEIGHTS);
  if (scorecard.dimensions.length !== expectedIds.length) {
    throw new Error(
      `scorecard dimensions must contain exactly ${expectedIds.length} entries`,
    );
  }

  const seen = new Set<string>();
  let total = 0;
  for (const dimension of scorecard.dimensions) {
    const expectedMax =
      DIMENSION_WEIGHTS[dimension.id as keyof typeof DIMENSION_WEIGHTS];
    if (expectedMax === undefined) {
      throw new Error(`unknown score dimension: ${dimension.id}`);
    }
    if (seen.has(dimension.id)) {
      throw new Error(`duplicate score dimension: ${dimension.id}`);
    }
    seen.add(dimension.id);
    if (dimension.evidence.length === 0) {
      throw new Error(`score dimension evidence must not be empty: ${dimension.id}`);
    }
    if (
      !Number.isFinite(dimension.score) ||
      !Number.isFinite(dimension.max_score) ||
      dimension.max_score !== expectedMax ||
      dimension.score < 0 ||
      dimension.score > dimension.max_score
    ) {
      throw new Error(
        `invalid score/max pair for ${dimension.id}: ${dimension.score}/${dimension.max_score}`,
      );
    }
    total += dimension.score;
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) throw new Error(`missing score dimension: ${id}`);
  }
  validateScorecardEvidence(scorecard, generatedOutput);

  let verdict: SkillScorecard['verdict'];
  if (total < 60 || scorecard.critical_defects.length > 0) {
    verdict = 'fail';
  } else if (total < 80 || scorecard.verdict === 'needs_review') {
    verdict = 'needs_review';
  } else {
    verdict = 'pass';
  }

  return { ...scorecard, total_score: total, verdict };
}

function fallbackScorecard(skillId: string, message: string): SkillScorecard {
  return {
    skill_id: skillId,
    total_score: null,
    verdict: 'needs_review',
    dimensions: [],
    critical_defects: [],
    review_notes: [message],
  };
}


export class SkillEvaluator {
  private readonly llm: LLMClient;
  private readonly skillLoader: SkillLoader;
  private readonly validator: SchemaValidator;
  private readonly scorecardSchemaPath: string;
  private readonly expectedActualModel?: string;

  constructor(deps: {
    llm: LLMClient;
    skillLoader: SkillLoader;
    validator: SchemaValidator;
    scorecardSchemaPath?: string;
    expectedActualModel?: string;
  }) {
    this.llm = deps.llm;
    this.skillLoader = deps.skillLoader;
    this.validator = deps.validator;
    this.scorecardSchemaPath =
      deps.scorecardSchemaPath ?? DEFAULT_SCORECARD_SCHEMA_PATH;
    this.expectedActualModel = deps.expectedActualModel;
  }

  async evaluate(
    loadedCase: LoadedEvaluationCase,
    kb?: { knowledgeContext: KnowledgeContext; retrieval: RetrievalRecord },
  ): Promise<SkillEvaluationRecord> {
    const startedAt = Date.now();
    const evaluationCase = loadedCase.data;
    const base: SkillEvaluationRecord = {
      skillId: evaluationCase.skill_id,
      skillHash: '',
      caseHash: loadedCase.caseHash,
      elapsedMs: 0,
      status: 'failed',
    };
    if (kb) {
      base.knowledgeContextRef = {
        mode: kb.knowledgeContext.mode,
        snapshot_id: kb.knowledgeContext.snapshot_id,
        required_source_ids: kb.knowledgeContext.required_source_ids,
        selected_source_ids: kb.knowledgeContext.selected_source_ids,
        retrieval_recall: kb.retrieval.required_source_recall,
      };
    }

    let body: string;
    let outputSchema: object | undefined;
    let generated: LLMResult<Record<string, unknown>>;
    try {
      const skill = this.skillLoader.getSkill(evaluationCase.skill_id);
      if (!skill) {
        throw new Error(`skill 未找到或非 active: ${evaluationCase.skill_id}`);
      }
      const loadedSkill = this.skillLoader.loadSkillBody(skill.id);
      body = loadedSkill.body;
      base.skillHash = loadedSkill.hash;
      outputSchema = this.skillLoader.loadSkillSchemas(skill.id).output;
      const generationContext = {
        research_goal: evaluationCase.research_goal,
        input_materials: evaluationCase.input_materials,
        tool_outputs: evaluationCase.tool_outputs,
        expected_deliverables: evaluationCase.expected_deliverables,
        risk_checks: evaluationCase.risk_checks,
        ...(kb ? { knowledge_context: kb.knowledgeContext } : {}),
      };
      const kbPrompt = kb
        ? `\n\nKnowledge context is authoritative for this KB-aware evaluation. Cite every KB-backed claim with an explicit source_id or source_path marker, and preserve source status in the output. Draft sources may be used only with a warning.`
        : '';

      generated =
        await this.llm.generateStructured<Record<string, unknown>>({
          prompt:
            `你是「${skill.name}」能力。严格按以下 SKILL.md 的工作流与质量门禁执行。` +
            `本次输入均为标准合成评测数据；只能基于 input_materials 与 tool_outputs 产出结果，` +
            `不得表述为真实业务事实。无数据支撑的判断必须明确标为 llm_inference 或待人工确认。${kbPrompt}\n\n${body}`,
          schema: outputSchema ?? {
            type: 'object',
            additionalProperties: true,
          },
          schemaName: `skill:${skill.id}`,
          context: generationContext,
          receipt: {
            stage: 'skill_evaluation_generation',
            contextManifestHash: hashPrompt('', generationContext),
            expectedModel:
              this.expectedActualModel ?? this.llm.identity.requestedModel,
          },
        });
      const expectedModel =
        this.expectedActualModel ?? this.llm.identity.requestedModel;
      if (generated.modelName !== expectedModel) {
        throw new ModelDriftError(expectedModel, generated.modelName);
      }

      Object.assign(base, {
        generationPromptHash: generated.promptHash,
        modelName: generated.modelName,
        modelVersion: generated.modelVersion,
        generationTraceId: generated.traceId,
        generationTokens: generated.tokens,
        output: generated.data,
      });
      if (kb) {
        base.kbAssessment = assessKnowledgeUsage(
          evaluationCase.skill_id,
          kb.knowledgeContext,
          kb.retrieval,
          generated.data,
        );
      }

      try {
        this.validator.validateSchemaOrThrow(
          outputSchema,
          generated.data,
          `skill:${skill.id}`,
        );
      } catch (error) {
        return {
          ...base,
          elapsedMs: Date.now() - startedAt,
          status: 'failed',
          errorStage: 'schema_validation',
          errorMessage: errorMessage(error),
        };
      }
    } catch (error) {
      return {
        ...base,
        elapsedMs: Date.now() - startedAt,
        status: 'failed',
        errorStage: 'generation',
        errorMessage: errorMessage(error),
      };
    }

    try {
      const scorecardSchema = JSON.parse(
        readFileSync(this.scorecardSchemaPath, 'utf8'),
      ) as object;
      const scoringContext = {
        skill_id: evaluationCase.skill_id,
        skill_body: body,
        evaluation_case: evaluationCase,
        generated_output: generated.data,
        ...(kb
          ? { knowledge_context: kb.knowledgeContext, retrieval: kb.retrieval }
          : {}),
      };
      const kbScoringPrompt = kb
        ? `\nKB context and retrieval metadata are supplied for grounding review only; do not alter the 100-point Skill score normalization because of KB assessment metadata.`
        : '';

      const scored = await this.llm.generateStructured<SkillScorecard>({
        prompt:
          `你是独立评测员。仅根据 Skill 工作流、评测 case 与 generated_output 评分。\n` +
          `固定维度与权重：workflow_adherence 20；method_correctness 20；` +
          `completeness_structure 20；evidence_boundaries 15；actionability 15；` +
          `risk_boundary_handling 10。\n` +
          `evidence 必须包含 generated_output 中支持评分的具体逐字引用；` +
          `不奖励无证据支撑的冗长内容。输入均为合成评测数据，不得将其当作真实业务事实。${kbScoringPrompt}`,
        schema: scorecardSchema,
        schemaName: 'skill-evaluation-scorecard',
        context: scoringContext,
        receipt: {
          stage: 'skill_evaluation_scoring',
          contextManifestHash: hashPrompt('', scoringContext),
          expectedModel:
            this.expectedActualModel ?? this.llm.identity.requestedModel,
        },
      });
      const expectedModel =
        this.expectedActualModel ?? this.llm.identity.requestedModel;
      if (scored.modelName !== expectedModel) {
        throw new ModelDriftError(expectedModel, scored.modelName);
      }

      Object.assign(base, {
        scoringPromptHash: scored.promptHash,
        scoringTraceId: scored.traceId,
        scoringTokens: scored.tokens,
      });
      this.validator.validateFileOrThrow(
        this.scorecardSchemaPath,
        scored.data,
      );
      const scorecard = normalizeScorecard(
        scored.data,
        evaluationCase.skill_id,
        generated.data,
      );
      return {
        ...base,
        elapsedMs: Date.now() - startedAt,
        status:
          scorecard.verdict === 'needs_review' ? 'needs_review' : 'succeeded',
        scorecard,
      };
    } catch (error) {
      if (error instanceof ModelDriftError) {
        return {
          ...base,
          elapsedMs: Date.now() - startedAt,
          status: 'failed',
          errorStage: 'scoring',
          errorMessage: error.message,
        };
      }
      const message = errorMessage(error);
      return {
        ...base,
        elapsedMs: Date.now() - startedAt,
        status: 'needs_review',
        errorStage: 'scoring',
        errorMessage: message,
        scorecard: fallbackScorecard(evaluationCase.skill_id, message),
      };
    }
  }
}

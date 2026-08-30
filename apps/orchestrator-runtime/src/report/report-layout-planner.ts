import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ReportLayoutBlueprintV1,
  ResearchStrategyReportPayloadV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { LLMClient } from '../runtime/llm-client.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';
import { SchemaValidator } from '../schema/validator.ts';

const BLUEPRINT_SCHEMA = 'schemas/report-layout-blueprint.schema.json';

function blueprintSchema(): object {
  return JSON.parse(readFileSync(join(getConfigRoot(), BLUEPRINT_SCHEMA), 'utf8')) as object;
}

export interface ReportLayoutPlanResult {
  blueprint: ReportLayoutBlueprintV1;
  mode: 'model' | 'fallback';
  warnings: string[];
}

function fallbackBlueprint(payload: ResearchStrategyReportPayloadV2): ReportLayoutBlueprintV1 {
  const requestedBlockIds = new Set(payload.requestedArtifactBindings.flatMap(({ blockIds }) => blockIds));
  return {
    version: 'report-layout-blueprint-v1',
    sections: payload.contentBlocks.map((block) => ({
      title: block.title,
      purpose: `Present the ${block.kind.replaceAll('_', ' ')} content from the reviewed Canonical Deliverable.`,
      prominence: requestedBlockIds.has(block.id) ? 'primary' : 'supporting',
      blockRefs: [block.id],
    })),
  };
}

function validateBlueprint(
  blueprint: ReportLayoutBlueprintV1,
  payload: ResearchStrategyReportPayloadV2,
): void {
  const known = new Set(payload.contentBlocks.map(({ id }) => id));
  const requested = new Set(payload.requestedArtifactBindings.flatMap(({ blockIds }) => blockIds));
  const references = blueprint.sections.flatMap(({ blockRefs }) => blockRefs);
  if (new Set(references).size !== references.length) throw new Error('layout blueprint contains duplicate Block references');
  for (const reference of references) {
    if (!known.has(reference)) throw new Error(`layout blueprint references unknown Block ${reference}`);
  }
  for (const blockId of known) {
    if (!references.includes(blockId)) throw new Error(`layout blueprint omits Canonical Block ${blockId}`);
  }
  for (const section of blueprint.sections) {
    if (section.prominence === 'appendix' && section.blockRefs.some((blockId) => requested.has(blockId))) {
      throw new Error('layout blueprint places a requested artifact in the appendix');
    }
  }
}

export class ReportLayoutPlanner {
  constructor(private readonly dependencies: {
    llm: Pick<LLMClient, 'generateStructured'>;
    validator?: Pick<SchemaValidator, 'validateFileOrThrow'>;
  }) {}

  async plan(input: {
    payload: ResearchStrategyReportPayloadV2;
    attemptId: string;
    stepNo: number;
    expectedModel: string;
    cancellationSignal?: AbortSignal;
  }): Promise<ReportLayoutPlanResult> {
    const fallback = fallbackBlueprint(input.payload);
    const validator = this.dependencies.validator ?? new SchemaValidator();
    const selectableContentBlockIds = new Set(input.payload.contentBlocks.map(({ id }) => id));
    const fixedDirectAnswerIds = new Set(
      input.payload.directAnswers.map(({ questionId }) => `answer-${questionId}`),
    );
    try {
      const generated = await this.dependencies.llm.generateStructured<ReportLayoutBlueprintV1>({
        prompt: [
          'Arrange the reviewed Canonical Content Blocks into a concise answer-first research report.',
          'Return only a report-layout-blueprint-v1 object.',
          'You may choose section titles, section count, order, grouping, and prominence.',
          'Direct Answers are fixed outside this Blueprint and must never appear in blockRefs.',
          'Reference every selectable Content Block exactly once. Do not add prose, facts, evidence, or unknown Block IDs.',
          'Requested artifact Blocks must not be placed in an appendix.',
        ].join('\n'),
        schema: blueprintSchema(),
        schemaName: 'report-layout-blueprint',
        context: {
          title: input.payload.title,
          fixedDirectAnswers: input.payload.directAnswers.map(({ questionId, question }) => ({
            id: `answer-${questionId}`,
            questionId,
            question,
          })),
          requestedArtifacts: input.payload.requestedArtifactBindings.map(({ artifactType, blockIds }) => ({
            artifactType,
            fixedDirectAnswerIds: blockIds.filter((id) => fixedDirectAnswerIds.has(id)),
            selectableContentBlockIds: blockIds.filter((id) => selectableContentBlockIds.has(id)),
          })),
          selectableContentBlocks: input.payload.contentBlocks.map((block) => ({
            id: block.id,
            kind: block.kind,
            title: block.title,
            questionIds: [...new Set(supports(block).flatMap(({ questionIds }) => questionIds))],
          })),
        },
        ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
        receipt: {
          stage: 'report_layout',
          attemptId: input.attemptId,
          stepNo: input.stepNo,
          expectedModel: input.expectedModel,
        },
      });
      validator.validateFileOrThrow(BLUEPRINT_SCHEMA, generated.data);
      validateBlueprint(generated.data, input.payload);
      return { blueprint: generated.data, mode: 'model', warnings: [] };
    } catch (error) {
      if (input.cancellationSignal?.aborted) {
        throw input.cancellationSignal.reason ?? error;
      }
      return {
        blueprint: fallback,
        mode: 'fallback',
        warnings: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
}

export function deterministicReportLayout(
  payload: ResearchStrategyReportPayloadV2,
): ReportLayoutPlanResult {
  return { blueprint: fallbackBlueprint(payload), mode: 'fallback', warnings: [] };
}

function supports(block: ResearchStrategyReportPayloadV2['contentBlocks'][number]) {
  if (block.kind === 'narrative') return [block.support];
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    return block.cells.map(({ support }) => support);
  }
  if (block.kind === 'mind_model') return block.nodes.map(({ support }) => support);
  if ('items' in block) return block.items.map(({ support }) => support);
  return [];
}

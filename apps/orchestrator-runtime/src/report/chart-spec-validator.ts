import type { ChartSpec } from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';

export type { ChartSeries, ChartSpec, ChartType } from '../../../../packages/api-contract/research-deliverable.ts';

export type ChartEvidenceResolver = (evidenceId: string) => unknown | undefined;

export class ChartSpecValidationError extends Error {
  constructor(message: string) {
    super(`Chart Spec validation failed: ${message}`);
    this.name = 'ChartSpecValidationError';
  }
}

const CHART_SPEC_VALIDATOR = new SchemaValidator();

export function validateChartSpec(
  value: unknown,
  resolveEvidence: ChartEvidenceResolver,
): ChartSpec {
  const schemaErrors = CHART_SPEC_VALIDATOR.validate('chart-spec', value);
  if (schemaErrors.length > 0) {
    throw new ChartSpecValidationError(schemaErrors.join('; '));
  }

  const spec = value as ChartSpec;
  if ((spec.type === 'comparison' || spec.type === 'trend') && spec.yAxis?.min !== undefined && spec.yAxis.min !== 0) {
    throw new ChartSpecValidationError(`${spec.type} charts require a zero yAxis baseline`);
  }
  if (
    (spec.type === 'comparison' || spec.type === 'trend')
    && spec.yAxis?.min === 0
    && spec.series.some((series) => series.values.some((chartValue) => chartValue !== null && chartValue < 0))
  ) {
    throw new ChartSpecValidationError(`${spec.type} charts cannot use a zero yAxis baseline with negative values`);
  }

  const seriesKeys = new Set<string>();
  for (const series of spec.series) {
    if (seriesKeys.has(series.key)) {
      throw new ChartSpecValidationError(`series key "${series.key}" must be unique`);
    }
    seriesKeys.add(series.key);

    if (series.values.length !== spec.categories.length) {
      throw new ChartSpecValidationError(`series "${series.key}" values length must match categories length`);
    }
    if (series.evidenceIds.length !== spec.categories.length) {
      throw new ChartSpecValidationError(`series "${series.key}" Evidence length must match categories length`);
    }

    for (let index = 0; index < series.values.length; index += 1) {
      const chartValue = series.values[index]!;
      const evidenceIds = series.evidenceIds[index]!;
      if (chartValue === null) {
        if (evidenceIds.length > 0) {
          throw new ChartSpecValidationError(`null value at series "${series.key}" category ${index} cannot claim Evidence`);
        }
        continue;
      }
      if (evidenceIds.length === 0) {
        throw new ChartSpecValidationError(`Evidence is required for series "${series.key}" category ${index}`);
      }
      for (const evidenceId of evidenceIds) {
        const evidenceValue = resolveEvidence(evidenceId);
        if (evidenceValue === undefined) {
          throw new ChartSpecValidationError(`Evidence "${evidenceId}" is dangling or cannot resolve`);
        }
        if (typeof evidenceValue !== 'number' || !Number.isFinite(evidenceValue) || evidenceValue !== chartValue) {
          throw new ChartSpecValidationError(
            `chart value ${chartValue} does not match Evidence "${evidenceId}" value`,
          );
        }
      }
    }
  }

  return spec;
}

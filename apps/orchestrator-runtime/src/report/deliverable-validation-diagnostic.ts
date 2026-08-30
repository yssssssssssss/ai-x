import { redactString } from '../runtime/redaction.ts';
import { SchemaValidationError } from '../schema/validator.ts';

export type DeliverableValidationStage =
  | 'content_schema'
  | 'content_semantics'
  | 'canonical_assembly'
  | 'layout_blueprint';

export interface DeliverableValidationDiagnosticV1 {
  version: 'deliverable-validation-diagnostic-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  stage: DeliverableValidationStage;
  round: number;
  issues: Array<{ code: string; jsonPointer?: string; message: string }>;
  fallbackApplied: boolean;
}

function boundedMessage(value: string): string {
  return redactString(value).replace(/\s+/gu, ' ').trim().slice(0, 500) || 'unknown validation failure';
}

function schemaIssue(value: string): { jsonPointer?: string; message: string } {
  const match = /^(\/\S*)\s+(.+)$/u.exec(value.trim());
  return match
    ? { jsonPointer: match[1], message: boundedMessage(match[2]!) }
    : { message: boundedMessage(value) };
}

export function createDeliverableValidationDiagnostic(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  stage: DeliverableValidationStage;
  round: number;
  error: unknown;
  fallbackApplied?: boolean;
}): DeliverableValidationDiagnosticV1 {
  const issues = input.error instanceof SchemaValidationError
    ? input.error.errors.map((issue) => ({ code: 'schema_validation', ...schemaIssue(issue) }))
    : [{
        code: input.error instanceof Error && input.error.name
          ? input.error.name.replace(/([a-z])([A-Z])/gu, '$1_$2').toLocaleLowerCase('en-US')
          : 'unknown_error',
        message: boundedMessage(input.error instanceof Error ? input.error.message : String(input.error)),
      }];
  return {
    version: 'deliverable-validation-diagnostic-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    stage: input.stage,
    round: input.round,
    issues,
    fallbackApplied: input.fallbackApplied ?? false,
  };
}

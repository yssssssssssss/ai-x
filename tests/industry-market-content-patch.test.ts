import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyIndustryMarketContentPatch,
  IndustryMarketContentPatchError,
  industryMarketDraftFromPayload,
} from '../apps/orchestrator-runtime/src/report/industry-market-content-patch.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { validIndustryMarketPayload } from './fixtures/industry-market.ts';

const patchSchema = 'schemas/skills/industry-market-content-patch-v1.schema.json';

test('Industry typed Patch changes only an authorized semantic leaf', () => {
  const source = industryMarketDraftFromPayload(validIndustryMarketPayload());
  const patch = {
    version: 'industry-market-content-patch-v1' as const,
    operations: [{
      op: 'replace_text' as const,
      reviewIssueId: 'issue-1',
      targetNodeId: 'strategy-1',
      field: 'designAction' as const,
      value: '增加配方证据卡，并在卡片内明确来源与适用对象。',
      reason: '补齐动作细节。',
    }],
  };
  new SchemaValidator().validateFileOrThrow(patchSchema, patch);
  const result = applyIndustryMarketContentPatch({
    source,
    patch,
    allowedReviewIssueTargets: new Map([['issue-1', new Set(['strategy-1'])]]),
  });

  assert.equal(result.draft.strategyChains[0]?.designAction, patch.operations[0]!.value);
  assert.equal(source.strategyChains[0]?.designAction, '增加配方证据卡。');
  assert.equal(result.draft.opportunities[0]?.statement, source.opportunities[0]?.statement);
});

test('Industry typed Patch rejects unauthorized nodes and non-patchable fields', () => {
  const source = industryMarketDraftFromPayload(validIndustryMarketPayload());
  assert.throws(() => applyIndustryMarketContentPatch({
    source,
    patch: {
      version: 'industry-market-content-patch-v1',
      operations: [{
        op: 'replace_text', reviewIssueId: 'issue-1', targetNodeId: 'strategy-1',
        field: 'statement', value: '越权修改', reason: '测试',
      }],
    },
    allowedReviewIssueTargets: new Map([['issue-1', new Set(['opportunity-1'])]]),
  }), IndustryMarketContentPatchError);

  assert.throws(() => applyIndustryMarketContentPatch({
    source,
    patch: {
      version: 'industry-market-content-patch-v1',
      operations: [{
        op: 'replace_text', reviewIssueId: 'issue-1', targetNodeId: 'strategy-1',
        field: 'statement', value: '不允许字段', reason: '测试',
      }],
    },
    allowedReviewIssueTargets: new Map([['issue-1', new Set(['strategy-1'])]]),
  }), IndustryMarketContentPatchError);
});

test('Industry support Patch can only lower certainty and cannot replace Evidence', () => {
  const source = industryMarketDraftFromPayload(validIndustryMarketPayload());
  const allowedReviewIssueTargets = new Map([['issue-1', new Set(['finding-1'])]]);
  assert.throws(() => applyIndustryMarketContentPatch({
    source,
    patch: {
      version: 'industry-market-content-patch-v1',
      operations: [{
        op: 'replace_support', reviewIssueId: 'issue-1', targetNodeId: 'finding-1', reason: '替换证据',
        value: { ...source.validatedFindings[0]!.support, evidenceIds: ['E2'] },
      }],
    },
    allowedReviewIssueTargets,
  }), /cannot replace question or Evidence/u);

  const provisional = structuredClone(source);
  provisional.validatedFindings[0]!.support = {
    ...provisional.validatedFindings[0]!.support,
    status: 'provisional', confidence: 0.4, validationNeeded: '待验证。',
  };
  assert.throws(() => applyIndustryMarketContentPatch({
    source: provisional,
    patch: {
      version: 'industry-market-content-patch-v1',
      operations: [{
        op: 'replace_support', reviewIssueId: 'issue-1', targetNodeId: 'finding-1', reason: '提升确定性',
        value: { ...provisional.validatedFindings[0]!.support, status: 'supported', confidence: 0.8 },
      }],
    },
    allowedReviewIssueTargets,
  }), /cannot increase certainty/u);
});

test('Industry Patch schema rejects whole-Draft replacement operations', () => {
  assert.throws(() => new SchemaValidator().validateFileOrThrow(patchSchema, {
    version: 'industry-market-content-patch-v1',
    operations: [{
      op: 'replace_payload', reviewIssueId: 'issue-1', targetNodeId: 'root',
      value: validIndustryMarketPayload(), reason: '禁止全文重写',
    }],
  }));
});

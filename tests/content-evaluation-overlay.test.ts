import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  addContentOverlayToKnowledge,
  assessContentEvaluation,
  loadContentOverlay,
} from '../evaluations/skills/content-overlay.ts';
import { loadRuntimeKnowledgeIndex } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import { dryRunContentEvaluation } from '../evaluations/skills/run.ts';
import { loadSkillRegistry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import type { LoadedEvaluationCase } from '../evaluations/skills/types.ts';
import type { KnowledgeContext, RetrievalRecord } from '../evaluations/skills/kb/types.ts';

const fixedCase: LoadedEvaluationCase = {
  data: JSON.parse(readFileSync('evaluations/skills/cases/competitive-analysis.json', 'utf8')),
  sourcePath: 'evaluations/skills/cases/competitive-analysis.json',
  caseHash: 'unused-by-assessor',
};

function baselineKnowledge(): { context: KnowledgeContext; retrieval: RetrievalRecord } {
  return {
    context: {
      mode: 'gold',
      snapshot_id: 'sha256:test',
      required_source_ids: ['baseline-method'],
      selected_source_ids: ['baseline-method'],
      items: [{
        source_id: 'baseline-method',
        title: 'Baseline method',
        source_path: 'methods/baseline.md',
        content_hash: 'sha256:baseline',
        status: 'draft',
        role: 'required',
        content: 'baseline',
      }],
    },
    retrieval: {
      mode: 'gold',
      snapshot_id: 'sha256:test',
      guide_tags: [],
      candidate_source_ids: ['baseline-method'],
      selected_source_ids: ['baseline-method'],
      required_source_recall: 1,
      missing_required_source_ids: [],
      unresolved_items: [],
    },
  };
}

function completeOutput(methodSourceId = 'ds-method-strategy-02-strategy-map'): Record<string, unknown> {
  const recommendation = 'P0：在比较页增加逐条来源入口';
  return {
    version: 'skill-output-v2',
    status: 'succeeded',
    summary: '证据透明是当前可验证的差异化机会。',
    findings: [],
    assumptions: [],
    limitations: [],
    recommendations: [recommendation],
    payload: {
      strategy_chains: [{
        recommendation,
        evidence_refs: ['C1'],
        method_source_ids: [methodSourceId],
        phenomenon: '选购星展示逐项来源链接。',
        claim_type: 'observed_fact',
        problem_attribution: '缺少来源入口会增加谨慎型消费者的核验成本。',
        insight: '证据可追溯性直接影响高客单决策信任。',
        strategy: '强化证据透明。',
        design_action: '在比较页每一项结论旁增加来源入口。',
        priority: {
          level: 'P0',
          user_impact: '降低核验成本',
          business_impact: '提高决策信任',
          cost_or_risk: '需控制来源失效风险',
        },
        metric: '来源入口点击后完成决策的比例',
        validation_method: '可用性测试并比较任务完成率',
      }],
    },
  };
}

test('existing KB evaluation dry-run reports the overlay and rejects production-search mode', () => {
  const report = dryRunContentEvaluation({
    runId: 'c1-dry-run',
    outputRoot: 'unused',
    concurrency: 1,
    resume: false,
    kbMode: 'gold',
    contentOverlay: 'user-research-hub-c1',
    contentVariant: 'enhanced',
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.selectedSkillIds.length, 23);
  assert.equal(report.contentEvaluation.promotionSet.knowledgeCandidateIds.length, 15);
  assert.equal(report.contentEvaluation.promotionSet.assetCandidateIds.length, 1);
  assert.equal(report.contentEvaluation.promotionSet.draftSkillIds.length, 1);
  assert.equal(report.contentEvaluation.promotionSet.skillDeltaIds.length, 2);
  assert.equal(report.checks.productionSearchUsed, false);
  assert.deepEqual(report.contentEvaluation.appliedSkillDeltaIds, [
    'trend-change-scan-delta',
    'experience-walkthrough-delta',
  ]);

  assert.throws(
    () => dryRunContentEvaluation({
      runId: 'invalid-live-run',
      outputRoot: 'unused',
      concurrency: 1,
      resume: false,
      kbMode: 'live',
      contentOverlay: 'user-research-hub-c1',
      contentVariant: 'enhanced',
    }),
    /gold.*production search/i,
  );
});

test('C1 overlay preserves the reviewed content set after owner-waived production activation', () => {
  const first = loadContentOverlay();
  const second = loadContentOverlay();
  const kinds = first.entries.map(({ metadata }) => metadata.kind);

  assert.equal(kinds.filter((kind) => kind === 'method').length, 15);
  assert.equal(kinds.filter((kind) => kind === 'asset').length, 1);
  assert.equal(kinds.filter((kind) => kind === 'draft_skill').length, 1);
  assert.equal(kinds.filter((kind) => kind === 'skill_delta').length, 2);
  assert.equal(first.manifestHash, second.manifestHash);
  assert.equal(first.contentSetHash, second.contentSetHash);
  assert.ok(first.entries.every(({ metadata }) => metadata.sourceHash.startsWith('sha256:')));
  assert.ok(first.entries.every(({ metadata }) => metadata.contentHash.startsWith('sha256:')));

  const runtimeIds = new Set(loadRuntimeKnowledgeIndex().map(({ id }) => id));
  for (const entry of first.entries.filter(({ metadata }) => metadata.kind === 'method')) {
    assert.equal(runtimeIds.has(entry.metadata.id), true, entry.metadata.id);
    assert.equal(entry.metadata.status, 'approved');
  }
  assert.equal(loadSkillRegistry().skills.find(({ id }) => id === 'solution-generation')?.status, 'draft');
  assert.equal(first.manifest.production_search_allowed, false);
  assert.equal(first.manifest.production_baseline.candidate_generation_mode, 'dynamic');
});

test('enhanced overlay injects frozen content by explicit binding and applies only the two narrow deltas', () => {
  const overlay = loadContentOverlay();
  const baseline = baselineKnowledge();
  const competitive = addContentOverlayToKnowledge(
    baseline.context,
    baseline.retrieval,
    overlay,
    'competitive-web-research',
  );
  const walkthrough = addContentOverlayToKnowledge(
    baseline.context,
    baseline.retrieval,
    overlay,
    'run-heuristic-evaluation',
  );

  assert.ok(competitive);
  assert.deepEqual(competitive.instructions.skillDeltaIds, ['trend-change-scan-delta']);
  assert.match(competitive.instructions.skillDeltaText, /dated, traceable public sources/);
  assert.ok(competitive.knowledgeContext.items.every(({ status }) => status === 'approved' || status === 'draft' || status === 'candidate'));
  assert.deepEqual(walkthrough?.instructions.skillDeltaIds, ['experience-walkthrough-delta']);
  assert.match(walkthrough?.instructions.skillDeltaText ?? '', /exact page\/state\/step/);
  assert.equal(addContentOverlayToKnowledge(baseline.context, baseline.retrieval, overlay, 'generate-survey'), undefined);

  assert.throws(
    () => addContentOverlayToKnowledge(
      { ...baseline.context, mode: 'live' },
      { ...baseline.retrieval, mode: 'live' },
      overlay,
      'competitive-web-research',
    ),
    /gold KB mode|production search/i,
  );
});

test('content assessment reports grounding and the complete strategy chain deterministically', () => {
  const overlay = loadContentOverlay();
  const assessment = assessContentEvaluation(fixedCase, completeOutput(), overlay, 'enhanced');

  assert.equal(assessment.grounding_verdict, 'pass');
  assert.equal(assessment.strategy_chain_verdict, 'pass');
  assert.deepEqual(assessment.grounding_criteria.map(({ id, status }) => [id, status]), [
    ['external_evidence_bound', 'pass'],
    ['candidate_sources_method_only', 'pass'],
    ['candidate_method_citation', 'pass'],
    ['source_reference_integrity', 'pass'],
    ['claim_type_explicit', 'pass'],
  ]);
  assert.deepEqual(assessment.strategy_chain_criteria.map(({ id }) => id), [
    'recommendation_coverage', 'evidence', 'phenomenon', 'problem_attribution',
    'insight', 'strategy', 'design_action', 'priority', 'metric', 'validation',
  ]);
  assert.deepEqual(assessment.cited_candidate_source_ids, ['ds-method-strategy-02-strategy-map']);
  assert.ok(assessment.tool_evidence_ids.includes('C1'));
});

test('content assessment rejects candidate-as-fact grounding and incomplete strategy chains', () => {
  const overlay = loadContentOverlay();
  const output = completeOutput();
  const chain = (output.payload as { strategy_chains: Array<Record<string, unknown>> }).strategy_chains[0]!;
  chain.evidence_refs = ['ds-method-strategy-02-strategy-map'];
  chain.method_source_ids = ['unknown-method'];
  delete chain.metric;

  const assessment = assessContentEvaluation(fixedCase, output, overlay, 'enhanced');
  assert.equal(assessment.grounding_verdict, 'fail');
  assert.equal(assessment.strategy_chain_verdict, 'fail');
  assert.ok(assessment.grounding_criteria.find(({ id }) => id === 'candidate_sources_method_only')?.status === 'fail');
  assert.ok(assessment.grounding_criteria.find(({ id }) => id === 'source_reference_integrity')?.status === 'fail');
  assert.ok(assessment.strategy_chain_criteria.find(({ id }) => id === 'metric')?.status === 'fail');
});

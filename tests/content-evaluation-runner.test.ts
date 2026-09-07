import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SkillCapability } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { runEvaluationBatch } from '../evaluations/skills/run.ts';
import type { SkillEvaluationRecord, SkillScorecard } from '../evaluations/skills/types.ts';
import type {
  GoldSourceSelection,
  KnowledgeContext,
  KnowledgeIndexItem,
  KnowledgeRetrievalResult,
  KnowledgeSnapshot,
  RetrievalRecord,
  SkillKnowledgeMapping,
} from '../evaluations/skills/kb/types.ts';

const skill: SkillCapability = {
  id: 'competitive-analysis',
  name: 'Competitive analysis',
  path: 'knowledge-base/skills/competitive-analysis',
  entry: 'knowledge-base/skills/competitive-analysis/SKILL.md',
  when_to_use: 'test',
  owner: 'test',
  status: 'active',
  risk_level: 'low',
};

function scorecard(): SkillScorecard {
  const maxima = [20, 20, 20, 15, 15, 10];
  const ids = ['workflow_adherence', 'method_correctness', 'completeness_structure', 'evidence_boundaries', 'actionability', 'risk_boundary_handling'];
  return {
    skill_id: skill.id,
    total_score: 100,
    verdict: 'pass',
    dimensions: ids.map((id, index) => ({ id, score: maxima[index]!, max_score: maxima[index]!, evidence: ['grounded'], defects: [] })),
    critical_defects: [],
    review_notes: [],
  };
}

function output(): Record<string, unknown> {
  const recommendation = 'P0：增加逐条来源入口';
  return {
    version: 'skill-output-v2', status: 'succeeded', summary: 'grounded', findings: [], assumptions: [], limitations: [],
    recommendations: [recommendation],
    payload: { strategy_chains: [{
      recommendation,
      evidence_refs: ['C1'],
      method_source_ids: ['ds-method-strategy-02-strategy-map'],
      phenomenon: '来源链接可见', claim_type: 'observed_fact', problem_attribution: '核验成本偏高',
      insight: '谨慎型用户需要可追溯依据', strategy: '提高证据透明度', design_action: '增加来源入口',
      priority: { level: 'P0', user_impact: '降低成本', business_impact: '增强信任', cost_or_risk: '链接维护成本' },
      metric: '任务完成率', validation_method: '可用性测试',
    }] },
  };
}

function kbDependencies() {
  const snapshot: KnowledgeSnapshot = {
    snapshot_id: 'sha256:test-snapshot', index_path: '/fixture/index.json', index_hash: 'sha256:test-index',
    built_at: '2026-08-21T00:00:00.000Z', source_files: [],
  };
  const mapping: SkillKnowledgeMapping = {
    skill_id: skill.id, kb_mode: 'required', required_sources: [], conditional_sources: [], optional_sources: [],
    retrieval_tags: [], source_status_policy: 'draft_allowed_with_warning', unresolved_items: [],
  };
  const selection: GoldSourceSelection = { skill_id: skill.id, mode: 'gold', selected_source_ids: [], unresolved_items: [] };
  const context: KnowledgeContext = { mode: 'gold', snapshot_id: snapshot.snapshot_id, required_source_ids: [], selected_source_ids: [], items: [] };
  const retrieval: RetrievalRecord = { mode: 'gold', snapshot_id: snapshot.snapshot_id, guide_tags: [], candidate_source_ids: [], selected_source_ids: [], required_source_recall: null, missing_required_source_ids: [], unresolved_items: [] };
  const result: KnowledgeRetrievalResult = { context, record: retrieval, warnings: [], failures: [] };
  return {
    loadKnowledgeSnapshot: () => ({ snapshot, index: new Map<string, KnowledgeIndexItem>(), warnings: [] }),
    loadSkillKnowledgeMappings: () => new Map([[skill.id, mapping]]),
    loadGoldSourceSelections: () => new Map([[skill.id, selection]]),
    loadGoldKnowledgeContext: () => result,
  };
}

test('runner keeps the baseline fixed and injects C1 content only in the enhanced variant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'content-eval-runner-'));
  const casesDir = join(root, 'cases');
  const outputRoot = join(root, 'output');
  mkdirSync(casesDir);
  writeFileSync(
    join(casesDir, 'competitive-analysis.json'),
    readFileSync('evaluations/skills/cases/competitive-analysis.json'),
  );
  const observed: Array<{ selectedIds: string[]; hasInstructions: boolean }> = [];
  const evaluator = {
    evaluate: async (
      loadedCase: { data: { skill_id: string }; caseHash: string },
      kb?: { knowledgeContext: KnowledgeContext },
      content?: unknown,
    ): Promise<SkillEvaluationRecord> => {
      observed.push({ selectedIds: kb?.knowledgeContext.selected_source_ids ?? [], hasInstructions: content !== undefined });
      return {
        skillId: loadedCase.data.skill_id,
        skillHash: 'sha256:production-skill',
        caseHash: loadedCase.caseHash,
        modelName: 'fixed-model',
        modelVersion: 'v1',
        elapsedMs: 1,
        status: 'succeeded',
        output: output(),
        scorecard: scorecard(),
      };
    },
  };
  const common = {
    outputRoot,
    casesDir,
    skillId: skill.id,
    concurrency: 1 as const,
    resume: false,
    kbMode: 'gold' as const,
    kbSnapshotId: 'sha256:test-snapshot',
    contentOverlay: 'user-research-hub-c1',
  };
  const dependencies = {
    skillLoader: { listActiveSkills: () => [skill], loadSkillBody: () => ({ body: '# baseline', hash: 'sha256:production-skill', path: skill.entry! }) },
    evaluator,
    kb: kbDependencies(),
    provider: 'fixture',
    expectedActualModel: 'fixed-model',
  };

  const baseline = await runEvaluationBatch({ ...common, runId: 'baseline', contentVariant: 'baseline' }, dependencies);
  const enhanced = await runEvaluationBatch({ ...common, runId: 'enhanced', contentVariant: 'enhanced' }, dependencies);

  assert.deepEqual(observed.map(({ hasInstructions }) => hasInstructions), [false, true]);
  assert.deepEqual(observed[0]?.selectedIds, []);
  assert.equal(observed[1]?.selectedIds.length, 11);
  assert.equal(baseline.contentEvaluation?.injectedSourceIds.length, 0);
  assert.equal(enhanced.contentEvaluation?.injectedSourceIds.length, 11);
  assert.equal(enhanced.contentEvaluation?.productionSearchUsed, false);
  assert.equal(baseline.records[0]?.contentAssessment?.variant, 'baseline');
  assert.equal(enhanced.records[0]?.contentAssessment?.grounding_verdict, 'pass');
  assert.equal(enhanced.records[0]?.contentAssessment?.strategy_chain_verdict, 'pass');
  assert.ok(readFileSync(join(outputRoot, 'enhanced', 'content-overlay.json'), 'utf8').includes('contentSetHash'));
  assert.ok(readFileSync(join(outputRoot, 'enhanced', skill.id, 'content-assessment.json'), 'utf8').includes('strategy_chain_verdict'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  SchemaValidationError,
  SchemaValidator,
} from '../apps/orchestrator-runtime/src/schema/validator.ts';

const validator = new SchemaValidator();
const researchPlanSchemaPath = join(
  process.cwd(),
  'schemas/deliverables/research-plan.schema.json',
);

function validResearchPlanPayload() {
  return {
    title: '宠物辅食竞品研究计划',
    researchGoal: '识别宠物辅食市场的主要竞品及其产品、价格与渠道差异',
    scope: {
      market: '中国大陆宠物辅食市场',
      subjects: ['犬用辅食', '猫用辅食'],
      timeWindow: '最近十二个月',
    },
    competitorSampling: {
      strategy: '按市场影响力与产品覆盖度分层抽样',
      targetCount: 6,
      inclusionCriteria: ['公开渠道可获取产品与品牌信息'],
      exclusionCriteria: ['已停止销售且无可核验公开资料'],
    },
    researchQuestions: ['主要竞品如何定位目标宠物与消费场景？'],
    comparisonDimensions: [
      {
        id: 'product-positioning',
        name: '产品定位',
        purpose: '比较各竞品的目标用户、宠物类型与核心卖点',
        collectionFields: ['目标宠物', '消费场景', '核心卖点'],
      },
    ],
    sourcePlan: [
      {
        evidenceClass: 'public_source',
        sourceTypes: ['品牌官网', '电商商品页'],
        purpose: '核验产品信息、价格与品牌定位',
      },
    ],
    executionPlan: [
      {
        phase: '竞品信息采集',
        activities: ['检索并记录入样品牌的公开资料'],
        duration: '2 个工作日',
        outputs: ['竞品信息采集表'],
      },
    ],
    collectionTemplate: [
      {
        field: '核心卖点',
        description: '品牌对产品价值的公开表述',
        evidenceRequired: true,
      },
    ],
    analysisMethods: ['横向维度对比'],
    deliverables: ['竞品研究报告'],
    qualityChecks: ['每项事实均关联可追溯公开来源'],
  };
}

test('完整 ResearchPlanPayload 通过计划交付物 schema 校验', () => {
  assert.doesNotThrow(() =>
    validator.validateFileOrThrow(researchPlanSchemaPath, validResearchPlanPayload()),
  );
});

test('ResearchPlanPayload 拒绝 targetCount=0', () => {
  const payload = validResearchPlanPayload();
  payload.competitorSampling.targetCount = 0;

  assert.throws(
    () => validator.validateFileOrThrow(researchPlanSchemaPath, payload),
    SchemaValidationError,
  );
});

test('ResearchPlanPayload 拒绝空 researchQuestions', () => {
  const payload = validResearchPlanPayload();
  payload.researchQuestions = [];

  assert.throws(
    () => validator.validateFileOrThrow(researchPlanSchemaPath, payload),
    SchemaValidationError,
  );
});

test('ResearchPlanPayload 拒绝缺失 comparisonDimensions', () => {
  const payload: Record<string, unknown> = validResearchPlanPayload();
  delete payload.comparisonDimensions;

  assert.throws(
    () => validator.validateFileOrThrow(researchPlanSchemaPath, payload),
    SchemaValidationError,
  );
});

test('Evidence Policy 保留历史竞品方案并提供六类 canonical mappings', () => {
  const policy = parseYaml(readFileSync(join(process.cwd(), 'orchestrator/evidence-policy.yaml'), 'utf8')) as {
    version: number;
    policies: Array<{
      task_type: string;
      deliverable_type: string;
      requirements: Array<{
        id: string;
        accepted_classes: string[];
        minimum_count: number;
        required: boolean;
      }>;
    }>;
  };

  assert.equal(policy.version, 1);
  const historical = policy.policies.find((entry) => (
    entry.task_type === 'competitive_research' && entry.deliverable_type === 'research_plan'
  ));
  assert.deepEqual(historical, {
    task_type: 'competitive_research',
    deliverable_type: 'research_plan',
    requirements: [{
      id: 'public-market-evidence',
      accepted_classes: ['public_source'],
      minimum_count: 1,
      required: true,
    }],
  });
  assert.deepEqual(policy.policies.filter((entry) => entry !== historical), [
    {
      task_type: 'user_research_planning',
      deliverable_type: 'research_plan',
      requirements: [{
        id: 'research-plan',
        accepted_classes: ['user_input', 'knowledge', 'public_source'],
        minimum_count: 1,
        required: true,
      }],
    },
    {
      task_type: 'research_synthesis',
      deliverable_type: 'research_strategy_report',
      requirements: [{
        id: 'research-strategy-report',
        accepted_classes: ['public_source', 'knowledge', 'user_input', 'dataset'],
        minimum_count: 1,
        required: true,
      }],
    },
    {
      task_type: 'competitive_research',
      deliverable_type: 'competitive_analysis_report',
      requirements: [{
        id: 'competitive-analysis-report',
        accepted_classes: ['public_source', 'screenshot'],
        minimum_count: 1,
        required: true,
      }],
    },
    {
      task_type: 'voc_diagnosis',
      deliverable_type: 'voc_diagnosis_report',
      requirements: [{
        id: 'voc-diagnosis-report',
        accepted_classes: ['dataset', 'user_input', 'public_source'],
        minimum_count: 1,
        required: true,
      }],
    },
    {
      task_type: 'design_audit',
      deliverable_type: 'design_audit_report',
      requirements: [{
        id: 'design-audit-report',
        accepted_classes: ['screenshot', 'user_input', 'public_source'],
        minimum_count: 1,
        required: true,
      }],
    },
    {
      task_type: 'a11y_audit',
      deliverable_type: 'accessibility_audit_report',
      requirements: [{
        id: 'accessibility-audit-report',
        accepted_classes: ['screenshot', 'user_input', 'public_source'],
        minimum_count: 1,
        required: true,
      }],
    },
  ]);
});

test('Deliverable Registry 将六类 active deliverable 绑定到冻结 payload schema', () => {
  const registry = parseYaml(readFileSync(join(process.cwd(), 'orchestrator/deliverable-registry.yaml'), 'utf8')) as {
    version: number;
    deliverables: Array<{
      id: string;
      status: string;
      envelope_version: string;
      payload_schema: string;
    }>;
  };

  assert.equal(registry.version, 2);
  assert.deepEqual(registry.deliverables.map(({ id, status, envelope_version, payload_schema }) => ({
    id,
    status,
    envelope_version,
    payload_schema,
  })), [
    {
      id: 'research_plan',
      status: 'active',
      envelope_version: 'research-deliverable-v1',
      payload_schema: 'schemas/deliverables/research-plan.schema.json',
    },
    {
      id: 'research_strategy_report',
      status: 'active',
      envelope_version: 'research-deliverable-v1',
      payload_schema: 'schemas/deliverables/research-strategy-report-v2.schema.json',
    },
    {
      id: 'competitive_analysis_report',
      status: 'active',
      envelope_version: 'research-deliverable-v1',
      payload_schema: 'schemas/deliverables/competitive-analysis-report.schema.json',
    },
    {
      id: 'voc_diagnosis_report',
      status: 'active',
      envelope_version: 'research-deliverable-v1',
      payload_schema: 'schemas/deliverables/voc-diagnosis-report.schema.json',
    },
    {
      id: 'design_audit_report',
      status: 'active',
      envelope_version: 'research-deliverable-v1',
      payload_schema: 'schemas/deliverables/design-audit-report.schema.json',
    },
    {
      id: 'accessibility_audit_report',
      status: 'active',
      envelope_version: 'research-deliverable-v1',
      payload_schema: 'schemas/deliverables/accessibility-audit-report.schema.json',
    },
  ]);
});

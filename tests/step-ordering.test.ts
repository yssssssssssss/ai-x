import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixStepOrdering } from '../apps/orchestrator-runtime/src/orchestrator.ts';

// 模拟 skillLoader:design-experience-review 依赖 attention-analysis-lab、aesthetic-quant-lab、vision-brand-lab
const mockSkillLoader = {
  getSkill(id: string) {
    if (id === 'design-experience-review') {
      return { required_tools: ['attention-analysis-lab', 'aesthetic-quant-lab', 'vision-brand-lab'] };
    }
    if (id === 'issue-prioritization') {
      return { required_tools: [] };
    }
    return null;
  },
};

test('fixStepOrdering:skill 排在 required_tool 前面时被移到后面', () => {
  const steps = [
    { step_no: 1, actor_type: 'llm', actor_id: 'llm', step_name: '理解' },
    { step_no: 2, actor_type: 'tool', actor_id: 'experience-model-lab', step_name: '匹配模型' },
    { step_no: 3, actor_type: 'skill', actor_id: 'design-experience-review', step_name: '设计评审' },
    { step_no: 4, actor_type: 'tool', actor_id: 'attention-analysis-lab', step_name: '注意力分析' },
    { step_no: 5, actor_type: 'skill', actor_id: 'issue-prioritization', step_name: '优先级排序' },
    { step_no: 6, actor_type: 'llm', actor_id: 'llm', step_name: '总结' },
  ];

  const reordered = fixStepOrdering(steps, mockSkillLoader);

  assert.equal(reordered, true);
  // design-experience-review 应该在 attention-analysis-lab 之后
  const reviewIdx = steps.findIndex((s) => s.actor_id === 'design-experience-review');
  const attentionIdx = steps.findIndex((s) => s.actor_id === 'attention-analysis-lab');
  assert.ok(reviewIdx > attentionIdx, `review(${reviewIdx}) should be after attention(${attentionIdx})`);
  // step_no 已重编
  for (let i = 0; i < steps.length; i++) {
    assert.equal(steps[i].step_no, i + 1);
  }
});

test('fixStepOrdering:多个 required_tool 都在方案中时,skill 排在最后一个之后', () => {
  const steps = [
    { step_no: 1, actor_type: 'skill', actor_id: 'design-experience-review', step_name: '设计评审' },
    { step_no: 2, actor_type: 'tool', actor_id: 'attention-analysis-lab', step_name: '注意力' },
    { step_no: 3, actor_type: 'tool', actor_id: 'aesthetic-quant-lab', step_name: '美学量化' },
    { step_no: 4, actor_type: 'tool', actor_id: 'vision-brand-lab', step_name: '品牌视觉' },
  ];

  const reordered = fixStepOrdering(steps, mockSkillLoader);

  assert.equal(reordered, true);
  const reviewIdx = steps.findIndex((s) => s.actor_id === 'design-experience-review');
  const brandIdx = steps.findIndex((s) => s.actor_id === 'vision-brand-lab');
  assert.ok(reviewIdx > brandIdx, `review(${reviewIdx}) should be after brand(${brandIdx}) which is the last dep`);
  assert.equal(steps[steps.length - 1].actor_id, 'design-experience-review');
});

test('fixStepOrdering:已正确排序时不修改', () => {
  const steps = [
    { step_no: 1, actor_type: 'tool', actor_id: 'attention-analysis-lab', step_name: '注意力' },
    { step_no: 2, actor_type: 'tool', actor_id: 'aesthetic-quant-lab', step_name: '美学量化' },
    { step_no: 3, actor_type: 'skill', actor_id: 'design-experience-review', step_name: '设计评审' },
    { step_no: 4, actor_type: 'llm', actor_id: 'llm', step_name: '总结' },
  ];

  const reordered = fixStepOrdering(steps, mockSkillLoader);

  assert.equal(reordered, false);
  assert.equal(steps[2].actor_id, 'design-experience-review');
});

test('fixStepOrdering:required_tool 不在方案中时不报错(speed 方案场景)', () => {
  // speed 方案只有 attention-analysis-lab,没有 aesthetic-quant-lab / vision-brand-lab
  const steps = [
    { step_no: 1, actor_type: 'skill', actor_id: 'design-experience-review', step_name: '设计评审' },
    { step_no: 2, actor_type: 'tool', actor_id: 'attention-analysis-lab', step_name: '注意力' },
  ];

  const reordered = fixStepOrdering(steps, mockSkillLoader);

  assert.equal(reordered, true);
  // 即使只有 attention 在方案中,review 也应该排在它后面
  assert.equal(steps[0].actor_id, 'attention-analysis-lab');
  assert.equal(steps[1].actor_id, 'design-experience-review');
});

test('fixStepOrdering:无 required_tools 的 skill 不受影响', () => {
  const steps = [
    { step_no: 1, actor_type: 'skill', actor_id: 'issue-prioritization', step_name: '排序' },
    { step_no: 2, actor_type: 'tool', actor_id: 'attention-analysis-lab', step_name: '注意力' },
  ];

  const reordered = fixStepOrdering(steps, mockSkillLoader);

  assert.equal(reordered, false);
  assert.equal(steps[0].actor_id, 'issue-prioritization');
});

test('fixStepOrdering:未知 skill(loader 返回 null)不报错', () => {
  const steps = [
    { step_no: 1, actor_type: 'skill', actor_id: 'unknown-skill', step_name: '未知' },
    { step_no: 2, actor_type: 'tool', actor_id: 'attention-analysis-lab', step_name: '注意力' },
  ];

  const reordered = fixStepOrdering(steps, mockSkillLoader);

  assert.equal(reordered, false);
});

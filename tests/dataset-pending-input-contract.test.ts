import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePendingInputContracts } from '../apps/orchestrator-runtime/src/control/pending-input-contract.ts';

test('dataset PendingInput is a first-class single-file input', () => {
  assert.deepEqual(parsePendingInputContracts([{
    kind: 'dataset',
    role: 'user_research_dataset',
    label: '匿名用户研究 CSV',
    multiple: false,
    targets: [{
      step_no: 4,
      tool_id: 'industry-market-analysis',
      field: 'user_research_dataset',
      multiple: false,
    }],
  }]), [{
    kind: 'dataset',
    role: 'user_research_dataset',
    label: '匿名用户研究 CSV',
    multiple: false,
    targets: [{
      step_no: 4,
      tool_id: 'industry-market-analysis',
      field: 'user_research_dataset',
      multiple: false,
    }],
  }]);
});

test('dataset PendingInput rejects multiple files in V1', () => {
  assert.throws(() => parsePendingInputContracts([{
    kind: 'dataset',
    role: 'user_research_dataset',
    label: '匿名用户研究 CSV',
    multiple: true,
    targets: [{
      step_no: 4,
      tool_id: 'industry-market-analysis',
      field: 'user_research_dataset',
      multiple: true,
    }],
  }]), /dataset.*multiple/u);
});

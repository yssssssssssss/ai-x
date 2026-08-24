import assert from 'node:assert/strict';
import { test } from 'node:test';

import { researchStrategyContentDraftFromPayload } from '../apps/orchestrator-runtime/src/report/research-strategy-deliverable-assembler.ts';
import {
  assertSemanticRevisionFidelity,
  assertStructuralRepairFidelity,
  compareResearchStrategyContentFidelity,
  inventoryResearchStrategyContent,
  ResearchStrategyContentFidelityError,
} from '../apps/orchestrator-runtime/src/report/research-strategy-content-fidelity.ts';
import { researchStrategyPayloadV2 } from './fixtures/research-strategy-v2.ts';

function contentDraft() {
  const payload = researchStrategyPayloadV2();
  return researchStrategyContentDraftFromPayload(payload, 'Synthesized verified evidence.');
}

test('content inventory fingerprints every semantic unit and ignores support metadata', () => {
  const source = contentDraft();
  const candidate = structuredClone(source);
  candidate.directAnswers[0]!.evidenceIds = ['E2'];
  candidate.directAnswers[0]!.confidence = 0.4;
  candidate.evidenceFindings[0]!.support.status = 'provisional';
  candidate.evidenceFindings[0]!.support.validationNeeded = 'Validate again.';
  const map = candidate.contentBlocks[0]!;
  assert.equal(map.kind, 'strategy_map');
  if (map.kind === 'strategy_map') map.cells[0]!.support.questionIds = ['Q2'];

  const inventory = inventoryResearchStrategyContent(source);
  const result = assertStructuralRepairFidelity(source, candidate);

  assert.equal(inventory.length, 10);
  assert.equal(result.preservedUnitCount, 10);
  assert.deepEqual(result.changedSemanticUnitKeys, []);
  assert.deepEqual(result.removedUnitKeys, []);
});

test('structural repair fidelity rejects changed prose, removed units, and reordering', () => {
  const source = contentDraft();

  const changed = structuredClone(source);
  changed.directAnswers[0]!.answer = 'A shorter replacement answer.';
  assert.throws(
    () => assertStructuralRepairFidelity(source, changed),
    (error: unknown) => error instanceof ResearchStrategyContentFidelityError
      && error.result.changedSemanticUnitKeys.includes('direct-answer:001'),
  );

  const removed = structuredClone(source);
  removed.contentBlocks.pop();
  assert.throws(
    () => assertStructuralRepairFidelity(source, removed),
    (error: unknown) => error instanceof ResearchStrategyContentFidelityError
      && error.result.removedUnitKeys.some((key) => key.startsWith('content-block:content-block-002')),
  );

  const reordered = structuredClone(source);
  reordered.contentBlocks.reverse();
  assert.throws(
    () => assertStructuralRepairFidelity(source, reordered),
    (error: unknown) => error instanceof ResearchStrategyContentFidelityError
      && error.result.reorderedUnitKeys.length > 0,
  );
});

test('structural repair fidelity permits additive content without changing existing units', () => {
  const source = contentDraft();
  const candidate = structuredClone(source);
  candidate.limitations.push('Additional disclosed limitation.');

  const result = assertStructuralRepairFidelity(source, candidate);

  assert.deepEqual(result.addedUnitKeys, ['limitation:001']);
  assert.equal(result.removedUnitKeys.length, 0);
  assert.equal(result.changedSemanticUnitKeys.length, 0);
});

test('semantic revision fidelity permits only explicitly authorized semantic units', () => {
  const source = contentDraft();
  const candidate = structuredClone(source);
  candidate.directAnswers[0]!.answer = 'A deliberately weakened answer.';

  assert.doesNotThrow(() => assertSemanticRevisionFidelity(
    source,
    candidate,
    new Set(['direct-answer:001']),
  ));
  assert.throws(
    () => assertSemanticRevisionFidelity(source, candidate, new Set()),
    (error: unknown) => error instanceof ResearchStrategyContentFidelityError
      && /unauthorized units/u.test(error.message),
  );
});

test('content inventory rejects duplicate stable keys', () => {
  const candidate = contentDraft();
  candidate.contentBlocks.push(structuredClone(candidate.contentBlocks[0]!));

  assert.throws(
    () => compareResearchStrategyContentFidelity(contentDraft(), candidate),
    (error: unknown) => error instanceof ResearchStrategyContentFidelityError
      && /duplicate content unit/u.test(error.message),
  );
});

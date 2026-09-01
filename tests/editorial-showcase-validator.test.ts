import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts';
import {
  EditorialShowcaseValidationError,
  validateEditorialShowcase,
} from '../apps/orchestrator-runtime/src/report/editorial-showcase-validator.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

test('rebuilds and validates the deterministic Showcase publication', () => {
  const fixture = showcaseFixture();
  const compiled = compileEditorialShowcase({ material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null });
  const rendered = renderEditorialShowcase({ spec: compiled.spec });
  const review = validateEditorialShowcase({
    material: fixture.material,
    sourcePacket: fixture.sourcePacket,
    spec: compiled.spec,
    renderResult: rendered,
  });

  assert.equal(review.version, 'universal-editorial-showcase-validation-v1');
  assert.equal(review.verdict, 'pass');
  assert.equal(review.specHash, compiled.hash);
  assert.equal(review.htmlHash, rendered.htmlHash);
  assert.equal(review.componentCount, compiled.spec.sections.flatMap(({ components }) => components).length);
  assert.equal(review.ownedBodyUnitCount, fixture.material.units.filter(({ requiredInBody }) => requiredInBody).length);
  assert.equal(review.promotedSupportingUnitCount, compiled.spec.promotedSupportingUnitIds.length);
  assert.equal(review.ownedAuditUnitCount, fixture.material.units.filter(({ requiredInOutput, requiredInBody, id }) => (
    requiredInOutput && !requiredInBody && !compiled.spec.promotedSupportingUnitIds.includes(id)
  )).length);

  const tampered = {
    ...rendered,
    htmlBytes: Buffer.from(rendered.htmlBytes.toString('utf8').replace('研究如何推进', '未授权改写')),
  };
  assert.throws(
    () => validateEditorialShowcase({
      material: fixture.material,
      sourcePacket: fixture.sourcePacket,
      spec: compiled.spec,
      renderResult: tampered,
    }),
    (error: unknown) => error instanceof EditorialShowcaseValidationError
      && error.code === 'SHOWCASE_VALIDATION_FAILED',
  );
});

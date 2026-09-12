import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { loadEditorialShowcaseProfile } from '../apps/orchestrator-runtime/src/report/editorial-showcase-profile.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

test('Showcase schemas accept compiled contracts and reject model-authored HTML', () => {
  const validator = new SchemaValidator();
  const fixture = showcaseFixture();
  const compiled = compileEditorialShowcase({ material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null });
  const rendered = renderEditorialShowcase({ spec: compiled.spec });
  const profile = loadEditorialShowcaseProfile();

  assert.deepEqual(validator.validate('universal-editorial-presentation-spec-v1', compiled.spec), []);
  assert.deepEqual(validator.validate('universal-editorial-showcase-render-manifest-v1', rendered.renderManifest), []);
  assert.deepEqual(validator.validate('universal-editorial-showcase-profile-v1', profile.profile), []);

  const intent = {
    version: 'universal-editorial-showcase-intent-v1',
    profileId: 'universal-editorial-showcase-v1',
    sections: [{
      id: 'decision', role: 'decision', title: '核心判断',
      componentIds: ['showcase-hero'],
    }],
  };
  assert.deepEqual(validator.validate('universal-editorial-showcase-intent-v1', intent), []);
  assert.notDeepEqual(validator.validate('universal-editorial-showcase-intent-v1', { ...intent, html: '<main>unsafe</main>' }), []);
});

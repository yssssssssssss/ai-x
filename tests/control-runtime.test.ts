import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visualAssetManifestStorageUri } from '../apps/agent-api/src/control-runtime.ts';

test('visual asset resolver derives manifests for PNG and chart SVG storage', () => {
  assert.equal(
    visualAssetManifestStorageUri('/runs/visual-assets/capture.image'),
    '/runs/visual-assets/capture.manifest.json',
  );
  assert.equal(
    visualAssetManifestStorageUri('/runs/visual-assets/chart.svg'),
    '/runs/visual-assets/chart.manifest.json',
  );
  assert.equal(visualAssetManifestStorageUri('/runs/visual-assets/unknown.bin'), null);
});

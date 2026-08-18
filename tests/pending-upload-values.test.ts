import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendingImageUploads } from '../apps/web/src/pending-upload-values.ts';

test('pending image uploads retain all files only for plural visual roles', () => {
  const pending = [
    { role: 'screenshots', label: 'Screenshots', multiple: true, targets: [] },
    { role: 'design', label: 'Design', multiple: false, targets: [] },
  ];
  assert.deepEqual(pendingImageUploads(pending, {
    screenshots: ['data:image/png;base64,one', 'data:image/png;base64,two'],
    design: ['data:image/png;base64,first', 'data:image/png;base64,ignored'],
  }), [
    { role: 'screenshots', dataUrl: 'data:image/png;base64,one' },
    { role: 'screenshots', dataUrl: 'data:image/png;base64,two' },
    { role: 'design', dataUrl: 'data:image/png;base64,first' },
  ]);
});

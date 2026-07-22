import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { RunWorkspace } from '../apps/orchestrator-runtime/src/run-workspace.ts';

test('媒体资产校验、落盘和读取保持任务隔离', () => {
  const taskId = `media-test-${Date.now()}`;
  const ws = new RunWorkspace(taskId);
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload')]);
    const asset = ws.writeMediaAsset({ role: 'design', mimeType: 'image/png', data: png, fileName: 'draft.png' });
    assert.equal(asset.role, 'design');
    assert.deepEqual(ws.readMediaData(asset.id), png);
    assert.ok(ws.readMediaDataUrl(asset.id).startsWith('data:image/png;base64,'));
    assert.throws(() => ws.readMediaAsset('../outside'), /媒体资产不存在/);
  } finally {
    rmSync(ws.uri, { recursive: true, force: true });
  }
});

test('媒体声明与文件魔数不一致时拒绝', () => {
  const ws = new RunWorkspace(`media-invalid-${Date.now()}`);
  try {
    assert.throws(
      () => ws.writeMediaAsset({ role: 'design', mimeType: 'image/png', data: Buffer.from('not-a-png') }),
      /内容与 Content-Type 不匹配/,
    );
  } finally {
    rmSync(ws.uri, { recursive: true, force: true });
  }
});

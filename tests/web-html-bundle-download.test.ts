import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api, ApiError } from '../apps/web/src/api/client.ts';

const originalFetch = globalThis.fetch;
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorageDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage');
  } else {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
  }
});

function installLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
}

test('HTML Bundle client uses only encoded Task and Attempt bindings', async () => {
  installLocalStorage();
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    });
  };

  const response = await api.controlHtmlBundle('task/one', 'attempt?two');

  assert.equal(
    requestedUrl,
    '/api/control-tasks/task%2Fone/reports/attempt%3Ftwo/html-bundle',
  );
  assert.deepEqual(
    new Uint8Array(await response.blob.arrayBuffer()),
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  );
});

test('Editorial Showcase client uses encoded bindings and requires HTML', async () => {
  installLocalStorage();
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response('<!doctype html><title>Showcase</title>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const response = await api.controlEditorialShowcase('task/one', 'attempt?two');
  assert.equal(
    requestedUrl,
    '/api/control-tasks/task%2Fone/reports/attempt%3Ftwo/editorial-showcase.html',
  );
  assert.match(await response.blob.text(), /Showcase/u);

  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    api.controlEditorialShowcase('task-1', 'attempt-1'),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
});

test('HTML Bundle client rejects a non-ZIP response', async () => {
  installLocalStorage();
  globalThis.fetch = async () => new Response('<html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await assert.rejects(
    api.controlHtmlBundle('task-1', 'attempt-1'),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
});

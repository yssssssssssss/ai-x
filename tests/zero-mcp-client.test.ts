import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, test } from 'node:test';
import {
  LocalZeroMcpClient,
  ZeroMcpClientError,
} from '../apps/agent-api/src/integrations/zero/zero-mcp-client.ts';

const REQUIRED_TOOLS = [
  'resources_list',
  'resources_read',
  'get_zero_status',
  'get_design_metadata',
  'get_design_context',
  'get_screenshot',
  'use_design_html',
  'use_design_script',
];

interface FakeOptions {
  tools?: string[];
  screenshotUrl?: string;
  screenshotContentType?: string;
  screenshotBytes?: Uint8Array;
  delayMs?: number;
  session?: boolean;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function sendSse(res: ServerResponse, value: unknown, session?: boolean): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  if (session) res.setHeader('Mcp-Session-Id', 'fake-session');
  res.end(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function fakeZero(options: FakeOptions = {}): Promise<{ url: string; calls: Array<Record<string, unknown>> }> {
  const calls: Array<Record<string, unknown>> = [];
  const image = options.screenshotBytes ?? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === '/assets/screenshot.png') {
      res.statusCode = 200;
      res.setHeader('Content-Type', options.screenshotContentType ?? 'image/png');
      res.end(image);
      return;
    }
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const message = await body(req);
    calls.push(message);
    const id = message.id;
    const method = message.method;
    if (method === 'notifications/initialized') {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === 'initialize') {
      sendSse(res, {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'zero-design', version: '1.0.0' },
        },
      }, options.session);
      return;
    }
    if (method === 'tools/list') {
      sendSse(res, {
        jsonrpc: '2.0', id,
        result: { tools: (options.tools ?? REQUIRED_TOOLS).map((name) => ({ name })) },
      });
      return;
    }
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (method !== 'tools/call' || !params?.name) {
      sendSse(res, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } });
      return;
    }
    if (params.name === 'resources_read') {
      sendSse(res, { jsonrpc: '2.0', id, result: { structuredContent: { contents: [{ text: '# skill' }] } } });
      return;
    }
    if (params.name === 'get_zero_status') {
      sendSse(res, {
        jsonrpc: '2.0', id,
        result: { structuredContent: { version: '3.12.8', authenticated: true } },
      });
      return;
    }
    if (params.name === 'get_design_metadata') {
      sendSse(res, {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: '<canvas id="30:1" name="[p]demo" />' }] },
      });
      return;
    }
    if (params.name === 'use_design_html') {
      sendSse(res, {
        jsonrpc: '2.0', id,
        result: { structuredContent: { nodeIds: ['31:2'], nodes: [{ id: '31:2', x: 1, y: 2, width: 1440, height: 5200 }] } },
      });
      return;
    }
    if (params.name === 'use_design_script') {
      const code = String(params.arguments?.code ?? '');
      const result = code.includes('currentPage') && code.includes('fileKey')
        ? { fileKey: 'file-1', pageId: '30:1', pageName: '[p]demo' }
        : code.includes('return { nodes:')
          ? { nodes: [{ id: '31:3', name: 'image', fills: [{ type: 'IMAGE', imageHash: 'hash-1', scaleMode: 'FIT' }] }] }
          : { mutatedNodeIds: ['31:3'], nodeId: '31:3', imageHash: 'hash-1', finalRootNodeId: '31:2' };
      sendSse(res, { jsonrpc: '2.0', id, result: { structuredContent: result } });
      return;
    }
    if (params.name === 'get_screenshot') {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      sendSse(res, {
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              image_url: options.screenshotUrl ?? `http://localhost:${port}/assets/screenshot.png`,
              width: 100,
              height: 200,
              format: 'png',
              original_width: 100,
              original_height: 200,
            }),
          }],
        },
      });
      return;
    }
    sendSse(res, { jsonrpc: '2.0', id, result: { structuredContent: {} } });
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.writableEnded) res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, calls };
}

test('Zero MCP client supports stateless and session-aware SSE protocol', async () => {
  for (const session of [false, true]) {
    const fake = await fakeZero({ session });
    const client = new LocalZeroMcpClient({ url: fake.url, timeoutMs: 2_000 });
    assert.deepEqual(await client.getStatus(), {
      available: true,
      authenticated: true,
      version: '3.12.8',
    });
    assert.ok(fake.calls.some((call) => call.method === 'initialize'));
    assert.ok(fake.calls.some((call) => call.method === 'tools/list'));
  }
});

test('Zero MCP client loads required resources before HTML and script writes', async () => {
  const fake = await fakeZero();
  const client = new LocalZeroMcpClient({ url: fake.url, timeoutMs: 2_000 });
  assert.deepEqual(await client.getCurrentTarget(), {
    fileKey: 'file-1',
    pageId: '30:1',
    pageName: '[p]demo',
  });
  assert.equal((await client.createHtmlDraft({ html: '<main>report</main>', name: 'Report' })).rootNodeId, '31:2');
  assert.equal((await client.writeImage({
    pageName: '[p]demo',
    nodeId: '31:3',
    bytes: new Uint8Array([1, 2, 3]),
    description: 'write image',
  })).imageHash, 'hash-1');
  const resourceReads = fake.calls.filter((call) => (
    call.method === 'tools/call'
    && (call.params as { name?: string } | undefined)?.name === 'resources_read'
  ));
  assert.equal(resourceReads.length, 3, 'HTML skill, script skill, and API index load once');
});

test('Zero MCP client inspects IMAGE fills and downloads a bounded screenshot', async () => {
  const fake = await fakeZero();
  const client = new LocalZeroMcpClient({ url: fake.url, timeoutMs: 2_000 });
  const inspection = await client.inspectNode('31:3');
  assert.equal(inspection.nodes[0]?.fills[0]?.type, 'IMAGE');
  const screenshot = await client.captureScreenshot('31:2', 4096);
  assert.deepEqual([...screenshot.bytes], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(screenshot.contentType, 'image/png');
  assert.equal(screenshot.width, 100);
  assert.equal(screenshot.height, 200);
});

test('Zero MCP client rejects missing tools, non-loopback URLs, and unsafe screenshot URLs', async () => {
  assert.throws(
    () => new LocalZeroMcpClient({ url: 'https://zero.example.com/mcp' }),
    ZeroMcpClientError,
  );
  const missing = await fakeZero({ tools: REQUIRED_TOOLS.filter((name) => name !== 'use_design_script') });
  await assert.rejects(
    () => new LocalZeroMcpClient({ url: missing.url, timeoutMs: 2_000 }).getStatus(),
    /required tool use_design_script/,
  );
  const unsafe = await fakeZero({ screenshotUrl: 'https://example.com/assets/screenshot.png' });
  await assert.rejects(
    () => new LocalZeroMcpClient({ url: unsafe.url, timeoutMs: 2_000 }).captureScreenshot('31:2', 4096),
    /screenshot URL/,
  );
});

test('Zero MCP client reports offline timeouts without leaking raw transport errors', async () => {
  const fake = await fakeZero({ delayMs: 100 });
  const client = new LocalZeroMcpClient({ url: fake.url, timeoutMs: 10 });
  await assert.rejects(
    () => client.getStatus(),
    (error: unknown) => error instanceof ZeroMcpClientError
      && error.code === 'zero_offline'
      && !error.message.includes(fake.url),
  );
});

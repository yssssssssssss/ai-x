import { isZeroNodeId } from '../../../../../packages/api-contract/zero-publication.ts';

const REQUIRED_TOOLS = [
  'resources_list',
  'resources_read',
  'get_zero_status',
  'get_design_metadata',
  'get_design_context',
  'get_screenshot',
  'use_design_html',
  'use_design_script',
] as const;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCRIPT_CHARS = 50_000;
const HTML_SKILL_URI = 'file://use-design-html/SKILL.md';
const SCRIPT_SKILL_URI = 'file://use-design-script/SKILL.md';
const SCRIPT_API_INDEX_URI = 'file://use-design-script/references/relay-plugin-api-index.md';

export class ZeroMcpClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ZeroMcpClientError';
  }
}

export interface ZeroClientStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
}

export interface ZeroTargetContext {
  fileKey: string;
  pageId: string;
  pageName: string;
}

export interface ZeroNodeInspection {
  nodes: Array<{
    id: string;
    name: string;
    fills: Array<{ type: string; imageHash?: string; scaleMode?: string }>;
  }>;
}

export interface ZeroScreenshot {
  bytes: Uint8Array;
  contentType: 'image/png';
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

interface McpEnvelope {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loopback(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1';
}

function endpoint(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ZeroMcpClientError('zero_invalid_url', 'Zero MCP URL is invalid');
  }
  if (
    parsed.protocol !== 'http:'
    || !loopback(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/mcp'
    || parsed.search
    || parsed.hash
  ) {
    throw new ZeroMcpClientError('zero_invalid_url', 'Zero MCP URL must be a loopback /mcp endpoint');
  }
  return parsed;
}

function parseSse(text: string): McpEnvelope {
  const messages = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as McpEnvelope);
  if (messages.length === 0) {
    throw new ZeroMcpClientError('zero_protocol_error', 'Zero MCP returned no SSE message');
  }
  return messages[messages.length - 1]!;
}

function toolData<T>(result: unknown): T {
  if (!isRecord(result)) {
    throw new ZeroMcpClientError('zero_protocol_error', 'Zero MCP tool result is malformed');
  }
  const tool = result as ToolResult;
  if (tool.isError) {
    const message = tool.content?.find((item) => item.type === 'text')?.text;
    throw new ZeroMcpClientError(
      'zero_tool_error',
      typeof message === 'string' && message.trim() ? message : 'Zero MCP tool call failed',
    );
  }
  if (tool.structuredContent !== undefined) return tool.structuredContent as T;
  const text = tool.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new ZeroMcpClientError('zero_protocol_error', 'Zero MCP tool returned no structured content');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export class LocalZeroMcpClient {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private sequence = 0;
  private initialized: Promise<void> | null = null;
  private htmlSkillLoaded = false;
  private scriptResourcesLoaded = false;

  constructor(options: { url: string; timeoutMs?: number }) {
    this.url = endpoint(options.url);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private nextId(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private async request(
    message: Record<string, unknown>,
    options: { allowEmpty?: boolean } = {},
  ): Promise<McpEnvelope | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ZeroMcpClientError(
          response.status === 401 || response.status === 403
            ? 'zero_unauthenticated'
            : 'zero_protocol_error',
          `Zero MCP request failed with HTTP ${response.status}`,
          response.status >= 500,
        );
      }
      this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
      const text = await response.text();
      if (!text.trim() && options.allowEmpty) return null;
      const contentType = response.headers.get('content-type') ?? '';
      const payload = contentType.includes('text/event-stream')
        ? parseSse(text)
        : JSON.parse(text) as McpEnvelope;
      if (payload.error) {
        throw new ZeroMcpClientError(
          'zero_protocol_error',
          typeof payload.error.message === 'string'
            ? payload.error.message
            : 'Zero MCP returned an error',
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof ZeroMcpClientError) throw error;
      throw new ZeroMcpClientError('zero_offline', 'Zero MCP is unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize().catch((error) => {
        this.initialized = null;
        throw error;
      });
    }
    await this.initialized;
  }

  private async initialize(): Promise<void> {
    const initialized = await this.request({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'ai-x-zero-publication', version: '1.0.0' },
      },
    });
    if (!isRecord(initialized?.result)) {
      throw new ZeroMcpClientError('zero_protocol_error', 'Zero MCP initialize response is malformed');
    }
    await this.request({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, { allowEmpty: true });
    const listed = await this.request({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/list',
      params: {},
    });
    const listResult = isRecord(listed?.result) ? listed.result : null;
    const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    const names = new Set(tools.flatMap((item) => {
      const candidate = isRecord(item) ? item.name : null;
      return typeof candidate === 'string' ? [candidate] : [];
    }));
    for (const required of REQUIRED_TOOLS) {
      if (!names.has(required)) {
        throw new ZeroMcpClientError(
          'zero_missing_tools',
          `Zero MCP is missing required tool ${required}`,
        );
      }
    }
  }

  private async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized();
    const payload = await this.request({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return toolData<T>(payload?.result);
  }

  private async loadHtmlSkill(): Promise<void> {
    if (this.htmlSkillLoaded) return;
    await this.callTool('resources_read', { uri: HTML_SKILL_URI });
    this.htmlSkillLoaded = true;
  }

  private async loadScriptResources(): Promise<void> {
    if (this.scriptResourcesLoaded) return;
    await this.callTool('resources_read', { uri: SCRIPT_SKILL_URI });
    await this.callTool('resources_read', { uri: SCRIPT_API_INDEX_URI });
    this.scriptResourcesLoaded = true;
  }

  async getStatus(): Promise<ZeroClientStatus> {
    const status = await this.callTool<{ version?: unknown; authenticated?: unknown }>(
      'get_zero_status',
      {},
    );
    if (typeof status.authenticated !== 'boolean') {
      throw new ZeroMcpClientError('zero_protocol_error', 'Zero status is malformed');
    }
    return {
      available: true,
      authenticated: status.authenticated,
      ...(typeof status.version === 'string' ? { version: status.version } : {}),
    };
  }

  async getCurrentTarget(): Promise<ZeroTargetContext> {
    const metadata = await this.callTool<string>('get_design_metadata', {
      maxDepth: 1,
      maxNodes: 50,
    });
    const match = typeof metadata === 'string'
      ? metadata.match(/<canvas\s+id="([^"]+)"\s+name="([^"]+)"/u)
      : null;
    if (!match || !isZeroNodeId(match[1])) {
      throw new ZeroMcpClientError('zero_no_design_tab', 'Zero has no current design page');
    }
    await this.loadScriptResources();
    const file = await this.callTool<{ fileKey?: unknown; pageId?: unknown; pageName?: unknown }>(
      'use_design_script',
      {
        description: 'Read the current Zero file identity for report publication',
        code: `return { fileKey: relay.fileKey, pageId: relay.currentPage.id, pageName: relay.currentPage.name }`,
      },
    );
    if (typeof file.fileKey !== 'string' || !file.fileKey.trim()) {
      throw new ZeroMcpClientError('zero_no_design_tab', 'Zero current design has no file key');
    }
    return { fileKey: file.fileKey, pageId: match[1], pageName: match[2]! };
  }

  async createHtmlDraft(input: {
    html: string;
    name: string;
    x?: number;
    y?: number;
  }): Promise<{ rootNodeId: string; x: number; y: number; width: number; height: number }> {
    await this.loadHtmlSkill();
    const created = await this.callTool<{
      nodeIds?: unknown;
      nodes?: unknown;
    }>('use_design_html', {
      htmlContent: input.html,
      appType: 'web',
      name: input.name,
      ...(input.x === undefined ? {} : { x: input.x }),
      ...(input.y === undefined ? {} : { y: input.y }),
    });
    const nodeIds = Array.isArray(created.nodeIds) ? created.nodeIds : [];
    const nodes = Array.isArray(created.nodes) ? created.nodes : [];
    const rootNodeId = nodeIds[0];
    const node = isRecord(nodes[0]) ? nodes[0] : null;
    if (
      !isZeroNodeId(rootNodeId)
      || node?.id !== rootNodeId
      || typeof node.x !== 'number'
      || typeof node.y !== 'number'
      || typeof node.width !== 'number'
      || typeof node.height !== 'number'
    ) {
      throw new ZeroMcpClientError('html_write_failed', 'Zero HTML draft response is malformed');
    }
    return {
      rootNodeId,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
  }

  async writeImage(input: {
    pageName: string;
    nodeId: string;
    bytes: Uint8Array;
    description: string;
  }): Promise<{ nodeId: string; imageHash: string }> {
    if (!isZeroNodeId(input.nodeId)) {
      throw new ZeroMcpClientError('image_write_failed', 'Zero image node ID is invalid');
    }
    await this.loadScriptResources();
    const encoded = Buffer.from(input.bytes).toString('base64');
    const code = `
const page = relay.root.children.find((candidate) => candidate.type === 'PAGE' && candidate.name === ${JSON.stringify(input.pageName)})
if (!page) throw new Error('target page unavailable')
await relay.setCurrentPageAsync(page)
const node = await relay.getNodeByIdAsync(${JSON.stringify(input.nodeId)})
if (!node || (node.type !== 'RECTANGLE' && node.type !== 'FRAME')) throw new Error('image node unavailable')
const image = relay.createImage(relay.base64Decode(${JSON.stringify(encoded)}))
node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FIT' }]
return { mutatedNodeIds: [node.id], nodeId: node.id, imageHash: image.hash }
`;
    if (code.length > MAX_SCRIPT_CHARS) {
      throw new ZeroMcpClientError('image_script_too_large', 'Zero image script exceeds the size limit');
    }
    const result = await this.callTool<{ nodeId?: unknown; imageHash?: unknown }>(
      'use_design_script',
      { code, description: input.description },
    );
    if (result.nodeId !== input.nodeId || typeof result.imageHash !== 'string') {
      throw new ZeroMcpClientError('image_write_failed', 'Zero image write response is malformed');
    }
    return { nodeId: input.nodeId, imageHash: result.imageHash };
  }

  async inspectNode(nodeId: string): Promise<ZeroNodeInspection> {
    if (!isZeroNodeId(nodeId)) {
      throw new ZeroMcpClientError('metadata_mismatch', 'Zero node ID is invalid');
    }
    await this.loadScriptResources();
    const code = `
const node = await relay.getNodeByIdAsync(${JSON.stringify(nodeId)})
if (!node) throw new Error('node unavailable')
const nodes = node.type === 'RECTANGLE' || node.type === 'FRAME'
  ? [node]
  : node.query('RECTANGLE, FRAME').toArray()
return { nodes: nodes.map((item) => ({ id: item.id, name: item.name, fills: item.fills })) }
`;
    const result = await this.callTool<ZeroNodeInspection>(
      'use_design_script',
      { code, description: 'Inspect Zero report publication node fills' },
    );
    if (!Array.isArray(result.nodes)) {
      throw new ZeroMcpClientError('metadata_mismatch', 'Zero node inspection is malformed');
    }
    return result;
  }

  private screenshotUrl(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot URL is invalid');
    }
    if (
      parsed.protocol !== this.url.protocol
      || parsed.port !== this.url.port
      || !loopback(parsed.hostname)
      || !parsed.pathname.startsWith('/assets/')
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot URL is not trusted');
    }
    return parsed;
  }

  async captureScreenshot(nodeId: string, maxDimension: number): Promise<ZeroScreenshot> {
    if (!isZeroNodeId(nodeId)) {
      throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot node ID is invalid');
    }
    const generated = await this.callTool<unknown>('get_screenshot', { nodeId, maxDimension });
    let metadata: Record<string, unknown> | null = isRecord(generated) ? generated : null;
    if (!metadata && typeof generated === 'string') {
      try {
        metadata = JSON.parse(generated) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    if (
      !metadata
      || typeof metadata.image_url !== 'string'
      || typeof metadata.width !== 'number'
      || typeof metadata.height !== 'number'
      || typeof metadata.original_width !== 'number'
      || typeof metadata.original_height !== 'number'
      || metadata.format !== 'png'
    ) {
      throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot response is malformed');
    }
    const url = this.screenshotUrl(metadata.image_url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot redirect is forbidden');
      }
      if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'image/png') {
        throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot response is not a PNG');
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_SCREENSHOT_BYTES) {
        throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot exceeds the size limit');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
        throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot exceeds the size limit');
      }
      return {
        bytes,
        contentType: 'image/png',
        width: metadata.width,
        height: metadata.height,
        originalWidth: metadata.original_width,
        originalHeight: metadata.original_height,
      };
    } catch (error) {
      if (error instanceof ZeroMcpClientError) throw error;
      throw new ZeroMcpClientError('screenshot_failed', 'Zero screenshot download failed', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async finalizeDraft(input: {
    pageName: string;
    draftRootNodeId: string;
    finalName: string;
    updateRootNodeId?: string;
  }): Promise<{ finalRootNodeId: string }> {
    if (!isZeroNodeId(input.draftRootNodeId) || (
      input.updateRootNodeId !== undefined && !isZeroNodeId(input.updateRootNodeId)
    )) {
      throw new ZeroMcpClientError('zero_swap_incomplete', 'Zero publication node ID is invalid');
    }
    await this.loadScriptResources();
    const code = `
const page = relay.root.children.find((candidate) => candidate.type === 'PAGE' && candidate.name === ${JSON.stringify(input.pageName)})
if (!page) throw new Error('target page unavailable')
await relay.setCurrentPageAsync(page)
const draft = await relay.getNodeByIdAsync(${JSON.stringify(input.draftRootNodeId)})
if (!draft || draft.parent !== page) throw new Error('draft unavailable')
const old = ${input.updateRootNodeId ? `await relay.getNodeByIdAsync(${JSON.stringify(input.updateRootNodeId)})` : 'null'}
if (old) { draft.x = old.x; draft.y = old.y; old.remove() }
draft.name = ${JSON.stringify(input.finalName)}
return { mutatedNodeIds: [draft.id], finalRootNodeId: draft.id }
`;
    const result = await this.callTool<{ finalRootNodeId?: unknown }>(
      'use_design_script',
      { code, description: 'Finalize verified Zero report publication' },
    );
    if (result.finalRootNodeId !== input.draftRootNodeId) {
      throw new ZeroMcpClientError('zero_swap_incomplete', 'Zero publication finalization failed');
    }
    return { finalRootNodeId: input.draftRootNodeId };
  }

  async cleanupDraft(input: { pageName: string; rootNodeId: string }): Promise<void> {
    if (!isZeroNodeId(input.rootNodeId)) return;
    await this.loadScriptResources();
    const code = `
const page = relay.root.children.find((candidate) => candidate.type === 'PAGE' && candidate.name === ${JSON.stringify(input.pageName)})
if (!page) return { mutatedNodeIds: [] }
await relay.setCurrentPageAsync(page)
const node = await relay.getNodeByIdAsync(${JSON.stringify(input.rootNodeId)})
if (!node || node.parent !== page) return { mutatedNodeIds: [] }
const id = node.id
node.remove()
return { mutatedNodeIds: [id] }
`;
    await this.callTool('use_design_script', {
      code,
      description: 'Clean up failed Zero report publication draft',
    });
  }
}

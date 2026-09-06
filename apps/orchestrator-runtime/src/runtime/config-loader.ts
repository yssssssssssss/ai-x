import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

let root = process.cwd();

export function setConfigRoot(directory: string): void {
  root = directory;
}

export function getConfigRoot(): string {
  return root;
}

export type ToolAdapterType = 'o2' | 'internal_api' | 'rest_json' | 'mcp' | 'script' | 'fake' | 'tavily' | 'playwright';

export interface ToolRegistryEntry {
  id: string;
  name: string;
  path: string;
  adapter_type: ToolAdapterType;
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  status: 'draft' | 'active' | 'deprecated';
}

export interface ToolManifest {
  id: string;
  name: string;
  adapter_type: ToolAdapterType;
  entrypoint?: string;
  base_url_env?: string;
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  approver_rule?: 'none' | 'owner' | 'security' | 'legal';
  timeout_seconds?: number;
  retry_policy?: { max_attempts: number; backoff_seconds: number };
  input_schema: string;
  output_schema: string;
  redaction_policy?: Record<string, string>;
}

function loadYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, 'utf8')) as T;
}

export function loadToolRegistry(): { version: number; tools: ToolRegistryEntry[] } {
  return loadYaml(join(root, 'orchestrator/tool-registry.yaml'));
}

export function loadToolManifest(relativePath: string): ToolManifest {
  return loadYaml(join(root, relativePath));
}

export function loadToolInputSchema(relativePath: string): object {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as object;
}

export function hashFile(relativeOrAbsolutePath: string): string {
  const path = isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : join(root, relativeOrAbsolutePath);
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function fileExists(relativePath: string): boolean {
  return existsSync(join(root, relativePath));
}

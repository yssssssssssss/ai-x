import { Router } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { SystemCapabilitiesResponse } from '../../../../packages/api-contract/system-capabilities.ts';
import { inspectDeliverableRegistry } from '../../../orchestrator-runtime/src/report/deliverable-registry.ts';
import {
  getConfigRoot,
  hashFile,
  loadSkillRegistry,
} from '../../../orchestrator-runtime/src/runtime/config-loader.ts';

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(getConfigRoot(), relativePath), 'utf8')) as Record<string, unknown>;
}

function optionalFileHash(relativePath: string): string | null {
  const path = join(getConfigRoot(), relativePath);
  if (!existsSync(path)) return null;
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function reportDocumentVersions(): string[] {
  const schema = readJson('schemas/report-document.schema.json');
  const properties = schema.properties as Record<string, { enum?: unknown }> | undefined;
  const versions = properties?.version?.enum;
  if (!Array.isArray(versions) || !versions.every((version) => typeof version === 'string')) {
    throw new Error('ReportDocument schema does not declare version values');
  }
  return [...versions];
}

function planContractVersions(): string[] {
  const schema = readJson('schemas/current-execution-plan.schema.json');
  const properties = schema.properties as Record<string, { const?: unknown }> | undefined;
  const current = properties?.execution_contract_version?.const;
  if (typeof current !== 'string') throw new Error('Current Plan schema does not declare its execution contract version');
  const legacy = current.replace(/v\d+$/u, 'v1');
  return legacy === current ? [current] : [legacy, current];
}

export const systemCapabilitiesRouter = Router();

systemCapabilitiesRouter.get('/', (_req, res) => {
  try {
    const inspection = inspectDeliverableRegistry();
    if (inspection.diagnostics.length > 0) {
      res.status(503).json({ error: '系统能力配置无效' });
      return;
    }
    const activeDeliverables = inspection.entries.filter(({ status }) => status === 'active');
    const packageManifest = readJson('package.json');
    const response: SystemCapabilitiesResponse = {
      applicationVersion: typeof packageManifest.version === 'string' ? packageManifest.version : 'unknown',
      planContractVersions: planContractVersions(),
      reportDocumentVersions: reportDocumentVersions(),
      activeTaskTypes: [...new Set(activeDeliverables.flatMap(({ task_types }) => task_types))].sort(),
      activeDeliverables: activeDeliverables.map(({ id }) => id).sort(),
      compiledSkills: loadSkillRegistry().skills
        .filter(({ status, execution_mode }) => status === 'active' && execution_mode === 'compiled')
        .map(({ id }) => id)
        .sort(),
      knowledgeIndexHash: optionalFileHash('knowledge-base/.index/knowledge.json'),
      toolRegistryHash: hashFile('orchestrator/tool-registry.yaml'),
    };
    res.json(response);
  } catch {
    res.status(503).json({ error: '系统能力配置无效' });
  }
});

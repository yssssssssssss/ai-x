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

function optionalFileHash(relativePath: string): string | null {
  const path = join(getConfigRoot(), relativePath);
  if (!existsSync(path)) return null;
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export const systemCapabilitiesRouter = Router();

systemCapabilitiesRouter.get('/', (_req, res) => {
  const inspection = inspectDeliverableRegistry();
  if (inspection.diagnostics.length > 0) {
    res.status(503).json({ error: '系统能力配置无效' });
    return;
  }
  const activeDeliverables = inspection.entries.filter(({ status }) => status === 'active');
  const response: SystemCapabilitiesResponse = {
    applicationVersion: '0.0.1',
    planContractVersions: ['current-execution-plan-v1', 'current-execution-plan-v2'],
    reportDocumentVersions: ['report-document-v1', 'report-document-v2'],
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
});

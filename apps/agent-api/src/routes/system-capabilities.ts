import { Router } from 'express';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

function sourceRevision(): string | null {
  const environmentRevision = process.env.GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const root = getConfigRoot();
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return environmentRevision;
  try {
    const dotGitStat = lstatSync(dotGit);
    const gitDir = dotGitStat.isDirectory()
      ? dotGit
      : (() => {
          if (!dotGitStat.isFile()) return null;
          const dotGitText = readFileSync(dotGit, 'utf8').trim();
          return dotGitText.startsWith('gitdir: ')
            ? resolve(root, dotGitText.slice('gitdir: '.length))
            : null;
        })();
    if (!gitDir) return environmentRevision;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/u.test(head)) return head;
    if (!head.startsWith('ref: ')) return environmentRevision;
    const ref = head.slice('ref: '.length);
    const commonDirPath = join(gitDir, 'commondir');
    const commonDir = existsSync(commonDirPath)
      ? resolve(dirname(commonDirPath), readFileSync(commonDirPath, 'utf8').trim())
      : gitDir;
    for (const refRoot of [gitDir, commonDir]) {
      const directRef = join(refRoot, ref);
      if (existsSync(directRef)) {
        const revision = readFileSync(directRef, 'utf8').trim();
        if (/^[0-9a-f]{40,64}$/u.test(revision)) return revision;
      }
    }
    const packedRefs = join(commonDir, 'packed-refs');
    if (existsSync(packedRefs)) {
      const match = readFileSync(packedRefs, 'utf8')
        .split('\n')
        .map((line) => line.trim().split(' '))
        .find(([revision, name]) => name === ref && /^[0-9a-f]{40,64}$/u.test(revision ?? ''));
      if (match?.[0]) return match[0];
    }
    return environmentRevision;
  } catch {
    return environmentRevision;
  }
}

function configurationHash(parts: readonly (string | null)[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
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
    const applicationVersion = typeof packageManifest.version === 'string' ? packageManifest.version : 'unknown';
    const knowledgeIndexHash = optionalFileHash('knowledge-base/.index/knowledge.json');
    const toolRegistryHash = hashFile('orchestrator/tool-registry.yaml');
    const deliverableRegistryHash = hashFile('orchestrator/deliverable-registry.yaml');
    const skillRegistryHash = hashFile('orchestrator/skill-registry.yaml');
    const planSchemaHash = hashFile('schemas/current-execution-plan.schema.json');
    const reportSchemaHash = hashFile('schemas/report-document.schema.json');
    const configHash = configurationHash([
      deliverableRegistryHash,
      skillRegistryHash,
      knowledgeIndexHash,
      toolRegistryHash,
      planSchemaHash,
      reportSchemaHash,
    ]);
    const revision = sourceRevision();
    const response: SystemCapabilitiesResponse = {
      applicationVersion,
      build: {
        id: process.env.APP_BUILD_ID ?? process.env.VERCEL_DEPLOYMENT_ID ?? `${applicationVersion}+${(revision ?? configHash).replace(/^sha256:/u, '').slice(0, 12)}`,
        sourceRevision: revision,
        builtAt: process.env.BUILD_TIMESTAMP ?? null,
        configurationHash: configHash,
      },
      planContractVersions: planContractVersions(),
      reportDocumentVersions: reportDocumentVersions(),
      activeTaskTypes: [...new Set(activeDeliverables.flatMap(({ task_types }) => task_types))].sort(),
      activeDeliverables: activeDeliverables.map(({ id }) => id).sort(),
      compiledSkills: loadSkillRegistry().skills
        .filter(({ status, execution_mode }) => status === 'active' && execution_mode === 'compiled')
        .map(({ id }) => id)
        .sort(),
      knowledgeIndexHash,
      toolRegistryHash,
    };
    res.json(response);
  } catch {
    res.status(503).json({ error: '系统能力配置无效' });
  }
});

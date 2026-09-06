import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import type { SystemCapabilitiesResponse } from '../../../../packages/api-contract/system-capabilities.ts';
import { SKILL_NATIVE_PLAN_VERSION } from '../../../../packages/api-contract/skill-native.ts';
import { SkillNativeCatalog } from '../../../orchestrator-runtime/src/skill-native/catalog.ts';
import { DockerSandboxExecutor } from '../../../orchestrator-runtime/src/skill-native/sandbox-executor.ts';
import type { SkillNativeTaskService } from '../../../orchestrator-runtime/src/skill-native/service.ts';
import { hashFile } from '../../../orchestrator-runtime/src/runtime/config-loader.ts';

type CatalogPort = Pick<SkillNativeTaskService, 'catalog'>;

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

export function createSystemCapabilitiesRouter(service?: CatalogPort): Router {
  const router = Router();
  router.get('/', (_request, response) => {
    try {
      const catalog = service?.catalog() ?? (() => {
        const discovered = new SkillNativeCatalog().load();
        return {
          skills: discovered.skills.map(({ id, name, description, packageHash, fileCount, byteSize }) => ({
            id, name, description, packageHash, fileCount, byteSize, available: true as const,
          })),
          unavailableSkills: discovered.unavailableSkills,
        };
      })();
      const toolRegistryHash = hashFile('orchestrator/tool-registry.yaml');
      const packageState = catalog.skills
        .map(({ id, packageHash }) => ({ id, packageHash }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const configurationHash = `sha256:${createHash('sha256')
        .update(JSON.stringify({ plan: SKILL_NATIVE_PLAN_VERSION, packageState, toolRegistryHash }))
        .digest('hex')}`;
      const applicationVersion = packageVersion();
      const sourceRevision = process.env.GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
      const body: SystemCapabilitiesResponse = {
        applicationVersion,
        build: {
          id: process.env.APP_BUILD_ID
            ?? process.env.VERCEL_DEPLOYMENT_ID
            ?? `${applicationVersion}+${(sourceRevision ?? configurationHash).replace(/^sha256:/u, '').slice(0, 12)}`,
          sourceRevision,
          builtAt: process.env.BUILD_TIMESTAMP ?? null,
          configurationHash,
        },
        planContractVersion: SKILL_NATIVE_PLAN_VERSION,
        skillPackages: packageState.map(({ id }) => id),
        unavailableSkillPackages: catalog.unavailableSkills.length,
        toolRegistryHash,
        sandboxAvailable: new DockerSandboxExecutor().status().available,
        zeroPublicationEnabled: process.env.ZERO_PUBLICATION_ENABLED === 'true',
      };
      response.json(body);
    } catch {
      response.status(503).json({ error: '系统能力配置无效' });
    }
  });
  return router;
}

import { join } from 'node:path';
import type { SkillPackageDescriptor } from '../../../../packages/api-contract/skill-native.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';
import {
  SkillPackageStore,
  type UnavailableSkillPackage,
} from './package-store.ts';

export type UnavailableSkill = UnavailableSkillPackage;

export interface SkillNativeCatalogSnapshot {
  skills: SkillPackageDescriptor[];
  unavailableSkills: UnavailableSkill[];
}

export class SkillNativeCatalog {
  readonly packages: SkillPackageStore;

  constructor(rootOrStore: string | SkillPackageStore = getConfigRoot()) {
    this.packages = rootOrStore instanceof SkillPackageStore
      ? rootOrStore
      : new SkillPackageStore({ sourceRoot: join(rootOrStore, 'skill-packages') });
  }

  load(): SkillNativeCatalogSnapshot {
    const discovered = this.packages.discover();
    return {
      skills: discovered.packages,
      unavailableSkills: discovered.unavailablePackages.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
}

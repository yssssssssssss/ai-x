import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FrozenSkillReference } from '../../../../packages/api-contract/native-skill-orchestration.ts';
import { getConfigRoot } from './config-loader.ts';
import { SkillPackageError } from './skill-package.ts';

export interface KnowledgeMount {
  id: string;
  rootPath: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const TEXT_EXTENSIONS = /\.(?:md|txt|json|ya?ml|html|css|svg)$/iu;

function digest(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function portable(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SkillPackageError('knowledge mount path escapes its root');
  }
}

function mountFiles(mount: KnowledgeMount): Array<{ path: string; fullPath: string }> {
  if (!SAFE_ID.test(mount.id)) throw new SkillPackageError(`invalid Knowledge Mount id: ${mount.id}`);
  const configuredRoot = resolve(mount.rootPath);
  if (lstatSync(configuredRoot).isSymbolicLink()) {
    throw new SkillPackageError(`Knowledge Mount ${mount.id} root must not be a symbolic link`);
  }
  const root = realpathSync(configuredRoot);
  if (!statSync(root).isDirectory()) throw new SkillPackageError(`Knowledge Mount ${mount.id} is not a directory`);
  const files: Array<{ path: string; fullPath: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      assertContained(root, fullPath);
      if (entry.isSymbolicLink()) {
        throw new SkillPackageError(`Knowledge Mount ${mount.id} contains a symbolic link`);
      }
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) throw new SkillPackageError(`Knowledge Mount ${mount.id} contains an unsupported entry`);
      const path = portable(relative(root, fullPath));
      if (TEXT_EXTENSIONS.test(path)) files.push({ path, fullPath });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function mountPathIdentity(mountId: string, path: string): { dev: bigint; ino: bigint; directory: boolean } {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink()) throw new SkillPackageError(`Knowledge Mount ${mountId} contains a symbolic link`);
  return { dev: metadata.dev, ino: metadata.ino, directory: metadata.isDirectory() };
}

function assertMountPathIdentity(
  mountId: string,
  path: string,
  expected: ReturnType<typeof mountPathIdentity>,
): void {
  const actual = mountPathIdentity(mountId, path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.directory !== expected.directory) {
    throw new SkillPackageError(`Knowledge Mount ${mountId} path changed while reading`);
  }
}

function readMountFile(mountId: string, root: string, path: string): Buffer {
  const chain = [root];
  let cursor = root;
  for (const segment of path.split('/')) {
    cursor = resolve(cursor, segment);
    assertContained(root, cursor);
    chain.push(cursor);
  }
  const identities = chain.map((item) => ({ path: item, identity: mountPathIdentity(mountId, item) }));
  const fullPath = resolve(root, path);
  const before = identities.at(-1)!.identity;
  const descriptor = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new SkillPackageError(`Knowledge Mount ${mountId}/${path} changed while opening`);
    }
    for (const item of identities) assertMountPathIdentity(mountId, item.path, item.identity);
    const bytes = readFileSync(descriptor);
    for (const item of identities) assertMountPathIdentity(mountId, item.path, item.identity);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function mentionsExactPath(instructions: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9._/-])(?:\\./)?${escaped}(?![A-Za-z0-9._/-])`, 'u').test(instructions);
}

function parseEnvironmentMounts(raw: string | undefined): KnowledgeMount[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SkillPackageError('SKILL_KNOWLEDGE_MOUNTS must be a JSON object');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillPackageError('SKILL_KNOWLEDGE_MOUNTS must be a JSON object');
  }
  return Object.entries(value).map(([id, rootPath]) => {
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
      throw new SkillPackageError(`Knowledge Mount ${id} has no root path`);
    }
    return { id, rootPath };
  });
}

export class KnowledgeMountRegistry {
  constructor(private readonly mounts: readonly KnowledgeMount[] = []) {
    if (new Set(mounts.map(({ id }) => id)).size !== mounts.length) {
      throw new SkillPackageError('Knowledge Mount ids must be unique');
    }
  }

  static fromEnvironment(): KnowledgeMountRegistry {
    const configured = parseEnvironmentMounts(process.env.SKILL_KNOWLEDGE_MOUNTS);
    const internalKnowledgeRoot = resolve(getConfigRoot(), 'knowledge-base');
    const mounts = configured.some(({ id }) => id === 'research-wiki') || !existsSync(internalKnowledgeRoot)
      ? configured
      : [{ id: 'research-wiki', rootPath: internalKnowledgeRoot }, ...configured];
    return new KnowledgeMountRegistry(mounts);
  }

  resolveReferences(instructions: string): FrozenSkillReference[] {
    const references: FrozenSkillReference[] = [];
    for (const mount of this.mounts) {
      const files = mountFiles(mount);
      const root = realpathSync(resolve(mount.rootPath));
      const logicalPrefix = `knowledge://${mount.id}/`;
      for (const file of files) {
        if (mount.id === 'research-wiki' && file.path.startsWith('skills/')) continue;
        const logicalPath = `${logicalPrefix}${file.path}`;
        const physicalPath = resolve(root, file.path);
        if (
          !mentionsExactPath(instructions, logicalPath)
          && !mentionsExactPath(instructions, physicalPath)
          && !mentionsExactPath(instructions, file.path)
        ) continue;
        const bytes = readMountFile(mount.id, root, file.path);
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new SkillPackageError(`Knowledge Mount ${mount.id}/${file.path} is not UTF-8 text`);
        }
        references.push({
          source: 'knowledge_mount',
          sourceId: mount.id,
          logicalPath,
          path: file.path,
          contentHash: digest(content),
          content,
          selectedBy: 'explicit_reference',
        });
      }
    }
    return references;
  }
}

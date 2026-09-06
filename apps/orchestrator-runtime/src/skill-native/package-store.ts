import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ExternalKnowledgeSnapshot,
  SkillPackageDescriptor,
  SkillPackageFile,
  SkillPackageSnapshot,
} from '../../../../packages/api-contract/skill-native.ts';
import { parseFrontmatter } from '../knowledge/frontmatter.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_FILES = 1_000;

export interface UnavailableSkillPackage {
  id: string;
  sourcePath: string;
  reason: string;
}

interface PackageContents {
  files: SkillPackageFile[];
  directories: string[];
  byteSize: number;
  packageHash: string;
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new Error('package path escapes its root');
}

function normalizedRelativePath(path: string): string {
  if (
    !path
    || isAbsolute(path)
    || path.includes('\\')
    || path.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error('package file path must be a normalized relative path');
  return path;
}

function calculatePackageHash(files: readonly SkillPackageFile[], directories: readonly string[]): string {
  return sha256(JSON.stringify({
    directories,
    files: files.map((file) => ({
      path: file.path,
      byteSize: file.byteSize,
      contentSha256: file.contentSha256,
      executable: file.executable,
    })),
  }));
}

function scanPackage(rootPath: string): PackageContents {
  const root = realpathSync(rootPath);
  if (!lstatSync(root).isDirectory()) throw new Error('package root must be a directory');
  const files: SkillPackageFile[] = [];
  const directories: string[] = [];
  let byteSize = 0;

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`package contains symlink: ${portablePath(root, path)}`);
      const real = realpathSync(path);
      assertContained(root, real);
      const relativePath = portablePath(root, real);
      if (stat.isDirectory()) {
        directories.push(relativePath);
        visit(real);
        continue;
      }
      if (!stat.isFile()) throw new Error(`package contains unsupported file type: ${relativePath}`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`package file exceeds 10 MiB: ${relativePath}`);
      byteSize += stat.size;
      if (byteSize > MAX_PACKAGE_BYTES) throw new Error('package exceeds 64 MiB');
      files.push({
        path: relativePath,
        byteSize: stat.size,
        contentSha256: sha256(readFileSync(real)),
        executable: (stat.mode & 0o111) !== 0,
      });
      if (files.length > MAX_PACKAGE_FILES) throw new Error('package exceeds 1000 files');
    }
  };

  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort();
  return { files, directories, byteSize, packageHash: calculatePackageHash(files, directories) };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

export class SkillPackageStore {
  readonly sourceRoot: string;
  readonly snapshotRoot: string;

  constructor(options: { sourceRoot?: string; snapshotRoot?: string } = {}) {
    this.sourceRoot = resolve(options.sourceRoot ?? join(getConfigRoot(), 'skill-packages'));
    this.snapshotRoot = resolve(
      options.snapshotRoot
      ?? join(process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces', 'skill-native'),
    );
  }

  discover(): { packages: SkillPackageDescriptor[]; unavailablePackages: UnavailableSkillPackage[] } {
    if (!existsSync(this.sourceRoot)) return { packages: [], unavailablePackages: [] };
    const sourceRoot = realpathSync(this.sourceRoot);
    const packages: SkillPackageDescriptor[] = [];
    const unavailablePackages: UnavailableSkillPackage[] = [];

    for (const entry of readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = entry.name;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.name !== '.DS_Store') {
          unavailablePackages.push({ id: entry.name, sourcePath, reason: 'package root entry must be a directory' });
        }
        continue;
      }
      const packageRoot = join(sourceRoot, entry.name);
      try {
        const skillPath = join(packageRoot, 'SKILL.md');
        if (!existsSync(skillPath) || !lstatSync(skillPath).isFile() || lstatSync(skillPath).isSymbolicLink()) {
          throw new Error('package root must contain a regular SKILL.md file');
        }
        const contents = scanPackage(packageRoot);
        const parsed = parseFrontmatter(readFileSync(skillPath, 'utf8'));
        const name = requiredString(parsed.frontmatter.name, 'name');
        const description = requiredString(parsed.frontmatter.description, 'description');
        const whenToUse = parsed.frontmatter.when_to_use;
        if (whenToUse !== undefined && (typeof whenToUse !== 'string' || !whenToUse.trim())) {
          throw new Error('when_to_use must be a non-empty string when present');
        }
        packages.push({
          id: entry.name,
          name,
          description,
          ...(typeof whenToUse === 'string' ? { whenToUse: whenToUse.trim() } : {}),
          sourcePath,
          packageHash: contents.packageHash,
          fileCount: contents.files.length,
          byteSize: contents.byteSize,
          frontmatter: structuredClone(parsed.frontmatter),
        });
      } catch (error) {
        unavailablePackages.push({
          id: entry.name,
          sourcePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const duplicateNames = new Set(
      packages.map(({ name }) => name).filter((name, index, names) => names.indexOf(name) !== index),
    );
    for (const descriptor of packages.filter(({ name }) => duplicateNames.has(name))) {
      unavailablePackages.push({
        id: descriptor.id,
        sourcePath: descriptor.sourcePath,
        reason: `duplicate package name ${descriptor.name}`,
      });
    }
    return {
      packages: packages.filter(({ name }) => !duplicateNames.has(name)),
      unavailablePackages,
    };
  }

  snapshot(taskId: string, descriptor: SkillPackageDescriptor): SkillPackageSnapshot {
    normalizedRelativePath(descriptor.sourcePath);
    const sourceRoot = realpathSync(this.sourceRoot);
    const source = realpathSync(join(sourceRoot, descriptor.sourcePath));
    assertContained(sourceRoot, source);
    const contents = scanPackage(source);
    if (contents.packageHash !== descriptor.packageHash) {
      throw new Error(`Skill package ${descriptor.id} changed after planning; replan is required`);
    }

    const digest = descriptor.packageHash.replace(/^sha256:/u, '').slice(0, 16);
    const snapshotPath = `${taskId}/packages/${descriptor.id}-${digest}`;
    const target = resolve(this.snapshotRoot, snapshotPath);
    assertContained(this.snapshotRoot, target);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: false });
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
      }
    }

    const snapshot: SkillPackageSnapshot = {
      version: 'skill-package-snapshot-v1',
      package: structuredClone(descriptor),
      packageHash: contents.packageHash,
      files: structuredClone(contents.files),
      directories: [...contents.directories],
      snapshotPath,
      createdAt: new Date().toISOString(),
    };
    this.verify(snapshot);
    return snapshot;
  }

  verify(snapshot: SkillPackageSnapshot): void {
    normalizedRelativePath(snapshot.snapshotPath);
    const snapshotRoot = realpathSync(this.snapshotRoot);
    const root = realpathSync(resolve(snapshotRoot, snapshot.snapshotPath));
    assertContained(snapshotRoot, root);
    const current = scanPackage(root);
    if (current.packageHash !== snapshot.packageHash) {
      throw new Error(`Skill package snapshot drift: ${snapshot.package.id}`);
    }
  }

  list(snapshot: SkillPackageSnapshot): SkillPackageFile[] {
    this.verify(snapshot);
    return structuredClone(snapshot.files);
  }

  read(snapshot: SkillPackageSnapshot, relativePath: string): Buffer {
    const normalized = normalizedRelativePath(relativePath);
    this.verify(snapshot);
    if (!snapshot.files.some((file) => file.path === normalized)) {
      throw new Error(`Skill package file does not exist: ${normalized}`);
    }
    const root = realpathSync(resolve(this.snapshotRoot, snapshot.snapshotPath));
    const path = realpathSync(resolve(root, normalized));
    assertContained(root, path);
    if (!lstatSync(path).isFile()) throw new Error(`Skill package path is not a file: ${normalized}`);
    return readFileSync(path);
  }

  snapshotRootPath(snapshot: SkillPackageSnapshot): string {
    this.verify(snapshot);
    return realpathSync(resolve(this.snapshotRoot, snapshot.snapshotPath));
  }

  snapshotExternal(input: {
    taskId: string;
    snapshotKey: string;
    mountId: string;
    logicalPath: string;
    hostPath: string;
    expected?: ExternalKnowledgeSnapshot;
  }): ExternalKnowledgeSnapshot {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(input.mountId)) throw new Error('external mount id is invalid');
    if (!/^[a-f0-9]{16,64}$/u.test(input.snapshotKey)) throw new Error('external snapshot key is invalid');
    const snapshotPath = `${input.taskId}/external/${input.snapshotKey}/${input.mountId}`;
    normalizedRelativePath(snapshotPath);
    const target = resolve(this.snapshotRoot, snapshotPath);
    assertContained(this.snapshotRoot, target);

    if (input.expected) {
      if (input.expected.snapshotPath !== snapshotPath) throw new Error(`external snapshot path changed: ${input.mountId}`);
      this.verifyExternal(input.expected);
      return structuredClone(input.expected);
    }

    if (!existsSync(target)) {
      if (!existsSync(input.hostPath)) throw new Error(`external mount ${input.mountId} is unavailable: ${input.hostPath}`);
      const source = realpathSync(input.hostPath);
      if (!lstatSync(source).isDirectory()) throw new Error(`external mount ${input.mountId} must be a directory`);
      const sourceContents = scanPackage(source);
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: false });
        const copiedContents = scanPackage(temporary);
        if (copiedContents.packageHash !== sourceContents.packageHash) {
          throw new Error(`external mount ${input.mountId} changed while it was being snapshotted`);
        }
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
      }
    }

    const contents = scanPackage(target);
    return {
      mountId: input.mountId,
      logicalPath: input.logicalPath,
      contentHash: contents.packageHash,
      files: structuredClone(contents.files),
      directories: [...contents.directories],
      snapshotPath,
      createdAt: new Date().toISOString(),
    };
  }

  verifyExternal(snapshot: ExternalKnowledgeSnapshot): void {
    normalizedRelativePath(snapshot.snapshotPath);
    if (!existsSync(this.snapshotRoot)) throw new Error(`external snapshot is missing: ${snapshot.mountId}`);
    const snapshotRoot = realpathSync(this.snapshotRoot);
    const unresolved = resolve(snapshotRoot, snapshot.snapshotPath);
    assertContained(snapshotRoot, unresolved);
    if (!existsSync(unresolved)) throw new Error(`external snapshot is missing: ${snapshot.mountId}`);
    const root = realpathSync(unresolved);
    assertContained(snapshotRoot, root);
    const current = scanPackage(root);
    if (current.packageHash !== snapshot.contentHash) {
      throw new Error(`external snapshot drift: ${snapshot.mountId}`);
    }
  }

  listExternal(snapshot: ExternalKnowledgeSnapshot, relativePath = ''): {
    files: SkillPackageFile[];
    directories: string[];
  } {
    const prefix = relativePath ? `${normalizedRelativePath(relativePath)}/` : '';
    this.verifyExternal(snapshot);
    return {
      files: snapshot.files
        .filter(({ path }) => path === relativePath || path.startsWith(prefix))
        .map((file) => structuredClone(file)),
      directories: snapshot.directories.filter((path) => path === relativePath || path.startsWith(prefix)),
    };
  }

  readExternal(snapshot: ExternalKnowledgeSnapshot, relativePath: string): Buffer {
    const normalized = normalizedRelativePath(relativePath);
    this.verifyExternal(snapshot);
    if (!snapshot.files.some((file) => file.path === normalized)) {
      throw new Error(`external knowledge file does not exist: ${snapshot.logicalPath}/${normalized}`);
    }
    const root = realpathSync(resolve(this.snapshotRoot, snapshot.snapshotPath));
    const path = realpathSync(resolve(root, normalized));
    assertContained(root, path);
    if (!lstatSync(path).isFile()) throw new Error(`external knowledge path is not a file: ${normalized}`);
    return readFileSync(path);
  }

  externalRootPath(snapshot: ExternalKnowledgeSnapshot): string {
    this.verifyExternal(snapshot);
    return realpathSync(resolve(this.snapshotRoot, snapshot.snapshotPath));
  }

  sourceSkillMarkdown(descriptor: SkillPackageDescriptor): string {
    normalizedRelativePath(descriptor.sourcePath);
    const sourceRoot = realpathSync(this.sourceRoot);
    const path = realpathSync(resolve(sourceRoot, descriptor.sourcePath, 'SKILL.md'));
    assertContained(sourceRoot, path);
    return readFileSync(path, 'utf8');
  }
}

export const SKILL_PACKAGE_LIMITS = {
  maxFileBytes: MAX_FILE_BYTES,
  maxPackageBytes: MAX_PACKAGE_BYTES,
  maxPackageFiles: MAX_PACKAGE_FILES,
} as const;

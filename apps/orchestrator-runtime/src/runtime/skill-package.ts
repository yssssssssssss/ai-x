import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from '../knowledge/frontmatter.ts';

export interface SkillPackageFile {
  path: string;
  mediaType: string;
  contentHash: string;
  byteSize: number;
}

export interface SkillPackageSnapshot {
  rootPath: string;
  entryPath: string;
  packageHash: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  files: SkillPackageFile[];
  explicitReferences: string[];
}

export class SkillPackageError extends Error {
  constructor(message: string) {
    super(`Skill package: ${message}`);
    this.name = 'SkillPackageError';
  }
}

export class SkillPackageDriftError extends SkillPackageError {
  constructor(path: string) {
    super(`content hash drift for ${path}`);
    this.name = 'SkillPackageDriftError';
  }
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.md': return 'text/markdown';
    case '.txt': return 'text/plain';
    case '.json': return 'application/json';
    case '.yaml':
    case '.yml': return 'application/yaml';
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function portablePath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function normalizedRelativePath(path: string): string {
  if (
    !path
    || isAbsolute(path)
    || path.includes('\\')
    || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new SkillPackageError(`path must be normalized and relative: ${path || '(empty)'}`);
  }
  return path;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SkillPackageError('path escapes package root');
  }
}

function resolvePackageRoot(rootPath: string): string {
  const absolute = resolve(rootPath);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new SkillPackageError('package root must not be a symbolic link');
  const physical = realpathSync(absolute);
  if (!statSync(physical).isDirectory()) throw new SkillPackageError('package root is not a directory');
  return physical;
}

function resolvePackageFile(root: string, relativePath: string): string {
  const normalized = normalizedRelativePath(relativePath);
  let cursor = root;
  for (const segment of normalized.split('/')) {
    cursor = resolve(cursor, segment);
    assertContained(root, cursor);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new SkillPackageError(`symbolic links are not allowed: ${normalized}`);
    }
  }
  const physical = realpathSync(cursor);
  assertContained(root, physical);
  if (!statSync(physical).isFile()) throw new SkillPackageError(`path is not a regular file: ${normalized}`);
  return physical;
}

function pathIdentity(path: string): { dev: bigint; ino: bigint; directory: boolean } {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink()) throw new SkillPackageError(`symbolic links are not allowed: ${path}`);
  return { dev: metadata.dev, ino: metadata.ino, directory: metadata.isDirectory() };
}

function assertPathIdentity(path: string, expected: ReturnType<typeof pathIdentity>): void {
  const actual = pathIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.directory !== expected.directory) {
    throw new SkillPackageError(`path changed while reading: ${path}`);
  }
}

function readPackageFile(root: string, relativePath: string): Buffer {
  const normalized = normalizedRelativePath(relativePath);
  const chain = [root];
  let cursor = root;
  for (const segment of normalized.split('/')) {
    cursor = resolve(cursor, segment);
    assertContained(root, cursor);
    chain.push(cursor);
  }
  const identities = chain.map((path) => ({ path, identity: pathIdentity(path) }));
  const fullPath = resolvePackageFile(root, normalized);
  const before = identities.at(-1)!.identity;
  const descriptor = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new SkillPackageError(`file changed while opening: ${relativePath}`);
    }
    for (const item of identities) assertPathIdentity(item.path, item.identity);
    const bytes = readFileSync(descriptor);
    for (const item of identities) assertPathIdentity(item.path, item.identity);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function listPackageFiles(root: string): SkillPackageFile[] {
  const files: SkillPackageFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      assertContained(root, full);
      if (entry.isSymbolicLink()) {
        throw new SkillPackageError(`symbolic links are not allowed: ${portablePath(relative(root, full))}`);
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillPackageError(`unsupported filesystem entry: ${portablePath(relative(root, full))}`);
      }
      const physical = realpathSync(full);
      assertContained(root, physical);
      const path = portablePath(relative(root, physical));
      const bytes = readPackageFile(root, path);
      files.push({
        path,
        mediaType: mediaType(path),
        contentHash: sha256(bytes),
        byteSize: bytes.byteLength,
      });
    }
  };
  visit(root);
  return files.sort(comparePaths);
}

function packageHash(files: readonly SkillPackageFile[]): string {
  const manifest = files
    .map(({ path, mediaType, contentHash, byteSize }) => `${path}\0${mediaType}\0${byteSize}\0${contentHash}\n`)
    .join('');
  return sha256(manifest);
}

function referencedFiles(entryContent: string, files: readonly SkillPackageFile[], entryPath: string): string[] {
  const referenced = new Set<string>();
  for (const file of files) {
    if (file.path === entryPath) continue;
    if (entryContent.includes(file.path) || entryContent.includes(`./${file.path}`)) {
      referenced.add(file.path);
      continue;
    }
    const segments = file.path.split('/');
    for (let length = segments.length - 1; length > 0; length -= 1) {
      const directory = `${segments.slice(0, length).join('/')}/`;
      if (entryContent.includes(directory)) {
        referenced.add(file.path);
        break;
      }
    }
  }
  return [...referenced].map((path) => ({ path })).sort(comparePaths).map(({ path }) => path);
}

export function inspectSkillPackage(input: {
  rootPath: string;
  entryPath?: string;
}): SkillPackageSnapshot {
  const rootPath = resolvePackageRoot(input.rootPath);
  const entryPath = normalizedRelativePath(input.entryPath ?? 'SKILL.md');
  resolvePackageFile(rootPath, entryPath);
  const files = listPackageFiles(rootPath);
  const entryFile = files.find((file) => file.path === entryPath);
  if (!entryFile) throw new SkillPackageError(`entry file is not in package manifest: ${entryPath}`);
  const entryContent = new TextDecoder('utf-8', { fatal: true }).decode(readPackageFile(rootPath, entryPath));
  if (
    sha256(entryContent) !== entryFile.contentHash
    || Buffer.byteLength(entryContent) !== entryFile.byteSize
  ) {
    throw new SkillPackageDriftError(entryPath);
  }
  const { frontmatter } = parseFrontmatter(entryContent);
  const frontmatterName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const frontmatterDescription = typeof frontmatter.description === 'string'
    ? frontmatter.description.trim()
    : '';
  return {
    rootPath,
    entryPath,
    packageHash: packageHash(files),
    name: frontmatterName || basename(rootPath),
    description: frontmatterDescription,
    frontmatter,
    files,
    explicitReferences: referencedFiles(entryContent, files, entryPath),
  };
}

export function readSkillPackageText(
  snapshot: SkillPackageSnapshot,
  relativePath: string,
): string {
  const normalized = normalizedRelativePath(relativePath);
  const frozen = snapshot.files.find((file) => file.path === normalized);
  if (!frozen) throw new SkillPackageError(`file is not present in frozen manifest: ${normalized}`);
  const bytes = readPackageFile(snapshot.rootPath, normalized);
  if (sha256(bytes) !== frozen.contentHash || bytes.byteLength !== frozen.byteSize) {
    throw new SkillPackageDriftError(normalized);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SkillPackageError(`file is not valid UTF-8 text: ${normalized}`);
  }
}

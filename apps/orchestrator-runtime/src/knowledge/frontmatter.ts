import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// frontmatter = 文件开头 ---\n...\n--- 之间的 YAML。无则视为纯正文。
const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(md: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const m = md.match(FM_RE);
  if (!m) return { frontmatter: {}, content: md.trim() };
  const frontmatter = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  const content = md.slice(m[0].length).trim();
  return { frontmatter, content };
}

export function serializeFrontmatter(
  fm: Record<string, unknown>,
  content: string,
): string {
  const yaml = stringifyYaml(fm).trimEnd();
  return `---\n${yaml}\n---\n\n${content.trim()}\n`;
}

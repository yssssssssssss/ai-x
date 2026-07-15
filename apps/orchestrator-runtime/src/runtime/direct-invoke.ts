// $<skill-name> [args] 直呼解析。命中返回 { skillName, rest }, 否则 null。
// skill-name: 字母开头, 允许字母/数字/下划线/连字符(对齐 registry skill id/name)。
const RE = /^\s*\$([A-Za-z][\w-]*)\s*([\s\S]*)$/;

export function parseDirectInvoke(input: string): { skillName: string; rest: string } | null {
  const m = input.match(RE);
  if (!m) return null;
  return { skillName: m[1], rest: m[2].trim() };
}

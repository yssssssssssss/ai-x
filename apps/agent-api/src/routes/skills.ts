import { Router } from 'express';
import { requireAuth } from '../middleware.ts';
import { loadSkillRegistry } from '../../../orchestrator-runtime/src/runtime/config-loader.ts';

// 列出可 $ 直呼的 active skill(供前端 $ 命令菜单)。
// id 是直呼标识($<id>),name 是展示名(原生 skill 可能是中文),description 取 when_to_use。
export const skillsRouter = Router();
skillsRouter.use(requireAuth);

skillsRouter.get('/', (_req, res) => {
  const skills = loadSkillRegistry()
    .skills.filter((s) => s.status === 'active')
    .map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      description: s.when_to_use ?? '',
      domain: Array.isArray(s.domain) ? s.domain : s.domain ? [s.domain] : [],
    }));
  res.json({ skills });
});

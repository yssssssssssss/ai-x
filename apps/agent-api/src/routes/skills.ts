import { Router } from 'express';
import { requireAuth } from '../middleware.ts';
import { SkillLoader } from '../../../orchestrator-runtime/src/runtime/skill-loader.ts';

// 列出可 $ 直呼的已安装 Skill。目录扫描是身份真相源，平台绑定只补充显示元数据。
export const skillsRouter = Router();
skillsRouter.use(requireAuth);

skillsRouter.get('/', (_req, res) => {
  const skills = new SkillLoader()
    .listActiveSkills()
    .map((skill) => ({
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.when_to_use ?? '',
      task_types: skill.task_types ?? [],
    }));
  res.json({ skills });
});

import { Router } from 'express';
import {
  listTaskHistoryPreferences,
  updateTaskHistoryPreference,
} from '../../../../database/task-history-preferences.ts';
import type {
  TaskHistoryKind,
  TaskHistoryPreferencePatch,
} from '../../../../packages/api-contract/http.ts';
import { requireAuth } from '../middleware.ts';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_PATCH_FIELDS = new Set(['displayName', 'pinned', 'hidden']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseTaskHistoryPreferencePatch(value: unknown): TaskHistoryPreferencePatch | null {
  const body = record(value);
  if (!body) return null;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !ALLOWED_PATCH_FIELDS.has(key))) return null;

  const patch: TaskHistoryPreferencePatch = {};
  if (Object.hasOwn(body, 'displayName')) {
    if (body.displayName === null) {
      patch.displayName = null;
    } else if (typeof body.displayName === 'string') {
      const displayName = body.displayName.trim();
      if (!displayName || displayName.length > 200) return null;
      patch.displayName = displayName;
    } else {
      return null;
    }
  }
  if (Object.hasOwn(body, 'pinned')) {
    if (typeof body.pinned !== 'boolean') return null;
    patch.pinned = body.pinned;
  }
  if (Object.hasOwn(body, 'hidden')) {
    if (typeof body.hidden !== 'boolean') return null;
    patch.hidden = body.hidden;
  }
  return patch;
}

function taskKind(value: string | string[] | undefined): TaskHistoryKind | null {
  return value === 'legacy' || value === 'current' || value === 'native' ? value : null;
}

function taskId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && TASK_ID.test(value) ? value : null;
}

export const taskHistoryRouter = Router();
taskHistoryRouter.use(requireAuth);

taskHistoryRouter.get('/', async (req, res) => {
  try {
    res.json({ preferences: await listTaskHistoryPreferences(req.userId!) });
  } catch {
    res.status(500).json({ error: '读取任务历史设置失败' });
  }
});

taskHistoryRouter.patch('/:kind/:id', async (req, res) => {
  const kind = taskKind(req.params.kind);
  const id = taskId(req.params.id);
  const patch = parseTaskHistoryPreferencePatch(req.body);
  if (!kind || !id || !patch) {
    res.status(400).json({ error: '任务历史设置参数无效' });
    return;
  }
  try {
    const preference = await updateTaskHistoryPreference({
      ownerUserId: req.userId!,
      taskKind: kind,
      taskId: id,
      patch,
    });
    res.json({ preference });
  } catch {
    res.status(500).json({ error: '保存任务历史设置失败' });
  }
});

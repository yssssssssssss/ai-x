import type {
  TaskHistoryKind,
  TaskHistoryPreference,
  TaskHistoryPreferencePatch,
} from '../packages/api-contract/http.ts';
import { pool } from './db.ts';

interface TaskHistoryPreferenceRow {
  task_id: string;
  task_kind: TaskHistoryKind;
  display_name: string | null;
  pinned_at: Date | string | null;
  hidden_at: Date | string | null;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('task history preference contains an invalid timestamp');
  return date.toISOString();
}

function fromRow(row: TaskHistoryPreferenceRow): TaskHistoryPreference {
  return {
    taskId: row.task_id,
    taskKind: row.task_kind,
    displayName: row.display_name,
    pinnedAt: iso(row.pinned_at),
    hiddenAt: iso(row.hidden_at),
    updatedAt: iso(row.updated_at)!,
  };
}

export async function listTaskHistoryPreferences(
  ownerUserId: string,
): Promise<TaskHistoryPreference[]> {
  const { rows } = await pool.query<TaskHistoryPreferenceRow>(
    `SELECT task_id, task_kind, display_name, pinned_at, hidden_at, updated_at
     FROM task_history_preferences
     WHERE owner_user_id = $1
     ORDER BY updated_at DESC, task_kind, task_id`,
    [ownerUserId],
  );
  return rows.map(fromRow);
}

export async function updateTaskHistoryPreference(input: {
  ownerUserId: string;
  taskKind: TaskHistoryKind;
  taskId: string;
  patch: TaskHistoryPreferencePatch;
}): Promise<TaskHistoryPreference> {
  const hasDisplayName = Object.hasOwn(input.patch, 'displayName');
  const hasPinned = Object.hasOwn(input.patch, 'pinned');
  const hasHidden = Object.hasOwn(input.patch, 'hidden');
  const { rows } = await pool.query<TaskHistoryPreferenceRow>(
    `INSERT INTO task_history_preferences
       (owner_user_id, task_kind, task_id, display_name, pinned_at, hidden_at)
     VALUES (
       $1, $2, $3,
       CASE WHEN $4::boolean THEN $5::text ELSE NULL END,
       CASE WHEN $6::boolean AND $7::boolean THEN now() ELSE NULL END,
       CASE WHEN $8::boolean AND $9::boolean THEN now() ELSE NULL END
     )
     ON CONFLICT (owner_user_id, task_kind, task_id) DO UPDATE SET
       display_name = CASE
         WHEN $4::boolean THEN $5::text
         ELSE task_history_preferences.display_name
       END,
       pinned_at = CASE
         WHEN $6::boolean THEN CASE WHEN $7::boolean THEN now() ELSE NULL END
         ELSE task_history_preferences.pinned_at
       END,
       hidden_at = CASE
         WHEN $8::boolean THEN CASE WHEN $9::boolean THEN now() ELSE NULL END
         ELSE task_history_preferences.hidden_at
       END,
       updated_at = now()
     RETURNING task_id, task_kind, display_name, pinned_at, hidden_at, updated_at`,
    [
      input.ownerUserId,
      input.taskKind,
      input.taskId,
      hasDisplayName,
      input.patch.displayName ?? null,
      hasPinned,
      input.patch.pinned ?? false,
      hasHidden,
      input.patch.hidden ?? false,
    ],
  );
  return fromRow(rows[0]!);
}

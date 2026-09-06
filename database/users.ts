import { pool } from './db.ts';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
}

export async function createUser(input: {
  email: string;
  displayName: string;
  passwordHash: string;
  role?: string;
}): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, COALESCE($4, 'member'))
     RETURNING id, email, display_name, role, status`,
    [input.email, input.displayName, input.passwordHash, input.role ?? null],
  );
  return rows[0]!;
}

export async function getUserByEmail(
  email: string,
): Promise<(UserRow & { password_hash: string }) | null> {
  const { rows } = await pool.query<UserRow & { password_hash: string }>(
    `SELECT id, email, display_name, role, status, password_hash
     FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, display_name, role, status FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

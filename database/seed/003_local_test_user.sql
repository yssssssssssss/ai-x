-- 本地 UI 真机测试账号。仅由显式 `pnpm db:seed` 写入，不进入生产 migration。
INSERT INTO users (id, email, display_name, password_hash, role, status)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  'test@ai-x.local',
  '本地测试用户',
  '$2b$10$N8.09mgFghxWC67G/eJriuk0698lef/jnNj4tfyPPtOmIQ5VpQofO',
  'member',
  'active'
)
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name,
    password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    status = EXCLUDED.status;

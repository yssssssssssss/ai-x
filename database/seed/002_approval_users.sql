-- 本地审批闭环测试账号。仅用于开发/验收，不用于生产环境。
INSERT INTO users (id, email, display_name, password_hash, role, status)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'legal@approval.local',
  '本地法务审批',
  '$2b$10$rzETUPzbValzzILP5wloK.llXO0byPQjuW4IDDrfrhXPWtc/HXwa6',
  'legal',
  'active'
)
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name,
    password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    status = EXCLUDED.status;

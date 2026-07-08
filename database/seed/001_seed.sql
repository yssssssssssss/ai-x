-- 用研 AI 专项 · 最小 seed(V0)
-- 固定 UUID + ON CONFLICT DO NOTHING,保证可重复执行不报错、不重复插入。
-- 覆盖:1 用户 / 1 会话 / 1 任务 / 1 执行日志 / 1 产物,用于验证读写与历史回看。

INSERT INTO users (id, email, display_name, password_hash, role, status)
VALUES ('00000000-0000-0000-0000-000000000001',
        'seed@user-research.local', '种子用户',
        -- V0 占位 hash,非真实口令(P1-01 才实现注册/登录)
        'seed-not-a-real-hash', 'member', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversations (id, owner_user_id, title, status, summary, last_message_at)
VALUES ('00000000-0000-0000-0000-000000000101',
        '00000000-0000-0000-0000-000000000001',
        '直播场域数字人竞品研究', 'active', '种子会话:验证会话记忆与历史回看', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO research_tasks (
  id, conversation_id, owner_user_id, original_input, task_type,
  structured_task, status, run_workspace_uri, sensitivity, pii_detected)
VALUES ('00000000-0000-0000-0000-000000000201',
        '00000000-0000-0000-0000-000000000101',
        '00000000-0000-0000-0000-000000000001',
        '我要为直播场域做一次数字人竞品研究', 'competitive_research',
        '{"task_type":"competitive_research","business_domain":"live_commerce","research_goal":"了解直播场域数字人竞品的能力与体验差异"}'::jsonb,
        'created', 'run-workspaces/seed-task-201', 'internal', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO execution_log (
  id, task_id, step_no, step_name, actor_type, actor_id, status,
  model_name, model_version, trace_id)
VALUES ('00000000-0000-0000-0000-000000000301',
        '00000000-0000-0000-0000-000000000201', 1, 'seed-step', 'llm', 'seed-actor',
        'succeeded', 'mock-llm', 'v0', 'seed-trace-001')
ON CONFLICT (task_id, step_no) DO NOTHING;

INSERT INTO artifacts (
  id, task_id, conversation_id, artifact_type, title, storage_uri,
  content_summary, sensitivity, created_by_user_id)
VALUES ('00000000-0000-0000-0000-000000000401',
        '00000000-0000-0000-0000-000000000201',
        '00000000-0000-0000-0000-000000000101',
        'report', '种子报告', 'run-workspaces/seed-task-201/artifacts/report.md',
        '种子产物:验证 artifact 可从历史任务打开', 'internal',
        '00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

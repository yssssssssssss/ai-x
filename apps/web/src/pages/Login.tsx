import { useEffect, useState, type FormEvent } from 'react';
import { api, setToken, ApiError, type User } from '../api/client.ts';

// 默认走本地快捷登录，邮箱密码仅作其他账号的兜底入口。
export function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [mode, setMode] = useState<'quick' | 'login' | 'register'>('quick');
  const [quickLoginAvailable, setQuickLoginAvailable] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.authMethods()
      .then(({ quickLogin }) => {
        if (!active) return;
        setQuickLoginAvailable(quickLogin);
        if (!quickLogin) setMode('login');
      })
      .catch(() => {
        if (!active) return;
        setQuickLoginAvailable(false);
        setMode('login');
      });
    return () => { active = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = mode === 'quick'
        ? await api.quickLogin()
        : mode === 'login'
          ? await api.login({ email, password })
          : await api.register({ email, password, displayName });
      setToken(r.token);
      onLoggedIn(r.user);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : '请求失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <form
        onSubmit={submit}
        style={{
          width: 'min(360px, calc(100vw - 32px))', padding: 32, background: 'var(--bg-card)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        }}
      >
        <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>用研 AI · 会话工作台</h1>
        <p style={{ color: 'var(--text-dim)', marginTop: 0, fontSize: 13 }}>
          {quickLoginAvailable === null
            ? '正在准备登录方式'
            : mode === 'quick'
              ? '无需输入账号密码，直接进入当前工作空间'
              : mode === 'login' ? '使用其他账号登录' : '注册新账号'}
        </p>

        {quickLoginAvailable === null ? (
          <div style={{ display: 'grid', placeItems: 'center', minHeight: 86 }}>
            <span className="spinner" aria-label="正在加载登录方式" />
          </div>
        ) : mode === 'quick' ? (
          <p style={{ color: 'var(--text-faint)', fontSize: 12, margin: '22px 0 14px' }}>
            登录后会载入该账号的历史任务与研究报告。
          </p>
        ) : (
          <>
            {mode === 'register' && (
              <Field label="显示名" value={displayName} onChange={setDisplayName} />
            )}
            <Field label="邮箱" type="email" value={email} onChange={setEmail} />
            <Field label="密码" type="password" value={password} onChange={setPassword} />
          </>
        )}

        {err && <div role="alert" style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{err}</div>}

        {quickLoginAvailable !== null && (
          <button className="btn-primary" style={{ width: '100%' }} disabled={busy}>
            {busy
              ? <span className="spinner" aria-label="正在登录" />
              : mode === 'quick'
                ? '一键进入工作台'
                : mode === 'login' ? '登录' : '注册'}
          </button>
        )}

        {quickLoginAvailable !== null && (
          <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13 }}>
            {mode === 'login' && quickLoginAvailable && (
              <ModeButton label="返回一键登录" onClick={() => { setMode('quick'); setErr(''); }} />
            )}
            <ModeButton
              label={mode === 'quick' ? '使用其他账号' : mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
              onClick={() => { setMode(mode === 'register' ? 'login' : mode === 'login' ? 'register' : 'login'); setErr(''); }}
            />
          </div>
        )}
      </form>
    </div>
  );
}

function ModeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn-ghost"
      style={{ border: 'none', color: 'var(--primary)' }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Field(props: {
  label: string; value: string; type?: string; onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required
        style={{
          width: '100%', marginTop: 4, padding: '9px 12px',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 8, color: 'var(--text)', fontSize: 14,
        }}
      />
    </label>
  );
}

import { useState, type FormEvent } from 'react';
import { api, setToken, ApiError, type User } from '../api/client.ts';

// 登录/注册页。登录成功写 token 到 localStorage,回调上层切换到工作台。
export function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r =
        mode === 'login'
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
          width: 360, padding: 32, background: 'var(--bg-card)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        }}
      >
        <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>用研 AI · 会话工作台</h1>
        <p style={{ color: 'var(--text-dim)', marginTop: 0, fontSize: 13 }}>
          {mode === 'login' ? '登录以继续' : '注册新账号'}
        </p>

        {mode === 'register' && (
          <Field label="显示名" value={displayName} onChange={setDisplayName} />
        )}
        <Field label="邮箱" type="email" value={email} onChange={setEmail} />
        <Field label="密码" type="password" value={password} onChange={setPassword} />

        {err && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{err}</div>}

        <button className="btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? <span className="spinner" /> : mode === 'login' ? '登录' : '注册'}
        </button>

        <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13 }}>
          <button
            type="button"
            className="btn-ghost"
            style={{ border: 'none', color: 'var(--primary)' }}
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}
          >
            {mode === 'login' ? '没有账号?去注册' : '已有账号?去登录'}
          </button>
        </div>
      </form>
    </div>
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

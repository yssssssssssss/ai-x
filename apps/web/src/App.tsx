import { useEffect, useState } from 'react';
import { api, getToken, clearToken, type User } from './api/client.ts';
import { Login } from './pages/Login.tsx';
import { Workbench } from './pages/Workbench.tsx';

// 轻量路由:不引 react-router。按登录态切换 Login / Workbench。
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <span className="spinner" />
      </div>
    );
  }

  if (!user) return <Login onLoggedIn={setUser} />;

  return (
    <Workbench
      user={user}
      onLogout={() => {
        clearToken();
        setUser(null);
      }}
    />
  );
}

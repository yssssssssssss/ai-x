import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth.ts';

// requireAuth:校验 Bearer JWT → 挂 req.userId / req.userEmail。
// 无 token 或非法 → 401。所有业务路由挂此中间件,配合 owner 隔离。

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: '未登录:缺少 Bearer token' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: '登录已失效或 token 非法' });
    return;
  }
  req.userId = payload.userId;
  req.userEmail = payload.email;
  next();
}

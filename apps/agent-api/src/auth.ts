import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// 认证工具:密码 hash/校验(bcryptjs 纯 JS 免编译)+ JWT 签发/校验。
// JWT secret 从 env 读;dev 有默认值,生产必须设 JWT_SECRET。

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-secret-change-in-prod';
const JWT_EXPIRES_IN = '7d';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: { userId: string; email: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): { userId: string; email: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
  } catch {
    return null;
  }
}

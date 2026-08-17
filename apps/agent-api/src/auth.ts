import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// 认证工具:密码 hash/校验(bcryptjs 纯 JS 免编译)+ JWT 签发/校验。

const JWT_EXPIRES_IN = '7d';

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret?.trim()) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: { userId: string; email: string }): string {
  return jwt.sign(payload, requireJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): { userId: string; email: string } | null {
  const secret = requireJwtSecret();
  try {
    return jwt.verify(token, secret) as { userId: string; email: string };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return null;
    }
    throw error;
  }
}

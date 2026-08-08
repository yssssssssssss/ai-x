export const DEVELOPMENT_SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

export interface DevelopmentSeedUser {
  id: string;
}

export function assertDevelopmentSeedUser(
  user: DevelopmentSeedUser | null,
): asserts user is DevelopmentSeedUser {
  if (!user || user.id !== DEVELOPMENT_SEED_USER_ID) {
    throw new Error('DEVELOPMENT_SEED_MISSING: run pnpm db:seed');
  }
}

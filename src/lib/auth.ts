import { cookies } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { withPlatformScope } from '@/db';
import { tenants, users } from '@/db/schema';
import { env } from './env';

const COOKIE = 'tc_session';
const MAX_AGE_SECONDS = 60 * 60 * 12;
const secret = new TextEncoder().encode(env.AUTH_SECRET);

export type Session = {
  userId: string;
  email: string;
  name: string;
  role: (typeof users.$inferSelect)['role'];
  /** Null for Talent Carriage staff, who choose a tenant to view. */
  tenantId: string | null;
  departmentScope: string[];
};

export async function signIn(email: string, password: string): Promise<Session | null> {
  const user = await withPlatformScope((tx) =>
    tx.query.users.findFirst({ where: and(eq(users.email, email.toLowerCase().trim()), eq(users.isActive, true)) }),
  );
  if (!user?.passwordHash) return null;
  if (!(await bcrypt.compare(password, user.passwordHash))) return null;

  const session: Session = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    departmentScope: user.departmentScope ?? [],
  };

  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret);

  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });

  await withPlatformScope((tx) =>
    tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)),
  );
  return session;
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

/**
 * The tenant whose data the current request may touch.
 *
 * Customer users are pinned to their own tenant. Talent Carriage staff pick one,
 * and the choice is remembered in a cookie - but every query still runs inside
 * `withTenant`, so the database enforces the boundary either way.
 */
export async function getActiveTenantId(session: Session): Promise<string | null> {
  if (session.tenantId) return session.tenantId;
  const chosen = (await cookies()).get('tc_tenant')?.value;
  if (chosen) return chosen;
  const first = await withPlatformScope((tx) => tx.query.tenants.findFirst({ where: eq(tenants.status, 'active') }));
  return first?.id ?? null;
}

export async function setActiveTenant(tenantId: string): Promise<void> {
  const store = await cookies();
  store.set('tc_tenant', tenantId, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: MAX_AGE_SECONDS });
}

export function canManageSettings(session: Session): boolean {
  return session.role === 'platform_admin' || session.role === 'hr_admin';
}

export function isPlatformAdmin(session: Session): boolean {
  return session.role === 'platform_admin';
}

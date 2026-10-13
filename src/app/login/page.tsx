import { redirect } from 'next/navigation';
import { getSession, signIn } from '@/lib/auth';
import { Wordmark } from '@/components/wordmark';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSession()) redirect('/');
  const { error } = await searchParams;

  async function attempt(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    const session = await signIn(email, password);
    if (!session) redirect('/login?error=1');
    redirect('/');
  }

  return (
    <div className="login-wrap">
      <div className="login-panel">
        <Wordmark variant="login" />
        <div>
          <div className="eyebrow">Attendance agent</div>
          <div className="login-headline">AI attendance follow-up across every customer, in one place.</div>
        </div>
        <div className="login-foot">Talent Carriage HR workspace</div>
      </div>

      <div className="login-side">
        <div className="login-card">
          <h1>Sign in</h1>
          <p>Sign in to the HR workspace.</p>

          {error ? (
            <div className="notice err" role="alert">
              That email and password did not match.
            </div>
          ) : null}

          <form action={attempt}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input className="input xl" id="email" name="email" type="email" required autoComplete="username" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input className="input xl" id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <button className="btn primary xl block" type="submit">
              Sign in
            </button>
          </form>

          <div className="login-hint">
            Seeded logins: <span className="mono">admin@talentcarriage.test</span> (all customers),{' '}
            <span className="mono">hr@dpod-lifestyle.test</span>, <span className="mono">hr@northwind-retail.test</span>,{' '}
            <span className="mono">hr@sunrise-logistics.test</span> — password <span className="mono">attendance123</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

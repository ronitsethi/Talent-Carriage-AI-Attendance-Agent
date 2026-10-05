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
      <div className="login-card">
        <Wordmark width={226} />
        <h1>Attendance Agent</h1>
        <p>Sign in to the HR workspace.</p>

        {error ? <div className="notice err" style={{ margin: '0 0 12px' }}>That email and password did not match.</div> : null}

        <form action={attempt}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" required autoComplete="username" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input className="input" id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          <button className="btn primary" type="submit">Sign in</button>
        </form>

        <div className="login-hint">
          Seeded logins: <code>admin@talentcarriage.test</code> (all customers),{' '}
          <code>hr@dpod-lifestyle.test</code>, <code>hr@northwind-retail.test</code>,{' '}
          <code>hr@sunrise-logistics.test</code> — password <code>attendance123</code>.
        </div>
      </div>
    </div>
  );
}

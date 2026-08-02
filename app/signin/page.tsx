import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentSession } from '@/auth/current';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const { returnTo = '/dashboard', error } = await searchParams;
  if (await currentSession()) redirect(returnTo);

  return (
    <main className="shell signin">
      <h1>Tracker</h1>
      <p className="muted">
        Pull request throughput and latency for your team, read straight from GitHub.
      </p>
      {error === 'declined' ? (
        <p className="notice notice-warn">
          Sign-in was not completed, so no account was created. You can try again.
        </p>
      ) : null}
      <Link className="button" href={`/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`}>
        Sign in with GitHub
      </Link>
      <p className="muted" style={{ marginTop: '1rem' }}>
        GitHub is the only sign-in method: what you can see here mirrors what you can see there.
      </p>
    </main>
  );
}

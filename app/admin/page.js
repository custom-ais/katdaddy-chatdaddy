import { getJobberConnection, supabaseProject } from '@/lib/jobberTokens';

export const dynamic = 'force-dynamic';

const SETTINGS = [
  ['JOBBER_CLIENT_ID', 'Jobber client ID'],
  ['JOBBER_CLIENT_SECRET', 'Jobber client secret'],
  ['JOBBER_REDIRECT_URI', 'Jobber redirect URI'],
  ['NEXT_PUBLIC_APP_URL', 'App URL'],
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase URL'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase service key'],
  ['ADMIN_PASSWORD', 'Admin password'],
];

const ERRORS = {
  missing_jobber_settings: 'Jobber client ID or redirect URI is not set on this deployment.',
  missing_code: 'Jobber did not send back an authorization code.',
  state_mismatch: 'The sign-in did not start from this page. Click Connect Jobber and try again.',
  token_exchange_failed: 'Jobber rejected the sign-in. Check the client ID, secret and redirect URI.',
  could_not_save_tokens: 'Jobber signed in, but the tokens could not be saved to the database.',
};

function when(iso) {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
}

export default async function Admin({ searchParams }) {
  const justConnected = searchParams?.jobber === 'connected';
  const error = searchParams?.error;
  const jobber = await getJobberConnection();
  const project = supabaseProject();

  return (
    <main>
      <h1>Admin</h1>
      <p className="sub">
        <a href="/">← Home</a>
      </p>

      {justConnected && <div className="banner ok">Jobber connected.</div>}
      {error && (
        <div className="banner bad">{ERRORS[error] || `Jobber connection failed: ${error}`}</div>
      )}

      <div className="card">
        <h2>Jobber</h2>
        {jobber.connected ? (
          <p style={{ marginTop: 0 }}>
            <span className="ok">Connected.</span> Tokens last saved {when(jobber.updatedAt)}.
            They refresh on their own when the app calls Jobber.
          </p>
        ) : jobber.missingTable ? (
          <p style={{ marginTop: 0 }}>
            <span className="bad">Database not set up.</span> The table <code>{jobber.table}</code>{' '}
            is missing in Supabase project <code>{project || 'unknown'}</code>. Run{' '}
            <code>supabase/{jobber.table}.sql</code> in that project&apos;s SQL editor, then reload.
          </p>
        ) : (
          <p style={{ marginTop: 0 }}>
            <span className="bad">Not connected.</span>{' '}
            {jobber.error ? jobber.error : 'Sign in to Jobber and approve access.'}
          </p>
        )}
        <p style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
          Supabase project: <code>{project || 'not set'}</code>
        </p>
        <a className="btn" href="/api/jobber/oauth/start">
          {jobber.connected ? 'Reconnect Jobber' : 'Connect Jobber'}
        </a>
      </div>

      <div className="card">
        <h2>Settings on this deployment</h2>
        {SETTINGS.map(([key, label]) => {
          const set = Boolean(process.env[key]);
          return (
            <div className="row" key={key}>
              <span>
                {label} <code>{key}</code>
              </span>
              <span className={set ? 'ok' : 'bad'}>{set ? 'Set' : 'Missing'}</span>
            </div>
          );
        })}
      </div>
    </main>
  );
}

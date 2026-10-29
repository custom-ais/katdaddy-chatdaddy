export const dynamic = 'force-dynamic';

const SETTINGS = [
  ['JOBBER_CLIENT_ID', 'Jobber client ID'],
  ['JOBBER_CLIENT_SECRET', 'Jobber client secret'],
  ['JOBBER_REDIRECT_URI', 'Jobber redirect URI'],
  ['NEXT_PUBLIC_APP_URL', 'App URL'],
  ['DATABASE_URL', 'Database URL'],
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase URL'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase service key'],
];

export default function Admin({ searchParams }) {
  const jobber = searchParams?.jobber;
  const error = searchParams?.error;

  return (
    <main>
      <h1>Admin</h1>
      <p className="sub">
        <a href="/">← Home</a>
      </p>

      {jobber === 'connected' && <div className="banner ok">Jobber connected.</div>}
      {error && <div className="banner bad">Jobber connection failed: {error}</div>}

      <div className="card">
        <h2>Jobber</h2>
        <p style={{ marginTop: 0 }}>
          Sign in to Jobber and approve access. You will come back here when it finishes.
        </p>
        <a className="btn" href="/api/jobber/oauth/start">
          Connect Jobber
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

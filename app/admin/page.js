import { getJobberConnection, supabaseProject } from '@/lib/jobberTokens';
import { HOURS_TEXT } from '@/lib/bob/catalog';
import { bookingCrews, geminiReady } from '@/lib/bob/config';
import CopyButton from '@/components/CopyButton';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'ChatDaddy admin',
  icons: { icon: '/chatdaddy-mark.webp' },
};

const SETTINGS = [
  ['JOBBER_CLIENT_ID', 'Jobber client ID', true],
  ['JOBBER_CLIENT_SECRET', 'Jobber client secret', true],
  ['JOBBER_REDIRECT_URI', 'Jobber redirect URI', true],
  ['NEXT_PUBLIC_APP_URL', 'App URL', true],
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase URL', true],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase service key', true],
  ['ADMIN_PASSWORD', 'Admin password', true],
  ['GEMINI_API_KEY', 'AI answers for typed questions', false],
  ['BOOKING_CREWS', 'Jobs at the same time (default 1)', false],
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
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://katdaddy-bookingbot.vercel.app').replace(/\/$/, '');
  const snippet = `<script src="${appUrl}/widget.js" defer></script>`;

  return (
    <main className="admin">
      <div className="admin-top">
        <img src="/chatdaddy-mark.webp" alt="" />
        <div>
          <h1>ChatDaddy admin</h1>
          <p>Running BOB for Dryer Vent Squad West Valley</p>
        </div>
        <a href="/">Open BOB</a>
      </div>

      {justConnected && jobber.connected && <div className="banner ok">Jobber connected.</div>}
      {justConnected && !jobber.connected && (
        <div className="banner bad">Jobber sign-in finished, but no tokens are saved. Click Connect Jobber again.</div>
      )}
      {error && <div className="banner bad">{ERRORS[error] || `Jobber connection failed: ${error}`}</div>}

      <section className="panel">
        <h2>Jobber</h2>
        {jobber.connected ? (
          <p className="status is-ok">Connected. BOB books straight onto your Jobber schedule.</p>
        ) : jobber.missingTable ? (
          <p className="status">
            Database not set up: create the {jobber.table} table in Supabase project {project || 'unknown'}.
          </p>
        ) : (
          <p className="status">Not connected. {jobber.error || 'BOB can show prices but cannot book until you connect.'}</p>
        )}
        {jobber.connected && <p className="muted">Tokens last saved {when(jobber.updatedAt)}. They refresh on their own.</p>}
        <p className="muted">Supabase project: {project || 'not set'}</p>
        <a className={jobber.connected ? 'btn btn-quiet' : 'btn'} href="/api/jobber/oauth/start">
          {jobber.connected ? 'Reconnect Jobber' : 'Connect Jobber'}
        </a>
      </section>

      <section className="panel">
        <h2>BOB on your website</h2>
        <p>Paste this just before the closing body tag on dryerventsquadaz.com. It adds a floating Book with BOB button.</p>
        <pre className="snippet">{snippet}</pre>
        <p className="muted">
          Any button or link with <code>data-bob-open</code>, or linking to <code>#book-with-bob</code>, also opens BOB.
        </p>
        <div className="actions">
          <CopyButton text={snippet} label="Copy snippet" />
          <a className="btn btn-quiet" href="/" target="_blank" rel="noreferrer">
            Try BOB
          </a>
        </div>
      </section>

      <section className="panel">
        <h2>Booking rules</h2>
        <div className="row">
          <span>Bookable hours</span>
          <span>{HOURS_TEXT}</span>
        </div>
        <div className="row">
          <span>Jobs at the same time</span>
          <span>{bookingCrews()}</span>
        </div>
        <div className="row">
          <span>Earliest booking</span>
          <span>2 hours from now, up to 14 days out</span>
        </div>
        <div className="row">
          <span>Answers to typed questions</span>
          <span className={geminiReady() ? 'ok' : 'soft'}>{geminiReady() ? 'AI on' : 'Phone number fallback'}</span>
        </div>
      </section>

      <section className="panel">
        <h2>Settings on this deployment</h2>
        {SETTINGS.map(([key, label, required]) => {
          const set = Boolean(process.env[key]);
          return (
            <div className="row" key={key}>
              <span>
                {label}
                <code>{key}</code>
              </span>
              <span className={set ? 'ok' : required ? 'bad' : 'soft'}>{set ? 'Set' : required ? 'Missing' : 'Optional'}</span>
            </div>
          );
        })}
      </section>
    </main>
  );
}

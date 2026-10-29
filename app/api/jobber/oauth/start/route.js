import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'jobber_oauth_state';

// Sends the user to Jobber's sign-in page. Jobber then returns them to
// JOBBER_REDIRECT_URI with a code, which the callback route exchanges for tokens.
export async function GET(request) {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const redirectUri = process.env.JOBBER_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.redirect(new URL('/admin?error=missing_jobber_settings', request.url));
  }

  // The state cookie must live on the same domain Jobber sends the user back to,
  // so start the flow there if this request came in on a different domain.
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const back = new URL(redirectUri);
  if (host && host !== back.host) {
    return NextResponse.redirect(new URL('/api/jobber/oauth/start', back.origin));
  }

  const state = crypto.randomUUID();
  const authorize = new URL('https://api.getjobber.com/api/oauth/authorize');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', state);

  const res = NextResponse.redirect(authorize);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: back.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });
  return res;
}

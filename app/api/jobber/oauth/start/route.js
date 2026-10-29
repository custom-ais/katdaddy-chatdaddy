import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Sends the user to Jobber's sign-in page. Jobber then returns them to
// JOBBER_REDIRECT_URI with a code, which the callback route exchanges for tokens.
export async function GET(request) {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const redirectUri = process.env.JOBBER_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.redirect(
      new URL('/admin?error=missing_jobber_settings', request.url)
    );
  }

  const authorize = new URL('https://api.getjobber.com/api/oauth/authorize');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', crypto.randomUUID());

  return NextResponse.redirect(authorize);
}

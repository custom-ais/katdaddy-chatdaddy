import { NextResponse } from 'next/server';
import { saveJobberTokens } from '@/lib/jobberTokens';

export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'jobber_oauth_state';

function toAdmin(request, query) {
  const base = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const res = NextResponse.redirect(`${base}/admin?${query}`);
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const expected = request.cookies.get(STATE_COOKIE)?.value;

  if (!code) {
    return toAdmin(request, 'error=missing_code');
  }
  // Only accept a sign-in that started from this app's Connect Jobber button.
  if (!state || !expected || state !== expected) {
    return toAdmin(request, 'error=state_mismatch');
  }

  try {
    const response = await fetch('https://api.getjobber.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        redirect_uri: process.env.JOBBER_REDIRECT_URI,
        code,
      }),
    });

    const tokenData = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Jobber token exchange error:', tokenData.error, tokenData.error_description);
      return toAdmin(request, 'error=token_exchange_failed');
    }

    await saveJobberTokens(tokenData);
    return toAdmin(request, 'jobber=connected');
  } catch (error) {
    console.error('Jobber OAuth callback error:', error.message);
    return toAdmin(request, 'error=could_not_save_tokens');
  }
}

import { createClient } from '@supabase/supabase-js';

const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const TABLE = 'jobber_tokens';
const ROW_ID = 1; // one Jobber account per app

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Jobber access tokens are JWTs; their "exp" claim says when they expire.
function expiryOf(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    if (payload.exp) return new Date(payload.exp * 1000).toISOString();
  } catch {
    // fall through
  }
  return new Date(Date.now() + 55 * 60 * 1000).toISOString();
}

export async function saveJobberTokens({ access_token, refresh_token }) {
  if (!access_token || !refresh_token) {
    throw new Error('Jobber did not return both an access token and a refresh token');
  }
  const { error } = await db()
    .from(TABLE)
    .upsert({
      id: ROW_ID,
      access_token,
      refresh_token,
      expires_at: expiryOf(access_token),
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`Could not save Jobber tokens: ${error.message}`);
}

async function readRow() {
  const { data, error } = await db()
    .from(TABLE)
    .select('access_token, refresh_token, expires_at, updated_at')
    .eq('id', ROW_ID)
    .maybeSingle();
  if (error) throw new Error(`Could not read Jobber tokens: ${error.message}`);
  return data;
}

// For the admin page: is Jobber connected, and since when. Never returns tokens.
export async function getJobberConnection() {
  try {
    const row = await readRow();
    if (!row) return { connected: false };
    return { connected: true, updatedAt: row.updated_at, expiresAt: row.expires_at };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.JOBBER_CLIENT_ID,
      client_secret: process.env.JOBBER_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Jobber token refresh failed (${res.status}): ${data.error_description || data.error || 'no access token returned'}. Reconnect Jobber on the admin page.`
    );
  }
  // Jobber may rotate the refresh token; keep the old one if it doesn't.
  const tokens = { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken };
  await saveJobberTokens(tokens);
  return tokens.access_token;
}

// Use this anywhere the app calls Jobber's API. Refreshes the token when it is
// within two minutes of expiring.
export async function getJobberAccessToken() {
  const row = await readRow();
  if (!row) throw new Error('Jobber is not connected. Connect it on the admin page.');
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 2 * 60 * 1000) return row.access_token;
  return refreshTokens(row.refresh_token);
}

import { NextResponse } from 'next/server';

export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');

    if (!code) {
        return NextResponse.json({ error: 'Missing auth code from Jobber' }, { status: 400 });
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
                code: code,
            }),
        });

        const tokenData = await response.json();

        if (!response.ok) {
            console.error('Jobber Token Exchange Error:', tokenData);
            return NextResponse.json({ error: tokenData.error_description || 'Token exchange failed' }, { status: 400 });
        }

        // IMPORTANT: Save tokenData.access_token and tokenData.refresh_token to your Neon DB
        // e.g., await saveJobberTokens(tokenData.access_token, tokenData.refresh_token);

        return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/admin?jobber=connected`);
    } catch (error) {
        console.error('OAuth Callback Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

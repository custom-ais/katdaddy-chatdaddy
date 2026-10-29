import { NextResponse } from 'next/server';

// Password-protects the admin page and the Connect Jobber button.
// Set ADMIN_PASSWORD in Vercel; any username works.
export function middleware(request) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return new NextResponse('Admin is locked. Set ADMIN_PASSWORD in Vercel and redeploy.', {
      status: 503,
    });
  }

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const given = decoded.slice(decoded.indexOf(':') + 1);
      if (given === password) return NextResponse.next();
    } catch {
      // fall through to the prompt
    }
  }

  return new NextResponse('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="ChatDaddy admin", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/admin/:path*', '/api/jobber/oauth/start'],
};

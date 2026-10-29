// JOBBER_REDIRECT_URI points at /api/jobber/callback, so this path serves
// the same handler as /api/jobber/oauth/callback.
export { GET } from '../oauth/callback/route';

export const dynamic = 'force-dynamic';

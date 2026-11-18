const PREFIX = '/dvswest/booking';
const ORIGIN = 'https://katdaddy-bookingbot.vercel.app';
const SECURITY = {
  'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; frame-src ${ORIGIN}; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  'Permissions-Policy': `camera=(), microphone=(), geolocation=(), web-share=(self "${ORIGIN}")`,
  'Referrer-Policy': 'strict-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, follow',
};
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    // The wildcard route must never swallow a similarly named existing site page.
    if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return fetch(request);
    const headers = new Headers(SECURITY);
    headers.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.set('Allow', 'GET, HEAD');
      return new Response('Method not allowed', {status:405,headers});
    }
    let content;
    if (path === PREFIX || path === PREFIX + '/') {
      content = PAGE_HTML;
      headers.set('Content-Type', 'text/html; charset=utf-8');
    } else if (path === PREFIX + '/page.css') {
      content = PAGE_CSS;
      headers.set('Content-Type', 'text/css; charset=utf-8');
      headers.set('Cache-Control', 'public, max-age=300');
    } else if (path === PREFIX + '/page.js') {
      content = PAGE_JS;
      headers.set('Content-Type', 'application/javascript; charset=utf-8');
      headers.set('Cache-Control', 'public, max-age=300');
    } else {
      headers.set('Content-Type', 'text/plain; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : 'Not found', {status:404,headers});
    }
    return new Response(request.method === 'HEAD' ? null : content, {status:200,headers});
  },
};

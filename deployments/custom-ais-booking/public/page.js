(() => {
  'use strict';
  const ORIGIN = 'https://katdaddy-bookingbot.vercel.app';
  const frame = document.getElementById('booking-frame');
  const loading = document.getElementById('loading');
  const fallback = document.getElementById('fallback');
  const minimized = document.getElementById('minimized');
  const reopen = document.getElementById('reopen');
  const input = new URLSearchParams(window.location.search);
  const target = new URL('/chat?embed=1', ORIGIN);
  const starts = new Set(['cleaning', 'repair', 'emergency', 'pest', 'question']);
  if (starts.has(input.get('start'))) target.searchParams.set('start', input.get('start'));
  if (['commercial', 'residential'].includes(input.get('audience'))) target.searchParams.set('audience', input.get('audience'));
  let ready = false;
  let collapsed = false;
  const restore = () => frame.contentWindow?.postMessage({ type: 'bob:restore' }, ORIGIN);
  const showFallback = () => { if (!ready && !collapsed) { loading.hidden = true; fallback.hidden = false; } };
  const timeout = window.setTimeout(showFallback, 15000);
  window.addEventListener('message', (event) => {
    if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'bob:ready') {
      ready = true;
      window.clearTimeout(timeout);
      loading.hidden = true;
      fallback.hidden = true;
      if (!collapsed) restore();
    } else if (event.data?.type === 'bob:minimize') {
      collapsed = true;
      frame.hidden = true;
      loading.hidden = true;
      fallback.hidden = true;
      minimized.hidden = false;
      reopen.focus();
    }
  });
  frame.addEventListener('load', () => { if (!collapsed) restore(); });
  frame.addEventListener('error', showFallback);
  reopen.addEventListener('click', () => {
    collapsed = false;
    minimized.hidden = true;
    frame.hidden = false;
    restore();
    frame.focus();
    if (!ready) showFallback();
  });
  // Only documented, fixed-choice bot options are forwarded; no form data or preview flags.
  frame.src = target.href;
})();

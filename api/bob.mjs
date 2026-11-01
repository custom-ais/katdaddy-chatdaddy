// Vercel Function: every /api/* request goes to BOB's handler.
import { handleReadOnlyPreview, isReadOnlyPreview } from '../server/preview.mjs';

export const config = { maxDuration: 60 };

// Load runtime lazily only after the preview guard. Even accidentally inherited
// production credentials cannot initialize databases or providers in previews.
export function createHandler({ env = process.env, loadRuntime = () => import('../server/runtime.mjs') } = {}) {
  return async function handler(req, res) {
    if (isReadOnlyPreview(env)) return handleReadOnlyPreview(req, res);
    try {
      const { bobRuntime } = await loadRuntime();
      const { handle } = await bobRuntime();
      await handle(req, res);
    } catch (error) {
      console.error('BOB failed to start:', error);
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'BOB is temporarily unavailable. Please call the office or try again shortly.' }));
      }
    }
  };
}

export default createHandler();

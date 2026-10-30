// Vercel Function: every /api/* request goes to BOB's handler.

import { bobRuntime } from "../server/runtime.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const { handle } = await bobRuntime();
    await handle(req, res);
  } catch (error) {
    console.error("BOB failed to start:", error);
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "BOB is temporarily unavailable. Please call the office or try again shortly." }));
    }
  }
}

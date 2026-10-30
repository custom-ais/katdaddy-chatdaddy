// Local server: the same API handler Vercel runs, plus the built app from dist/.
// Without DATABASE_URL or Supabase keys it uses a throwaway in-memory database.

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bobRuntime } from "./runtime.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Run `npm run build` first, or use `npm run dev`.");
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const port = Number(process.env.PORT || 3000);
http
  .createServer(async (req, res) => {
    if (!req.url.startsWith("/api/")) return serveStatic(req, res);
    try {
      const { handle } = await bobRuntime();
      await handle(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "BOB is temporarily unavailable." }));
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`BOB on http://127.0.0.1:${port}`));

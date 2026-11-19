# Custom-AIs DVS West booking route

This isolated Cloudflare Worker serves `https://custom-ais.com/dvswest/booking` and a trailing-slash form. It embeds the existing production app at `https://katdaddy-bookingbot.vercel.app/chat?embed=1`. The booking rules, API, database, provider credentials, administrator login, OAuth callbacks, and Vercel hosting remain unchanged. This is a branded entry point, not a migration of the booking backend.

## Before deployment

The current Vercel `vercel.json` has overlapping global and `/chat` CSP rules. The effective `/chat` `frame-ancestors` policy must allow `https://custom-ais.com` (and `https://www.custom-ais.com` only if adding that host) while retaining existing allowed sites. Preserve the admin restriction `frame-ancestors 'none'`. Without the CSP update the browser will block the frame; the wrapper provides a direct link after 15 seconds. Do not change `PUBLIC_ORIGIN`, OAuth settings, booking configuration, or the main Custom-AIs Worker.

Run `npm test` and `npm run build`. No dependencies are required for building or testing. `dist/worker.mjs` is a self-contained ES-module Worker for deployment; `wrangler.jsonc` describes only the new isolated Worker and its one narrow route. No deployment was performed by the implementation task.

The wildcard route also matches similarly named siblings, so the Worker passes every path outside `/dvswest/booking` or `/dvswest/booking/` unchanged to the existing origin. Inside that prefix only the page, `page.css`, and `page.js` are served; unknown descendants return 404. No site-wide API or asset routing changes are made.

## Behavior and privacy

Desktop uses a centered chat with ample height; mobile is full screen. Minimize/reopen preserve the iframe and its conversation. The existing bot's confirmed-booking autoclose also minimizes. Strict source and origin checks protect the message bridge; `strict-origin` referrers allow the child to verify restore messages. The Web Share permission preserves the existing iPhone appointment-card sharing flow. The iframe is not sandboxed, allowing existing downloads and external links.

Only known `start` values (`cleaning`, `repair`, `emergency`, `pest`, `question`) and `audience` (`commercial`, `residential`) are forwarded. Other queries, including preview flags, credentials, or customer data, are not inserted into HTML or forwarded. The wrapper has no secret bindings, logging, forms, storage, booking calls, or customer data processing. Normal existing bot session/activity logging still occurs inside the frame. Browser third-party storage restrictions may prevent conversation restoration after a reload; the active conversation is retained in the child memory and a direct booking link remains available.

## Verification after deployment

Check the page and slash form, scoped CSS/JS, CSP, and original Vercel URL. Check desktop/mobile sizing, opening, FAQ, deterministic chat answers/back, minimize/reopen, refresh restoration, and assets. Do not submit contact data, verification codes, callback requests, holds, or bookings in this limited smoke test. Verify an unrelated Custom-AIs page and similarly prefixed sibling still reach the existing site. Leave the main `custom-ais-studio` Worker and its settings intact. Do not add `global_fetch_strictly_public` to this Worker: with it, the pass-through `fetch(request)` re-enters this same `/dvswest/booking*` route and fails with Cloudflare error 1019 ("Compute server error") instead of reaching the main site. Without it, same-zone pass-through goes to the `custom-ais-studio` Custom Domain Worker, as it already does for the `sms-consent` and `chatdaddy-landing` route Workers.

## Rollback

Delete only the new Cloudflare route `custom-ais.com/dvswest/booking*` attached to `custom-ais-dvswest-booking`. This immediately restores the previous site's handling of these paths. The unused dedicated Worker can then be deleted, or retained for diagnosis. Never delete or redeploy the main site's Worker. Revert only the narrowly added Custom-AIs `frame-ancestors` entry if desired; preserve all other existing CSP settings and allowed domains. The original Vercel booking URL continues operating throughout and is the fallback. Save the actual route ID and Vercel deployment IDs when publishing so rollback can target them exactly.

## Current verification limitation

In this session, Custom-AIs requests return HTTP 403 because Cloudflare has an explicitly enabled **Block OpenAI personal AI agent** rule. Branded-path visual verification cannot be completed from this agent while that rule applies. Leave that security rule unchanged; this deployment does not authorize disabling it. Verify the branded page in a normal user browser and report this agent-testing limitation accurately. The original standalone fallback URL is `https://katdaddy-bookingbot.vercel.app/`.

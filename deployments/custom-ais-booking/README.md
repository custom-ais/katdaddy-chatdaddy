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

## Verification status

In an earlier session, Custom-AIs requests returned HTTP 403 because Cloudflare has an explicitly enabled **Block OpenAI personal AI agent** rule. Leave that security rule unchanged; this deployment does not authorize disabling it. If an agent is blocked, verify the branded page in a normal user browser instead and report the limitation accurately. The original standalone fallback URL is `https://katdaddy-bookingbot.vercel.app/`.

On 2026-11-19 the deployed page was verified from an agent session whose requests were not blocked. The page, its trailing-slash form, `page.css`, `page.js`, the security headers, 404s for unknown descendants, and 405s for other methods all behaved as described. Sibling paths (`/dvswest/bookings`, `/dvswest/booking-old`) and unrelated pages reached the main site. In headless Chromium on desktop (1366×900) and iPhone 13, BOB loaded inside the frame, the `bob:ready` handshake cleared the loading notice, and minimize, reopen and refresh worked. No contact data, codes, callbacks, holds or bookings were submitted. The only console messages were Cloudflare Web Analytics beacons to `/cdn-cgi/rum`, which this page's `connect-src 'none'` blocks by design.

## Deployment record

Cloudflare (account `c0d77f921e906893f30b4ed560ff2280`, zone `custom-ais.com` `37a25ec02235c470c3af8c7a55a2bde9`):

- Worker `custom-ais-dvswest-booking`, route `custom-ais.com/dvswest/booking*`, route ID `285829acaccc4fbb8ad3845bdac8e219`. Rollback deletes only this route.
- 2026-11-18: version `0d8fd2f9-a284-4d1f-adde-3fff94eb7278` (deployment `9e23d874-969c-4cd6-9110-40483f42c742`) from `a75ccb9`. It carried `global_fetch_strictly_public`, so sibling paths returned error 1019.
- 2026-11-19: version `e75ad970-a344-473b-8b18-a14261e4843a` (deployment `5254aeea-82b0-47fe-8ffd-fbb32280bd24`) from `fdbd6eb`. This was a settings-only change that dropped that flag. The module is unchanged from the build of this directory (`dist/worker.mjs` SHA-256 `5d948f33e40054453f87d8f29586394197eed6c4110e8d65e6e0a8952c7f0f6e`).

Vercel (`katdaddy-bookingbot`, `prj_pglqAzraSnFNMgFG5tvNMz6VBAd7`):

- Production `dpl_9aT6jKzEXXcuPZNLjX44MCPnSyUt` from `a75ccb9` serves the `/chat` `frame-ancestors` that allows `https://custom-ais.com` and `https://www.custom-ais.com`. `/admin` keeps `frame-ancestors 'none'`.
- The production deployment before the CSP change was `dpl_EzkuFaEYdDXB2MFXbePY912kYLNR` (`b173e53`).

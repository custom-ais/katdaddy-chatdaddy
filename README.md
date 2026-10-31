# BOB — Dryer Vent Squad booking assistant

Customer chat (`/chat`, embeddable with `/embed.js`) and office dashboard (`/admin`) for Dryer Vent Squad West Valley.

- **Booking**: question-by-question flow, exact prices from the service catalog, phone-code verification, held times, and a finished booking is a scheduled Jobber job with a visit.
- **Rules**: service-area ZIP gate, travel fee, drive time under 20 minutes between jobs, route scoring from the scheduling workbook, optional same-day and 5 PM overflow (off by default), named-approver step for emergency service.
- **Smart chat**: Gemini reads typed messages into BOB's commands and answers approved FAQs. It can't set prices or book.
- **Messages**: LeadConnector texts and emails (verification codes, confirmations, approver requests).
- **Early availability checks**: same-day emergency inquiries notify the configured approver (or Ryan's configured technician phone) during chat, before the booking form. The office inquiry does not reserve or confirm a visit. Requests received at or after 2 PM Arizona time are not eligible for same-day emergency service.
- **Editable service area map**: Settings → Service area map supports measured Google Routes driving miles or a circular radius. Move the base pin, drag radius handles, adjust mileage sliders, draw included/excluded polygons, and drag their vertices to customize coverage. Save settings to apply those boundaries to customer address checks; exclusions take priority. Existing ZIP coverage stays active until the edited map rules are saved. Road-routing failures stay unverified in driving-distance mode.
- **Activity**: the private BOB activity tab stores chat messages, widget actions, availability inquiries, provider acceptance/message IDs and failures in Postgres. Records survive conversation expiration. Provider acceptance does not establish handset delivery. Activity records use the existing events table and are excluded from webhook dispatch.
- **Minimize**: the customer header can collapse and restore BOB without resetting the conversation. The embedded widget also closes its outer panel and restores the same iframe.

## Run

```sh
npm install
npm run build && node server/index.mjs   # http://127.0.0.1:3000 (in-memory database unless env vars are set)
npm test
```

## Deploy (Vercel)

Vite build to `dist/`, one function at `api/bob.mjs`. Copy `.env.example` for the variables to set.
The database is the `bob` schema in Supabase (apply with `npm run db:schema`, which prints the SQL), reached with `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Jobber tokens are stored in `public.chatdaddy_jobber_tokens` (`supabase/chatdaddy_jobber_tokens.sql`).
Jobber redirect URI: `<app url>/api/jobber/callback`.

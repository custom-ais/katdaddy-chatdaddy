# BOB — Dryer Vent Squad booking assistant

Customer chat (`/chat`, embeddable with `/embed.js`) and office dashboard (`/admin`) for Dryer Vent Squad West Valley.

- **Booking**: question-by-question flow, exact prices from the service catalog, phone-code verification, held times, and a finished booking is a scheduled Jobber job with a visit.
- **Rules**: service-area ZIP gate, travel fee, drive time under 20 minutes between jobs, route scoring from the scheduling workbook, optional same-day and 5 PM overflow (off by default), named-approver step for emergency service.
- **Smart chat**: Gemini reads typed messages into BOB's commands and answers approved FAQs. It can't set prices or book.
- **Messages**: LeadConnector texts and emails (verification codes, confirmations, approver requests).

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

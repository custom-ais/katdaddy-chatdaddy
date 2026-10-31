# BOB — Dryer Vent Squad booking assistant

Customer chat (`/chat`, embeddable with `/embed.js`) and office dashboard (`/admin`) for Dryer Vent Squad West Valley.

- **Booking**: question-by-question flow, exact prices from the service catalog, phone-code verification, held times, and a finished booking is a scheduled Jobber job with a visit.
- **Rules**: service-area ZIP gate, travel fee, drive time under 20 minutes between jobs, route scoring from the scheduling workbook, optional same-day and 5 PM overflow (off by default), named-approver step for emergency service.
- **Smart chat**: Gemini reads typed messages into BOB's commands and answers approved FAQs. It can't set prices or book.
- **Messages**: texts and emails through Twilio (SMS, Verify, SendGrid) and/or LeadConnector — phone codes, booking confirmations, day-before reminders, approver requests, office alerts, and customers' replies forwarded to the office. Settings → Texts and emails picks the service; LeadConnector keeps saving contacts either way.

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

## Twilio

Set these in Vercel (Production), then redeploy. Each piece works on its own; whatever isn't set falls back to LeadConnector when the provider setting is "Automatic".

| Variable | What it's for |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | `AC…` — required for texts and Verify |
| `TWILIO_AUTH_TOKEN` | Signs Twilio's webhooks (delivery receipts, replies). Also the API password unless an API key is set |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | Optional `SK…` key for API calls (recommended) |
| `TWILIO_MESSAGING_SERVICE_SID` | `MG…` — the sender for texts. Handles STOP/HELP and A2P registration |
| `TWILIO_FROM_NUMBER` | Only if there's no Messaging Service |
| `TWILIO_VERIFY_SERVICE_SID` | `VA…` — phone codes through Twilio Verify. Keep the code length at 6 |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME` | Email through Twilio SendGrid. The from address must be a verified sender or an authenticated domain |
| `PUBLIC_ORIGIN` | e.g. `https://katdaddy-bookingbot.vercel.app` — needed for delivery receipts |
| `CRON_SECRET` | Any long random string. Vercel sends it to `/api/cron/reminders` (daily, 4 PM Arizona) |

In Twilio, set the number's (or Messaging Service's) incoming-message webhook to `POST <app url>/api/twilio/inbound`. Status callbacks go to `<app url>/api/twilio/status` automatically.

US texting from a 10-digit number needs an approved **A2P 10DLC** campaign (or a verified toll-free number); until then carriers block the texts (error 30034, shown in Settings). Twilio Verify phone codes don't need that registration, so booking can go live on Verify first.

Day-before reminders are off by default (Settings → Texts and emails). If Jobber already sends visit reminders, use one or the other. A visit that lives in Jobber is reminded only when Jobber still has it at the same time.

The message log is kept in `bob.kv` (`msg:` keys, 90 days), so no new table is needed.

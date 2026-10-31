# BOB — Dryer Vent Squad booking assistant

Customer chat (`/chat`, embeddable with `/embed.js`) and office dashboard (`/admin`) for Dryer Vent Squad West Valley.

- **Booking**: question-by-question flow, exact prices from the service catalog, optional phone-code verification, held times, and a finished booking is a scheduled Jobber job with a visit.
- **Rules**: service-area ZIP gate, travel fee, drive time under 20 minutes between jobs, route scoring from the scheduling workbook, optional same-day and 5 PM overflow (off by default), on-call acceptance for emergency service and named approval for overflow.
- **Smart chat**: Gemini reads typed messages into BOB's commands and answers approved FAQs. It can't set prices or book.
- **Messages**: branded SMTP appointment emails and a 5:10 p.m. Arizona daily report. Texting preferences are still recorded in Jobber while customer SMS and phone-code verification are paused.
- **Office visibility**: live BOB activity, observable decision explanations, a rolling 60-day conversation archive, and calendar-derived technician availability.
- **On call**: optional emergency/same-day availability check after the normal service/contact flow. On-call technicians have five minutes to accept; unaccepted requests become emailed office support tickets. Acceptance still requires a live schedule check and customer confirmation.
- **Admin settings**: encrypted API credentials and bounded Gemini model/temperature/response settings.

See [Operations setup](docs/operations-setup.md) before deploying this release.

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

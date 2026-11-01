# BOB — Dryer Vent Squad booking assistant

Customer chat (`/chat`, embeddable with `/embed.js`) and office dashboard (`/admin`) for Dryer Vent Squad West Valley.

- **Booking**: question-by-question flow, exact prices from the service catalog, contact-code verification, held times, and a finished booking is a scheduled Jobber job with a visit.
- **Rules**: service-area ZIP gate, travel fee, drive time under 20 minutes between jobs, route scoring from the scheduling workbook, optional same-day scheduling, named-approver step only for emergency same-day service. Other legacy approval-only exceptions/overflow remain office-only.
- **Smart chat**: Gemini reads typed messages into BOB's commands and answers approved FAQs. It can't set prices or book.
- **Messages**: Explicit Twilio Verify SMS/email and independently gated appointment texts are documented in `TWILIO-SETUP.md`. LeadConnector is removed; confirmation email uses separately configured SendGrid transactional delivery.
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

### Optional Jobber Client Hub link

In Settings → Connections, the Client Hub setting accepts only the public company login link copied from **the connected company's Jobber Settings → Client hub**. Confirm that the displayed Jobber company is the company whose link you copied. Jobber account identity can be verified through OAuth; ownership of a manually supplied Hub URL is **not** independently verified by the API.

The link is optional and blank by default. When safely bound to the same connected account as a newly booked appointment, it appears as an **Open Client Hub** button and plain-text URL in the booking-confirmation email. It is not included in four-digit verification messages or SMS confirmations. It is a login page, not a personalized authentication token or an appointment-verification action.

Disconnecting or changing the Jobber connection disables the binding until an administrator reconfirms it; ordinary OAuth token refreshes do not. If account identity cannot be checked, or a historical appointment lacks the verified account binding, the email is sent without the link. Invalid links, personal login tokens and arbitrary query parameters are rejected. No emails are resent merely by editing this setting.

# Email, activity archive, and on-call rollout

This release preserves the service questions, pricing, safety guidance, arrival windows, Jobber booking checks, and final customer confirmation. The authorized exceptions are pausing customer SMS and phone verification, adding the optional on-call availability check, and preventing same-day/emergency booking until the phone connection is tested.

## Before production

1. Verify the deployment targets `katdaddy-bookingbot`, the `seths-projects-e9e6cba0` Vercel team, and the existing Supabase project `nmqljrhhtctfekcfcrca`. Do not substitute another database.
2. Apply `supabase/bob-observability.sql` to the existing database. It adds two private tables and their indexes/permissions, without changing existing appointments. Direct Postgres deployments can also create the tables at startup; Supabase REST deployments require the migration first because their service role is not the table owner.
3. Confirm the Vercel plan supports minute-level Cron Jobs (Pro or above). `vercel.json` schedules the report at `10 0 * * *` UTC, which is **5:10 p.m. America/Phoenix** year round, and checks on-call deadlines every minute. Hobby does not support this on-call schedule or precise report timing. Do not upgrade the plan without the account owner's authorization. Cron jobs run on production deployments.
4. Set `CRON_SECRET` to a strong random secret in Production. Vercel supplies it in the Authorization header when invoking cron handlers. Set a separate `BOB_SECRET_KEY` to 32 random bytes encoded as base64 or 64 hex characters. Keep that key stable and backed up securely: replacing it makes previously saved credentials unreadable.
5. Set `PUBLIC_ORIGIN` or `NEXT_PUBLIC_APP_URL` to `https://katdaddy-bookingbot.vercel.app`. On-call response links use this trusted origin.
6. Configure SMTP below, run the checks, and only then deploy the reviewed commit to production. A preview must not silently share production credentials or send real customer messages.

## Email account

Use `westvalley@dryerventsquad.com` for SMTP_USER, EMAIL_FROM, and EMAIL_REPLY_TO. For Google Workspace, SMTP_HOST is `smtp.gmail.com`, SMTP_PORT is `465`, and SMTP_PASSWORD is a **Google app password**, not the mailbox sign-in password. The mailbox must have two-step verification, and its organization must permit app passwords. If it does not, configure another authenticated SMTP provider authorized to send from that address.

Enter these values directly into Vercel or Admin → Settings → Connections and API keys. Never paste passwords or tokens into chat, Git, or a support ticket. The connected Gmail tool does not supply deployable server credentials. Use **Check email connection** to verify the saved SMTP login without sending a message.

Customer confirmation emails send only for confirmed appointments with an email address and email confirmations enabled. Their existing prices and arrival windows are unchanged. SMTP acceptance is recorded as `sent`; it is not proof of inbox delivery. LeadConnector email is used only when no direct SMTP account is configured, so a failed SMTP attempt is not blindly resent through another provider.

Daily reports go to **westvalley@dryerventsquad.com**, CC **seth@custom-ais.com**, by default. They cover the interval from the previous 5:10 p.m. cutoff to the current cutoff; activity after today's cutoff appears tomorrow. Reports include conversations/messages, AI versus guided replies, booking results and quoted value, callback/support requests, approvals, and operational issues. The first report identifies partial conversation tracking. Large lists are capped with links to the dashboard; quoted value is not collected revenue.

The report uses a database lock and delivery receipts to suppress duplicate invocations. An ambiguous SMTP result requires reviewing the sender's Sent folder before a deliberate retry. Inspect `diag:daily-report` and `report:daily:<cutoff>`; do not clear an uncertain receipt unless delivery has been checked.

## One-time phone pause

On the first startup of this release, one atomic config update sets `smsConfirmations=false`, `requirePhoneVerification=false`, `phoneServiceReady=false`, and `emailConfirmations=true`. The config marker `emailLaunchVersion=1` prevents later startups from overwriting subsequent admin choices. The config version increments so a stale settings tab cannot silently undo the rollout.

Customers still answer the texting-consent question. The answer is stored on BOB's booking and passed to Jobber's phone `smsAllowed` field, including for an existing matching client phone. Other client phone numbers are preserved. The normal final booking approval is still required.

## On-call availability

In Settings → Technicians, supply each participating technician's mobile number, link the correct Jobber user, enable online bookings for that technician, and switch **On call** on. Off-duty technicians are excluded. After testing the HighLevel sender, enable **Office phone connection has been tested**. Customer SMS confirmations can remain off independently.

The normal service, safety, address, and contact questions come first. The availability screen offers an explicit emergency/same-day check. A request texts each eligible on-call technician a short-lived signed link. Opening the link does not accept; the technician must tap **I can take it** or **I'm unavailable**. The first acceptance wins and is tied to the requested service/contact details. BOB then checks that technician's live calendar and travel constraints, offers available times for today, and waits for the customer's final confirmation. Acceptance is not a booking and does not override safety, coverage, price, drive-time, or working-hours rules. Separate overflow approval still applies.

After five minutes without acceptance, or if everyone declines, BOB explains that the team is taking care of other customers and creates an urgent support ticket in the existing Requests tab. The ticket is emailed to **westvalley@dryerventsquad.com**. The minute cron means processing normally occurs within about one minute after the five-minute deadline, even if the customer closes the page. Delivery failures remain visible; no claim of a confirmed appointment is made. An accepted check expires after 30 minutes without booking and also becomes a follow-up ticket. A full calendar after acceptance creates a ticket immediately.

Before phone readiness, the same button submits an office follow-up ticket without texting or enabling same-day bookings. The current implementation uses the existing HighLevel integration for technician texts; a Twilio account by itself does not configure this sender.

## Activity and data retention

Admin → BOB activity polls every three seconds when visible. The archive lists conversations and loads their retained messages, contact questions, state transitions, detected facts, rule decisions, and API outcomes. Explanations describe observable behavior; no private model chain of thought is collected or shown. These endpoints require an admin session and return no chat bearer tokens or stored credentials.

Messages older than 60 days are excluded from reads and deleted during cleanup. Conversation summaries expire 60 days after their last activity. Cleanup runs with the daily report and periodic API housekeeping; older callback transcript copies are also removed. Operational bookings and support tickets remain normal business records. The archive begins with this deployment; it does not reconstruct messages that were never stored.

## Key and AI controls

Admin credentials are encrypted using AES-256-GCM with a fresh nonce. Only a whitelist of integration fields is editable. The API returns field names and configured/source status, never saved values. Blank inputs retain existing credentials; removing a dashboard override falls back to a Vercel value if present. Do not put the database URL, admin password, cron secret, or encryption key into the integration editor.

Saved overrides take effect on subsequent requests across serverless instances. Rotating Jobber app credentials may require reconnecting Jobber OAuth. Model name, temperature (or provider default), token limit, and timeout are adjustable; the deterministic safety, pricing, and booking rules remain enforced.

Technician status is derived from working hours, BOB visits, and Jobber's calendar (cached up to 60 seconds). A missing Jobber mapping or failed calendar read shows unknown availability. Manual off-duty remains an override. The status is a calendar availability indicator, not GPS tracking or a promise that a full new visit will fit.

## Verification

Run the full Node tests, `npm run typecheck`, and `npm run build`. Verify migration permissions, SMTP login, cron authorization, and the production deployment with the correct credentials. Do not create a real customer booking or text a technician solely as a test without arranging that test with the office.

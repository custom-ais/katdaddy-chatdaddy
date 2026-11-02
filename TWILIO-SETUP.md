# Twilio booking integration — staged, not enabled by this change

No messaging provider is selected implicitly. LeadConnector has been removed. No credentials, messages, or deployments are included.

## Server-only configuration contract

For verification, explicitly select `BOOKING_VERIFICATION_PROVIDER=twilio`, and configure:
- `TWILIO_ACCOUNT_SID` (AC identifier)
- `TWILIO_API_KEY_SID` (SK identifier)
- `TWILIO_API_KEY_SECRET`
- `TWILIO_VERIFY_SERVICE_SID` (VA identifier)

Use a Verify service with **4-digit codes** (Verify service → General settings → Code length = 4; the booking page only accepts 4 digits, by text or email), SMS and Email enabled, and its SendGrid mailer attached. The attached mailer stays in Twilio; this application does not need its SendGrid key. Confirm the active email template uses `{{twilio_code}}`. Review geographic restrictions and fraud safeguards before approved real tests.

Twilio verification is always required when explicitly selected, independently of the old phone-verification/text-confirmation switches. An incomplete configuration disables online booking. The customer explicitly chooses SMS or email before sending. A callback number remains required and can be a landline with email verification. Email verification never marks a phone verified and never grants SMS consent.

For ordinary owner, customer confirmation, or company texts, separately select `BOOKING_SMS_PROVIDER=twilio`, configure `TWILIO_MESSAGING_SERVICE_SID`, and set `TWILIO_SMS_SENDER_APPROVED=true` **only after** business/campaign/sender registration and consent requirements have been verified. Merely creating a Verify service or approving a brand is not ordinary-SMS readiness. This flag records the operator's attestation; it does not check Twilio's campaign approval. Missing approval/configuration fails closed; it never silently falls back to another provider.

LeadConnector CRM/contact synchronization and its appointment-email transport have been removed. Existing local requests and Jobber booking records remain. No connector credentials are revoked or deleted. Verify email is only an OTP, never a booking confirmation. Separate SendGrid transactional delivery is supported with `BOOKING_EMAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` and `SENDGRID_SENDER_VERIFIED=true` only after sender verification. Optional `SENDGRID_FROM_NAME` controls the sender display name. The API key needs Mail Send access and stays server-side. Existing app HTML/text templates are used; no SendGrid dynamic template ID is required and the Verify OTP template is untouched. Until configured, email confirmations report `skipped`; they never pretend delivery succeeded. The Connections email switch disables confirmation and emergency approval email independently of Verify. A permanent per-record claim prevents duplicate attempts on retries or uncertain timeouts; `accepted` means SendGrid accepted the request, not that the inbox received it.

Never use VITE_ or NEXT_PUBLIC_ names for Twilio secrets. Provision keys privately in the hosting environment, not chat/repository. Do not put raw codes or provider responses in logs.

### Owner-only ordinary SMS

Set the server environment variable `SMS_OWNER_ALERTS_ONLY` to the exact string `true` to suppress customer confirmation SMS, company approver SMS, and staff early-availability SMS. The default is off. Approver email continues through its existing email checks. Public configuration reports `textMessages: false`, so the customer UI does not offer confirmation texting. This mode does not change Twilio Verify SMS/email codes or the separate owner booking and service-error alerts; each keeps its own readiness and consent checks. Customer confirmation email also retains its existing settings.

The program for owner alerts is **Custom-AIs ChatDaddy Owner Alerts**. Its campaign references are [SMS Terms](https://custom-ais.com/sms-terms), [Privacy Policy](https://custom-ais.com/privacy), and [consent evidence](https://custom-ais.com/sms-consent). Use the owner campaign entry checklist **Part 4** for registration evidence and entry details. Part 4 has not been supplied for this local implementation; no campaign identifier, registration status, approval, or completed checklist is implied. The owner program's consent does not authorize customer or approver messages.

## Scheduling and company notices

Only an emergency appointment on today's **America/Phoenix** calendar date enters online company approval. It remains pending until a named authenticated approver accepts; then the existing fresh schedule check and Jobber job/visit creation run before confirmation.

Previously approval-only non-emergency overflow or other configured exceptions are withheld from online booking and directed to the office, rather than silently losing their safety gate. Future-day emergency exceptions also need office handling. This preserves current schedule/cutoff/route constraints; enabling broader overflow behavior requires an explicit business decision.

Early company availability notices are emergency same-day only. They are inquiries, not confirmed appointments. Existing before-2-PM cutoff and deduplication remain. Owner-only mode suppresses these SMS notices; availability requests are still captured for the team.

## Verification and rollout

Requests for different booking conversations run independently. Overlapping updates to one booking wait briefly for its current operation; activity logging does not hold that booking's lock. A duplicate code request during cooldown returns the existing pending code information without another provider send. The browser retries only an explicit `CONVERSATION_PENDING` response, which means the operation has not run; it never automatically retries an uncertain provider send or booking. Existing destination limits, cooldowns, code expiry and attempt limits still apply.

Run `npm test`, `npm run typecheck`, and `npm run build` without production environment credentials. Tests use fake providers and in-process Postgres; no real booking/SMS/email is needed.

Before publishing: review the diff, verify provider configuration in a non-production environment, confirm the exact company approver/contact and registered SMS sender, obtain approval for one controlled SMS and email OTP test and one confirmation test, then verify provider acceptance/delivery independently. No production push/deploy or real message is authorized by these local changes.

## Owner consent and optional booking alerts

Master Admin manages owner consent, the two owner-alert switches, and `bookingOwnerSmsPhone` (default blank). The recipient is configured privately per deployment/tenant, never hardcoded, and is separate from the emergency approver. `bookingOwnerSmsEnabled` and `ownerErrorSmsEnabled` both default to **false**, including saved settings from before their introduction. Enabling either requires a valid configured number; saving a switch is not a consent grant or proof of provider readiness.

Both owner alert purposes require a durable, current **v2** grant (`custom-ais-owner-alerts-v2`) for the currently configured normalized phone number. The v2 disclosure covers successful ChatDaddy bookings and actionable service errors. A v1 receipt never authorizes either purpose and is not silently upgraded. A recipient change requires consent for that recipient. Missing, withdrawn, mismatched, or unreadable consent blocks sending. A ready selected ordinary-SMS provider and its enabled connection are also required; read-only previews never send. These controls and consent management require Master Admin authority.

Booking alerts, when enabled, notify once for an original customer-chat (`ai_bot`) appointment after successful confirmation, including approved emergency bookings and a pending chat booking later confirmed by the office. Pending/failed/declined bookings, manual office-created appointments, and manual customer-confirmation resends do not create successful-booking alerts. Owner consent and switches are independent of customer SMS-consent/confirmation preferences and company approval requests.

A permanent atomic claim in the existing `bob.kv` table precedes the provider call. Uncertain/failed sends are recorded and are not automatically retried, prioritizing no duplicate owner texts over guaranteed delivery. A claimed attempt may therefore need office review if the process/provider fails. Delivery is not proven by API acceptance. No new schema migration is needed.

### Optional owner service-error alerts

`ownerErrorSmsEnabled` is a separate default-off switch. Only these six event types qualify:

1. An original customer-chat booking needs office action (`action_needed`).
2. An original customer-chat booking has a hard Jobber booking failure.
3. The Jobber connection transitions into `error`.
4. The verification connection transitions into `error`.
5. The assistant connection transitions into `error`.
6. The email connection transitions into `error`.

SMS-connection errors, database errors, and office-created bookings do not trigger service-error SMS. Messages use fixed operational descriptions and an opaque booking reference where applicable; they exclude customer names, phone numbers, addresses, free-text notes, raw exceptions, and provider responses. The current v2 recipient consent, ordinary-SMS readiness, and preview restrictions above apply to every attempt.

An atomic durable claim permits at most one service-error attempt per booking ever, across both booking failure types. Connection alerts are limited to one attempt per connection in a six-hour bucket, and all service-error attempts share a cap of ten per **America/Phoenix calendar day**. These limits are for error alerts, separate from successful-booking deduplication. Failed or uncertain attempts retain their claims and are never automatically retried. Provider acceptance does not prove delivery, and a failing alert must not change the booking outcome.

## Phone display formatting

All editable admin/customer phone controls format US numbers as `(xxx) xxx-xxxx` while typing, including `+1` paste. Partial entry, selection, caret movement, and separator deletion use a shared display helper. General chat prose, searches, and OTP input are not reformatted. Canonical provider/booking destinations remain E.164. Unsupported international, alphabetic, extended or overlong values are not silently truncated into a different US recipient; the server rejects unsupported values.

The test command blocks non-loopback fetches before transport; provider integrations inject fake responses. Browser interaction testing must still run on an executor where Chromium is permitted before production cutover.

## Hosted preview safety

Vercel previews are deliberately **read-only**. The API dispatch guard runs before importing the real runtime: no database initialization/migration, provider client, message, booking, OAuth, admin login, or paid AI operation is permitted. Only static health/public configuration and an inert session bootstrap are available. This permits an initial visual review, not a live end-to-end booking test. The preview UI labels that restriction.

Preview builds also exclude inherited `VITE_*` environment variables from Vite's client environment prefix. No client code currently reads that key, and a nonsecret canary build confirmed it is absent from emitted assets. Production environment-prefix behavior is unchanged. Deployment protection remains enabled and no share/bypass link is created.

### Verify works but confirmation/owner texts do not

Verify codes and ordinary appointment messages are separate Twilio products/configurations. Confirm the account has an SMS-capable sender in the appropriate Messaging Service, with applicable sender/campaign registration approved and recipient consent requirements satisfied. Then configure Production `BOOKING_SMS_PROVIDER=twilio`, `TWILIO_MESSAGING_SERVICE_SID` (MG…), and `TWILIO_SMS_SENDER_APPROVED=true` only after that approval is verified, plus server credentials with permission to create Messages. A restricted key permitted only to create/check Verify requests will not suffice for ordinary Messages. Do not infer the current key's permissions merely from successful OTP delivery. Redeploy after environment changes. Never paste credentials in chat or templates.

Connections → appointment texts must be on. Customer confirmations additionally require `SMS_OWNER_ALERTS_ONLY` to be off, Settings → Templates to select Text or Both, and customer consent. Owner alerts use their separate enabled setting, configured recipient, and current v2 consent. These settings never auto-approve a sender or activate a paid transport. Verify STOP/HELP handling, opt-out suppression, and the campaign's public evidence before a separately approved activation; this local implementation and its tests do not establish those external facts.

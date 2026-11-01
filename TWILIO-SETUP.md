# Twilio booking integration — staged, not enabled by this change

The default remains LeadConnector. No credentials, messages, or deployments are included.

## Server-only configuration contract

For verification, explicitly select `BOOKING_VERIFICATION_PROVIDER=twilio`, and configure:
- `TWILIO_ACCOUNT_SID` (AC identifier)
- `TWILIO_API_KEY_SID` (SK identifier)
- `TWILIO_API_KEY_SECRET`
- `TWILIO_VERIFY_SERVICE_SID` (VA identifier)

Use a Verify service with **four-digit codes**, SMS and Email enabled, and its SendGrid mailer attached. The attached mailer stays in Twilio; this application does not need its SendGrid key. Confirm the active email template uses `{{twilio_code}}`. Review geographic restrictions and fraud safeguards before approved real tests.

Twilio verification is always required when explicitly selected, independently of the old phone-verification/text-confirmation switches. An incomplete configuration disables online booking. The customer explicitly chooses SMS or email before sending. A callback number remains required and can be a landline with email verification. Email verification never marks a phone verified and never grants SMS consent.

For ordinary customer confirmation/company texts, separately select `BOOKING_SMS_PROVIDER=twilio`, configure `TWILIO_MESSAGING_SERVICE_SID`, and set `TWILIO_SMS_SENDER_APPROVED=true` **only after** business/campaign/sender registration and consent requirements have been verified. Merely creating a Verify service or approving a brand is not ordinary-SMS readiness. Missing approval/configuration fails closed; it never silently falls back to LeadConnector texting.

LeadConnector remains the CRM/contact and appointment-email integration (`LC_PRIVATE_TOKEN`, `LC_LOCATION_ID`, existing optional settings). Verify email is only an OTP, never a booking confirmation. Existing LeadConnector appointment emails remain enabled under their existing configuration. Twilio SMS is independent of LeadConnector contact-upsert success; CRM failures cannot silently change its selected provider. Keep LeadConnector configured for appointment emails and CRM.

Never use VITE_ or NEXT_PUBLIC_ names for Twilio secrets. Provision keys privately in the hosting environment, not chat/repository. Do not put raw codes or provider responses in logs.

## Scheduling and company notices

Only an emergency appointment on today's **America/Phoenix** calendar date enters online company approval. It remains pending until a named authenticated approver accepts; then the existing fresh schedule check and Jobber job/visit creation run before confirmation.

Previously approval-only non-emergency overflow or other configured exceptions are withheld from online booking and directed to the office, rather than silently losing their safety gate. Future-day emergency exceptions also need office handling. This preserves current schedule/cutoff/route constraints; enabling broader overflow behavior requires an explicit business decision.

Early company availability notices are emergency same-day only. They are inquiries, not confirmed appointments. Existing before-2-PM cutoff and deduplication remain.

## Verification and rollout

Requests for different booking conversations run independently. Overlapping updates to one booking wait briefly for its current operation; activity logging does not hold that booking's lock. A duplicate code request during cooldown returns the existing pending code information without another provider send. The browser retries only an explicit `CONVERSATION_PENDING` response, which means the operation has not run; it never automatically retries an uncertain provider send or booking. Existing destination limits, cooldowns, code expiry and attempt limits still apply.

Run `npm test`, `npm run typecheck`, and `npm run build` without production environment credentials. Tests use fake providers and in-process Postgres; no real booking/SMS/email is needed.

Before publishing: review the diff, verify provider configuration in a non-production environment, confirm the exact company approver/contact and registered SMS sender, obtain approval for one controlled SMS and email OTP test and one confirmation test, then verify provider acceptance/delivery independently. No production push/deploy or real message is authorized by these local changes.

## Optional owner booking alert

Settings → Owner booking alerts adds `bookingOwnerSmsEnabled` (default **false**) and `bookingOwnerSmsPhone` (default blank). The recipient is configured privately per deployment/tenant, never hardcoded. Enabling requires an explicit valid number and a ready selected ordinary-SMS provider. This number is **not** the emergency approver.

It alerts once for an original customer-chat (`ai_bot`) appointment after successful confirmation, including approved emergency bookings and a pending chat booking later confirmed by the office. Pending/failed/declined bookings, manual office-created appointments, and manual customer-confirmation resends do not create owner alerts. It is independent of customer SMS-consent/confirmation preferences and separate from company approval requests.

A permanent atomic claim in the existing `bob.kv` table precedes the provider call. Uncertain/failed sends are recorded and are not automatically retried, prioritizing no duplicate owner texts over guaranteed delivery. A claimed attempt may therefore need office review if the process/provider fails. Delivery is not proven by API acceptance. No new schema migration is needed.

## Phone display formatting

All editable admin/customer phone controls format US numbers as `(xxx) xxx-xxxx` while typing, including `+1` paste. Partial entry, selection, caret movement, and separator deletion use a shared display helper. General chat prose, searches, and OTP input are not reformatted. Canonical provider/booking destinations remain E.164. Unsupported international, alphabetic, extended or overlong values are not silently truncated into a different US recipient; the server rejects unsupported values.

The test command blocks non-loopback fetches before transport; provider integrations inject fake responses. Browser interaction testing must still run on an executor where Chromium is permitted before production cutover.

## Hosted preview safety

Vercel previews are deliberately **read-only**. The API dispatch guard runs before importing the real runtime: no database initialization/migration, provider client, message, booking, OAuth, admin login, or paid AI operation is permitted. Only static health/public configuration and an inert session bootstrap are available. This permits an initial visual review, not a live end-to-end booking test. The preview UI labels that restriction.

Preview builds also exclude inherited `VITE_*` environment variables from Vite's client environment prefix. No client code currently reads that key, and a nonsecret canary build confirmed it is absent from emitted assets. Production environment-prefix behavior is unchanged. Deployment protection remains enabled and no share/bypass link is created.

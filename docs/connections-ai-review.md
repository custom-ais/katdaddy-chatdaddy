# Connections and Smart chat review

Base: main `653288e4fa5e6fc2486c6939121f3e94b81dfb33` (including the separately deployed typed-address routing hotfix). No deployment or remote write is included.

## Configuration contract

Persisted tenant settings `aiProvider` (`gemini` default, or `openai`) and existing `aiAssistant` select the language layer. Server environment only: `GEMINI_API_KEY`, optional `GEMINI_MODEL`; or `OPENAI_API_KEY`, optional `OPENAI_MODEL` (default `gpt-4.1-mini`). No frontend-prefixed secrets. OpenAI API billing is separate from a ChatGPT subscription. Missing selected credentials mean deterministic buttons/keyword handling, not fallback to another paid provider. Both providers use the same instruction/schema/result guardrails; prices, availability and booking remain deterministic.

Settings Connections switches persist in `integrations`: `jobber`, `maps`, `verification`, `sms`, `email`. Legacy configs default these switches true to preserve existing integration eligibility, but never create credentials or select an unconfigured transport. Switch changes are drafts until Save. Disabling Jobber/Maps/Verify warns first. Database remains required infrastructure without an off switch. Provider wrappers and outbound fetch guards re-read persisted config; cached credentials cannot bypass off switches. Off stops subsequent requests, but cannot cancel a provider request already accepted externally.

- Jobber off stops live calendar/account/mutation calls and pauses Jobber-backed booking. Saved OAuth account remains; local disconnect still allowed.
- Maps off stops Google and Census calls, including cached lookups, and pauses online booking because verified addresses/routes cannot be supplied. No new Maps APIs or billing settings enabled.
- Verify off blocks required verification and booking; it is not a verification bypass. Required verification no longer depends on customer SMS-confirmation preferences. Explicitly selected Twilio always requires verification. The existing intentional `requirePhoneVerification=false` policy is preserved only when no Twilio provider is selected; turning the integration off does not change that policy.
- Appointment SMS off suppresses customer texts, emergency same-day approval texts and owner alerts. Verify remains separately controlled.
- Appointment email off suppresses SendGrid customer confirmations and emergency approval emails independently of Verify OTP.
- Smart chat off avoids model calls and retains deterministic chat.

Twilio still requires explicit `BOOKING_VERIFICATION_PROVIDER=twilio` and server credentials/service SID. Ordinary texts additionally require `BOOKING_SMS_PROVIDER=twilio`, `TWILIO_MESSAGING_SERVICE_SID` and explicit `TWILIO_SMS_SENDER_APPROVED=true`. Nothing is enabled in production by this patch.

## LeadConnector removal and delivery gap

Removed LC transport, CRM/contact synchronization, request note synchronization, identity lookup and UI. Local requests and Jobber records persist normally. Old environment values and external connectors are untouched. No automatic replacement sending is selected. Booking confirmation and emergency approval email use explicitly configured SendGrid. Required server variables: `BOOKING_EMAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_SENDER_VERIFIED=true` after sender verification; optional `SENDGRID_FROM_NAME`. No dynamic template ID is needed: existing server-generated HTML/text templates remain separate from Verify OTP. Missing configuration is visibly unavailable. HTTP202 is accepted for delivery, not confirmed delivered. A permanent kind+record-ID claim prevents retries, repeated clicks and ambiguous timeouts from duplicating email; rejected/uncertain outcomes require office review, not automatic resend. Twilio Verify's attached mailer sends codes only. Customer receipts and office records remain; unavailable notification delivery never rolls back or duplicates an appointment.

## Recorded status clarity

Maps operation results stay separate: address lookup, suggestions and driving routes. A recent successful route does not prove unused/stale operations; partial success is displayed explicitly with per-operation timestamps. Active failures retain precedence; historical failures remain collapsed, never revived by refresh. Refresh makes no provider calls. Account identity lookup remains distinct from service health; no project identity is inferred from a key.

## Preserved safety

Four-digit server Verify, exact destination/channel binding, expiry/attempt/rate/replay guards; emergency-only company approval; owner-alert consent/config/dedup; scheduling route fail-closed, fresh revalidation and verified Jobber visit assignments; eight Settings subpages, save drafts, navigation/history. No live provider calls, messages or bookings in QA.

## Remaining review gates

SendGrid was selected by the user. Configure its Mail Send API key and verified sender securely before release if email confirmations are required. No key creation or sender choice was inferred from the existing Verify mailer. Credentials/settings are separately managed; do not paste secrets into code or conversation. No PR merge or production deployment authorized by this implementation request. Browser QA remains subject to the documented local Chromium environment limitation; SSR/callback and mocked API tests are not a successful real-browser run.

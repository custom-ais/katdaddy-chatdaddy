# Scheduling-first release review

Based on current main `66ff2df53523d3d6cf88b1dfecd8fc2b859cd19b`, preserving the later shared four-digit verification and browser-submit fixes. This release does not merge the older setup branch wholesale.

## Changes
- Jobber booking requires a mapped member before client/job creation. Creation is confirmed only after fresh visit ID, interval and assignee readback. Incomplete/malformed provider responses remain uncertain. Known partial IDs are retained for office reconciliation; no blind mutation retry.
- Office-created bookings also reserve locally before provider creation. Unverified results stay action-needed without confirmation. Resolving as in-Jobber requires matching visit readback, not a job number alone.
- Local reservations remain until a confirmed remote visit matches ID, interval and mapped technician. Incomplete Jobber pages/assignee lists/time ranges fail closed, rather than silently freeing capacity.
- Travel feasibility no longer substitutes straight-line estimates for measured road travel. Unknown legs block affected automatic slots. Configured base rules are reverified at final confirmation. Route caches are connection-scoped, measured/timestamped, five minutes; final checks bypass them. Existing traffic-unaware routing remains, not a traffic guarantee or route optimizer.
- Inactive preferred technicians are not reintroduced; overnight timed commitments overlap following days correctly.
- Settings has eight URL-addressable subpages. Back/Forward and top-level navigation retain Settings drafts; reload warns when settings/team drafts are dirty. No saved values or existing business controls are removed.
- Connections shows passive, operation/config-aware diagnostic status and collapsed historical errors. Account-name refresh is a separate authenticated, CSRF-protected POST, not a booking/message/paid Maps test.

## Account names
Existing server credentials only; no new environment variables or permissions are silently added.
- Jobber: documented account name, tied to current OAuth connection.
- Twilio: matching account friendly name/status via Account GET with existing API key. If restricted permissions deny it, identity remains unavailable; sending configuration is separate.
- LeadConnector: configured location name via Locations GET. If existing token lacks location-read permission, show unavailable; do not expand scopes automatically.
- Google Maps, Gemini, database: no account/project identity inferred from keys, model names or database type.
Identity cache is 24 hours and credential-scoped, contains projected names/statuses only. Refresh errors do not expose provider bodies or credentials. Account identity does not prove every provider operation is healthy.

## Launch checklist (not activated by this patch)
1. Confirm one intended active DVS technician and select that person's actual Jobber user. Defaults do not infer identity.
2. Confirm hours, duration catalog, company closures/capacity, service area and existing credentials/sender readiness.
3. Time-off/callouts are not imported automatically. For single-tech launch use company Closed dates, off-duty, or pause booking; full dated staff calendars remain later work.
4. Preserve emergency-same-day-only approval, customer verification/consent, optional owner alerts. No notification defaults or recipient configuration changed.
5. Review changes and preview, then separately approve production release and any controlled live booking/message tests. No finance, revenue scoring, fuel provider, RCS or advanced multi-crew work included.

## Limits
Browser interaction needs a functioning Playwright Chromium installation; the current environment lacked it and its normal installer returned invalid/truncated archives. Automated API/unit/SSR/navigation-contract checks are separate from real browser or live Jobber proof. No database migration is required. Readback failures may conservatively require office review even when a provider write eventually succeeds.

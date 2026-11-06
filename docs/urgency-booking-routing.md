# Urgency-aware booking routing: production reconciliation

Local changes based on production commit `7ee0fdeef11fa51c23bf62a77f016c038db60a0e`. No push, PR, merge or deployment has been performed. The earlier patch on `bfd5e79` is superseded and must not be deployed.

## Verified production baseline

On 2026-11-06, the production alias pointed to Vercel deployment `dpl_4jy3mKb61V3WQ6jFTVJ6qrfkLH28`. The production Supabase URL was matched to the connected database; read-only queries projected scheduling fields from `bob.settings`, without retrieving credentials or customer records.

| Rule | Saved production value | With this change |
| --- | --- | --- |
| Drive between jobs | Strictly under 20 minutes | Routine under 20; urgent under 25 |
| Minimum gap | 15 minutes | Unchanged; measured travel must fit when longer |
| Drive from base | 60 minutes maximum | Unchanged |
| Regular / emergency notice | 12 / 4 hours | At least 12 hours for every booking path |
| Same-day | Disabled | Disabled, including starts over 12 hours away |
| Daily capacity | 5 jobs | Unchanged |
| Service area | Driving distance, standard 49 miles / outer 65 miles | Unchanged |
| Booking horizon | 45 days | Unchanged |

Both configured technicians are active in scheduling with Jobber mappings, business-hours fallback and no time off. Current off-duty status still affects today only; future work schedules determine eligibility. No persisted settings or appointments were changed.

## Behavior and preserved functionality

The existing performance/assessment answers identify a dryer that is not working, overheats/shuts off, or shows an error. Normal operation, slower drying alone, package selection, and client urgency flags do not widen routing. No question is added. Existing safety handling and the current Emergency-to-office phone handoff remain in place; removed emergency/after-hours chat offers are not restored.

Explicit corrections reconcile the matching saved symptoms and triage facts, including when AI interpretation substitutes a command for the original message. Normal drying alone does not retract a reported error or heat problem. A corrected routine request loses the wider allowance, and an earlier held opening must pass the ordinary route rules at confirmation.

New heat reports retain their source (heat, shutoff, or burning smell) in session JSON so correcting one does not erase another. Older coarse heat records with no known source remain urgent until all three are explicitly denied; a known legacy overheating/shutoff triage label retains those two sources. Questions and hypothetical statements do not clear reported problems.

Urgent requests get five extra minutes on the saved between-job drive limit and see feasible times chronologically. Routine route scoring, nearby-first behavior and revenue pacing stay unchanged. No slots are reserved and routine customers are not artificially delayed.

Known measured travel in both relevant directions and the configured buffer must fit before and after a visit. At the production 15-minute buffer, a 22-minute drive requires at least 22 minutes. Capacity, overlapping jobs, coverage, fees, blocked days, technician weekly hours/time off, and final fresh route checks are preserved. Extra Jobber assignees, calendar deduplication, batch geocoding, timing instrumentation, configurable upsells, customer-name capitalization and Portland deployment configuration are retained.

The inclusive 12-hour floor is checked during availability, holds, add-on changes, approvals, final confirmation and office creation/rescheduling. Checks repeat after asynchronous work; larger applicable configured notice remains effective. Saved emergency notice of four hours cannot bypass the floor. Legacy after-hours approval handlers remain present in production source; their existing bypass of the regular scheduler is unchanged, but notice and same-day restrictions now apply.

## Rollback and release review

Publication remains on hold for independent review. Recheck the production alias and commit before release, since another change may ship meanwhile. Review and test the reconciled patch against any newer base before publication.

For deployment rollback, restore the recorded pre-release production deployment, not the old `bfd5e79` snapshot. Verify the alias and read-only booking behavior afterward. Revert only the eventual feature commit in Git, preserving other work. There is no database migration to reverse. Existing appointments, including those using the wider routing allowance, must remain intact.

A complete code rollback removes the added 12-hour guards and can restore the saved four-hour emergency and legacy office/after-hours notice behavior. If only urgency routing needs removal, prefer a reviewed targeted reversal that retains notice safeguards. Legacy after-hours UI selections may be rejected by the new notice restriction; this patch does not redesign that obsolete flow.

import { randomUUID } from "node:crypto";

export const RETENTION_MS = 60 * 86_400_000;
export const OBSERVABILITY_DDL = [
  `create table if not exists bob.conversations (id text primary key, created bigint not null, updated bigint not null, expires bigint not null, data jsonb not null)`,
  `create index if not exists conversations_updated on bob.conversations(updated desc)`,
  `create index if not exists conversations_expires on bob.conversations(expires)`,
  `create table if not exists bob.conversation_events (id text primary key, conversation_id text not null references bob.conversations(id) on delete cascade, created bigint not null, kind text not null, data jsonb not null)`,
  `create index if not exists conversation_events_created on bob.conversation_events(created desc)`,
  `create index if not exists conversation_events_conversation on bob.conversation_events(conversation_id,created)`,
  `alter table bob.conversations enable row level security`,
  `alter table bob.conversation_events enable row level security`,
];

export const redact = (text) => String(text ?? "").replace(/Bearer\s+\S+|\b(?:sk-|pit-)[A-Za-z0-9_-]{12,}|\bAIza[A-Za-z0-9_-]{20,}/gi, "[credential removed]");
const cleanSnapshot = (data) => ({
  stage: data.stage, pending: data.pending, route: data.route, package: data.package, zip: data.zip,
  safety: data.safety, property: data.property || {}, contact: data.contact || {},
  serviceAccepted: Boolean(data.serviceAccepted), bundleAccepted: Boolean(data.bundleAccepted),
  bookingId: data.bookingId || null, approvalId: data.approvalId || null,
});

/** Observable facts and applied rules, not private model chain-of-thought. */
export function explainDecision(before, result) {
  const after = result.session || before;
  const reasons = [];
  if (after.safety) reasons.push(`Safety guidance took priority: ${after.safety}.`);
  if (after.route !== before.route) reasons.push(`Service route changed from ${before.route || "unselected"} to ${after.route || "unselected"}.`);
  if (after.package !== before.package) reasons.push(`Selected service: ${after.package || "none"}.`);
  if (after.stage !== before.stage) reasons.push(`Moved from ${before.stage} to ${after.stage}.`);
  if (after.pending) reasons.push(`Waiting for the customer's ${after.pending.replace(/([A-Z])/g, " $1").toLowerCase()} answer.`);
  if (result.aiError) reasons.push("The AI provider failed; BOB used its guided rules.");
  else if (result.via === "ai") reasons.push("AI interpreted the message; BOB's rules control pricing and booking.");
  else reasons.push("BOB used its guided rules and approved answers.");
  if (result.action === "request") reasons.push("Handed off to the office callback workflow.");
  const changes = Object.entries(after.property || {}).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before.property?.[key]));
  return { via: result.via || "rules", aiError: Boolean(result.aiError), before: { stage: before.stage, route: before.route, pending: before.pending },
    after: { stage: after.stage, route: after.route, pending: after.pending, package: after.package },
    facts: Object.fromEntries(changes), reasons, action: result.action || null };
}

export function createObserver(db, { clock = Date.now } = {}) {
  const query = (text, params = []) => db.query(text, params);
  return {
    async init() {
      if (db.kind === 'supabase-rest') {
        // The service role has DML permissions, not ownership/DDL rights. Apply the migration first.
        await query('select id from bob.conversations limit 0');
        await query('select id from bob.conversation_events limit 0');
      } else for (const sql of OBSERVABILITY_DDL) await query(sql);
    },
    async snapshot(id, data) {
      const now = clock();
      await query(`insert into bob.conversations(id,created,updated,expires,data) values($1,$2,$2,$3,$4::jsonb)
        on conflict(id) do update set updated=excluded.updated,expires=excluded.expires,data=excluded.data`,
      [id, now, now + RETENTION_MS, JSON.stringify(cleanSnapshot(data))]);
    },
    async ensure(id, data) {
      const now = clock();
      await query('insert into bob.conversations(id,created,updated,expires,data) values($1,$2,$2,$3,$4::jsonb) on conflict(id) do nothing', [id, now, now + RETENTION_MS, JSON.stringify(cleanSnapshot(data))]);
    },
    async record(id, kind, data, eventId = randomUUID()) {
      const rows = await query(`insert into bob.conversation_events(id,conversation_id,created,kind,data) values($1,$2,$3,$4,$5::jsonb) on conflict(id) do nothing returning id`,
      [eventId, id, clock(), kind, JSON.stringify(data)]);
      if (rows.length) await query('update bob.conversations set updated=greatest(updated,$2),expires=greatest(expires,$3) where id=$1', [id, clock(), clock() + RETENTION_MS]);
      return rows.length > 0;
    },
    async list({ before = Number.MAX_SAFE_INTEGER, beforeId = '', limit = 50 } = {}) {
      const rows = await query('select id,created,updated,expires,data from bob.conversations where expires>$1 and (updated<$2 or (updated=$2 and id>$4)) order by updated desc,id limit $3', [clock(), before, Math.min(limit, 100), beforeId]);
      return rows.map((r) => ({ ...r, created: Number(r.created), updated: Number(r.updated), expires: Number(r.expires) }));
    },
    async conversation(id) {
      const rows = await query('select id,created,updated,expires,data from bob.conversations where id=$1 and expires>$2', [id, clock()]);
      if (!rows.length) return null;
      const events = await query('select id,created,kind,data from bob.conversation_events where conversation_id=$1 and created>$2 order by created,id', [id, clock() - RETENTION_MS]);
      return { ...rows[0], created: Number(rows[0].created), updated: Number(rows[0].updated), expires: Number(rows[0].expires), events: events.map((e) => ({ ...e, created: Number(e.created) })) };
    },
    async feed({ after = 0, limit = 100 } = {}) {
      return (await query(`select e.id,e.conversation_id,e.created,e.kind,e.data,c.data->'contact'->>'name' as customer
        from bob.conversation_events e join bob.conversations c on c.id=e.conversation_id
        where c.expires>$1 and e.created>=$2 order by e.created desc,e.id limit $3`, [clock(), Math.max(after, clock() - RETENTION_MS), Math.min(limit, 200)]))
        .map((e) => ({ ...e, created: Number(e.created) }));
    },
    async cleanup() {
      await query('delete from bob.conversation_events where created<=$1', [clock() - RETENTION_MS]);
      await query('delete from bob.conversations where expires<=$1', [clock()]);
      await query("update bob.requests set data=data-'transcript' where created<=$1 and data ? 'transcript'", [clock() - RETENTION_MS]);
    },
  };
}

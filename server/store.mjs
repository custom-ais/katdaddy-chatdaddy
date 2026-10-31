// BOB's persistent store on Postgres. Same responsibilities as the original SQLite
// store (settings, sessions, holds, appointments, requests, outbox, audit) plus a
// small key/value table for caches, locks, rate limits and integration tokens.

import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, INITIAL_FAQS, INITIAL_TECHNICIANS, withConfigDefaults } from "../shared/domain.mjs";
import { refreshFaqs } from "../shared/faqs.mjs";
import { createObserver } from "./observability.mjs";

const num = (v) => (v == null ? null : Number(v));
const json = (v) => JSON.stringify(v ?? null);

export function createStore(db, { clock = Date.now } = {}) {
  const q = (text, params) => db.query(text, params);
  const observer = createObserver(db, { clock });
  let ready = null;

  const store = {
    db,
    clock,
    observer,

    /** Seed default settings once per cold start. */
    async init() {
      ready ??= (async () => {
        await observer.init();
        for (const [key, value] of [
          ["config", DEFAULT_CONFIG],
          ["faqs", INITIAL_FAQS],
          ["technicians", INITIAL_TECHNICIANS],
        ]) {
          await q("insert into bob.settings(key,value) values($1,$2::jsonb) on conflict (key) do nothing", [key, json(value)]);
        }
        await q("insert into bob.kv(key,value) values('report:tracking-started',$1::jsonb) on conflict (key) do nothing", [json(clock())]);
        // One-time rollout requested by the office: retain consent, pause sending and phone codes.
        // The marker and settings update are one atomic statement; later admin choices are preserved.
        await q(`update bob.settings set value=value || jsonb_build_object(
          'smsConfirmations',false,'requirePhoneVerification',false,'phoneServiceReady',false,
          'emailConfirmations',true,'emailLaunchVersion',1,'version',coalesce((value->>'version')::int,1)+1)
          where key='config' and coalesce(value->>'emailLaunchVersion','')<>'1'`);
      })().catch((error) => {
        ready = undefined; // a failed start must not stick for the life of the server
        throw error;
      });
      return ready;
    },

    // ---- settings ------------------------------------------------------------
    async get(key, fallback = null) {
      const rows = await q("select value from bob.settings where key=$1", [key]);
      if (!rows.length) return fallback;
      return key === "faqs" ? refreshFaqs(rows[0].value) : rows[0].value; // saved default answers get the current wording
    },
    async set(key, value) {
      await q(
        "insert into bob.settings(key,value) values($1,$2::jsonb) on conflict (key) do update set value=excluded.value",
        [key, json(value)],
      );
    },
    async config() {
      return withConfigDefaults(await store.get("config"));
    },
    async technicians() {
      return ((await store.get("technicians")) || []).map((t) => ({ jobberUserId: "", ...t }));
    },

    // ---- sessions ------------------------------------------------------------
    async createSession(token, data) {
      const now = clock();
      await q('insert into bob.sessions(token,data,created,expires) values($1,$2::jsonb,$3,$4)', [token, json(data), now, now + 86_400_000]);
      await store.audit('conversation.started', token);
      await observer.snapshot(token, data);
      await observer.record(token, "started", { summary: "A customer opened a new BOB conversation.", stage: data.stage });
    },
    async loadSession(token) {
      const rows = await q("select data from bob.sessions where token=$1 and expires>$2", [token, clock()]);
      return rows.length ? rows[0].data : null;
    },
    async saveSession(token, data) {
      await q("update bob.sessions set data=$1::jsonb, expires=$2 where token=$3", [json(data), clock() + 86_400_000, token]);
      await observer.snapshot(token, data);
    },
    async countSessions() {
      return num((await q("select count(*)::int as n from bob.sessions"))[0].n);
    },

    // ---- admin sessions ------------------------------------------------------
    async addAdmin(token, expires) {
      await q("insert into bob.admins(token,expires) values($1,$2)", [token, expires]);
    },
    async isAdmin(token) {
      return (await q("select 1 from bob.admins where token=$1 and expires>$2", [token, clock()])).length > 0;
    },
    async removeAdmin(token) {
      await q("delete from bob.admins where token=$1", [token]);
    },
    async clearAdmins() {
      await q("delete from bob.admins");
    },

    // ---- holds ----------------------------------------------------------------
    async releaseHolds(session) {
      await q("delete from bob.holds where session=$1", [session]);
    },
    async insertHold(hold) {
      await q(
        "insert into bob.holds(id,session,tech,start_ms,end_ms,expires,quote,lat,lng,address,overflow) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)",
        [hold.id, hold.session, hold.tech, hold.start, hold.end, hold.expires, json(hold.quote), hold.lat ?? null, hold.lng ?? null, hold.address ?? null, Boolean(hold.overflow)],
      );
    },
    async getHold(id, session) {
      const rows = await q("select * from bob.holds where id=$1 and session=$2 and expires>$3", [id, session, clock()]);
      return rows.length ? mapHold(rows[0]) : null;
    },
    /** Unexpired holds that overlap a window, excluding one session's own hold. */
    async activeHolds(fromMs, toMs, excludeSession = "") {
      const rows = await q(
        "select * from bob.holds where expires>$1 and start_ms<$2 and end_ms>$3 and session<>$4",
        [clock(), toMs, fromMs, excludeSession || ""],
      );
      return rows.map(mapHold);
    },
    async extendHold(id, expires) {
      await q("update bob.holds set expires=$1 where id=$2", [expires, id]);
    },
    async holdById(id) {
      const rows = await q("select * from bob.holds where id=$1", [id]);
      return rows.length ? mapHold(rows[0]) : null;
    },
    async releaseHold(id) {
      await q("delete from bob.holds where id=$1", [id]);
    },
    async countActiveHolds() {
      return num((await q("select count(*)::int as n from bob.holds where expires>$1", [clock()]))[0].n);
    },

    // ---- appointments ------------------------------------------------------------
    async appointments() {
      return (await q("select data from bob.appointments order by start_ms desc")).map((r) => r.data);
    },
    async appointment(id) {
      const rows = await q("select data from bob.appointments where id=$1", [id]);
      return rows.length ? rows[0].data : null;
    },
    async appointmentByIdem(idem) {
      const rows = await q("select data, session, status from bob.appointments where idem=$1", [idem]);
      return rows.length ? rows[0] : null;
    },
    /** Non-cancelled appointments overlapping a window. */
    async activeAppointments(fromMs, toMs, ignoreId = null) {
      const rows = await q(
        "select id, tech, start_ms, end_ms, data, jobber_visit_id from bob.appointments where status not in ('cancelled','rescheduled','failed') and start_ms<$1 and end_ms>$2 and ($3::text is null or id<>$3)",
        [toMs, fromMs, ignoreId],
      );
      return rows.map((r) => ({
        id: r.id,
        tech: r.tech,
        start: num(r.start_ms),
        end: num(r.end_ms),
        jobberVisitId: r.jobber_visit_id,
        location: r.data?.location || null,
        address: r.data?.address ? `${r.data.address}, ${r.data.city}, AZ ${r.data.zip}` : "",
        overflow: Boolean(r.data?.overflow),
      }));
    },
    /** Insert; returns false when the idempotency key already exists. */
    async insertAppointment(appt, { session = null, idem = randomUUID(), status = appt.status } = {}) {
      const rows = await q(
        `insert into bob.appointments(id,session,idem,tech,start_ms,end_ms,status,data,jobber_job_id,jobber_visit_id,created)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) on conflict (idem) do nothing returning id`,
        [
          appt.id, session, idem, appt.technicianId, Date.parse(appt.scheduledAt),
          Date.parse(appt.scheduledAt) + appt.durationMins * 60_000, status, json(appt),
          appt.jobber?.jobId || null, appt.jobber?.visitId || null, clock(),
        ],
      );
      return rows.length > 0;
    },
    async updateAppointment(appt) {
      const start = Date.parse(appt.scheduledAt);
      await q(
        "update bob.appointments set tech=$1,start_ms=$2,end_ms=$3,status=$4,data=$5::jsonb,jobber_job_id=$6,jobber_visit_id=$7 where id=$8",
        [appt.technicianId, start, start + appt.durationMins * 60_000, appt.status, json(appt), appt.jobber?.jobId || null, appt.jobber?.visitId || null, appt.id],
      );
    },
    async deleteAppointment(id) {
      await q("delete from bob.appointments where id=$1", [id]);
    },

    /** Move a failed booking's idempotency key aside so the customer can try again. */
    async retireAppointment(appt, status = "failed") {
      await q("update bob.appointments set status=$1, data=$2::jsonb, idem=idem||':'||$3 where id=$4", [status, json({ ...appt, status }), String(clock()), appt.id]);
    },

    // ---- approvals -------------------------------------------------------------------
    async insertApproval(a) {
      await q("insert into bob.approvals(id,session,status,data,created,expires) values($1,$2,$3,$4::jsonb,$5,$6)", [a.id, a.session, a.status, json(a), clock(), a.expiresAt]);
    },
    async approval(id) {
      const rows = await q("select data from bob.approvals where id=$1", [id]);
      return rows.length ? rows[0].data : null;
    },
    async updateApproval(a) {
      await q("update bob.approvals set status=$1, data=$2::jsonb, expires=$3 where id=$4", [a.status, json(a), a.expiresAt, a.id]);
    },
    async approvals(limit = 100) {
      return (await q("select data from bob.approvals order by created desc limit $1", [limit])).map((r) => r.data);
    },

    // ---- requests ------------------------------------------------------------------
    async requests() {
      return (await q("select data from bob.requests order by created desc")).map((r) => r.data);
    },
    async requestByIdem(idem) {
      const rows = await q("select data, session from bob.requests where idem=$1", [idem]);
      return rows.length ? rows[0] : null;
    },
    async insertRequest(request, session, idem) {
      await q("insert into bob.requests(id,session,idem,data,created) values($1,$2,$3,$4::jsonb,$5)", [request.id, session, idem, json(request), clock()]);
    },
    async updateRequest(request) {
      await q("update bob.requests set data=$1::jsonb where id=$2", [json(request), request.id]);
    },

    // ---- outbox + audit --------------------------------------------------------------
    async enqueue(kind, data, configured) {
      const id = randomUUID();
      await q("insert into bob.events(id,kind,created,data,status) values($1,$2,$3,$4::jsonb,$5)", [
        id, kind, clock(), json({ ...data, eventId: id }), configured ? "pending" : "not_configured",
      ]);
      return id;
    },
    async nextEvent() {
      const rows = await q(
        "select * from bob.events where status in ('pending','failed') and attempts<5 and next<=$1 order by created limit 1",
        [clock()],
      );
      return rows.length ? { ...rows[0], attempts: num(rows[0].attempts) } : null;
    },
    async markEvent(id, delivered, attempts) {
      if (delivered) await q("update bob.events set status='delivered', attempts=attempts+1 where id=$1", [id]);
      else await q("update bob.events set status='failed', attempts=attempts+1, next=$1 where id=$2", [clock() + 60_000 * 2 ** attempts, id]);
    },
    async recentEvents() {
      return (await q("select id,kind,created,status,attempts from bob.events order by created desc limit 100")).map((e) => ({
        ...e, created: num(e.created), attempts: num(e.attempts),
      }));
    },
    async audit(action, target) {
      await q("insert into bob.audit(id,created,action,target) values($1,$2,$3,$4)", [randomUUID(), clock(), action, String(target)]);
    },

    /** BOB activity in [from,to), plus current results. Never returns chat tokens or transcripts. */
    async activityReport(from, to) {
      const params = [from, to];
      const [chatRows, bookingRows, requestCounts, approvalCounts, appointmentRows, requestRows, approvalRows, auditRows, issueRows, trackingStartedAt] = await Promise.all([
        q(`select
          count(*) filter(where action='conversation.started')::int as conversations,
          count(*) filter(where action in ('conversation.ai','conversation.guided','conversation.ai_fallback','conversation.contact_message'))::int as messages,
          count(*) filter(where action='conversation.ai')::int as "aiReplies",
          count(*) filter(where action in ('conversation.guided','conversation.ai_fallback'))::int as "ruleReplies",
          count(*) filter(where action='conversation.ai_fallback')::int as "aiFallbacks"
          from bob.audit where created >= $1 and created < $2`, params),
        q(`select
          count(*) filter(where created >= $1 and created < $2)::int as "bookingsCreated",
          count(*) filter(where created >= $1 and created < $2 and status in ('confirmed','in_progress','completed'))::int as "bookingsConfirmed",
          coalesce(sum(round((data->>'price')::numeric*100)) filter(where created >= $1 and created < $2 and status in ('confirmed','in_progress','completed')),0) as "bookedValueCents",
          count(*) filter(where status in ('action_needed','confirming') or (status='failed' and created >= $1 and created < $2))::int as "bookingProblems",
          count(*) filter(where data #>> '{notifications,email}'='failed' and status not in ('cancelled','rescheduled','failed'))::int as "emailFailures"
          from bob.appointments where created < $2`, params),
        q(`select count(*) filter(where created >= $1)::int as "requestsCreated",
          count(*) filter(where data->>'status' in ('new','in_progress'))::int as "openRequests"
          from bob.requests where created < $2`, params),
        q('select count(*)::int as "pendingApprovals" from bob.approvals where created < $1 and status=\'pending\' and expires > $2', [to, clock()]),
        q(`select data, status, count(*) over()::int as total from bob.appointments b
          where (b.created >= $1 and b.created < $2) or exists(select 1 from bob.audit a where a.target=b.id and a.created >= $1 and a.created < $2)
          order by b.created desc, b.id limit 50`, params),
        q(`select data - 'transcript' as data, count(*) over()::int as total from bob.requests r
          where (r.created >= $1 and r.created < $2) or exists(select 1 from bob.audit a where a.target=r.id and a.created >= $1 and a.created < $2)
          order by r.created desc, r.id limit 50`, params),
        q(`select data - 'session' - 'snapshot' as data, status, count(*) over()::int as total from bob.approvals r
          where (r.created >= $1 and r.created < $2) or (r.created < $2 and r.status='pending' and r.expires > $3)
          or exists(select 1 from bob.audit a where a.target=r.id and a.created >= $1 and a.created < $2)
          order by r.created desc, r.id limit 50`, [from, to, clock()]),
        q(`select created, action, target, count(*) over()::int as total from bob.audit
          where created >= $1 and created < $2 and (action like 'booking.%' or action like 'appointment.%'
          or action like 'request.%' or action like 'approval.%' or action like 'oncall.%' or action in ('settings.updated','integrations.updated','admin.booking.created','email.confirmation_failed'))
          order by created desc, id limit 100`, params),
        q("select value from bob.kv where key in ('diag:email','diag:daily-report','diag:last-error','diag:oncall-email') and (expires is null or expires>$1)", [clock()]),
        store.kvGet("report:tracking-started"),
      ]);
      const counts = { ...chatRows[0], ...bookingRows[0], ...requestCounts[0], ...approvalCounts[0],
        appointmentsChanged: appointmentRows[0]?.total || 0, requestsChanged: requestRows[0]?.total || 0,
        approvalsIncluded: approvalRows[0]?.total || 0, activityCount: auditRows[0]?.total || 0 };
      for (const key of Object.keys(counts)) counts[key] = Number(counts[key] || 0);
      return { from, to, counts, trackingStartedAt: Number(trackingStartedAt || to),
        appointments: appointmentRows.map((r) => ({ ...r.data, status: r.status })),
        requests: requestRows.map((r) => r.data), approvals: approvalRows.map((r) => ({ ...r.data, status: r.status })),
        activity: auditRows.map(({ created, action, target }) => ({ created: Number(created), action, target })),
        issues: issueRows.map((r) => r.value).filter((v) => v && Number(v.at) >= from && Number(v.at) < to),
      };
    },

    // ---- key/value: cache, locks, rate limits ---------------------------------------
    async kvGet(key) {
      const rows = await q("select value from bob.kv where key=$1 and (expires is null or expires>$2)", [key, clock()]);
      return rows.length ? rows[0].value : null;
    },
    async kvSet(key, value, ttlSeconds) {
      const expires = ttlSeconds ? clock() + ttlSeconds * 1000 : null;
      await q(
        "insert into bob.kv(key,value,expires) values($1,$2::jsonb,$3) on conflict (key) do update set value=excluded.value, expires=excluded.expires",
        [key, json(value), expires],
      );
    },
    async kvDel(key) {
      await q("delete from bob.kv where key=$1", [key]);
    },
    /** Take a named lock for ttlSeconds. Returns true if acquired. */
    async lock(key, ttlSeconds) {
      const now = clock();
      const rows = await q(
        `insert into bob.kv(key,value,expires) values($1,'1'::jsonb,$2)
         on conflict (key) do update set value=excluded.value, expires=excluded.expires
         where bob.kv.expires is not null and bob.kv.expires<=$3
         returning key`,
        [`lock:${key}`, now + ttlSeconds * 1000, now],
      );
      return rows.length > 0;
    },
    async unlock(key) {
      await q("delete from bob.kv where key=$1", [`lock:${key}`]);
    },
    /** Fixed-window counter. Returns true while under the limit. */
    async rateHit(key, limit, periodMs) {
      const now = clock();
      const bucket = `rate:${key}:${Math.floor(now / periodMs)}`;
      const rows = await q(
        `insert into bob.kv(key,value,expires) values($1,'1'::jsonb,$2)
         on conflict (key) do update set value=to_jsonb((bob.kv.value)::text::int + 1)
         returning value`,
        [bucket, now + periodMs],
      );
      return Number(rows[0].value) <= limit;
    },

    async cleanup() {
      const now = clock();
      await observer.cleanup();
      await q("delete from bob.holds where expires<=$1", [now]);
      await q("delete from bob.sessions where expires<=$1", [now]);
      await q("delete from bob.admins where expires<=$1", [now]);
      await q("delete from bob.kv where expires is not null and expires<=$1", [now]);
    },
  };
  return store;
}

function mapHold(r) {
  return {
    id: r.id,
    session: r.session,
    tech: r.tech,
    start: Number(r.start_ms),
    end: Number(r.end_ms),
    expires: Number(r.expires),
    quote: r.quote,
    location: r.lat != null && r.lng != null ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
    address: r.address || "",
    overflow: Boolean(r.overflow),
  };
}

// The dashboard shows only appointments booked into the Jobber account connected now. New bookings
// record their account; older ones are checked once against the connected account (job, else
// client). Appointments known to be in another account also stop blocking technicians' times.

import test from "node:test";
import assert from "node:assert/strict";
import { accountMatch, inOtherAccount } from "../server/jobber-account.mjs";
import { projectSnapshot } from "../server/admin-authorization.mjs";
import { harness, contact } from "./helpers.mjs";

const A = { id: "ACCOUNT-A", name: "Test Vent Co" }, B = { id: "ACCOUNT-B", name: "Other Co" };

test("which account an appointment belongs to", () => {
  assert.equal(accountMatch({ jobber: { accountId: "ACCOUNT-A" } }, A), "this");
  assert.equal(accountMatch({ jobber: { accountId: "ACCOUNT-A" } }, B), "other");
  assert.equal(accountMatch({ jobber: { notInAccounts: ["ACCOUNT-B"] } }, B), "other");
  assert.equal(accountMatch({ jobber: { notInAccounts: ["ACCOUNT-B"] } }, A), "unknown", "not in B says nothing about A");
  assert.equal(accountMatch({ jobber: { jobId: "J" } }, A), "unknown", "not checked yet");
  assert.equal(accountMatch({}, A), "unknown", "never reached Jobber");
  assert.equal(accountMatch({ jobber: { accountId: "ACCOUNT-A" } }, null), "unknown", "Jobber not connected: nothing is hidden");
  assert.equal(inOtherAccount({ jobber: { accountId: "ACCOUNT-A" } }, B), true);
});

const legacy = (id, jobber, scheduledAt = "2026-09-30T17:00:00.000Z") => ({
  id, status: "confirmed", scheduledAt, durationMins: 120, technicianId: "tech-ryan", technicianName: "Ryan", customerName: `Customer ${id}`,
  phone: "+16235550100", email: "", address: "1 Main St", city: "Surprise", zip: "85374", route: "cleaning", source: "ai_bot", revision: 1, createdAt: Date.parse("2026-09-01T00:00:00Z"), jobber,
});
const shown = (data) => data.appointments.map((a) => a.id);

test("new bookings record their Jobber account, and only the connected account's show", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const booked = await h.book();
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const appt = (await h.store.appointments()).at(-1);
  assert.equal(appt.jobber.accountId, "ACCOUNT-A");
  const cookie = await h.login();
  const before = (await h.call("/api/admin/data", { cookie })).data;
  assert.ok(shown(before).includes(appt.id));
  assert.equal(before.appointmentsOtherAccount, 0);

  // A different Jobber account is connected: that booking is hidden, and counted.
  h.jobber.account = B;
  const other = (await h.call("/api/admin/data", { cookie })).data;
  assert.ok(!shown(other).includes(appt.id));
  assert.equal(other.appointmentsOtherAccount, 1);
  // Connecting the first account again brings it back.
  h.jobber.account = A;
  assert.ok(shown((await h.call("/api/admin/data", { cookie })).data).includes(appt.id));
  // With Jobber disconnected nothing is hidden.
  h.jobber.account = B; h.jobber.isConnected = false;
  assert.ok(shown((await h.call("/api/admin/data", { cookie })).data).includes(appt.id));
});

test("older bookings are checked once against the connected account", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  h.jobber.owned.add("KEEP-JOB");
  await h.store.insertAppointment(legacy("old-mine", { jobId: "KEEP-JOB", clientId: "KEEP-CLIENT", jobNumber: 7 }));
  await h.store.insertAppointment(legacy("old-elsewhere", { jobId: "GONE-JOB", clientId: "GONE-CLIENT", jobNumber: 8 }));
  await h.store.insertAppointment(legacy("never-in-jobber", null));
  const cookie = await h.login();
  const data = (await h.call("/api/admin/data", { cookie })).data;
  assert.deepEqual(shown(data).filter((id) => id.startsWith("old") || id.startsWith("never")).sort(), ["never-in-jobber", "old-mine"]);
  assert.equal(data.appointmentsOtherAccount, 1);
  assert.equal((await h.store.appointment("old-mine")).jobber.accountId, "ACCOUNT-A", "recorded");
  assert.deepEqual((await h.store.appointment("old-elsewhere")).jobber.notInAccounts, ["ACCOUNT-A"]);
  assert.equal(h.jobber.accountChecks, 2, "one question each; the one with no Jobber link isn't asked");
  await h.call("/api/admin/data", { cookie });
  assert.equal(h.jobber.accountChecks, 2, "not asked again");
});

test("when Jobber can't say, the booking keeps showing and is asked again later", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  await h.store.insertAppointment(legacy("old-unsure", { jobId: "MAYBE-JOB", jobNumber: 9 }));
  h.jobber.accountAnswer = null;
  const cookie = await h.login();
  assert.ok(shown((await h.call("/api/admin/data", { cookie })).data).includes("old-unsure"));
  assert.equal(h.jobber.accountChecks, 1);
  await h.call("/api/admin/data", { cookie });
  assert.equal(h.jobber.accountChecks, 1, "not asked again right away");
  h.advance(13 * 3_600_000);
  h.jobber.accountAnswer = false;
  const again = await h.call("/api/admin/login", { method: "POST", body: { password: "Test-only-strong-password-2026" } }); // a new day, a new sign-in
  const later = (await h.call("/api/admin/data", { cookie: again.cookie })).data;
  assert.equal(h.jobber.accountChecks, 2);
  assert.ok(!shown(later).includes("old-unsure"));
});

test("a booking in another account stops blocking the technician; one not yet known still blocks", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const booked = await h.book();
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const appt = (await h.store.appointments()).at(-1);
  const day = appt.scheduledAt.slice(0, 10);
  const token = await h.prepare("cleaning", { ...contact, name: "Second Customer" });
  // Ryan is the only tech taking online bookings here, so the time is offered only when he's free.
  const taken = async () => !(await h.slots(token, `?date=${day}`)).some((s) => s.scheduledAt === appt.scheduledAt);
  assert.equal(await taken(), true, "booked");
  // The new account's calendar doesn't have that visit, and BOB knows the booking went elsewhere.
  h.jobber.account = B;
  h.jobber.visits.length = 0;
  assert.equal(await taken(), false, "free on the new account's calendar");
  // A booking BOB can't place yet keeps the time held.
  const unsure = await h.store.appointment(appt.id);
  delete unsure.jobber.accountId;
  await h.store.updateAppointment(unsure);
  assert.equal(await taken(), true, "unknown keeps blocking");
});

test("the hidden count reaches staff who see appointments", () => {
  const snapshot = { config: {}, appointments: [], appointmentsOtherAccount: 3 };
  const member = (permissions) => ({ id: "m", role: "member", permissions, name: "Member" });
  assert.equal(projectSnapshot(snapshot, member(["appointments.view"])).appointmentsOtherAccount, 3);
  assert.equal(projectSnapshot(snapshot, member(["settings.business.view"])).appointmentsOtherAccount, 0);
});

test("asking Jobber: found, not found, and answers that don't count as no", async () => {
  const { createJobber } = await import("../server/jobber.mjs");
  const reply = { found: { data: { job: { id: "J1" } } }, missing: { data: { job: null, client: null } } };
  const make = (respond) => {
    const asked = [];
    const api = createJobber({
      store: { kvGet: async () => null, kvSet: async () => {} },
      env: { JOBBER_CLIENT_ID: "fake-client", JOBBER_CLIENT_SECRET: "fake-secret", JOBBER_REDIRECT_URI: "https://example.com/callback" },
      tokens: { load: async () => ({ accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 }) },
      fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); asked.push(body.query.match(/query (\w+)/)[1]); const r = respond(body); return new Response(JSON.stringify(r.body), { status: r.status || 200 }); },
    });
    return { api, asked };
  };
  assert.equal(await make(() => ({ body: reply.found })).api.accountHas({ jobId: "J1" }), true);
  const missing = make(() => ({ body: reply.missing }));
  assert.equal(await missing.api.accountHas({ jobId: "J1", clientId: "C1" }), false);
  assert.deepEqual(missing.asked, ["BobAccountHasjob", "BobAccountHasclient"], "the client is asked when the job is gone");
  assert.equal(await make(() => ({ body: { errors: [{ message: "Couldn't find Job with 'id'=1" }] } })).api.accountHas({ jobId: "J1" }), false);
  // Not a "no": a query Jobber doesn't understand, a server error, an unfamiliar message.
  assert.equal(await make(() => ({ body: { errors: [{ message: "Field 'job' doesn't exist on type 'Query'" }] } })).api.accountHas({ jobId: "J1" }), null);
  assert.equal(await make(() => ({ status: 500, body: { errors: [{ message: "Internal error" }] } })).api.accountHas({ jobId: "J1" }), null);
  assert.equal(await make(() => ({ body: { errors: [{ message: "Something unexpected" }] } })).api.accountHas({ jobId: "J1" }), null);
  assert.equal(await make(() => ({ body: reply.found })).api.accountHas({}), null, "nothing to ask about");
});

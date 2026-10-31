import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { emergencySameDayEligible, requestedVisit, safeDetails } from "../server/activity.mjs";
import { createGeo } from "../server/geo.mjs";
import { createStore } from "../server/store.mjs";
import { candidateStarts } from "../server/schedule-rules.mjs";
import { DEFAULT_CONFIG, drivingAreaFor, areaFor } from "../shared/domain.mjs";
import { distanceMiles, pointInArea, customCoverage } from "../shared/coverage.mjs";
import { harness, baseTime } from "./helpers.mjs";

test("same-day emergency cutoff is strictly before 2 PM Phoenix time", () => {
  const before = Date.parse("2026-10-31T13:59:59-07:00"), cutoff = Date.parse("2026-10-31T14:00:00-07:00");
  assert.equal(emergencySameDayEligible(before, "2026-10-31"), true);
  assert.equal(emergencySameDayEligible(cutoff, "2026-10-31"), false);
  assert.equal(emergencySameDayEligible(before, "2026-11-01"), false);
  const config = { ...DEFAULT_CONFIG, leadHours: 0, weekdayStarts: ["15:00"], emergencyRequestedAt: Date.parse("2026-11-02T14:00:00-07:00") };
  const starts = candidateStarts({ config, now: config.emergencyRequestedAt, durationMins: 60 });
  assert.ok(!starts.some((s) => s.date === "2026-11-02"));
  assert.ok(starts.some((s) => s.date === "2026-11-03"));
});

test("preferred date/time is captured explicitly in Arizona time", () => {
  const now = Date.parse("2026-11-01T00:00:00Z"); // still October 31 in Arizona
  assert.deepEqual(requestedVisit("Can a tech come today at 5pm?", {}, now), { date: "2026-10-31", time: "17:00" });
  assert.deepEqual(requestedVisit("10/31 at 5 PM", {}, now), { date: "2026-10-31", time: "17:00" });
  assert.deepEqual(requestedVisit("Tomorrow at 12am", {}, now), { date: "2026-11-01", time: "00:00" });
});

test("road-distance boundaries ignore ZIP membership and leave unknown routes unverified", () => {
  const c = { ...DEFAULT_CONFIG, serviceAreaMode: "driving_distance", serviceAreaMiles: 25, travelAreaMiles: 45, serviceZips: ["85326"] };
  assert.equal(areaFor("99999", c, "AZ", 25), "in");
  assert.equal(areaFor("85326", c, "AZ", 25.01), "travel");
  assert.equal(drivingAreaFor(45, c), "travel");
  assert.equal(drivingAreaFor(45.01, c), "out");
  assert.equal(drivingAreaFor(null, c), "unknown");
  assert.equal(drivingAreaFor(0, c), "in");
});

test("road coverage uses route meters and never substitutes a straight-line estimate", async () => {
  const cache = new Map();
  let outage = false;
  const geo = createGeo({ googleKey: "test", cache: { kvGet: async (k) => cache.get(k), kvSet: async (k, v) => cache.set(k, v) }, fetchImpl: async (_url, init) => {
    assert.match(init.headers["X-Goog-FieldMask"], /status/);
    assert.match(init.headers["X-Goog-FieldMask"], /distanceMeters/);
    if (outage) throw new Error("offline");
    return new Response(JSON.stringify([{ condition: "ROUTE_EXISTS", distanceMeters: 40233.6, duration: "1800s" }]), { status: 200 });
  } });
  const from = { lat: 33.4, lng: -112.5 }, to = { lat: 33.5, lng: -112.6 };
  const [route] = await geo.roadRoutes([{ from, to }]);
  assert.equal(route.miles, 25); assert.equal(route.minutes, 30);
  outage = true;
  assert.equal((await geo.roadRoutes([{ from, to }]))[0].miles, 25, "measured routes are cached");
  await assert.rejects(geo.roadRoutes([{ from, to: { lat: 34, lng: -113 } }]), { code: "ROUTING_UNAVAILABLE" });
});

test("a Google refusal on drive distance says why and what to change, and shows in Connections", async () => {
  const cache = new Map();
  const disabled = [{ error: { code: 403, status: "PERMISSION_DENIED", message: "Routes API has not been used in project 123 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] } }];
  const geo = createGeo({ googleKey: "test", cache: { kvGet: async (k) => cache.get(k), kvSet: async (k, v) => cache.set(k, v) }, fetchImpl: async () => new Response(JSON.stringify(disabled), { status: 403 }) });
  const error = await geo.roadRoutes([{ from: { lat: 33.4, lng: -112.5 }, to: { lat: 33.5, lng: -112.6 } }]).catch((e) => e);
  assert.equal(error.code, "ROUTING_UNAVAILABLE");
  assert.match(error.cause.message, /PERMISSION_DENIED/);
  assert.match(error.cause.message, /"Routes API" and click Enable/);
  assert.match((await geo.lastIssue()).message, /Routes API/);
  const noKey = await createGeo({ googleKey: "", cache: { kvGet: async () => null, kvSet: async () => {} } }).roadRoutes([]).catch((e) => e);
  assert.match(noKey.message, /GOOGLE_MAPS_API_KEY isn't set/);
});

test("availability text is requested before triage and deduplicated, even when customer texts are off", async (t) => {
  const h = await harness(t, { config: { smsConfirmations: false, approver: { name: "Ryan", phone: "6235550100", email: "" } } });
  h.advance(40 * 86_400_000); // October 31, 1 PM Arizona
  const token = await h.fresh();
  const first = await h.chat(token, "Emergency Clog / Overheating");
  assert.equal(first.session.pending, "safetyCheck");
  assert.ok(h.lc.calls.some((c) => c[0] === "sms" && /availability check/.test(c[2])));
  await h.chat(token, "Can a tech come today at 5pm?");
  const sent = h.lc.calls.filter((c) => c[0] === "sms").length;
  await h.chat(token, "Can a tech come today at 5pm?");
  assert.equal(h.lc.calls.filter((c) => c[0] === "sms").length, sent);
  const requests = await h.store.requests();
  const requested = requests.find((r) => r.requestedVisit?.time === "17:00");
  assert.equal(requested.requestedVisit.date, "2026-10-31");
  assert.equal(requested.notification.status, "accepted");
  assert.equal(h.jobber.jobs.length, 0, "availability inquiries do not book an appointment");
  const cookie = await h.login();
  assert.equal((await h.call("/api/admin/activity")).status, 401);
  const log = await h.call("/api/admin/activity", { cookie });
  assert.ok(log.data.items.some((e) => e.kind === "notification.accepted"));
  assert.ok(!JSON.stringify(log.data).includes(token), "raw conversation credentials are not logged");
});

test("after the cutoff the safety flow continues, but no same-day emergency text is sent", async (t) => {
  const h = await harness(t, { config: { approver: { name: "Ryan", phone: "6235550100", email: "" } } });
  h.advance(3_600_000); // 2 PM Arizona, exactly
  const r = await h.chat(await h.fresh(), "Emergency Clog / Overheating");
  assert.match(r.reply, /before 2 p\.m/);
  assert.equal(r.session.pending, "safetyCheck");
  assert.ok(!h.lc.calls.some((c) => c[0] === "sms"));
});

test("failed staff messages are saved and activity survives session cleanup and store reconstruction", async (t) => {
  const h = await harness(t, { lc: { failSms: true }, config: { approver: { name: "Ryan", phone: "6235550100", email: "" } } });
  const token = await h.fresh();
  const r = await h.chat(token, "Emergency Clog / Overheating");
  assert.match(r.reply, /text could not be sent/);
  assert.equal((await h.store.requests())[0].notification.status, "failed");
  h.advance(2 * 86_400_000); await h.store.cleanup();
  const reopened = createStore(h.db, { clock: () => baseTime + 2 * 86_400_000 });
  const events = await reopened.activity({ sessionId: createHash("sha256").update(token).digest("hex").slice(0, 16) });
  assert.ok(events.items.some((e) => e.kind === "notification.failed" && /sms down/.test(e.details.error)));
  assert.ok(!JSON.stringify(await h.store.recentEvents()).includes("activity."));
  assert.deepEqual(safeDetails({ password: "hidden", accessToken: "hidden", verificationCode: "123456", messageId: "safe" }), { messageId: "safe" });
});

test("admin address checks use road miles outside legacy ZIPs, with travel fees and routing outages explicit", async (t) => {
  const h = await harness(t, { config: { serviceAreaMode: "driving_distance", baseAddress: "1 Base Way, Buckeye, AZ 85326", serviceAreaMiles: 25, travelAreaMiles: 45, travelZoneFeeCents: 2500, serviceZips: ["99999"] } });
  h.geo.roadRoutes = async () => [{ miles: 35, minutes: 42 }];
  const cookie = await h.login();
  const body = { address: "100 W Test St, Buckeye, AZ 85326" };
  const checked = await h.call("/api/admin/geo/check", { method: "POST", cookie, body });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.area, "travel");
  assert.equal(checked.data.driveFromBaseMiles, 35);
  assert.equal(checked.data.travelFeeCents, 2500);
  h.geo.roadRoutes = async () => { throw new Error("Routes down"); };
  const missing = await h.call("/api/admin/geo/check", { method: "POST", cookie, body });
  assert.equal(missing.data.ok, false);
  assert.equal(missing.data.reason, "routing_unavailable");
});

test("widget actions require a conversation and are recorded without allowing arbitrary event names", async (t) => {
  const h = await harness(t), token = await h.fresh();
  assert.equal((await h.call("/api/activity", { method: "POST", body: { kind: "widget.minimized" } })).status, 401);
  assert.equal((await h.call("/api/activity", { method: "POST", token, body: { kind: "booking.confirmed" } })).status, 400);
  assert.equal((await h.call("/api/activity", { method: "POST", token, body: { kind: "widget.minimized" } })).status, 201);
  assert.ok((await h.store.activity()).items.some((e) => e.kind === "widget.minimized"));
});

const included = { id: 'test-included', kind: 'include', points: [{lat:33.35,lng:-112.65},{lat:33.45,lng:-112.65},{lat:33.45,lng:-112.5},{lat:33.35,lng:-112.5}] };
test("custom included areas override the distance limit and excluded areas always take priority", () => {
  const point = { lat: 33.4, lng: -112.58 };
  assert.equal(pointInArea(point, included.points), true);
  assert.equal(pointInArea(included.points[0], included.points), true, 'the boundary is included');
  assert.equal(customCoverage(point, [included]), 'in');
  const config = { ...DEFAULT_CONFIG, serviceAreaMode: 'radius', serviceAreaMiles: 1, travelAreaMiles: 2, customServiceAreas: [included] };
  assert.equal(areaFor('99999', config, 'AZ', 20, point), 'in');
  assert.equal(areaFor('99999', {...config,customServiceAreas:[included,{...included,id:'excluded',kind:'exclude'}]}, 'AZ', 20, point), 'out');
  assert.equal(areaFor('99999', config, 'CA', 20, point), 'out');
});

test("map-selected base and custom boundaries save and control the actual customer address gate", async (t) => {
  const h = await harness(t), cookie = await h.login(), saved = await h.store.config();
  const body = {...saved,serviceAreaMode:'radius',baseAddress:'',baseLocation:{lat:33.45,lng:-112.45},serviceAreaMiles:1,travelAreaMiles:2,customServiceAreas:[included],serviceZips:[]};
  assert.ok(distanceMiles(body.baseLocation, {lat:33.4,lng:-112.58}) > 2);
  const updated = await h.call('/api/admin/config',{method:'PATCH',cookie,body});
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.deepEqual((await h.store.config()).customServiceAreas,[included]);
  const token = await h.fresh();await h.chat(token,'Dryer Vent Cleaning');
  const address = await h.chat(token,'100 W Test St, Buckeye, AZ 85326');
  assert.notEqual(address.session.stage,'out_of_area');
  assert.notEqual(address.session.pending,'serviceAddress');
  assert.equal(address.session.serviceAddress.lat,33.4);
});

test("editing a saved map invalidates earlier address checks before showing or holding slots", async (t) => {
  const h = await harness(t), token = await h.prepare(), c = await h.store.config();
  await h.store.set('config', {...c,serviceAreaMode:'radius',baseLocation:{lat:33.4,lng:-112.58},serviceAreaMiles:25,travelAreaMiles:45});
  const availability = await h.call('/api/availability',{token});
  assert.equal(availability.status,409);
  assert.equal(availability.data.code,'COVERAGE_CHANGED');
  const hold = await h.hold(token,'2026-09-23T09:00:00-07:00');
  assert.equal(hold.status,409);
  assert.equal(await h.store.countActiveHolds(),0);
});

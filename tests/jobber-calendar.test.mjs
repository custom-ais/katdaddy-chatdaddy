import test from "node:test";
import assert from "node:assert/strict";
import { createJobber } from "../server/jobber.mjs";
import { harness as appHarness } from "./helpers.mjs";

// Tasks and events in Jobber (time off, meetings, errands) take time from the people they're for.
// BOB reads them from Jobber's scheduledItems list, building the query from Jobber's own description
// of its API, because the names can't be checked against a published reference.

const T = (kind, name = null, ofType = null) => ({ kind, name, ofType });
const nonNull = (t) => T("NON_NULL", null, t), list = (t) => T("LIST", null, t);
const field = (name, { connection = false, args = [] } = {}) => connection
  ? { name, args: [{ name: "first" }, ...args], type: nonNull(T("OBJECT", "UserConnection")) }
  : { name, args, type: T("SCALAR", "String") };
const kind = (name, ...names) => ({ name, fields: names.map((n) => n === "assignedUsers" ? field(n, { connection: true }) : field(n)) });
const VISIT = kind("Visit", "id", "title", "startAt", "endAt", "allDay", "assignedUsers");
const ASSESSMENT = kind("Assessment", "id", "title", "startAt", "endAt", "allDay", "assignedUsers");
const REMINDER = kind("Reminder", "id", "startAt");

/** Jobber's answers about its API, in one of the shapes it might have. */
function schema({ dateField = "startAt", pair = ["after", "before"], kindField = "scheduledItemType", kindList = true, values = ["VISIT", "ASSESSMENT", "TASK", "EVENT", "REMINDER"], types, requiredExtra = null, hasList = true } = {}) {
  return {
    BobCalendarSchemaRoot: { schema: { fields: [
      { name: "visits", args: [], type: nonNull(T("OBJECT", "VisitConnection")) },
      ...(hasList ? [{ name: "scheduledItems", args: [{ name: "first", type: T("SCALAR", "Int") }, { name: "after", type: T("SCALAR", "String") }, { name: "filter", type: T("INPUT_OBJECT", "ScheduledItemsFilterAttributes") }], type: nonNull(T("OBJECT", "ScheduledItemInterfaceConnection")) }] : []),
    ] } },
    BobCalendarSchemaParts: {
      connection: { fields: [{ name: "nodes", type: nonNull(list(nonNull(T("INTERFACE", "ScheduledItemInterface")))) }, { name: "pageInfo", type: nonNull(T("OBJECT", "PageInfo")) }] },
      filter: { inputFields: [
        { name: dateField, defaultValue: null, type: T("INPUT_OBJECT", "DateRangeInput") },
        ...(kindField ? [{ name: kindField, defaultValue: null, type: kindList ? list(nonNull(T("ENUM", "ScheduledItemTypeEnum"))) : T("ENUM", "ScheduledItemTypeEnum") }] : []),
        ...(requiredExtra ? [{ name: requiredExtra, defaultValue: null, type: nonNull(T("ENUM", "Aspect")) }] : []),
      ] },
    },
    BobCalendarSchemaTypes: {
      node: { possibleTypes: types || [VISIT, ASSESSMENT, REMINDER, kind("Task", "id", "title", "startAt", "endAt", "allDay", "assignedUsers"), kind("Event", "id", "title", "startAt", "endAt", "allDay", "assignedUsers")] },
      date: { inputFields: pair.map((name) => ({ name, type: T("SCALAR", "ISO8601DateTime") })) },
      kinds: kindField ? { enumValues: values.map((name) => ({ name })) } : { enumValues: null },
    },
  };
}

const users = (...ids) => ({ nodes: ids.map((id) => ({ id })), pageInfo: { hasNextPage: false } });
const from = Date.parse("2026-11-18T07:00:00Z"), to = Date.parse("2026-11-19T07:00:00Z"); // Nov 18, Arizona

function jobberWith(responses) {
  const calls = [], cache = new Map();
  const store = { kvGet: async (k) => cache.get(k), kvSet: async (k, v) => cache.set(k, v) };
  const all = { BobAccountIdentity: { account: { id: "ACCOUNT-TEST", name: "Test Company" } }, ...responses };
  const api = createJobber({ store, env: { JOBBER_CLIENT_ID: "fake-client", JOBBER_CLIENT_SECRET: "fake-secret", JOBBER_REDIRECT_URI: "https://example.com/callback" }, tokens: { load: async () => ({ accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 }) }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body), operation = body.query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({ operation, ...body });
    const answer = all[operation];
    if (typeof answer === "function") return answer(body, calls);
    assert.ok(answer, `Unexpected operation ${operation}`);
    return new Response(JSON.stringify({ data: answer }), { status: 200 });
  } });
  return { api, calls, cache };
}
const page = (nodes) => new Response(JSON.stringify({ data: { scheduledItems: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 });

test("tasks and events are read with the filter and fields Jobber describes, and nothing else", async () => {
  const h = jobberWith({ ...schema(), BobCalendarItems: (body) => {
    assert.match(body.query, /filter: \{ startAt: \{ after: \$from, before: \$to \}, scheduledItemType: \[TASK, EVENT\] \}/);
    assert.match(body.query, /\$from: ISO8601DateTime!/);
    assert.match(body.query, /\.\.\. on Task \{ id title startAt endAt allDay assignedUsers\(first: 5\) \{ nodes \{ id \} pageInfo \{ hasNextPage \} \} \}/);
    assert.match(body.query, /\.\.\. on Event \{/);
    assert.doesNotMatch(body.query, /on (?:Visit|Assessment|Reminder)\b/, "visits and assessments are read on their own; reminders occupy nobody");
    assert.equal(body.variables.from, new Date(from - 7 * 86_400_000).toISOString(), "looks back a week for multi-day events");
    return page([
      { __typename: "Task", id: "T1", title: "Pick up parts", startAt: "2026-11-18T17:00:00Z", endAt: "2026-11-18T18:00:00Z", allDay: false, assignedUsers: users("J-RYAN") },
      { __typename: "Event", id: "E1", title: "Vacation", startAt: "2026-11-16T07:00:00Z", endAt: "2026-11-21T07:00:00Z", allDay: true, assignedUsers: users("J-ANDREW") },
      { __typename: "Event", id: "E-old", title: "Ended before", startAt: "2026-11-12T17:00:00Z", endAt: "2026-11-12T18:00:00Z", allDay: false, assignedUsers: users() },
      { __typename: "Task", id: "T-unscheduled", title: "Someday", startAt: null, endAt: null, allDay: false, assignedUsers: users() },
      { __typename: "Visit", id: "V1", startAt: "2026-11-18T17:00:00Z" },
    ]);
  } });
  const items = await h.api.readCalendarItems(from, to);
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.allDay, i.jobberUserIds]), [["T1", "task", false, ["J-RYAN"]], ["E1", "event", true, ["J-ANDREW"]]]);
  assert.equal(items[0].start, Date.parse("2026-11-18T17:00:00Z"));
  // Jobber's description is reused: the next lookup is only the list itself.
  await h.api.readCalendarItems(from, to, { fresh: true });
  assert.deepEqual(h.calls.map((c) => c.operation).filter((o) => o !== "BobAccountIdentity"), ["BobCalendarSchemaRoot", "BobCalendarSchemaParts", "BobCalendarSchemaTypes", "BobCalendarItems", "BobCalendarItems"]);
});

test("another shape of the same list: a different date filter, no kind filter, events without assignees", async () => {
  const types = [VISIT, ASSESSMENT, kind("BasicTask", "id", "title", "startAt", "endAt", "assignedUsers"), kind("Event", "id", "title", "startAt", "endAt", "allDay")];
  const h = jobberWith({ ...schema({ dateField: "startsBetween", pair: ["from", "to"], kindField: null, types }), BobCalendarItems: (body) => {
    assert.match(body.query, /filter: \{ startsBetween: \{ from: \$from, to: \$to \} \}/);
    assert.match(body.query, /\.\.\. on BasicTask \{ id title startAt endAt assignedUsers/);
    assert.match(body.query, /\.\.\. on Event \{ id title startAt endAt allDay \}/);
    return page([
      { __typename: "Visit", id: "V1", startAt: "2026-11-18T17:00:00Z" },
      { __typename: "Event", id: "E2", title: "Team meeting", startAt: "2026-11-18T15:00:00Z", endAt: null, allDay: false },
      { __typename: "BasicTask", id: "T2", title: "Errand", startAt: "2026-11-18T20:00:00Z", endAt: "2026-11-18T20:30:00Z", assignedUsers: users() },
    ]);
  } });
  const items = await h.api.readCalendarItems(from, to);
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.jobberUserIds, i.end - i.start]), [["E2", "event", null, 3_600_000], ["T2", "task", [], 1_800_000]]);
});

test("a list Jobber doesn't have, or can't be filtered the way BOB knows, is reported as unsupported", async () => {
  for (const [label, shape] of [["no list", { hasList: false }], ["unknown required filter", { requiredExtra: "schedulingAspect" }], ["unknown date shape", { pair: ["since", "until"] }], ["no task or event kinds", { types: [VISIT, ASSESSMENT, REMINDER] }]]) {
    const h = jobberWith(schema(shape));
    await assert.rejects(h.api.readCalendarItems(from, to), { code: "JOBBER_CALENDAR_UNSUPPORTED" }, label);
    await assert.rejects(h.api.readCalendarItems(from, to, { fresh: true }), { code: "JOBBER_CALENDAR_UNSUPPORTED" }, label);
    assert.equal(h.calls.filter((c) => c.operation === "BobCalendarSchemaRoot").length, 1, `${label}: the answer is remembered`);
  }
});

test("a lookup Jobber refuses is unsupported and asks Jobber to describe its API again; a network failure is just a failure", async () => {
  let refuse = true;
  const h = jobberWith({ ...schema(), BobCalendarItems: () => refuse
    ? new Response(JSON.stringify({ errors: [{ message: "Field 'allDay' doesn't exist on type 'Task'" }] }), { status: 200 })
    : page([]) });
  await assert.rejects(h.api.readCalendarItems(from, to), (e) => e.code === "JOBBER_CALENDAR_UNSUPPORTED" && /allDay/.test(e.message));
  refuse = false;
  assert.deepEqual(await h.api.readCalendarItems(from, to, { fresh: true }), []);
  assert.equal(h.calls.filter((c) => c.operation === "BobCalendarSchemaRoot").length, 2, "described again after the refusal");

  const down = jobberWith({ ...schema(), BobCalendarItems: () => { throw new Error("socket hang up"); } });
  await assert.rejects(down.api.readCalendarItems(from, to), (e) => !e.code && /Jobber request failed/.test(e.message));
});

test("an incomplete assignee list is never guessed", async () => {
  const h = jobberWith({ ...schema(), BobCalendarItems: () => page([{ __typename: "Task", id: "T3", startAt: "2026-11-18T17:00:00Z", endAt: "2026-11-18T18:00:00Z", allDay: false, assignedUsers: { nodes: [{ id: "J-RYAN" }], pageInfo: { hasNextPage: true } } }]) });
  await assert.rejects(h.api.readCalendarItems(from, to), /assignment list is incomplete/);
});

// ---- availability ---------------------------------------------------------------------------

const DAY = "2026-09-22";
/** The start of each time offered on DAY (the customer only sees when it starts). */
async function openTimes(h, token) {
  return (await h.slots(token, `?date=${DAY}`)).map((s) => Date.parse(s.scheduledAt));
}

test("a timed task or event takes its time (plus the usual gap) from its technician, not the whole day", async (t) => {
  const h = await appHarness(t);
  const token = await h.prepare();
  const before = await openTimes(h, token);
  assert.ok(before.length >= 2, "the day has several openings to begin with");
  const [start] = before;
  h.jobber.calendar.push({ id: "E-meeting", kind: "event", title: "Meeting", start, end: start + 30 * 60_000, allDay: false, jobberUserIds: ["J-RYAN"], address: "" });
  const after = await openTimes(h, token);
  assert.ok(!after.includes(start), "not during the meeting");
  assert.ok(!after.some((s) => s > start - 60 * 60_000 && s < start + 60 * 60_000), "nor within the visit length and 30-minute gap around it");
  assert.ok(after.some((s) => s >= start + 60 * 60_000), "later openings that day are still offered (no drive time needed to a meeting)");
});

test("an all-day task or event takes the day; other days are unaffected", async (t) => {
  const h = await appHarness(t);
  const token = await h.prepare();
  h.jobber.calendar.push({ id: "E-off", kind: "event", title: "Day off", start: Date.parse(`${DAY}T07:00:00Z`), end: Date.parse(`${DAY}T07:00:00Z`) + 86_400_000, allDay: true, jobberUserIds: ["J-RYAN"], address: "" });
  assert.deepEqual(await openTimes(h, token), []);
  assert.ok((await h.slots(token, "?date=2026-09-23")).length > 0);
});

test("unassigned tasks block everyone; tasks for the office block no linked technician; they aren't jobs", async (t) => {
  const h = await appHarness(t);
  const token = await h.prepare();
  const [start] = await openTimes(h, token);
  h.jobber.calendar.push({ id: "T-office", kind: "task", title: "Payroll", start, end: start + 3_600_000, allDay: false, jobberUserIds: ["J-OFFICE"], address: "" });
  assert.ok((await openTimes(h, token)).includes(start), "a task for someone who isn't a BOB technician doesn't block Ryan");
  h.jobber.calendar.push({ id: "T-all", kind: "task", title: "Shop closed", start, end: start + 3_600_000, allDay: false, jobberUserIds: [], address: "" });
  assert.ok(!(await openTimes(h, token)).includes(start), "an unassigned task blocks the whole crew");
});

test("if Jobber won't answer the task and event lookup, booking carries on and the office is told once", async (t) => {
  const h = await appHarness(t);
  const cookie = await h.login();
  const token = await h.prepare();
  const before = await openTimes(h, token);
  h.jobber.calendarError = Object.assign(new Error("Jobber refused the task and event lookup (missing scope)."), { code: "JOBBER_CALENDAR_UNSUPPORTED" });
  assert.deepEqual(await openTimes(h, token), before);
  await openTimes(h, token);
  const warnings = (await h.call("/api/admin/activity", { cookie })).data.items.filter((e) => e.kind === "jobber.calendar_unavailable");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].details.reason, /missing scope/);

  h.jobber.calendarError = new Error("Jobber request failed: socket hang up");
  const r = await h.call(`/api/availability?date=${DAY}`, { token });
  assert.ok(r.status >= 400, "any other failure stops the lookup, as for visits");
});

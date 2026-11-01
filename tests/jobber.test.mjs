import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobber } from '../server/jobber.mjs';

const start = Date.parse('2026-11-02T18:00:00Z'), end = start + 3600_000;
const options = { propertyId: 'PROPERTY', title: 'Cleaning', instructions: 'Test only', lineItems: [{ name: 'Cleaning', cents: 19900 }], start, end, jobberUserId: 'USER-RYAN' };
const job = { id: 'JOB', jobNumber: 101, jobberWebUri: 'https://example.com/job/101' };
const visit = { id: 'VISIT', startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
function harness(overrides = {}) {
  const calls = [], cache = new Map();
  const responses = {
    BobUsers: { users: { nodes: [{ id: 'USER-RYAN', name: { full: 'Ryan Test' } }], pageInfo: { hasNextPage: false } } },
    BobJobCreate: { jobCreate: { job, userErrors: [] } },
    BobVisitCreate: { visitCreate: { createdVisits: [visit], userErrors: [] } },
    BobVisits: { visits: { nodes: [{ ...visit, allDay: false, assignedUsers: { nodes: [{ id: 'USER-RYAN' }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } },
    BobAccountIdentity: { account: { id: 'ACCOUNT-TEST', name: 'Test Company' } },
    ...overrides,
  };
  let tokenBinding = { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600_000 };
  const store = { kvGet: async k => cache.get(k), kvSet: async (k, v) => cache.set(k, v) };
  const api = createJobber({ store, env: { JOBBER_CLIENT_ID: 'fake-client', JOBBER_CLIENT_SECRET: 'fake-secret', JOBBER_REDIRECT_URI: 'https://example.com/callback' }, tokens: { load: async () => tokenBinding }, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.getjobber.com/api/graphql');
    const body = JSON.parse(init.body); const operation = body.query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({ operation, ...body });
    const response = responses[operation];
    if (typeof response === 'function') return response(body, calls);
    assert.ok(response, `Unexpected operation ${operation}`);
    return new Response(JSON.stringify({ data: response }), { status: 200 });
  } });
  return { api, calls, responses, cache, setTokenBinding: value => { tokenBinding = value; } };
}

test('missing assignment refuses every provider call and mutation', async () => {
  const h = harness();
  for (const id of ['', ' ', undefined]) await assert.rejects(h.api.createScheduledJob({ ...options, jobberUserId: id }), { code: 'JOBBER_ASSIGNMENT_REQUIRED' });
  assert.equal(h.calls.length, 0);
});

test('a user outside the connected account prevents creation mutations', async () => {
  const h = harness();
  await assert.rejects(h.api.createScheduledJob({ ...options, jobberUserId: 'UNKNOWN' }), { code: 'JOBBER_ASSIGNMENT_INVALID' });
  assert.deepEqual(h.calls.map(c => c.operation), ['BobUsers']);
});

test('assignment lookup paginates users and does not guess based on name', async () => {
  const h = harness({ BobUsers: body => new Response(JSON.stringify({ data: { users: body.variables.cursor ? { nodes: [{ id: 'USER-RYAN', name: { full: 'Ryan Test' } }], pageInfo: { hasNextPage: false } } : { nodes: [{ id: 'SAME-NAME-WRONG-ID', name: { full: 'Ryan Test' } }], pageInfo: { hasNextPage: true, endCursor: 'next' } } } })) });
  assert.deepEqual(await h.api.verifyAssignment('USER-RYAN'), { id: 'USER-RYAN', name: 'Ryan Test' });
  assert.equal(h.calls.length, 2);
});

test('creation explicitly assigns intended user and verifies fresh returned visit time and assignment', async () => {
  const h = harness();
  const result = await h.api.createScheduledJob(options);
  assert.deepEqual(h.calls.map(c => c.operation), ['BobUsers', 'BobJobCreate', 'BobVisitCreate', 'BobVisits']);
  const schedule = h.calls[2].variables.input.visits[0].schedule;
  assert.deepEqual(schedule.teamMemberIdsToAssign, ['USER-RYAN']);
  assert.deepEqual(schedule.startAt, { date: '2026-11-02', time: '11:00:00', timezone: 'America/Phoenix' });
  assert.equal(result.visit.assignmentVerified, true);
  assert.deepEqual(result.visit.assignedUserIds, ['USER-RYAN']);
  assert.equal(result.visit.startAt, visit.startAt);
});

for (const [name, nodes] of [
  ['missing visit', []],
  ['unassigned visit', [{ ...visit, assignedUsers: { nodes: [], pageInfo: { hasNextPage: false } } }]],
  ['wrong assigned user', [{ ...visit, assignedUsers: { nodes: [{ id: 'USER-OTHER' }], pageInfo: { hasNextPage: false } } }]],
  ['extra assigned user', [{ ...visit, assignedUsers: { nodes: [{ id: 'USER-RYAN' }, { id: 'USER-OTHER' }], pageInfo: { hasNextPage: false } } }]],
  ['wrong time', [{ ...visit, startAt: new Date(start + 60_000).toISOString(), assignedUsers: { nodes: [{ id: 'USER-RYAN' }], pageInfo: { hasNextPage: false } } }]],
]) {
  test(`${name} is uncertain with known job and visit preserved; never automatically retries`, async () => {
    const h = harness({ BobVisits: { visits: { nodes, pageInfo: { hasNextPage: false } } } });
    await assert.rejects(h.api.createScheduledJob(options), e => {
      assert.equal(e.code, 'JOBBER_VISIT_UNVERIFIED'); assert.equal(e.uncertain, true);
      assert.equal(e.jobberJob.id, 'JOB'); assert.equal(e.jobberVisit.id, 'VISIT'); return true;
    });
    assert.equal(h.calls.filter(c => c.operation === 'BobJobCreate').length, 1);
    assert.equal(h.calls.filter(c => c.operation === 'BobVisitCreate').length, 1);
  });
}

test('empty create result is action-needed, never a confirmed null visit', async () => {
  const h = harness({ BobVisitCreate: { visitCreate: { createdVisits: [], userErrors: [] } } });
  await assert.rejects(h.api.createScheduledJob(options), e => e.code === 'JOBBER_VISIT_UNVERIFIED' && e.uncertain && e.jobberJob.id === 'JOB');
  assert.equal(h.calls.filter(c => c.operation === 'BobVisitCreate').length, 1);
});

test('readback failure preserves mutation IDs and never replays writes', async () => {
  const h = harness({ BobVisits: () => { throw new Error('read network failed'); } });
  await assert.rejects(h.api.createScheduledJob(options), e => e.uncertain && e.jobberVisit.id === 'VISIT' && e.jobberJob.id === 'JOB');
  assert.equal(h.calls.length, 4);
});

test('uncertain visit-create timeout preserves job and never replays mutation', async () => {
  const h = harness({ BobVisitCreate: () => { throw new Error('write timeout'); } });
  await assert.rejects(h.api.createScheduledJob(options), e => e.uncertain && e.jobberJob.id === 'JOB');
  assert.equal(h.calls.filter(c => c.operation === 'BobVisitCreate').length, 1);
});

test('partial mutation error with throttling is not retried', async () => {
  const h = harness({ BobVisitCreate: () => new Response(JSON.stringify({ data: { visitCreate: { createdVisits: [visit] } }, errors: [{ message: 'throttled partial result' }] })) });
  await assert.rejects(h.api.createScheduledJob(options), e => e.uncertain && e.jobberJob.id === 'JOB' && e.jobberVisit.id === 'VISIT');
  assert.equal(h.calls.filter(c => c.operation === 'BobVisitCreate').length, 1);
});

test('verified account identity comes only from documented account response, never configured client', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0, 'construction is passive');
  const identity = await h.api.accountIdentity();
  assert.equal(identity.id, 'ACCOUNT-TEST'); assert.equal(identity.name, 'Test Company'); assert.equal(identity.verified, true);
  assert.equal(Number.isFinite(identity.checkedAt), true);
  assert.equal(/fake-secret|fake-access|fake-client/.test(JSON.stringify(identity)), false);
  assert.deepEqual(h.calls.map(c => c.operation), ['BobAccountIdentity']);
  const bad = harness({ BobAccountIdentity: { account: null } });
  await assert.rejects(bad.api.accountIdentity(), /could not be verified/);
});

test('identity revision is opaque, passive and changes on token binding or disconnection', async () => {
  let binding = { refreshToken: 'fake-refresh-one', savedAt: 1 };
  const api = createJobber({ store: {}, env: { JOBBER_CLIENT_ID: 'fake-client' }, tokens: { load: async () => binding }, fetchImpl: async () => { throw new Error('must not fetch'); } });
  const first = await api.accountIdentityRevision();
  assert.match(first, /^[a-f0-9]{64}$/);
  binding = { refreshToken: 'fake-refresh-two', savedAt: 2 };
  assert.notEqual(await api.accountIdentityRevision(), first);
  binding = null;
  assert.equal(await api.accountIdentityRevision(), null);
});

test('incomplete visit-assignee connection fails closed before availability is returned', async () => {
  const h = harness({ BobVisits: { visits: { nodes: [{ ...visit, assignedUsers: { nodes: [{ id: 'USER-OTHER' }], pageInfo: { hasNextPage: true } } }], pageInfo: { hasNextPage: false } } } });
  await assert.rejects(h.api.readVisits(start - 1, end + 1), /assignment list is incomplete/);
  assert.equal(h.cache.size, 0);
});

for (const [name, changes] of [['missing start', { startAt: null }], ['invalid start', { startAt: 'bad' }], ['missing timed end', { endAt: null }], ['invalid end', { endAt: 'bad' }], ['inverted interval', { endAt: new Date(start - 1).toISOString() }]]) {
  test(`${name} cannot silently remove or shorten an occupied visit`, async () => {
    const h = harness({ BobVisits: { visits: { nodes: [{ ...visit, ...changes, allDay: false, assignedUsers: { nodes: [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } } });
    await assert.rejects(h.api.readVisits(start - 1, end + 1), /invalid visit time range/);
    assert.equal(h.cache.size, 0);
  });
}

test('visit pagination cap with remaining pages fails closed and is not cached', async () => {
  const h = harness({ BobVisits: (body, calls) => new Response(JSON.stringify({ data: { visits: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page-' + calls.length } } } })) });
  await assert.rejects(h.api.readVisits(start - 1, end + 1), /exceeds the verification limit/);
  assert.equal(h.calls.length, 15); assert.equal(h.cache.size, 0);
});

test('visit cache uses exact range, bypasses on fresh, and cannot cross OAuth bindings', async () => {
  const h = harness();
  await h.api.readVisits(start - 60_000, end + 60_000);
  await h.api.readVisits(start - 60_000, end + 60_000);
  assert.equal(h.calls.length, 1);
  await h.api.readVisits(start - 30_000, end + 30_000);
  assert.equal(h.calls.length, 2, 'nearby but distinct range does not share cache');
  await h.api.readVisits(start - 60_000, end + 60_000, { fresh: true });
  assert.equal(h.calls.length, 3);
  h.setTokenBinding({ accessToken: 'fake-access-new', refreshToken: 'fake-refresh-new', savedAt: 2, expiresAt: Date.now() + 3600_000 });
  await h.api.readVisits(start - 60_000, end + 60_000);
  assert.equal(h.calls.length, 4);
  h.setTokenBinding(null);
  await assert.rejects(h.api.readVisits(start - 60_000, end + 60_000), { code: 'JOBBER_NOT_CONNECTED' });
  assert.equal(h.calls.length, 4);
});

test('office verification requires an actual matching visit, never a job number placeholder', async () => {
  const h = harness();
  await assert.rejects(h.api.verifyScheduledVisit({ visitId: 'confirmed-by-office', start, end, jobberUserId: 'USER-RYAN' }), { code: 'JOBBER_VISIT_UNVERIFIED' });
  assert.equal(h.calls.length, 0);
  const result = await h.api.verifyScheduledVisit({ visitId: 'VISIT', start, end, jobberUserId: 'USER-RYAN' });
  assert.equal(result.assignmentVerified, true);
  assert.deepEqual(h.calls.map(x => x.operation), ['BobVisits']);
  await assert.rejects(h.api.verifyScheduledVisit({ visitId: 'VISIT', start, end, jobberUserId: 'USER-OTHER' }), { code: 'JOBBER_VISIT_UNVERIFIED' });
  assert.equal(h.calls.length, 2, 'verification always reads fresh');
});

for (const malformed of [null, {}, { jobCreate: null }, { jobCreate: { job: null, userErrors: [] } }]) {
  test(`malformed job mutation success stays uncertain: ${JSON.stringify(malformed)}`, async () => {
    const h = harness({ BobJobCreate: () => new Response(JSON.stringify({ data: malformed })) });
    await assert.rejects(h.api.createScheduledJob(options), e => e.uncertain === true && !(e instanceof TypeError));
    assert.deepEqual(h.calls.map(x => x.operation), ['BobUsers', 'BobJobCreate']);
  });
}

test('malformed client mutation success is uncertain and never proceeds to job creation', async () => {
  for (const value of [null, {}, { clientCreate: { client: { id: 'CLIENT', properties: [] } } }]) {
    const h = harness({ BobClientSearch: { clients: { nodes: [] } }, BobClientCreate: () => new Response(JSON.stringify({ data: value })) });
    await assert.rejects(h.api.ensureClientAndProperty({ firstName: 'Test', phone: '6235550100' }, { street1: '100 Test St', city: 'Buckeye', zip: '85326' }), e => e.uncertain === true && !(e instanceof TypeError));
    assert.deepEqual(h.calls.map(x => x.operation), ['BobClientSearch', 'BobClientCreate']);
  }
});

test('malformed property mutation success preserves client ID and is uncertain', async () => {
  const h = harness({ BobClientSearch: { clients: { nodes: [{ id: 'CLIENT', emails: [], phones: [{ number: '6235550100' }], properties: [] }] } }, BobPropertyCreate: {} });
  await assert.rejects(h.api.ensureClientAndProperty({ firstName: 'Test', phone: '6235550100' }, { street1: '100 Test St', city: 'Buckeye', zip: '85326' }), e => e.uncertain === true && e.jobberClientId === 'CLIENT');
  assert.deepEqual(h.calls.map(x => x.operation), ['BobClientSearch', 'BobPropertyCreate']);
});

test('mutation userErrors with known created IDs stay uncertain and preserve evidence', async () => {
  const h = harness({ BobJobCreate: { jobCreate: { job, userErrors: [{ message: 'Partial completion' }] } } });
  await assert.rejects(h.api.createScheduledJob(options), e => e.uncertain && e.jobberJob.id === 'JOB');
  assert.deepEqual(h.calls.map(x => x.operation), ['BobUsers', 'BobJobCreate']);
  const v = harness({ BobVisitCreate: { visitCreate: { createdVisits: [visit], userErrors: [{ message: 'Partial assignment' }] } } });
  await assert.rejects(v.api.createScheduledJob(options), e => e.uncertain && e.jobberJob.id === 'JOB' && e.jobberVisit.id === 'VISIT');
});

test('office job-number recovery requires one exact fresh account visit and returns its real ID', async () => {
  const node = { ...visit, job: { id: 'JOB', jobNumber: 101 }, assignedUsers: { nodes: [{ id: 'USER-RYAN' }], pageInfo: { hasNextPage: false } } };
  const h = harness({ BobVisits: { visits: { nodes: [node], pageInfo: { hasNextPage: false } } } });
  const result = await h.api.verifyScheduledVisit({ jobNumber: '101', start, end, jobberUserId: 'USER-RYAN' });
  assert.equal(result.id, 'VISIT');
  assert.equal(result.assignmentVerified, true);
  assert.match(h.calls[0].query, /job \{ id jobNumber/);
  for (const number of ['102', '', 'not-a-number']) await assert.rejects(h.api.verifyScheduledVisit({ jobNumber: number, start, end, jobberUserId: 'USER-RYAN' }), { code: 'JOBBER_VISIT_UNVERIFIED' });
  h.responses.BobVisits.visits.nodes = [node, { ...node, id: 'DUPLICATE-VISIT' }];
  await assert.rejects(h.api.verifyScheduledVisit({ jobNumber: '101', start, end, jobberUserId: 'USER-RYAN' }), { code: 'JOBBER_VISIT_UNVERIFIED' });
  h.responses.BobVisits.visits.nodes = [{ ...node, assignedUsers: { nodes: [{ id: 'USER-OTHER' }], pageInfo: { hasNextPage: false } } }];
  await assert.rejects(h.api.verifyScheduledVisit({ jobNumber: '101', start, end, jobberUserId: 'USER-RYAN' }), { code: 'JOBBER_VISIT_UNVERIFIED' });
});

test('known visit ID cannot be relabeled with an unrelated supplied job number', async () => {
  const h = harness({ BobVisits: { visits: { nodes: [{ ...visit, job: { id: 'JOB', jobNumber: 101 }, assignedUsers: { nodes: [{ id: 'USER-RYAN' }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } } });
  await assert.rejects(h.api.verifyScheduledVisit({ visitId: 'VISIT', jobNumber: '999', start, end, jobberUserId: 'USER-RYAN' }), { code: 'JOBBER_VISIT_UNVERIFIED' });
  const matched = await h.api.verifyScheduledVisit({ visitId: 'VISIT', jobNumber: '101', start, end, jobberUserId: 'USER-RYAN' });
  assert.equal(matched.jobNumber, 101);
  const creation = await h.api.verifyScheduledVisit({ visitId: 'VISIT', start, end, jobberUserId: 'USER-RYAN' });
  assert.equal(creation.assignmentVerified, true);
});

test('malformed visit IDs cannot confirm job-number recovery', async () => {
  for (const id of [undefined, null, '', '   ', 101]) {
    const node = { ...visit, id, job: { id: 'JOB', jobNumber: 101 }, assignedUsers: { nodes: [{ id: 'USER-RYAN' }], pageInfo: { hasNextPage: false } } };
    const h = harness({ BobVisits: { visits: { nodes: [node], pageInfo: { hasNextPage: false } } } });
    await assert.rejects(h.api.verifyScheduledVisit({ jobNumber: 101, start, end, jobberUserId: 'USER-RYAN' }), /invalid visit ID/);
    assert.equal(h.calls.filter(c => c.operation.startsWith('Bob') && /mutation/.test(c.query)).length, 0);
    assert.equal(h.cache.size, 0);
  }
});

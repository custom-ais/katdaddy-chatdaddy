import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeo } from '../server/geo.mjs';
import { createScheduler } from '../server/schedule.mjs';
import { evaluateTech } from '../server/schedule-rules.mjs';
import { DEFAULT_CONFIG } from '../shared/domain.mjs';

const from = { lat: 33.4, lng: -112.5 }, to = { lat: 33.5, lng: -112.6 };
const pair = [{ from, to }];
const cache = () => { const values = new Map(); return { kvGet: async k => values.get(k), kvSet: async (k,v) => values.set(k,v), values }; };
const route = seconds => new Response(JSON.stringify([{ condition: 'ROUTE_EXISTS', duration: `${seconds}s`, distanceMeters: 1609 }]), { status: 200 });

test('no key, failed Routes and unroutable legs remain unknown rather than estimated', async () => {
  const noKey = createGeo({ cache: cache(), googleKey: '', fetchImpl: () => { throw new Error('must not call'); } });
  assert.deepEqual(await noKey.driveMinutes(pair), [null]);
  assert.deepEqual(await noKey.driveMinutes([{from,to:from}]), [0]);
  assert.deepEqual(await noKey.driveMinutes([{from,to:{lat:33.400001,lng:-112.5}}]), [null], 'nearby is not identical');
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => route('bad'), async () => new Response(JSON.stringify([{ condition: 'ROUTE_NOT_FOUND' }]))]) {
    const g = createGeo({ cache: cache(), googleKey: 'fake-key', fetchImpl });
    assert.deepEqual(await g.driveMinutes(pair), [null]);
  }
});

test('measured travel caches are short-lived, credential scoped and bypassed for fresh checks', async () => {
  let now = 1000000, calls = 0, offline = false;
  const c = cache(), fetchImpl = async () => { calls++; if (offline) throw new Error('offline'); return route(1199); };
  const g = createGeo({ cache: c, googleKey: 'key-one', fetchImpl, clock: () => now });
  assert.deepEqual(await g.driveMinutes(pair), [1199 / 60], 'retain measured fractions instead of rounding at the strict 20-minute boundary');
  offline = true;
  assert.deepEqual(await g.driveMinutes(pair), [1199 / 60]); assert.equal(calls, 1);
  assert.deepEqual(await g.driveMinutes(pair, { fresh:true }), [null]);
  const changed = createGeo({ cache:c, googleKey:'key-two', fetchImpl, clock:()=>now });
  assert.deepEqual(await changed.driveMinutes(pair), [null]);
  now += 300000;
  assert.deepEqual(await g.driveMinutes(pair), [null], 'TTL enforced even if storage neglects expiry');
});

test('overnight timed visits block the following day and require measured travel after ending', () => {
  const tech = { id:'a', jobberUserId:'ja' }, config = { ...DEFAULT_CONFIG, bufferMinutes:15 };
  const block = { id:'night',kind:'jobber',techIds:['a'],allDay:false,start:Date.parse('2026-09-21T23:00:00-07:00'),end:Date.parse('2026-09-22T10:00:00-07:00') };
  const candidate = {date:'2026-09-22',start:Date.parse('2026-09-22T09:00:00-07:00'),end:Date.parse('2026-09-22T10:00:00-07:00')};
  assert.equal(evaluateTech({candidate,tech,blocks:[block],drive:new Map(),config}).reason,'overlap');
  candidate.start += 7200000; candidate.end += 7200000;
  assert.equal(evaluateTech({candidate,tech,blocks:[block],drive:new Map(),config}).reason,'unknown_location');
  assert.equal(evaluateTech({candidate,tech,blocks:[block],drive:new Map([['night',{toNew:10,fromNew:10}]]),config}).ok,true);
});

test('preferred technician cannot reactivate an excluded technician and fresh check reaches routing', async () => {
  const options = [];
  const store = {activeAppointments:async()=>[],activeHolds:async()=>[]};
  const geo = {driveMinutes:async (_pairs,opts)=>{options.push(opts);return []},geocode:async()=>null};
  const scheduler = createScheduler({store,geo,jobber:{readVisits:async()=>[]}});
  const technicians = [{id:'active',name:'Active',status:'available'},{id:'removed',name:'Removed',status:'available'}];
  const config = {...DEFAULT_CONFIG,scheduleSource:'BOB',activeTechnicianIds:['active']};
  const result = await scheduler.check({config,technicians,durationMins:60,location:from,now:Date.parse('2026-09-21T08:00:00-07:00'),iso:'2026-09-22T09:00:00-07:00',preferTech:'removed',fresh:true});
  assert.equal(result.technicianId,'active');
  assert.ok(options.length && options.every(x=>x.fresh===true));
});

test('known uncertain Jobber visit ID never releases the intended local reservation', async () => {
  const appointment = {id:'local',tech:'intended',start:100,end:200,jobberVisitId:'visit',location:from,address:'test',status:'action_needed'};
  const board = [{id:'visit',start:100,end:200,allDay:false,jobberUserIds:['wrong-user'],address:''}];
  const store = {activeAppointments:async()=>[appointment],activeHolds:async()=>[]};
  const scheduler = createScheduler({store,geo:{geocode:async()=>null},jobber:{readVisits:async()=>board}});
  const args = {config:{scheduleSource:'Jobber'},technicians:[{id:'intended',jobberUserId:'intended-user'}],from:0,to:300};
  for (const status of ['action_needed','confirming',undefined]) {
    appointment.status=status;
    const blocks=await scheduler.blocks(args);
    assert.ok(blocks.some(b=>b.id==='a:local' && b.techIds.includes('intended')));
  }
  appointment.status='confirmed';
  assert.equal((await scheduler.blocks(args)).some(b=>b.id==='a:local'),true,'wrong technician still retains confirmed local');
  board[0].jobberUserIds=['intended-user'];
  board[0].start=101;
  assert.equal((await scheduler.blocks(args)).some(b=>b.id==='a:local'),true,'wrong time still retains confirmed local');
  board[0].start=100;
  assert.equal((await scheduler.blocks(args)).some(b=>b.id==='a:local'),false,'confirmed observed visit can replace local');
  board.length=0;
  assert.equal((await scheduler.blocks(args)).some(b=>b.id==='a:local'),true,'missing remote visit cannot release local protection');
});

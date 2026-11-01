import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from './helpers.mjs';
import { initialSession } from '../shared/conversation.mjs';

const source=await readFile(new URL('../server/app.mjs',import.meta.url),'utf8');
const start=source.indexOf('  async function lookupPlace(text, c) {');
const end=source.indexOf('\n  // ---- phone verification',start);
assert.ok(start>0&&end>start);
const snippet=source.slice(start,end);
const make=(code,geo)=>new Function('geo','validPoint','distanceMiles',`${code};return lookupPlace;`)(geo,()=>true,()=>5);
const place={lat:33.4,lng:-112.4,zip:'85326',city:'Buckeye',state:'AZ',precise:true,provider:'google',formatted:'100 W Test St, Buckeye, AZ 85326'};
const config={serviceAreaMode:'driving_distance',baseLocation:{lat:33.5,lng:-112.3}};

test('typed driving-distance lookup calls measured routes and returns measured coverage',async()=>{
  let calls=0;const geo={geocode:async()=>place,roadRoutes:async(_pairs,options)=>{calls++;assert.equal(options.fresh,false);return [{miles:5,minutes:10}];}};
  const result=await make(snippet,geo)('100 W Test St Buckeye AZ',config);
  assert.equal(result.found,true);assert.equal(result.drivingMiles,5);assert.equal(calls,1);
});

test('repaired lookup still fails closed when a measured route is unavailable',async()=>{
  for(const roadRoutes of [async()=>[null],async()=>{throw Error('mock outage');}]) {
    assert.deepEqual(await make(snippet,{geocode:async()=>place,roadRoutes})('100 W Test St Buckeye AZ',config),{routingUnavailable:true});
  }
});

test('typed address API preserves measured distance and advances service-address conversation',async t=>{
  const h=await harness(t,{config:{...config,serviceAreaMiles:20,aiAssistant:false}});
  h.geo.provider='google';h.geo.geocode=async()=>place;let calls=0;
  h.geo.roadRoutes=async()=>{calls++;return [{miles:5,minutes:10}];};
  const token=await h.fresh();await h.store.saveSession(createHash('sha256').update(token).digest('hex'),{...initialSession(),pending:'serviceAddress'});
  const result=await h.chat(token,'100 W Test St, Buckeye AZ 85326');
  assert.equal(calls,1);assert.equal(result.session.serviceAddress.drivingMiles,5);
  assert.doesNotMatch(result.reply,/couldn.t verify the driving distance/i);
  assert.equal(h.jobber.jobs.length,0);
});

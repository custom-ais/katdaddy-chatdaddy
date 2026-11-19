import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import worker from '../dist/worker.mjs';
const base = 'https://custom-ais.com';
const route = '/dvswest/booking';
const get = (path,method='GET') => worker.fetch(new Request(base+path,{method}));
const script = await readFile(new URL('../public/page.js',import.meta.url),'utf8');
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));

test('only intended paths serve HTML; both trailing slash forms work',async()=>{
  for(const path of [route,route+'/',route+'?start=cleaning']){
    const r=await get(path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/html/);
  }
  for(const path of [route+'/admin',route+'/api/session',route+'/anything',route+'//'])assert.equal((await get(path)).status,404);
});

test('wildcard route siblings and unrelated existing pages pass through unchanged',async()=>{
  const original=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async req=>{requests.push(req);return new Response('existing website',{status:203});};
  try{for(const path of [route+'-other','/privacy','/api/session','/dvswest/bookings']){
    const req=new Request(base+path);const r=await worker.fetch(req);assert.equal(r.status,203);assert.equal(requests.at(-1),req);
  }}finally{globalThis.fetch=original;}
});

test('HTML is static and never reflects arbitrary query markup or flags',async()=>{
  const clean=await(await get(route)).text();
  const hostile=await(await get(route+'?name=%3Cscript%3Ealert(1)%3C%2Fscript%3E&preview=true&token=private')).text();
  assert.equal(hostile,clean);assert.doesNotMatch(hostile,/alert\(1\)|token=private/);
  assert.ok(clean.includes('href="https://katdaddy-bookingbot.vercel.app/" target="_blank"'));
  assert.match(clean,/referrerpolicy="strict-origin"/);assert.match(clean,/allow="web-share"/);assert.doesNotMatch(clean,/\bsandbox=/);
  assert.match(clean,/title="BOB — Dryer Vent Squad West Valley booking assistant"/);
});

test('GET and HEAD assets have correct type and cache; HEAD bodies are empty',async()=>{
  for(const [path,type] of [[route,'text/html'],[route+'/page.css','text/css'],[route+'/page.js','application/javascript']]){
    const r=await get(path);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(type));assert.ok((await r.text()).length>100);
    const h=await get(path,'HEAD');assert.equal(h.status,200);assert.equal(await h.text(),'');assert.equal(h.headers.get('content-type'),r.headers.get('content-type'));
  }
  assert.equal((await get(route)).headers.get('cache-control'),'no-store');
  assert.equal((await get(route+'/page.js')).headers.get('cache-control'),'public, max-age=300');
  assert.equal(await(await get(route+'/missing','HEAD')).text(),'');
});

test('unsupported methods do not forward or create booking operations',async()=>{
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
    const r=await get(route,method);assert.equal(r.status,405);assert.equal(r.headers.get('allow'),'GET, HEAD');
  }
});

test('tight CSP permits only the bot frame; web share is delegated without secrets or main worker edits',async()=>{
  const r=await get(route),c=r.headers.get('content-security-policy');
  assert.match(c,/default-src 'none'/);assert.match(c,/frame-src https:\/\/katdaddy-bookingbot\.vercel\.app/);
  assert.match(c,/script-src 'self'/);assert.match(c,/connect-src 'none'/);assert.doesNotMatch(c,/unsafe-inline|unsafe-eval/);
  assert.match(r.headers.get('permissions-policy'),/web-share=\(self "https:\/\/katdaddy-bookingbot\.vercel\.app"\)/);
  assert.deepEqual(config.compatibility_flags,['nodejs_compat']);
  // global_fetch_strictly_public would send pass-through fetches back through this same wildcard route
  // (Cloudflare error 1019) instead of to the main custom-ais-studio Worker, breaking sibling paths.
  assert.ok(!config.compatibility_flags.includes('global_fetch_strictly_public'));
  assert.deepEqual(config.routes.map(r=>r.pattern),['custom-ais.com/dvswest/booking*']);
  assert.equal(config.observability.enabled,false);assert.equal(config.name,'custom-ais-dvswest-booking');
  assert.equal(config.bindings,undefined);assert.equal(config.vars,undefined);
});

function browser(search=''){
  const handlers={},sent=[],timers=new Map();let nextTimer=0;
  const elements=Object.fromEntries(['booking-frame','loading','fallback','minimized','reopen'].map(id=>[id,{hidden:['fallback','minimized'].includes(id),listeners:{},focus(){this.focused=true;},addEventListener(type,fn){this.listeners[type]=fn;}}]));
  const frameWindow={postMessage:(...args)=>sent.push(args)};elements['booking-frame'].contentWindow=frameWindow;
  const window={location:{search},addEventListener:(type,fn)=>{handlers[type]=fn;},setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(script,{window,document:{getElementById:id=>elements[id]},URL,URLSearchParams,Set});
  return {elements,sent,timers,frameWindow,message:(data,origin='https://katdaddy-bookingbot.vercel.app',source=frameWindow)=>handlers.message({data,origin,source})};
}

test('forwards only documented fixed-choice query values',()=>{
  const b=browser('?start=repair&audience=commercial&preview=1&token=private&name=hello');
  assert.equal(b.elements['booking-frame'].src,'https://katdaddy-bookingbot.vercel.app/chat?embed=1&start=repair&audience=commercial');
  const invalid=browser('?start=%3Cscript%3E&audience=admin');
  assert.equal(invalid.elements['booking-frame'].src,'https://katdaddy-bookingbot.vercel.app/chat?embed=1');
});

test('readiness and minimize messages require BOTH exact source and exact origin',()=>{
  const b=browser();
  for(const [origin,source] of [['https://evil.example',b.frameWindow],['https://katdaddy-bookingbot.vercel.app',{}]]){
    b.message({type:'bob:ready'},origin,source);assert.equal(b.elements.loading.hidden,false);
    b.message({type:'bob:minimize'},origin,source);assert.equal(b.elements.minimized.hidden,true);
  }
  b.message({type:'bob:ready'});assert.equal(b.elements.loading.hidden,true);assert.equal(b.timers.size,0);
  assert.equal(b.sent.at(-1)[0].type,'bob:restore');assert.equal(b.sent.at(-1)[1],'https://katdaddy-bookingbot.vercel.app');
  b.message({type:'bob:minimize'});assert.equal(b.elements['booking-frame'].hidden,true);assert.equal(b.elements.minimized.hidden,false);assert.equal(b.elements.reopen.focused,true);
  b.elements.reopen.listeners.click();assert.equal(b.elements['booking-frame'].hidden,false);assert.equal(b.elements.minimized.hidden,true);assert.equal(b.sent.at(-1)[0].type,'bob:restore');
});

test('loading fallback is accessible and readiness removes it; load restores child state',()=>{
  const b=browser();[...b.timers.values()][0]();assert.equal(b.elements.fallback.hidden,false);assert.equal(b.elements.loading.hidden,true);
  b.elements['booking-frame'].listeners.load();assert.equal(b.sent.at(-1)[0].type,'bob:restore');
  b.message({type:'bob:ready'});assert.equal(b.elements.fallback.hidden,true);
});

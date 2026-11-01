import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,scryptSync} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import ts from 'typescript';
import * as permissions from '../shared/admin-permissions.mjs';
import {DEFAULT_CONFIG} from '../shared/domain.mjs';
import {createSupabaseRpcDb} from '../server/db.mjs';
import {createStore} from '../server/store.mjs';
import {createScheduler} from '../server/schedule.mjs';
import {createBobHandler} from '../server/app.mjs';
import {fakeJobber,fakeGeo,fakeTwilio} from './helpers.mjs';

// Produce the request through the real UI helper, not a test-side approximation.
const access={};
const uiSource=await readFile(new URL('../src/admin/access.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(uiSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
new Function('require','exports',compiled)(id=>{assert.equal(id,'../../shared/admin-permissions.mjs');return permissions;},access);
const legacySchema=await readFile(new URL('./fixtures/pre-named-admin-schema.sql',import.meta.url),'utf8');
const password='Synthetic-legacy-settings-password-2026';

async function oldSchemaServer(t,{rest,storedPassword}) {
 const pg=new PGlite();
 await pg.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await pg.exec(legacySchema);
 const queries=[];
 const db=rest?createSupabaseRpcDb({url:'https://synthetic.example.test',key:'synthetic-service-key',fetchImpl:async(url,init)=>{
  assert.equal(url,'https://synthetic.example.test/rest/v1/rpc/bob_exec');
  const {q}=JSON.parse(init.body);queries.push(q);
  try{const {rows}=await pg.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.bob_exec($1) as result',[q]);});return new Response(JSON.stringify(rows[0].result));}
  catch(error){return new Response(JSON.stringify({message:error.message,code:error.code}),{status:400});}
 }}):{query:async(sql,args)=>{queries.push(sql);return (await pg.query(sql,args)).rows;}};
 const store=createStore(db);await store.init();
 await store.set('config',{
  ...DEFAULT_CONFIG,businessName:'Synthetic staged release company',bookingEnabled:false,scheduleSource:'BOB',
  aiAssistant:false,smsConfirmations:false,emailConfirmations:false,bookingOwnerSmsEnabled:false,
  integrations:{jobber:false,maps:false,verification:false,sms:true,email:false},
  sameDay:{enabled:true,cutoffHour:13,minNoticeHours:4,requireNearby:false},
  messageTemplates:{
   ...DEFAULT_CONFIG.messageTemplates,
   confirmationSms:'Synthetic original SMS {{customer_name}}',
   confirmationEmailSubject:'Synthetic custom email subject',
   confirmationEmailBody:'Synthetic custom email body {{customer_name}}',
   ownerBookingSms:'Synthetic owner template {{customer_name}}',
  },
 });
 if(storedPassword){const salt=randomBytes(16).toString('hex');await store.set('auth',{salt,hash:scryptSync(password,salt,64).toString('hex')});}
 const jobber=fakeJobber({connected:false}),geo=fakeGeo(),twilio=fakeTwilio();
 const handle=createBobHandler({store,jobber,geo,twilio,scheduler:createScheduler({store,jobber,geo}),env:storedPassword?{}:{ADMIN_PASSWORD:password}});
 const server=http.createServer(handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pg.close();});
 const call=async(path,{method='GET',cookie,body}={})=>{
  const response=await fetch(origin+path,{method,headers:{'content-type':'application/json','x-bob-request':'1',origin,...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 const login=await call('/api/admin/login',{method:'POST',body:{password}});assert.equal(login.status,200);
 return {pg,store,queries,jobber,twilio,call,cookie:login.cookie};
}

for(const rest of [false,true])for(const storedPassword of [false,true]) {
 test(`${rest?'REST RPC':'PGlite'} / ${storedPassword?'stored':'environment'} legacy password: UI sparse settings preserve nested siblings on the old schema`,async t=>{
  const h=await oldSchemaServer(t,{rest,storedPassword});
  const saveDraft=async(change,expectedPatch)=>{
   const before=await h.store.config(),draft=structuredClone(before);change(draft);
   const patch=access.changedConfig(before,draft);assert.deepEqual(patch,expectedPatch);
   const result=await h.call('/api/admin/config',{method:'PATCH',cookie:h.cookie,body:{version:before.version,...patch}});
   assert.equal(result.status,200,JSON.stringify(result.data));
   const saved=await h.store.config();assert.equal(saved.version,before.version+1);
   assert.deepEqual({...saved,version:before.version},draft,'only UI-selected leaves change');
   assert.deepEqual(result.data.config,saved,'mutation response contains the preserved configuration');
   return {before,saved};
  };
  const integrations=await saveDraft(draft=>{draft.integrations.sms=false;},{integrations:{sms:false}});
  assert.deepEqual(integrations.saved.integrations,{...integrations.before.integrations,sms:false});
  const sameDay=await saveDraft(draft=>{draft.sameDay.enabled=false;},{sameDay:{enabled:false}});
  assert.deepEqual(sameDay.saved.sameDay,{...sameDay.before.sameDay,enabled:false});
  const sms=await saveDraft(draft=>{draft.messageTemplates.confirmationSms='Synthetic revised SMS {{customer_name}}';},{messageTemplates:{confirmationSms:'Synthetic revised SMS {{customer_name}}'}});
  assert.equal(sms.saved.messageTemplates.confirmationEmailSubject,sms.before.messageTemplates.confirmationEmailSubject);
  assert.equal(sms.saved.messageTemplates.confirmationEmailBody,sms.before.messageTemplates.confirmationEmailBody);
  assert.equal(sms.saved.messageTemplates.ownerBookingSms,sms.before.messageTemplates.ownerBookingSms);
  const email=await saveDraft(draft=>{draft.messageTemplates.confirmationEmailSubject='Synthetic revised email subject';},{messageTemplates:{confirmationEmailSubject:'Synthetic revised email subject'}});
  assert.equal(email.saved.messageTemplates.confirmationEmailBody,email.before.messageTemplates.confirmationEmailBody);
  assert.equal(email.saved.messageTemplates.ownerBookingSms,email.before.messageTemplates.ownerBookingSms);
  assert.equal(email.saved.bookingOwnerSmsEnabled,false);
  const status=await h.call('/api/admin/status',{cookie:h.cookie});assert.equal(status.data.authMode,'legacy');assert.equal(status.data.authenticated,true);
  const names=(await h.pg.query("select table_name from information_schema.tables where table_schema='bob'")).rows.map(x=>x.table_name);
  assert.equal(names.length,10);assert.ok(names.every(name=>!name.startsWith('auth_')));
  assert.equal((await h.pg.query("select key from bob.kv where key='admin-auth:authority'")).rows.length,0);
  assert.equal(h.queries.some(sql=>/^\s*(create|alter|drop|grant|revoke)\b/i.test(sql)),false);
  assert.equal(h.twilio.calls.length,0);assert.equal(h.jobber.jobs.length,0);assert.equal(h.jobber.clients.length,0);
 });
}

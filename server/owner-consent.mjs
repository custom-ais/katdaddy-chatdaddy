import {createHash,randomUUID} from 'node:crypto';
import {normalizePhone} from '../shared/domain.mjs';
import {OWNER_SMS_CONSENT_VERSION,OWNER_SMS_PURPOSES,OWNER_SMS_DISCLOSURE,OWNER_SMS_TERMS_URL,OWNER_SMS_PRIVACY_URL} from '../shared/owner-sms-consent.mjs';
const CURRENT='owner-sms-consent:current';
const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
export function createOwnerConsent({store,clock=Date.now}){
 async function current(){return await store.kvGet(CURRENT)||null;}
 async function snapshot(){
  const record=await current();
  const configuredPhone=normalizePhone((await store.config()).bookingOwnerSmsPhone);
  const matchesConfiguredPhone=Boolean(record&&configuredPhone&&record.phone===configuredPhone);
  const currentVersion=record?.disclosureVersion===OWNER_SMS_CONSENT_VERSION;
  return {revision:record?.revision||0,current:record,matchesConfiguredPhone,currentVersion,effectiveActive:record?.active===true&&matchesConfiguredPhone&&currentVersion,disclosure:{version:OWNER_SMS_CONSENT_VERSION,text:OWNER_SMS_DISCLOSURE,purposes:[...OWNER_SMS_PURPOSES],termsUrl:OWNER_SMS_TERMS_URL,privacyUrl:OWNER_SMS_PRIVACY_URL}};
 }
 async function record(body,adminSession,actorUserId=null){
  if(!body||typeof body!=='object'||Array.isArray(body))throw failure('Invalid consent request.');
  if(!['grant','revoke'].includes(body.action)||!Number.isInteger(body.revision)||body.revision<0||typeof body.idempotencyKey!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(body.idempotencyKey))throw failure('Invalid consent request.');
  if(typeof adminSession!=='string'||!adminSession)throw failure('Authenticated administration is required.',401);
  const phone=body.action==='grant'?normalizePhone(body.phone):null;
  if(body.action==='grant'&&(!phone||body.consent!==true||body.disclosureVersion!==OWNER_SMS_CONSENT_VERSION))throw failure('Read the current disclosure, enter a valid phone number, and explicitly check consent.');
  if(body.action==='grant'&&phone!==normalizePhone((await store.config()).bookingOwnerSmsPhone))throw failure('Save this phone number as the owner alert recipient in Settings before recording consent.');
  const fingerprint=hash(JSON.stringify([body.action,phone,body.revision,body.action==='grant'?body.disclosureVersion:null]));
  const key=`owner-sms-consent:receipt:${hash(body.idempotencyKey)}`;
  const existing=await store.kvGet(key);
  if(existing){if(existing.requestFingerprint!==fingerprint)throw failure('This request key was already used for a different consent change.',409);return {...await snapshot(),receipt:existing};}
  const old=await current();if((old?.revision||0)!==body.revision){const retry=await store.kvGet(key);if(retry?.requestFingerprint===fingerprint)return {...await snapshot(),receipt:retry};throw failure('Consent changed elsewhere. Refresh before saving.',409);}
  if(body.action==='revoke'&&!old)throw failure('There is no recorded consent to revoke.',409);
  const receipt={id:randomUUID(),revision:body.revision+1,action:body.action,active:body.action==='grant',phone:phone||old.phone,at:new Date(clock()).toISOString(),disclosureVersion:OWNER_SMS_CONSENT_VERSION,disclosure:OWNER_SMS_DISCLOSURE,purposes:[...OWNER_SMS_PURPOSES],actor:{type:actorUserId?'authenticated_admin_user':'authenticated_admin_session',...(actorUserId?{userId:actorUserId}:{}),reference:hash(adminSession)},requestFingerprint:fingerprint};
  // One atomic block works through the existing REST RPC, which nests row-producing
  // queries in a CTE and cannot nest a data-changing CTE. No schema change is needed.
  // Hex keeps all request data out of SQL syntax and the RPC's keyword detection.
  const payload=Buffer.from(JSON.stringify({current:CURRENT,key,revision:body.revision,receipt}),'utf8').toString('hex');
  try{await store.db.query(`do $owner_consent$
  declare
    payload jsonb := convert_from(decode('${payload}','hex'),'UTF8')::jsonb;
    changed integer;
  begin
    insert into bob.kv(key,value,expires) values(payload->>'current',payload->'receipt',null)
    on conflict (key) do update set value=excluded.value,expires=null
    where (bob.kv.value->>'revision')::int=(payload->>'revision')::int;
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'Consent revision changed'; end if;
    insert into bob.kv(key,value,expires) values(payload->>'key',payload->'receipt',null);
  end
  $owner_consent$`);}
  catch{const retry=await store.kvGet(key).catch(()=>null);if(retry?.requestFingerprint===fingerprint)return {...await snapshot(),receipt:retry};throw failure('Consent could not be saved. Refresh and retry.',409);}
  const saved=await store.kvGet(key);
  if(saved?.requestFingerprint!==fingerprint)throw failure('Consent changed elsewhere. Refresh before saving.',409);
  return {...await snapshot(),receipt:saved};
 }
 async function allows(phone){
  try{
   const configuredPhone=normalizePhone((await store.config()).bookingOwnerSmsPhone);
   // Read the receipt after configuration so revocation during that await is observed.
   const receipt=await current();
   // v1 receipts must never authorize sending: that disclosure said saving did not enable alerts.
   if(!receipt||receipt.active!==true||receipt.disclosureVersion!==OWNER_SMS_CONSENT_VERSION)return false;
   return Boolean(configuredPhone)&&receipt.phone===normalizePhone(phone)&&receipt.phone===configuredPhone;
  }catch{return false;}
 }
 return {snapshot,record,allows};
}

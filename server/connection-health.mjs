import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NAMES=['verification','sms','email','assistant','database','jobber'];
/** Observes real operations; it never manufactures a send or paid model request. */
export function createConnectionHealth({store,env={},clock=Date.now,maxAgeMs=15*60_000,jobber,onError}) {
  const revision=(name,c)=>hash(name==='verification'?[env.TWILIO_ACCOUNT_SID,env.TWILIO_API_KEY_SID,env.TWILIO_API_KEY_SECRET,env.TWILIO_VERIFY_SERVICE_SID,env.BOOKING_VERIFICATION_PROVIDER]:name==='sms'?[env.TWILIO_ACCOUNT_SID,env.TWILIO_API_KEY_SID,env.TWILIO_API_KEY_SECRET,env.TWILIO_MESSAGING_SERVICE_SID,env.BOOKING_SMS_PROVIDER,env.TWILIO_SMS_SENDER_APPROVED]:name==='email'?[env.SENDGRID_API_KEY,env.SENDGRID_FROM_EMAIL,env.SENDGRID_SENDER_VERIFIED,env.BOOKING_EMAIL_PROVIDER]:name==='assistant'?[c.aiProvider||'gemini',(c.aiProvider||'gemini')==='openai'?env.OPENAI_API_KEY:env.GEMINI_API_KEY,(c.aiProvider||'gemini')==='openai'?env.OPENAI_MODEL:env.GEMINI_MODEL]:['database',store.db?.kind,env.DATABASE_URL||env.POSTGRES_URL||env.SUPABASE_DB_URL||'',env.SUPABASE_URL||env.NEXT_PUBLIC_SUPABASE_URL||'',env.SUPABASE_SERVICE_ROLE_KEY||'',env.BOB_PGLITE_DIR||'']);
  const enabled=(name,c)=>name==='database'||(name==='assistant'?c.aiAssistant!==false:c.integrations?.[name]!==false);
  const key=name=>`connection-observation:v1:${name}`;
  async function context(name){const c=await store.config();const rev=name==='jobber'?hash(['jobber',await jobber?.accountIdentityRevision?.()]):revision(name,c);return {enabled:enabled(name,c),revision:rev,provider:c.aiProvider||'gemini'};}
  async function record(name,operation,status,meaning,before){
    try{
      const now=await context(name);if(!now.enabled||before.revision!==now.revision)return;
      const prior=await store.kvGet(key(name));const at=clock();
      await store.kvSet(key(name),{revision:now.revision,status,operation,meaning,checkedAt:at,lastSuccessAt:status==='healthy'?at:prior?.revision===now.revision?prior.lastSuccessAt||null:null});
      if(status==='error'&&!(prior?.revision===now.revision&&prior.status==='error')){
        try{await onError?.({name,operation,at});}catch{}
      }
    }catch{} // Observability cannot undo a booking or successful provider request.
  }
  function observe(name,operation,fn,{meaning='response_received',valid=()=>true,provider}={}){
    return async(...args)=>{
      let before;try{before=await context(name);}catch{}
      try{
        const result=await fn(...args);
        if(before?.enabled&&(!provider||before.provider===provider))await record(name,operation,valid(result)?'healthy':'error',meaning,before);
        return result;
      }catch(error){
        if(before?.enabled&&(!provider||before.provider===provider)&&error?.code!=='INTEGRATION_DISABLED')await record(name,operation,'error',meaning,before);
        throw error;
      }
    };
  }
  async function snapshot(){
    const out={};
    for(const name of NAMES){
      try{
        const c=await context(name),saved=await store.kvGet(key(name));const current=saved?.revision===c.revision;
        const fresh=current&&Number.isFinite(saved.checkedAt)&&clock()>=saved.checkedAt&&clock()-saved.checkedAt<maxAgeMs;
        out[name]={status:!c.enabled?'off':fresh?saved.status:'unknown',checkedAt:current?saved.checkedAt:null,lastSuccessAt:current?saved.lastSuccessAt:null,operation:current?saved.operation:null,meaning:current?saved.meaning:null,stale:Boolean(current&&!fresh)};
      }catch{out[name]={status:'unknown',checkedAt:null,lastSuccessAt:null,operation:null,meaning:null,stale:false};}
    }
    return out;
  }
  async function refresh({integrationAccounts}={}){
    // Durable cross-instance cooldown; never unlock early. No provider calls if unavailable.
    let acquired=false;try{acquired=await store.lock('connection-refresh',30);}catch{return {checked:false,reason:'database_unavailable'};}
    if(!acquired)return {checked:false,reason:'cooldown'};
    const check=observe('database','select_one',()=>store.db.query('select 1 as ok'),{meaning:'read_check_succeeded',valid:r=>Array.isArray(r)&&r.length>0});
    try{await check();}catch{}
    // Account lookup is explicitly read-only. A denied name lookup must not mark
    // messaging operations unhealthy, since scoped sending keys may omit it.
    try { const before=await context('jobber');const names=await integrationAccounts?.refresh();if(before.enabled&&names?.jobber?.status==='verified')await record('jobber','account_read','healthy','read_check_succeeded',before);else if(before.enabled&&names?.jobber?.status==='unavailable'&&Number.isFinite(names.jobber.checkedAt))await record('jobber','account_read','error','read_check_failed',before); } catch {}
    return {checked:true};
  }
  return {observe,snapshot,refresh};
}

export function observeMessaging({health,twilio,sendgrid,assistant}){
  const twilioOut={...twilio,
    sendVerification:health.observe('verification','send_code',twilio.sendVerification.bind(twilio),{meaning:'code_request_accepted',valid:r=>r?.status==='pending'}),
    checkVerification:health.observe('verification','check_code',twilio.checkVerification.bind(twilio),{meaning:'verification_response_received',valid:r=>typeof r?.status==='string'}),
    sendSms:health.observe('sms','send_message',twilio.sendSms.bind(twilio),{meaning:'accepted_not_delivered',valid:r=>Boolean(r?.messageId)&&['accepted','queued','sending','sent','delivered'].includes(r?.status)})};
  const sendgridOut={...sendgrid,sendEmail:health.observe('email','send_email',sendgrid.sendEmail.bind(sendgrid),{meaning:'accepted_not_delivered',valid:r=>r?.status==='accepted'})};
  const adapt=provider=>{const a=assistant.forProvider(provider);return {...a,interpret:health.observe('assistant','interpret',a.interpret.bind(a),{provider,valid:r=>Boolean(r&&typeof r==='object')})};};
  const assistantOut={...assistant,...adapt('gemini'),providers:assistant.providers,forProvider:adapt};
  return {twilio:twilioOut,sendgrid:sendgridOut,assistant:assistantOut};
}

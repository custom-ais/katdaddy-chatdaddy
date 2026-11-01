import { randomBytes } from 'node:crypto';
import { normalizeClientHubUrl } from '../shared/client-hub.mjs';
export const CLIENT_HUB_EPOCH = 'client-hub:connection-epoch';
const KEY = 'client-hub:binding';
const invalid = () => Object.assign(new Error('Verify the connected Jobber account again before saving its Client Hub link.'), { status: 409 });

export function createClientHub({store,jobber,clock=Date.now}) {
  const epoch=async()=>await store.kvGet(CLIENT_HUB_EPOCH) || 'legacy';
  async function identity() {
    if ((await store.config()).integrations?.jobber === false || !await jobber.connected()) throw invalid();
    const before=await epoch();let account;
    try { account=await jobber.accountIdentity(); } catch { throw invalid(); }
    if (before!==await epoch() || account?.verified!==true || typeof account.id!=='string' || !account.id || typeof account.name!=='string' || !account.name.trim()) throw invalid();
    return {id:account.id,name:account.name.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160),epoch:before};
  }
  async function invalidate(reason='reconfirmation_required') {
    const binding=await store.kvGet(KEY);
    if(binding) await store.kvSet(KEY,{...binding,enabled:false,reason});
  }
  async function challenge() {
    const account=await identity();const token=randomBytes(24).toString('base64url');
    await store.kvSet(`client-hub:confirm:${token}`,{...account,expiresAt:clock()+600000},600);
    return {accountName:account.name,confirmationToken:token};
  }
  async function save({url,confirmAccount,confirmationToken}) {
    const normalized=normalizeClientHubUrl(url);
    if(!normalized) {await store.kvSet(KEY,{url:'',enabled:false,reason:'not_configured'});return;}
    if(confirmAccount!==true || typeof confirmationToken!=='string' || !/^[\w-]{32}$/.test(confirmationToken)) throw invalid();
    const key=`client-hub:confirm:${confirmationToken}`;const expected=await store.kvGet(key);
    if(!expected || expected.expiresAt<=clock())throw invalid();
    const account=await identity();
    if(account.id!==expected.id || account.epoch!==expected.epoch)throw invalid();
    await store.kvSet(KEY,{url:normalized,enabled:true,accountId:account.id,accountName:account.name,epoch:account.epoch,confirmedAt:clock(),reason:null});
    await store.kvDel(key);
  }
  async function snapshot() {
    try {
      let b=await store.kvGet(KEY);
      if(b?.enabled && b.epoch!==await epoch()){await invalidate('reconfirmation_required');b={...b,enabled:false,reason:'reconfirmation_required'};}
      return {url:b?.url||'',enabled:b?.enabled===true,accountName:b?.accountName||'',reason:b?.reason||null};
    }catch{return {url:'',enabled:false,accountName:'',reason:'unavailable'};}
  }
  async function current() {
    const b=await store.kvGet(KEY);if(!b?.enabled)return null;
    if(b.epoch!==await epoch()){await invalidate();return null;}
    let account;
    try { if(!await jobber.connected()){await invalidate('disconnected');return null;} } catch {return null;}
    try{account=await identity();}catch{return null;}
    if(account.id!==b.accountId || account.epoch!==b.epoch){await invalidate('account_changed');return null;}
    return {id:account.id,epoch:account.epoch,url:normalizeClientHubUrl(b.url)};
  }
  async function capture(){try{return await current();}catch{return null;}}
  async function resolve(appointment) {
    if(appointment?.status!=='confirmed' || !appointment.jobber?.accountId)return '';
    const account=await capture();
    return account && account.id===appointment.jobber.accountId && account.epoch===appointment.jobber.clientHubEpoch ? account.url : '';
  }
  return {challenge,save,snapshot,invalidate,capture,resolve};
}

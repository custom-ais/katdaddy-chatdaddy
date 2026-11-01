import {createHash} from 'node:crypto';
import {normalizePhone} from '../shared/domain.mjs';
/** Permanent per-appointment customer SMS claim. No retry after ambiguous acceptance.
 * Consent and selected channel remain mandatory. OTP/owner/emergency texts are separate.
 */
export async function deliverConfirmationSmsOnce({store,appointment,enabled,configured,sendSms,message,clock=Date.now}) {
  if(appointment?.status!=='confirmed')return {status:'skipped',reason:'not_confirmed'};
  const prior=appointment.notifications;
  if(['sent','accepted','failed','failed_or_uncertain','rejected','attempting'].includes(prior?.sms))return {status:'already_attempted',prior:{status:prior.sms==='sent'?'accepted':prior.sms,messageId:prior.smsMessageId||null,delivery:'not_confirmed'}};
  if(!enabled||!configured)return {status:'skipped',reason:'not_configured_or_disabled'};
  if(appointment.smsConsent!==true)return {status:'skipped',reason:'no_consent'};
  if(!appointment.phone)return {status:'skipped',reason:'missing_phone'};
  const phone=normalizePhone(appointment.phone);
  if(!phone||typeof appointment.id!=='string'||!appointment.id||typeof message!=='string'||!message.trim())return {status:'rejected',reason:'invalid_notification'};
  const key=`customer-confirmation-sms:${appointment.id}`;
  const record={status:'attempting',appointmentId:appointment.id,recipientHash:createHash('sha256').update(phone).digest('hex'),provider:'Twilio',at:clock(),delivery:'not_confirmed'};
  try {
    const rows=await store.db.query('insert into bob.kv(key,value,expires) values($1,$2::jsonb,null) on conflict (key) do nothing returning key',[key,JSON.stringify(record)]);
    if(!rows.length){let prior=null;try{prior=await store.kvGet(key);}catch{}return {status:'already_attempted',prior};}
  }catch{return {status:'failed_or_uncertain',reason:'claim_failed',delivery:'not_confirmed'};}
  let result;
  try {
    const response=await sendSms(phone,message);
    result=response?.messageId && ['accepted','queued','sending','sent','delivered'].includes(response.status)
      ? {...record,status:'accepted',messageId:response.messageId}
      : {...record,status:'failed_or_uncertain',reason:'invalid_provider_response'};
  }catch{result={...record,status:'failed_or_uncertain',reason:'provider_request_failed'};}
  try{await store.kvSet(key,result);}catch{}
  try{await store.log(`customer_sms.${result.status}`,{appointmentId:appointment.id,status:result.status,provider:'Twilio',delivery:'not_confirmed'},{level:result.status==='accepted'?'info':'warning'});}catch{}
  return result;
}

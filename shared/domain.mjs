import {SERVICE_CATALOG,effectiveFamily,lineForService,addOnLines} from './catalog.mjs';
export const TIME_ZONE = 'America/Phoenix';
export const BUNDLE_PRICE_CENTS = 24800;
export const DEFAULT_CONFIG = {
  version: 1,
  businessName: 'Dryer Vent Squad West Valley',
  phone: '', email: '',
  bookingEnabled: false,
  scheduleAcknowledged: false,
  pricesAcknowledged: false,
  // 'Jobber' = open times come from the live Jobber calendar and bookings become
  // scheduled Jobber jobs. 'BOB' = the original standalone schedule.
  scheduleSource: 'Jobber',
  // Geo rules. The truck's starting point, the farthest drive BOB will book,
  // and the most driving allowed between two jobs on the same day.
  baseAddress: '',
  maxDriveFromBaseMin: 60,
  maxDriveBetweenJobsMin: 20,
  // Travel fee by drive time from base: [{upToMin:45,feeCents:2500}, ...].
  // Empty = no travel fee. BOB never invents one.
  travelFeeTiers: [],
  // Route clustering: offer times next to jobs already booked nearby first.
  nearbyFirst: true,
  // LeadConnector confirmations.
  smsConfirmations: true,
  emailConfirmations: true,
  // Service catalog (packages, home versions, add-ons). Edited in admin → Services & prices.
  services: SERVICE_CATALOG,
  // Emergency Same-Day Clog Relief can be booked with less notice than regular visits.
  emergencyLeadHours: 2,
  // Rulebook (Oct 20): a LeadConnector text code proves the customer controls the phone
  // before an appointment is created.
  requirePhoneVerification: true,
  // Services that need a named approver's yes (sent through LeadConnector) before booking.
  approvalServices: ['emergency'],
  approver: { name: '', phone: '', email: '' },
  // Smart chat: Gemini reads free-typed messages. Off = button-and-keyword chat only.
  aiAssistant: true,
  // From the scheduling workbook (dvs_sched_sql_truth_pkg). Rank open times by route fit.
  routeScoring: true,
  // Same-day regular visits: only before the cutoff hour, with notice, next to a booked job.
  sameDay: { enabled: false, cutoffHour: 15, minNoticeHours: 2, requireNearby: true },
  // 5 PM overflow: never a normal slot. Short, nearby, high enough ticket, and approved.
  overflow: { enabled: false, start: '17:00', maxDurationMins: 90, minTicketCents: 22000, requireNearby: true },
  // Daily revenue target per technician, shown on the dashboard only.
  dailyRevenueTargetCents: 75000,
  cleaningPriceCents: 18900,
  assessmentPriceCents: 11900,
  bundlePriceCents: BUNDLE_PRICE_CENTS,
  cleaningMinutes: 90, assessmentMinutes: 60, bundleMinutes: 150,
  bufferMinutes: 30, maxJobsPerDay: 4, leadHours: 12, horizonDays: 45,
  weekdayStarts: ['09:00','11:00','13:00','15:00'], weekdayClose: '17:00',
  saturdayStarts: ['10:00','12:00'], saturdayClose: '14:00',
  blockedDates: [],
  serviceZips: [],
  activeTechnicianIds: ['tech-ryan'],
  preparation: 'Please make the laundry area accessible and secure pets before the visit. Do not move or disconnect the dryer yourself. Let the team know about access restrictions.',
  cleaningProcess: 'Every See-It-Clean visit is a full vent cleaning with a live camera inspection during service, and we verify airflow before and after so you can see the difference.',
  assessmentProcess: 'We evaluate the vent issue, document our findings, and explain the recommended repair options so the work can be quoted appropriately.',
  // Rules manual: the $119 assessment is credited 100% toward the repair when the customer hires DVS for it.
  assessmentCredited: true,
};
export const INITIAL_TECHNICIANS = [
  {id:'tech-ryan',name:'Ryan Boucher',phone:'',status:'available',color:'#f97316',zone:'West Valley',jobberUserId:''},
  {id:'tech-andrew',name:'Andrew Sulanke',phone:'',status:'off_duty',color:'#3b82f6',zone:'West Valley',jobberUserId:''},
];
export { INITIAL_FAQS } from './faqs.mjs';
export const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:cents%100?2:0}).format(cents/100);
export const phoenixDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export const phoenixInput = iso => new Date(new Date(iso).getTime()-7*3600000).toISOString().slice(0,16);
export const dateTime = (date,time) => new Date(`${date}T${time}:00-07:00`);
export const formatSlot = iso => new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(iso));
export const windowLabel = iso => {
 const t = new Date(iso).getTime();
 const f = d => new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,hour:'numeric',minute:'2-digit'}).format(d);
 const day = new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,weekday:'long',month:'short',day:'numeric',year:'numeric'}).format(new Date(t));
 return `${day} · ${f(new Date(t-1800000))}–${f(new Date(t+1800000))} arrival · Arizona time`;
};
/**
 * What a visit costs and how long it takes.
 * ctx: { package, property, addOns } — package picks the cleaning tier; property picks the
 * 1-story / 2-story / upstairs version and the gas safety fee; addOns are optional extras.
 */
export function serviceQuote(route,config=DEFAULT_CONFIG,ctx={}) {
 const services=config.services||SERVICE_CATALOG,property=ctx.property||{};
 let base,family;
 if(route==='assessment'){family='assessment';base={id:'assessment',name:'Dryer-vent assessment',description:'Evaluation of the vent issue with documented findings. Repairs are quoted separately.',cents:config.assessmentPriceCents,mins:config.assessmentMinutes,certain:true};}
 else if(route==='bundle'){family='bundle';base={id:'bundle',name:'Cleaning + assessment',description:'Essential See-It-Clean plus an assessment at 50% off. Repairs and parts are quoted separately.',cents:BUNDLE_PRICE_CENTS,mins:config.bundleMinutes,certain:true};}
 else if(route==='cleaning'){family=effectiveFamily(ctx.package||'essential',property);base=lineForService(services,family,property);}
 else throw new Error('Choose cleaning, assessment, or cleaning + assessment.');
 if(!base)throw new Error('That service is not available right now.');
 const lines=[base,...addOnLines(services,{family,route,property,addOns:ctx.addOns||{}})];
 return {route,package:family,serviceId:base.id,name:base.name,priceCents:lines.reduce((n,l)=>n+l.cents,0),durationMins:lines.reduce((n,l)=>n+l.mins,0),
  lineItems:lines.map(({id,name,description,cents,mins})=>({id,name,description,cents,mins})),
  priceNote:base.certain?'':'Priced for a 2-story home with first-floor laundry. Your technician lowers it on site if your home is smaller.',
  version:config.version,repairsIncluded:false};
}
/** Travel fee in cents for a drive time from base. null = beyond the last tier (out of area). */
export function travelFeeFor(driveFromBaseMin,config=DEFAULT_CONFIG) {
 const tiers=[...(config.travelFeeTiers||[])].sort((a,b)=>a.upToMin-b.upToMin);
 if(driveFromBaseMin==null||!tiers.length)return 0;
 const tier=tiers.find(t=>driveFromBaseMin<=t.upToMin);
 return tier?tier.feeCents:null;
}
/** Service quote plus the travel fee for this address. This is what a hold locks in. */
export function bookingQuote(route,config=DEFAULT_CONFIG,ctx={}) {
 const q=serviceQuote(route,config,ctx),fee=Math.max(0,Math.round(ctx.travelFeeCents||0));
 const lineItems=fee?[...q.lineItems,{id:'travel-fee',name:'Travel fee',description:'Based on drive time to your address.',cents:fee,mins:0}]:q.lineItems;
 return {...q,lineItems,travelFeeCents:fee,totalCents:q.priceCents+fee};
}
// Saved settings win, but catalog items added in a later release (like new add-ons) are filled in.
export const withConfigDefaults = saved => {
 const c={...DEFAULT_CONFIG,...(saved||{})};
 if(Array.isArray(saved?.services)){const ids=new Set(saved.services.map(x=>x.id));c.services=[...saved.services,...SERVICE_CATALOG.filter(x=>!ids.has(x.id))];}
 return c;
};
export function isBookable(config) {
 return !!(config.bookingEnabled && config.scheduleAcknowledged && config.pricesAcknowledged && config.serviceZips.length && config.activeTechnicianIds.length);
}
export function normalizePhone(value) {
 const digits=String(value||'').replace(/\D/g,'');
 return /^1?\d{10}$/.test(digits) ? `+1${digits.slice(-10)}` : null;
}
export function validateContact(data,{address=true}={}) {
 const errors=[];
 if(typeof data.name!=='string'||data.name.trim().length<2||data.name.length>100)errors.push('Enter your full name.');
 if(!normalizePhone(data.phone))errors.push('Enter a valid 10-digit callback number.');
 if(data.email && (typeof data.email!=='string'||data.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)))errors.push('Enter a valid email or leave it blank.');
 if(address){
  if(typeof data.address!=='string'||!/^\d+\s+\S/.test(data.address.trim())||data.address.length>250)errors.push('Enter the service street address, including unit if applicable.');
  if(typeof data.city!=='string'||data.city.trim().length<2||data.city.length>100)errors.push('Enter the service city.');
  if(!/^\d{5}$/.test(data.zip||''))errors.push('Enter a five-digit service ZIP code.');
 }
 if(typeof data.notes==='string'&&data.notes.length>4000)errors.push('Please shorten the notes to 4,000 characters.');
 return errors;
}
export function validateConfig(c) {
 const errors=[];
 for(const [key,min,max] of [['cleaningPriceCents',0,1000000],['assessmentPriceCents',0,1000000],['cleaningMinutes',30,480],['assessmentMinutes',30,480],['bundleMinutes',30,600],['bufferMinutes',0,180],['maxJobsPerDay',1,30],['leadHours',0,168],['horizonDays',1,180]]) {
  if(!Number.isInteger(c[key])||c[key]<min||c[key]>max)errors.push(`Invalid ${key}.`);
 }
 if(c.bundlePriceCents!==BUNDLE_PRICE_CENTS)errors.push('The approved cleaning + assessment total is $248.');
 if(c.bundleMinutes<Math.max(c.cleaningMinutes,c.assessmentMinutes))errors.push('The combined visit cannot be shorter than either service.');
 for(const key of ['weekdayStarts','saturdayStarts'])if(!Array.isArray(c[key])||c[key].length>12||c[key].some(t=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))errors.push(`Invalid ${key}.`);
 for(const key of ['weekdayClose','saturdayClose'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(c[key]||''))errors.push(`Invalid ${key}.`);
 if(!Array.isArray(c.serviceZips)||c.serviceZips.length>1000||c.serviceZips.some(z=>!/^\d{5}$/.test(z)))errors.push('Coverage must contain five-digit ZIP codes.');
 if(!Array.isArray(c.blockedDates)||c.blockedDates.length>1000||c.blockedDates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d))))errors.push('Invalid blocked dates.');
 if(!Array.isArray(c.activeTechnicianIds)||!c.activeTechnicianIds.every(id=>typeof id==='string'&&id.length<80))errors.push('Invalid technician selection.');
 for(const k of ['bookingEnabled','scheduleAcknowledged','pricesAcknowledged','nearbyFirst','smsConfirmations','emailConfirmations'])if(typeof c[k]!=='boolean')errors.push(`Invalid ${k}.`);
 if(!['Jobber','BOB'].includes(c.scheduleSource))errors.push('Choose Jobber or BOB as the schedule source.');
 if(!Number.isInteger(c.emergencyLeadHours)||c.emergencyLeadHours<0||c.emergencyLeadHours>48)errors.push('Emergency notice must be 0–48 hours.');
 if(!Array.isArray(c.services)||!c.services.length||c.services.length>80||c.services.some(x=>!x||typeof x.id!=='string'||typeof x.family!=='string'||typeof x.variant!=='string'||typeof x.name!=='string'||!x.name.trim()||x.name.length>150||typeof x.description!=='string'||x.description.length>800||!Number.isInteger(x.priceCents)||x.priceCents<0||x.priceCents>1000000||!Number.isInteger(x.minutes)||x.minutes<0||x.minutes>600||typeof x.active!=='boolean'))errors.push('Each service needs a name, price, and duration.');
 if(typeof c.baseAddress!=='string'||c.baseAddress.length>300)errors.push('Invalid base address.');
 if(!Number.isInteger(c.maxDriveFromBaseMin)||c.maxDriveFromBaseMin<5||c.maxDriveFromBaseMin>240)errors.push('Max drive from base must be 5–240 minutes.');
 if(!Number.isInteger(c.maxDriveBetweenJobsMin)||c.maxDriveBetweenJobsMin<5||c.maxDriveBetweenJobsMin>120)errors.push('Max drive between jobs must be 5–120 minutes.');
 if(!Array.isArray(c.travelFeeTiers)||c.travelFeeTiers.length>10||c.travelFeeTiers.some(t=>!t||!Number.isInteger(t.upToMin)||t.upToMin<1||t.upToMin>240||!Number.isInteger(t.feeCents)||t.feeCents<0||t.feeCents>100000))errors.push('Each travel fee tier needs a drive time (minutes) and a fee.');
 for(const k of ['businessName','phone','email','preparation','cleaningProcess','assessmentProcess'])if(typeof c[k]!=='string'||c[k].length>3000)errors.push(`Invalid ${k}.`);
 if(c.phone && !normalizePhone(c.phone)) errors.push('Enter a valid office phone number or leave it blank.');
 for(const k of ['requirePhoneVerification','aiAssistant','routeScoring'])if(typeof c[k]!=='boolean')errors.push(`Invalid ${k}.`);
 const families=new Set((c.services||[]).map(x=>x.family));
 if(!Array.isArray(c.approvalServices)||c.approvalServices.some(f=>typeof f!=='string'||!families.has(f)))errors.push('Choose approval services from the service list.');
 const a=c.approver||{};
 if(typeof a.name!=='string'||a.name.length>100||typeof a.phone!=='string'||(a.phone&&!normalizePhone(a.phone))||typeof a.email!=='string'||(a.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)))errors.push('Enter the approver\'s name, a valid phone, and a valid email (or leave blank).');
 const sd=c.sameDay||{};
 if(typeof sd.enabled!=='boolean'||!Number.isInteger(sd.cutoffHour)||sd.cutoffHour<6||sd.cutoffHour>20||!Number.isInteger(sd.minNoticeHours)||sd.minNoticeHours<0||sd.minNoticeHours>12||typeof sd.requireNearby!=='boolean')errors.push('Check the same-day settings.');
 const ov=c.overflow||{};
 if(typeof ov.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(ov.start||'')||!Number.isInteger(ov.maxDurationMins)||ov.maxDurationMins<15||ov.maxDurationMins>240||!Number.isInteger(ov.minTicketCents)||ov.minTicketCents<0||ov.minTicketCents>1000000||typeof ov.requireNearby!=='boolean')errors.push('Check the 5 PM overflow settings.');
 if(!Number.isInteger(c.dailyRevenueTargetCents)||c.dailyRevenueTargetCents<0||c.dailyRevenueTargetCents>10000000)errors.push('Invalid daily revenue target.');
 if(c.bookingEnabled&&(!c.scheduleAcknowledged||!c.pricesAcknowledged||!c.serviceZips?.length||!c.activeTechnicianIds?.length))errors.push('Review prices, acknowledge BOB as the scheduling source, select a technician, and enter approved service ZIP codes before enabling bookings.');
 return errors;
}

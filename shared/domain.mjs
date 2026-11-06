import { DEFAULT_MESSAGE_TEMPLATES, validateMessageTemplates } from './message-templates.mjs';
import {SERVICE_CATALOG,RETIRED_FAMILIES,effectiveFamily,lineForService,addOnLines,RECENT_SERVICE_DISCOUNT,RECENT_SERVICE_DISCOUNT_CENTS,DEFAULT_UPSELLS,bundleSavings} from './catalog.mjs';
import {difficultyMinutes} from './airflow.mjs';
import {COVERAGE_VERSION,COVERAGE_IN,COVERAGE_TRAVEL,validPoint,customCoverage} from './coverage.mjs';
// Cleaning packages get extra time when the answers point to a restricted or severe vent.
const DIFFICULTY_FAMILIES=new Set(['premium','ultimate','express','postservice']);
export const TIME_ZONE = 'America/Phoenix';
// Legacy fixed combined price (before Oct 30 2026), kept only for old saved configs and API shape.
export const BUNDLE_PRICE_CENTS = 24800;
// Cleaning + Assessment: the Premium 1-2-3 cleaning for the home plus a fixed assessment add-on.
// $179 + $60 = $239 for a 1-story home; 2-story homes follow their cleaning price ($259 / $279).
export const BUNDLE_ASSESSMENT_CENTS = 6000;
// Nov 2 2026: the office's assessment description (camera, airflow, photos, itemized estimate).
export const ASSESSMENT_PROCESS_VERSION = 2;
export const bundleAssessmentCents = (config) => (Number.isInteger(config?.bundleAssessmentCents) ? config.bundleAssessmentCents : BUNDLE_ASSESSMENT_CENTS);
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
  baseLocation: null,
  customServiceAreas: [],
  serviceAreaMode: 'zip', // Existing coverage remains active until distance settings are saved.
  serviceAreaMiles: 25,
  travelAreaMiles: 45,
  maxDriveFromBaseMin: 60,
  maxDriveBetweenJobsMin: 20,
  // Travel fee by drive time from base: [{upToMin:45,feeCents:2500}, ...].
  // Empty = no travel fee. BOB never invents one.
  travelFeeTiers: [],
  // Route clustering: offer times next to jobs already booked nearby first.
  nearbyFirst: true,
  // LeadConnector confirmations.
  messageTemplates: { ...DEFAULT_MESSAGE_TEMPLATES },
  messageEmailFormat: 'plain',
  smsConfirmations: true,
  emailConfirmations: true,
  // Optional internal owner alerts, separate from customer consent and approvals.
  bookingOwnerSmsEnabled: false,
  ownerErrorSmsEnabled: false,
  bookingOwnerSmsPhone: '',
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
  // Smart chat: the selected provider reads free-typed messages. Off = button-and-keyword chat only.
  aiAssistant: true,
  aiProvider: 'gemini',
  // Operational switches never replace credential/readiness checks. Database remains mandatory.
  integrations: { jobber: true, maps: true, verification: true, sms: true, email: true },
  // From the scheduling workbook (dvs_sched_sql_truth_pkg). Rank open times by route fit.
  routeScoring: true,
  // Same-day regular visits: only before the cutoff hour, with notice, next to a booked job.
  sameDay: { enabled: false, cutoffHour: 15, minNoticeHours: 2, requireNearby: true },
  // 5 PM overflow: never a normal slot. Short, nearby, high enough ticket, and approved.
  overflow: { enabled: false, start: '17:00', maxDurationMins: 90, minTicketCents: 22000, requireNearby: true },
  // Daily revenue target per technician, shown on the dashboard only.
  dailyRevenueTargetCents: 75000,
  // Revenue pacing: a company-wide minimum per month (÷ 4 = per week, ÷ 5 = per weekday) or per week.
  // While a week is under it, BOB offers that week's openings first (still within the drive limits);
  // once it's met, the week's remaining openings go to jobs that fit the route and farther customers
  // see the next week first. outsideJobCents values jobs booked outside BOB (0 = BOB's average ticket).
  revenuePacing: { enabled: false, period: 'month', targetCents: 0, outsideJobCents: 0 },
  // The optional add-ons offered on the review screen (Settings → Upsells at checkout).
  upsells: { ...DEFAULT_UPSELLS },
  cleaningPriceCents: 17900,
  assessmentPriceCents: 11900,
  bundlePriceCents: BUNDLE_PRICE_CENTS,
  bundleAssessmentCents: BUNDLE_ASSESSMENT_CENTS,
  cleaningMinutes: 90, assessmentMinutes: 60, bundleMinutes: 150,
  bufferMinutes: 30, maxJobsPerDay: 4, leadHours: 12, horizonDays: 45,
  // Calendar items BOB didn't book (BidBee, the office) block at least this long, even when Jobber
  // shows a shorter or default length. 0 = use Jobber's times exactly.
  minVisitMinutes: 90,
  weekdayStarts: ['09:00','11:00','13:00','15:00'], weekdayClose: '17:00',
  saturdayStarts: ['10:00','12:00'], saturdayClose: '14:00',
  blockedDates: [],
  serviceZips: [],
  // Just outside the service area (the 852 ZIPs on the office's coverage list): BOB says so,
  // mentions the travel charge, and lets the customer continue or find someone more local.
  // Every other ZIP outside serviceZips is told politely that DVS doesn't service the area.
  travelZips: COVERAGE_TRAVEL,
  coverageVersion: COVERAGE_VERSION,
  travelZoneFeeCents: 0,
  activeTechnicianIds: ['tech-ryan'],
  // Jobber users added to every visit BOB books, next to the technician doing it, so the visit shows
  // on their own Jobber schedule too (the owner or office). Their calendars aren't used to find times.
  alsoAssignJobberUserIds: [],
  preparation: 'Please make the laundry area accessible and secure pets before the visit. Do not move or disconnect the dryer yourself. Let the team know about access restrictions.',
  cleaningProcess: 'Every See-It-Clean visit is a full vent cleaning with a live camera inspection during service.',
  assessmentProcess: "We'll start by asking what you've noticed, then inspect the vent from the connection behind your dryer to the outlet on your wall or roof.\n\nYour technician will use a camera to look inside the duct and measure airflow at both ends. That helps us pinpoint problems like a blockage, a crushed section, or a loose connection. We'll show you photos of what we find, explain what needs attention, and give you an itemized estimate so you can review your options before approving any work.\n\nAssessments start at $119. If you choose us for the repair, we'll apply the full assessment fee toward it.",
  // Bumped when the office supplies new default wording; older saved settings switch to it once.
  assessmentProcessVersion: ASSESSMENT_PROCESS_VERSION,
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
 const a = f(new Date(t-1800000)), b = f(new Date(t+1800000)), [ta, pa] = a.split(/\s+/), [, pb] = b.split(/\s+/);
 return `${day} · ${f(new Date(t))} (arrival window ${pa && pa === pb ? ta : a}–${b}) · Arizona time`;
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
 else if(route==='bundle'){family=effectiveFamily(ctx.package||'premium',property);base=lineForService(services,family,property);}
 else if(route==='cleaning'){family=effectiveFamily(ctx.package||'essential',property);base=lineForService(services,family,property);}
 else throw new Error('Choose cleaning, assessment, or cleaning + assessment.');
 if(!base)throw new Error('That service is not available right now.');
 const lines=[base,...addOnLines(services,{family,route:route==='bundle'?'cleaning':route,property,addOns:ctx.addOns||{},bundleSavingsCents:bundleSavings(config)})];
 if(property.recentService==='Yes'&&RECENT_SERVICE_DISCOUNT_CENTS>0)lines.push({...RECENT_SERVICE_DISCOUNT,cents:-RECENT_SERVICE_DISCOUNT_CENTS,mins:0,certain:true});
 if(route==='bundle')lines.push({id:'assessment-with-cleaning',name:'Repair Assessment (with cleaning)',description:'Evaluation of the vent issue during the cleaning visit, with documented findings. Repairs are quoted separately.',cents:bundleAssessmentCents(config),mins:config.assessmentMinutes,certain:true});
 // With no dryer, Premium's usual time for cleaning the dryer covers the extra vent work, so no difficulty time is added.
 const noDryerPremium=property.hasDryer==='No'&&family==='premium';
 const difficultyMins=(route==='cleaning'||route==='bundle')&&DIFFICULTY_FAMILIES.has(family)&&!noDryerPremium?difficultyMinutes(property):0;
 return {route,package:family,serviceId:base.id,name:route==='bundle'?`${base.name} + Assessment`:base.name,priceCents:lines.reduce((n,l)=>n+l.cents,0),durationMins:lines.reduce((n,l)=>n+l.mins,0)+difficultyMins,difficultyMins,
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
 const templates=saved?.messageTemplates;
 c.messageTemplates=templates===undefined?{...DEFAULT_MESSAGE_TEMPLATES}:templates&&typeof templates==='object'&&!Array.isArray(templates)?{...DEFAULT_MESSAGE_TEMPLATES,...templates}:templates;
 const pacing=saved?.revenuePacing;
 if(pacing&&typeof pacing==='object'&&!Array.isArray(pacing))c.revenuePacing={...DEFAULT_CONFIG.revenuePacing,...pacing};
 const upsells=saved?.upsells;
 c.upsells=upsells&&typeof upsells==='object'&&!Array.isArray(upsells)?{...DEFAULT_CONFIG.upsells,...upsells}:{...DEFAULT_CONFIG.upsells};
 const gates=saved?.integrations;
 c.integrations=gates===undefined?{...DEFAULT_CONFIG.integrations}:gates&&typeof gates==='object'&&!Array.isArray(gates)?{...DEFAULT_CONFIG.integrations,...gates}:gates;
 // Settings saved before the office's coverage list switch to it once; later edits in Settings stand.
 // The office's Nov 2 2026 assessment description replaces older saved wording once; later edits stand.
 if((saved?.assessmentProcessVersion||0)<ASSESSMENT_PROCESS_VERSION){c.assessmentProcess=DEFAULT_CONFIG.assessmentProcess;c.assessmentProcessVersion=ASSESSMENT_PROCESS_VERSION;}
 if((saved?.coverageVersion||0)<COVERAGE_VERSION){c.serviceZips=[...COVERAGE_IN];c.travelZips=[...COVERAGE_TRAVEL];c.coverageVersion=COVERAGE_VERSION;}
 if(Array.isArray(saved?.services)){const ids=new Set(saved.services.map(x=>x.id));c.services=[...saved.services.map(x=>RETIRED_FAMILIES.has(x.family)?{...x,active:false}:x),...SERVICE_CATALOG.filter(x=>!ids.has(x.id))];}
 return c;
};
/** "Text confirmations" is the switch for every text to customers: with it off, the phone code isn't sent either. */
export const textCodeOn=(config)=>Boolean(config.requirePhoneVerification)&&config.smsConfirmations!==false;
/** Where a ZIP stands: in the service area, just outside it (travel charge), or not served. */
export function areaFor(zip,config=DEFAULT_CONFIG,state='',drivingMiles=null,point=null) {
 if(['driving_distance','radius'].includes(config.serviceAreaMode))return drivingAreaFor(drivingMiles,config,state,point);
 if(state&&String(state).toUpperCase()!=='AZ')return 'out';
 if((config.serviceZips||[]).includes(zip))return 'in';
 if((config.travelZips||[]).includes(zip))return 'travel';
 return 'out';
}
export function drivingAreaFor(miles,config=DEFAULT_CONFIG,state='',point=null) {
 if(state&&String(state).toUpperCase()!=='AZ')return 'out';
 const customized=customCoverage(point,config.customServiceAreas);
 if(customized)return customized;
 if(typeof miles!=='number'||!Number.isFinite(miles)||miles<0)return 'unknown';
 if(miles<=config.serviceAreaMiles)return 'in';
 return miles<=config.travelAreaMiles?'travel':'out';
}
export function isBookable(config) {
 const coverage=['driving_distance','radius'].includes(config.serviceAreaMode)?Boolean((config.baseAddress?.trim()||validPoint(config.baseLocation))&&config.serviceAreaMiles>0&&config.travelAreaMiles>=config.serviceAreaMiles):config.serviceZips.length;
 return !!(config.bookingEnabled && config.scheduleAcknowledged && config.pricesAcknowledged && coverage && config.activeTechnicianIds.length);
}
export function normalizePhone(value) {
 const raw=String(value||'').trim();
 if(!/^\+?[\d\s().-]+$/.test(raw))return null;
 const digits=raw.replace(/\D/g,'');
 if(raw.startsWith('+')&&!/^1\d{10}$/.test(digits))return null;
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
 const errors=[...validateMessageTemplates(c.messageTemplates)];
 if (!['plain','html'].includes(c.messageEmailFormat)) errors.push('Choose plain text or HTML for confirmation emails.');
 if(!['gemini','openai'].includes(c.aiProvider))errors.push('Choose Gemini or OpenAI as the AI provider.');
 if(!c.integrations||typeof c.integrations!=='object'||Array.isArray(c.integrations)||Object.keys(c.integrations).some(k=>!['jobber','maps','verification','sms','email'].includes(k)))errors.push('Invalid integration switches.');
 for(const k of ['jobber','maps','verification','sms','email'])if(typeof c.integrations?.[k]!=='boolean')errors.push(`Invalid integration switch: ${k}.`);
 for(const [key,min,max] of [['cleaningPriceCents',0,1000000],['assessmentPriceCents',0,1000000],['bundleAssessmentCents',0,1000000],['cleaningMinutes',30,480],['assessmentMinutes',30,480],['bundleMinutes',30,600],['bufferMinutes',0,180],['minVisitMinutes',0,480],['maxJobsPerDay',1,30],['leadHours',0,168],['horizonDays',1,180]]) {
  if(!Number.isInteger(c[key])||c[key]<min||c[key]>max)errors.push(`Invalid ${key}.`);
 }
 for(const key of ['weekdayStarts','saturdayStarts'])if(!Array.isArray(c[key])||c[key].length>12||c[key].some(t=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))errors.push(`Invalid ${key}.`);
 for(const key of ['weekdayClose','saturdayClose'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(c[key]||''))errors.push(`Invalid ${key}.`);
 if(!Array.isArray(c.serviceZips)||c.serviceZips.length>1000||c.serviceZips.some(z=>!/^\d{5}$/.test(z)))errors.push('Coverage must contain five-digit ZIP codes.');
 if(!Array.isArray(c.travelZips)||c.travelZips.length>1000||c.travelZips.some(z=>!/^\d{5}$/.test(z)))errors.push('Just-outside ZIPs must be five-digit ZIP codes.');
 if(c.coverageVersion!=null&&!Number.isInteger(c.coverageVersion))errors.push('Invalid coverageVersion.');
 if(c.assessmentProcessVersion!=null&&!Number.isInteger(c.assessmentProcessVersion))errors.push('Invalid assessmentProcessVersion.');
 if(!Number.isInteger(c.travelZoneFeeCents)||c.travelZoneFeeCents<0||c.travelZoneFeeCents>50000)errors.push('The just-outside travel charge must be $0–$500.');
 if(!Array.isArray(c.blockedDates)||c.blockedDates.length>1000||c.blockedDates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d))))errors.push('Invalid blocked dates.');
 if(c.alsoAssignJobberUserIds!==undefined&&(!Array.isArray(c.alsoAssignJobberUserIds)||c.alsoAssignJobberUserIds.length>10||!c.alsoAssignJobberUserIds.every(id=>typeof id==='string'&&/^[A-Za-z0-9+/=_-]{1,200}$/.test(id))||new Set(c.alsoAssignJobberUserIds).size!==c.alsoAssignJobberUserIds.length))errors.push('Choose up to 10 Jobber team members to add to every BOB visit.');
 if(!Array.isArray(c.activeTechnicianIds)||!c.activeTechnicianIds.every(id=>typeof id==='string'&&id.length<80))errors.push('Invalid technician selection.');
 for(const k of ['bookingEnabled','scheduleAcknowledged','pricesAcknowledged','nearbyFirst','smsConfirmations','emailConfirmations','bookingOwnerSmsEnabled','ownerErrorSmsEnabled'])if(typeof c[k]!=='boolean')errors.push(`Invalid ${k}.`);
 if(!['Jobber','BOB'].includes(c.scheduleSource))errors.push('Choose Jobber or BOB as the schedule source.');
 if(!Number.isInteger(c.emergencyLeadHours)||c.emergencyLeadHours<0||c.emergencyLeadHours>48)errors.push('Emergency notice must be 0–48 hours.');
 if(!Array.isArray(c.services)||!c.services.length||c.services.length>80||c.services.some(x=>!x||typeof x.id!=='string'||typeof x.family!=='string'||typeof x.variant!=='string'||typeof x.name!=='string'||!x.name.trim()||x.name.length>150||typeof x.description!=='string'||x.description.length>800||!Number.isInteger(x.priceCents)||x.priceCents<0||x.priceCents>1000000||!Number.isInteger(x.minutes)||x.minutes<0||x.minutes>600||typeof x.active!=='boolean'))errors.push('Each service needs a name, price, and duration.');
 if(typeof c.baseAddress!=='string'||c.baseAddress.length>300)errors.push('Invalid base address.');
 if(!['zip','driving_distance','radius'].includes(c.serviceAreaMode))errors.push('Choose a service-area coverage method.');
 if(!Number.isFinite(c.serviceAreaMiles)||c.serviceAreaMiles<=0||c.serviceAreaMiles>150||!Number.isFinite(c.travelAreaMiles)||c.travelAreaMiles<c.serviceAreaMiles||c.travelAreaMiles>150)errors.push('Driving distance limits must be 1–150 miles, with the travel area at least as large as the standard area.');
 if(c.baseLocation!==null&&!validPoint(c.baseLocation))errors.push('Choose a valid base point on the map.');
 if(['driving_distance','radius'].includes(c.serviceAreaMode)&&!c.baseAddress.trim()&&!validPoint(c.baseLocation))errors.push('Enter the base address or choose the base point on the map.');
 if(!Array.isArray(c.customServiceAreas)||c.customServiceAreas.length>12||c.customServiceAreas.some(a=>!a||typeof a.id!=='string'||a.id.length>80||!['include','exclude'].includes(a.kind)||!Array.isArray(a.points)||a.points.length<3||a.points.length>60||a.points.some(p=>!validPoint(p))))errors.push('Draw valid included or excluded areas (3–60 points per shape, up to 12 shapes).');
 if(!Number.isInteger(c.maxDriveFromBaseMin)||c.maxDriveFromBaseMin<5||c.maxDriveFromBaseMin>240)errors.push('Max drive from base must be 5–240 minutes.');
 if(!Number.isInteger(c.maxDriveBetweenJobsMin)||c.maxDriveBetweenJobsMin<5||c.maxDriveBetweenJobsMin>120)errors.push('Max drive between jobs must be 5–120 minutes.');
 if(!Array.isArray(c.travelFeeTiers)||c.travelFeeTiers.length>10||c.travelFeeTiers.some(t=>!t||!Number.isInteger(t.upToMin)||t.upToMin<1||t.upToMin>240||!Number.isInteger(t.feeCents)||t.feeCents<0||t.feeCents>100000))errors.push('Each travel fee tier needs a drive time (minutes) and a fee.');
 for(const k of ['businessName','phone','email','preparation','cleaningProcess','assessmentProcess'])if(typeof c[k]!=='string'||c[k].length>3000)errors.push(`Invalid ${k}.`);
 if(typeof c.bookingOwnerSmsPhone!=='string'||c.bookingOwnerSmsPhone.length>30||(c.bookingOwnerSmsPhone&&!normalizePhone(c.bookingOwnerSmsPhone))||((c.bookingOwnerSmsEnabled||c.ownerErrorSmsEnabled)&&!normalizePhone(c.bookingOwnerSmsPhone)))errors.push('Enter a valid owner notification phone number before enabling owner alerts.');
 if(c.phone && !normalizePhone(c.phone)) errors.push('Enter a valid office phone number or leave it blank.');
 for(const k of ['requirePhoneVerification','aiAssistant','routeScoring'])if(typeof c[k]!=='boolean')errors.push(`Invalid ${k}.`);
 const families=new Set((c.services||[]).map(x=>x.family));
 if(!Array.isArray(c.approvalServices)||c.approvalServices.some(f=>typeof f!=='string'||!families.has(f)))errors.push('Choose approval services from the service list.');
 const a=c.approver||{};
 if(typeof a.name!=='string'||a.name.length>100||typeof a.phone!=='string'||(a.phone&&!normalizePhone(a.phone))||typeof a.email!=='string'||(a.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)))errors.push('Enter the approver\'s name, a valid phone, and a valid email (or leave blank).');
 const sd=c.sameDay||{};
 if(typeof sd.enabled!=='boolean'||typeof sd.requireNearby!=='boolean')errors.push('Check the same-day settings.');
 if(!Number.isInteger(sd.cutoffHour)||sd.cutoffHour<6||sd.cutoffHour>20)errors.push('Same-day "Book before" must be an hour from 6 to 20 on a 24-hour clock (12 = noon, 14 = 2 PM).');
 if(!Number.isInteger(sd.minNoticeHours)||sd.minNoticeHours<0||sd.minNoticeHours>12)errors.push('Same-day notice must be 0 to 12 hours.');
 const ov=c.overflow||{};
 if(typeof ov.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(ov.start||'')||!Number.isInteger(ov.maxDurationMins)||ov.maxDurationMins<15||ov.maxDurationMins>240||!Number.isInteger(ov.minTicketCents)||ov.minTicketCents<0||ov.minTicketCents>1000000||typeof ov.requireNearby!=='boolean')errors.push('Check the 5 PM overflow settings.');
 if(!Number.isInteger(c.dailyRevenueTargetCents)||c.dailyRevenueTargetCents<0||c.dailyRevenueTargetCents>10000000)errors.push('Invalid daily revenue target.');
 const rp=c.revenuePacing||{};
 if(typeof rp.enabled!=='boolean'||!['month','week'].includes(rp.period)||!Number.isInteger(rp.targetCents)||rp.targetCents<0||rp.targetCents>100000000||!Number.isInteger(rp.outsideJobCents)||rp.outsideJobCents<0||rp.outsideJobCents>10000000)errors.push('Check the revenue target: a whole-dollar amount per month or per week.');
 else if(rp.enabled&&rp.targetCents<=0)errors.push('Enter the revenue target amount, or turn revenue pacing off.');
 const up=c.upsells;
 if(up!==undefined){
  const bool=k=>typeof up?.[k]==='boolean',str=(k,max,required)=>typeof up?.[k]==='string'&&up[k].length<=max&&(!required||up[k].trim().length>0),cents=k=>Number.isInteger(up?.[k])&&up[k]>=0&&up[k]<=100000;
  if(!up||typeof up!=='object'||Array.isArray(up)||!['dryerflexEnabled','foggingEnabled','bundleEnabled','ultimateEnabled'].every(bool))errors.push('Check the upsell on/off switches.');
  else{
   if(!str('dryerflexTitle',80,true)||!str('foggingTitle',80,true))errors.push('Give each upsell a name (up to 80 characters).');
   if(!str('dryerflexBadge',40)||!str('dryerflexPoints',800)||!str('foggingDescription',400)||!str('ultimatePitch',400,true))errors.push('Shorten the upsell wording: badge up to 40 characters, DryerFlex points up to 800, fog description and Ultimate list up to 400 (the Ultimate list can\'t be empty).');
   if(!str('dryerflexLink',300)||(up.dryerflexLink&&!/^https:\/\/[^\s<>"']+$/.test(up.dryerflexLink)))errors.push('The DryerFlex "Learn more" link must start with https://, or be left blank.');
   if(!cents('dryerflexWasCents')||!cents('bundleSavingsCents'))errors.push('Upsell amounts must be between $0 and $1,000.');
  }
 }
 if(c.bookingEnabled&&!isBookable(c))errors.push('Review prices, acknowledge the schedule source, select a technician, and configure the service area before enabling bookings.');
 return errors;
}

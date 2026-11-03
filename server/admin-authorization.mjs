import { isDeepStrictEqual } from 'node:util';
import { CONFIG_FIELD_PERMISSIONS, PERMISSION_KEYS, hasPermission, isMaster } from '../shared/admin-permissions.mjs';

const forbidden = () => Object.assign(new Error('You do not have permission for this management action.'), {status:403,code:'PERMISSION_DENIED'});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const clone = value => value === undefined ? undefined : structuredClone(value);
const list = value => Array.isArray(value) ? value : [];
const own = (value,key) => Object.prototype.hasOwnProperty.call(value || {},key);
const hasAll = (principal,permissions) => permissions.every(key => hasPermission(principal,key));
const validPrincipal = principal => ['master','member','legacy'].includes(principal?.role);

// All requirements are all-of. No prefix permission grants future endpoints.
const routes = [
  ['GET', /^\/api\/admin\/(?:status|data)$/, []],
  ['POST', /^\/api\/admin\/logout$/, []],
  ['POST', /^\/api\/admin\/password$/, ['account.password']],
  ['GET', /^\/api\/admin\/owner-sms-consent$/, ['ownerSms.manage']],
  ['POST', /^\/api\/admin\/owner-sms-consent$/, ['ownerSms.manage']],
  ['POST', /^\/api\/admin\/booking-report\/test$/, ['integrations.manage']],
  ['GET', /^\/api\/admin\/maps-key$/, ['settings.coverage.view']],
  ['GET', /^\/api\/admin\/integration-accounts$/, ['settings.connections.view']],
  ['POST', /^\/api\/admin\/(?:integration-accounts|connections\/refresh)$/, ['integrations.manage']],
  ['GET', /^\/api\/admin\/jobber\/(?:connect|users)$/, ['integrations.manage']],
  ['POST', /^\/api\/admin\/jobber\/(?:disconnect|client-hub|client-hub\/identity)$/, ['integrations.manage']],
  ['GET', /^\/api\/admin\/activity$/, ['activity.view','finance.view']],
  ['POST', /^\/api\/admin\/service-area\/map$/, ['settings.coverage.view','settings.coverage.manage']],
  ['POST', /^\/api\/admin\/geo\/check$/, ['settings.coverage.view','settings.coverage.manage']],
  ['POST', /^\/api\/admin\/templates\/preview$/, ['settings.templates.view','settings.templates.manage','finance.view']],
  ['PATCH', /^\/api\/admin\/config$/, []], // Every supplied changed field is checked separately.
  ['POST', /^\/api\/admin\/faqs(?:\/reset)?$/, ['settings.answers.view','settings.answers.manage','finance.view']],
  ['POST', /^\/api\/admin\/technicians$/, ['settings.schedule.view','settings.schedule.manage']],
  ['PATCH', /^\/api\/admin\/requests\/[^/]+$/, ['inbox.view','inbox.manage']],
  ['POST', /^\/api\/admin\/approvals\/[^/]+$/, ['inbox.view','inbox.manage']],
  ['POST', /^\/api\/admin\/appointments$/, ['appointments.view','appointments.manage']],
  ['PATCH', /^\/api\/admin\/appointments\/[^/]+$/, ['appointments.view','appointments.manage']],
  ['POST', /^\/api\/admin\/appointments\/[^/]+\/resolve$/, ['appointments.view','appointments.manage']],
  ['POST', /^\/api\/admin\/appointments\/[^/]+\/confirmation$/, ['appointments.view','appointments.send']],
  ['GET', /^\/api\/admin\/export$/, ['exports.download']],
  ['GET', /^\/api\/admin\/users$/, ['users.manage']],
  ['POST', /^\/api\/admin\/users\/invite$/, ['users.manage']],
  ['PATCH', /^\/api\/admin\/users\/[^/]+$/, ['users.manage']],
  ['POST', /^\/api\/admin\/users\/[^/]+\/reset-invite$/, ['users.manage']],
  ['POST', /^\/api\/admin\/invitations\/[^/]+\/revoke$/, ['users.manage']],
];
export function requireAdminRoute(principal, method, path) {
  if (!validPrincipal(principal) || typeof path !== 'string') throw forbidden();
  // A shared-password session cannot identify the owner who records or withdraws consent.
  if (path === '/api/admin/owner-sms-consent' && !isMaster(principal)) throw forbidden();
  // The booking report goes to the ChatDaddy operator; only the Master Admin can send a test.
  if (path === '/api/admin/booking-report/test' && !isMaster(principal)) throw forbidden();
  const route = routes.find(([verb,pattern]) => verb === method && pattern.test(path));
  if (!route || !hasAll(principal,route[2])) throw forbidden();
  return true;
}

const nestedFields = new Set(Object.keys(CONFIG_FIELD_PERMISSIONS).filter(key => key.includes('.')).map(key => key.split('.')[0]));
const monetaryFields = new Set(['services','travelFeeTiers','travelZoneFeeCents','dailyRevenueTargetCents','cleaningPriceCents','assessmentPriceCents','bundleAssessmentCents','bundlePriceCents','overflow.minTicketCents']);
const textFields = new Set(['messageTemplates.confirmationSms','messageTemplates.confirmationEmailSubject','messageTemplates.confirmationEmailBody']);
const arraySchemas = {
  services:['id','family','variant','name','description','category','priceCents','minutes','active'],
  travelFeeTiers:['upToMin','feeCents'],
  customServiceAreas:['id','kind','points'],
};
function validateArrayKeys(path,value) {
  if (!Array.isArray(value)) throw forbidden();
  const schema = arraySchemas[path];
  if (!schema) {
    if (value.some(item => typeof item !== 'string')) throw forbidden();
    return;
  }
  for (const row of value) {
    if (!object(row) || Object.keys(row).some(key => !schema.includes(key))) throw forbidden();
    if (path === 'customServiceAreas') {
      if (!Array.isArray(row.points) || row.points.some(point => !object(point) || Object.keys(point).some(key => !['lat','lng'].includes(key)))) throw forbidden();
    } else if (Object.values(row).some(item => item !== null && typeof item === 'object')) throw forbidden();
  }
}
const arrayFields = new Set(['services','travelFeeTiers','customServiceAreas','serviceZips','travelZips','approvalServices','weekdayStarts','saturdayStarts','blockedDates','activeTechnicianIds']);
function canChange(principal,path) {
  const permission = CONFIG_FIELD_PERMISSIONS[path];
  if (!permission || !hasPermission(principal,permission)) return false;
  if (principal.role === 'legacy') return true;
  if (permission.startsWith('settings.') && !hasPermission(principal,permission.replace(/\.manage$/,'.view'))) return false;
  return !(monetaryFields.has(path) || textFields.has(path)) || hasPermission(principal,'finance.view');
}
/** Named users submit sparse authorized fields, even for no-op values. Legacy retains its old comparison semantics. */
export function assertConfigPatch(principal, body, old = {}) {
  if (!validPrincipal(principal) || !object(body)) throw forbidden();
  const named = principal.role !== 'legacy';
  let suppliedFields = 0;
  for (const [key,value] of Object.entries(body)) {
    if (key === 'version') continue; // Existing optimistic-concurrency validation owns this.
    if (nestedFields.has(key)) {
      if (key === 'baseLocation' && value === null) {
        suppliedFields++;
        if ((named || !isDeepStrictEqual(value,old[key])) && !canChange(principal,'baseLocation.lat')) throw forbidden();
        continue;
      }
      if (!object(value)) throw forbidden();
      for (const [child,next] of Object.entries(value)) {
        const path = `${key}.${child}`;
        if (!own(CONFIG_FIELD_PERMISSIONS,path) || next !== null && typeof next === 'object') throw forbidden();
        suppliedFields++;
        if ((named || !isDeepStrictEqual(next,old[key]?.[child])) && !canChange(principal,path)) throw forbidden();
      }
    } else {
      if (!own(CONFIG_FIELD_PERMISSIONS,key)) throw forbidden();
      if (arrayFields.has(key)) validateArrayKeys(key,value);
      else if (value !== null && typeof value === 'object') throw forbidden();
      suppliedFields++;
      if ((named || !isDeepStrictEqual(value,old[key])) && !canChange(principal,key)) throw forbidden();
    }
  }
  if (named && suppliedFields === 0) throw forbidden();
  return true;
}

/** Merge only registered settings; version checks/increment and domain validation stay in app.mjs. */
export function applyConfigPatch(principal, body, old = {}) {
  assertConfigPatch(principal,body,old);
  const next = clone(old);
  for (const [key,value] of Object.entries(body)) {
    if (key === 'version') continue;
    if (nestedFields.has(key) && object(value)) next[key] = {...(object(old[key])?clone(old[key]):{}),...clone(value)};
    else next[key] = clone(value);
  }
  return next;
}

// Projection is an allowlist, including nested records. New fields are not public.
const pick = (value,keys) => Object.fromEntries(keys.filter(key => own(value,key) && (value[key] === null || ['string','number','boolean'].includes(typeof value[key]))).map(key => [key,value[key]]));
const point = value => object(value) ? pick(value,['lat','lng']) : null;
const safeStrings = value => list(value).filter(item => typeof item === 'string');
const finance = principal => hasPermission(principal,'finance.view');
const safeService = (value,principal) => {
  const result = pick(value,['id','family','variant','category','minutes','active']);
  if (finance(principal)) Object.assign(result,pick(value,['name','description','priceCents']));
  else { result.name = 'Service details restricted'; result.description = ''; }
  return result;
};
function blankConfig() {
  return {
    version:0, businessName:'',phone:'',email:'',preparation:'',cleaningProcess:'',assessmentProcess:'',assessmentProcessVersion:0,
    bookingEnabled:false,scheduleAcknowledged:false,pricesAcknowledged:false,scheduleSource:'BOB',
    baseAddress:'',baseLocation:null,customServiceAreas:[],serviceAreaMode:'zip',serviceAreaMiles:0,travelAreaMiles:0,
    maxDriveFromBaseMin:0,maxDriveBetweenJobsMin:0,travelFeeTiers:[],nearbyFirst:false,
    messageTemplates:{confirmationSms:'',confirmationEmailSubject:'',confirmationEmailBody:'',ownerBookingSms:''},messageEmailFormat:'plain',
    smsConfirmations:false,emailConfirmations:false,bookingOwnerSmsEnabled:false,ownerErrorSmsEnabled:false,bookingOwnerSmsPhone:'',services:[],
    emergencyLeadHours:0,requirePhoneVerification:false,approvalServices:[],approver:{name:'',phone:'',email:''},aiAssistant:false,aiProvider:'gemini',
    integrations:{jobber:false,maps:false,verification:false,sms:false,email:false},routeScoring:false,
    sameDay:{enabled:false,cutoffHour:0,minNoticeHours:0,requireNearby:false},
    overflow:{enabled:false,start:'',maxDurationMins:0,requireNearby:false},
    cleaningMinutes:0,assessmentMinutes:0,bundleMinutes:0,bufferMinutes:0,maxJobsPerDay:0,leadHours:0,horizonDays:0,
    weekdayStarts:[],weekdayClose:'',saturdayStarts:[],saturdayClose:'',blockedDates:[],serviceZips:[],travelZips:[],coverageVersion:0,activeTechnicianIds:[],assessmentCredited:false,
  };
}
// Reading a status page never inherits every field controlled by its administrator.
// This map is intentionally independent of write permissions and DEFAULT_CONFIG.
const configReadGroups = {
  'settings.business.view':['businessName','phone','email','preparation','cleaningProcess','assessmentProcess','assessmentProcessVersion'],
  'settings.booking.view':['bookingEnabled','scheduleAcknowledged','scheduleSource','requirePhoneVerification','aiAssistant','smsConfirmations','emailConfirmations','emergencyLeadHours','approvalServices','approver.name'],
  'settings.connections.view':['scheduleSource','requirePhoneVerification','aiAssistant','aiProvider','integrations.jobber','integrations.maps','integrations.verification','integrations.sms','integrations.email'],
  'integrations.manage':['approver.phone','approver.email'],
  'ownerSms.manage':['bookingOwnerSmsEnabled','ownerErrorSmsEnabled','bookingOwnerSmsPhone','messageTemplates.ownerBookingSms'],
  'settings.templates.view':['messageTemplates.confirmationSms','messageTemplates.confirmationEmailSubject','messageTemplates.confirmationEmailBody','messageEmailFormat'],
  'settings.services.view':['pricesAcknowledged','services','cleaningPriceCents','assessmentPriceCents','bundleAssessmentCents','bundlePriceCents','cleaningMinutes','assessmentMinutes','bundleMinutes','assessmentCredited'],
  'settings.coverage.view':['baseAddress','baseLocation.lat','baseLocation.lng','customServiceAreas','serviceAreaMode','serviceAreaMiles','travelAreaMiles','serviceZips','travelZips','coverageVersion','travelZoneFeeCents','travelFeeTiers'],
  'settings.schedule.view':['maxDriveFromBaseMin','maxDriveBetweenJobsMin','nearbyFirst','routeScoring','sameDay.enabled','sameDay.cutoffHour','sameDay.minNoticeHours','sameDay.requireNearby','overflow.enabled','overflow.start','overflow.maxDurationMins','overflow.minTicketCents','overflow.requireNearby','dailyRevenueTargetCents','bufferMinutes','maxJobsPerDay','leadHours','horizonDays','weekdayStarts','weekdayClose','saturdayStarts','saturdayClose','blockedDates','activeTechnicianIds'],
  'appointments.view':['scheduleSource'],
  'appointments.manage':['services','serviceZips','scheduleSource','cleaningPriceCents','assessmentPriceCents','bundleAssessmentCents','cleaningMinutes','assessmentMinutes','bundleMinutes'],
  'inbox.view':['approver.name'],
  'analytics.view':['dailyRevenueTargetCents'],
};
const configReadFields = new Map();
for (const [permission,paths] of Object.entries(configReadGroups)) {
  for (const path of paths) configReadFields.set(path,[...(configReadFields.get(path) || []),permission]);
}
function configReadable(principal,path) {
  return (configReadFields.get(path) || []).some(permission => permission === 'appointments.manage'
    ? hasAll(principal,['appointments.view','appointments.manage'])
    : hasPermission(principal,permission));
}
export function projectConfig(config,principal) {
  if (principal?.role === 'legacy') return clone(config || {});
  const result = blankConfig();
  if (Number.isInteger(config?.version)) result.version = config.version;
  for (const path of Object.keys(CONFIG_FIELD_PERMISSIONS)) {
    if (!configReadable(principal,path)) continue;
    if ((monetaryFields.has(path) || textFields.has(path)) && !finance(principal) && path !== 'services') continue;
    const [key,child] = path.split('.');
    const value = child ? config?.[key]?.[child] : config?.[key];
    if (value === undefined) continue;
    let projected;
    if (key === 'services') projected = list(value).map(row => safeService(row,principal));
    else if (key === 'customServiceAreas') projected = list(value).map(row => ({...pick(row,['id','kind']),points:list(row?.points).map(point)}));
    else if (key === 'travelFeeTiers') projected = list(value).map(row => pick(row,['upToMin','feeCents']));
    else if (arrayFields.has(key)) projected = safeStrings(value);
    else if (value === null || ['string','number','boolean'].includes(typeof value)) projected = value;
    else continue;
    if (child) { if (!object(result[key])) result[key] = {}; result[key][child] = projected; }
    else result[key] = projected;
  }
  return result;
}
const recordFields = ['id','status','scheduledAt','durationMins','technicianId','technicianName','createdAt','revision','urgency','source','route','packageId','overflow','sameDay','jobberState','smsConsent','phoneVerified'];
const contactFields = ['customerName','name','phone','email','address','city','zip'];
const safeNotifications = value => pick(value,['sms','email','smsDelivery','emailDelivery','smsAlreadyAttempted','emailAlreadyAttempted']);
const safeJobber = value => object(value) ? pick(value,['jobNumber','jobId','visitId','webUri']) : null;
const serviceLabel = row => row?.route === 'assessment' ? 'Assessment' : row?.route === 'bundle' ? 'Cleaning and assessment' : 'Service';
export function projectAppointment(row,principal,{analytics=false}={}) {
  const result = pick(row,analytics ? ['id','status','scheduledAt','durationMins','technicianId','city','source','route'] : [...recordFields,...contactFields]);
  result.package = finance(principal) && typeof row?.package === 'string' ? row.package : serviceLabel(row);
  result.airflowReadings = pick(row?.airflowReadings,['beforeCfm','afterCfm']);
  result.territory = pick(row?.territory,['city','zone','micro','corridor']);
  if (!analytics) {
    result.jobber = safeJobber(row?.jobber);
    result.notifications = safeNotifications(row?.notifications);
    result.approval = object(row?.approval) ? pick(row.approval,['id','by','at']) : null;
  }
  if (finance(principal)) {
    Object.assign(result,pick(row,['price','servicePriceCents','travelFeeCents']));
    if (!analytics) {
      Object.assign(result,pick(row,['notes','jobberError','smsConsent','phoneVerified']));
      result.lineItems = list(row?.lineItems).map(item => pick(item,['id','name','cents','mins']));
      result.concerns = safeStrings(row?.concerns);
      result.property = pick(row?.property,['stories','laundryFloor','hasDryer','power','mount','dryerWorking','triage']);
      for (const key of ['symptoms','animals']) if (Array.isArray(row?.property?.[key])) result.property[key] = safeStrings(row.property[key]);
    }
  }
  return result;
}
function projectRequest(row,principal) {
  const result = pick(row,['id','status','name','phone','email','address','city','zip','preference','createdAt','urgency','kind','route','smsConsent','emergency','requestedAt']);
  if (['gas','fire','stop'].includes(row?.safety)) result.safety = row.safety;
  result.requestedVisit = pick(row?.requestedVisit,['date','time']);
  result.notification = pick(row?.notification,['status','provider','at']);
  if (finance(principal)) {
    Object.assign(result,pick(row,['reason','notes','service','message']));
    result.transcript = list(row?.transcript).map(item => pick(item,['role','text']));
    result.concerns = safeStrings(row?.concerns);
    Object.assign(result.notification,pick(row?.notification,['recipient','to','messageId','error']));
  }
  return result;
}
function projectApproval(row,principal) {
  const result = pick(row,['id','kind','status','requestedAt','expiresAt','scheduledAt','durationMins','technicianName','technicianId','appointmentId']);
  result.customer = pick(row?.customer,['name','phone','email','address','city','zip']);
  result.service = finance(principal) && typeof row?.service === 'string' ? row.service : 'Service';
  result.notified = { ...safeNotifications(row?.notified), ...pick(row?.notified,['smsReason','reason']) };
  result.decision = pick(row?.decision,['decision','by','at']);
  if (finance(principal)) {
    Object.assign(result,pick(row,['reason','notes','failure','totalCents']));
    Object.assign(result.decision,pick(row?.decision,['note']));
    result.lineItems = list(row?.lineItems).map(item => pick(item,['id','name','cents','mins']));
    result.concerns = safeStrings(row?.concerns);
  }
  return result;
}
function projectTechnician(row,principal) {
  const result = pick(row,['id','name','status','color','zone']);
  if (hasPermission(principal,'settings.schedule.view')) Object.assign(result,pick(row,['phone','jobberUserId','vehicle',...(finance(principal)?['bio']:[])]));
  return result;
}
function projectIntegrations(value,principal) {
  if (!hasPermission(principal,'settings.connections.view') && !isMaster(principal)) {
    // Appointment send controls need capability flags, never account metadata.
    return hasAll(principal,['appointments.view','appointments.send']) ? {sms:pick(value?.sms,['enabled','configured']),email:pick(value?.email,['enabled','configured'])} : {};
  }
  const result = {};
  for (const name of ['jobber','verification','sms','email','maps','assistant']) result[name] = pick(value?.[name],['enabled','provider','configured','appConfigured','connected','deliveryVerified','model']);
  result.verification.channels = safeStrings(value?.verification?.channels);
  result.database = typeof value?.database === 'string' ? value.database : '';
  result.accounts = {};
  for (const name of ['jobber','twilio']) result.accounts[name] = pick(value?.accounts?.[name],['status','displayName','checkedAt','accountStatus']);
  result.observed = {};
  for (const name of ['jobber','verification','sms','email','assistant','database']) result.observed[name] = pick(value?.observed?.[name],['status','checkedAt','lastSuccessAt','operation','meaning','stale']);
  result.assistant.providers = {};
  for (const name of ['gemini','openai']) result.assistant.providers[name] = pick(value?.assistant?.providers?.[name],['configured','model']);
  if (hasPermission(principal,'integrations.manage')) result.clientHub = pick(value?.clientHub,['url','enabled','accountName','reason']);
  return result;
}
export function projectPrincipal(principal) {
  if (!validPrincipal(principal)) return null;
  return {...pick(principal,['id','email','name','role','version','sessionVersion']),permissions:PERMISSION_KEYS.filter(key => hasPermission(principal,key))};
}
export function projectSnapshot(snapshot,principal) {
  if (principal?.role === 'legacy') return clone(snapshot);
  const source = object(snapshot) ? snapshot : {};
  const appointments = hasPermission(principal,'appointments.view'), analytics = hasAll(principal,['analytics.view','finance.view']), inbox = hasPermission(principal,'inbox.view');
  const technicians = appointments || analytics || hasPermission(principal,'settings.schedule.view');
  const showActivity = hasAll(principal,['activity.view','finance.view']);
  const result = {
    config:projectConfig(source.config,principal),
    appointments:appointments ? list(source.appointments).map(row => projectAppointment(row,principal)) : [],
    analyticsAppointments:analytics ? list(source.appointments).map(row => projectAppointment(row,principal,{analytics:true})) : [],
    requests:inbox ? list(source.requests).map(row => projectRequest(row,principal)) : [],
    approvals:inbox ? list(source.approvals).map(row => projectApproval(row,principal)) : [],
    technicians:technicians ? list(source.technicians).map(row => projectTechnician(row,principal)) : [],
    faqs:hasAll(principal,['settings.answers.view','finance.view']) ? list(source.faqs).map(row => ({...pick(row,['id','question','answer','category','subcategory','status','reviewNote','isCustom','updatedAt']),keywords:safeStrings(row?.keywords)})) : [],
    notifications:showActivity ? list(source.notifications).map(row => pick(row,['id','kind','created','status','attempts'])) : [],
    integrations:projectIntegrations(source.integrations,principal),
    westValleyZips:hasPermission(principal,'settings.coverage.view') ? safeStrings(source.westValleyZips) : [],
    heldLocksCount:analytics && Number.isFinite(source.heldLocksCount) ? source.heldLocksCount : 0,
    conversations:analytics && Number.isFinite(source.conversations) ? source.conversations : 0,
    now:Number.isFinite(source.now) ? source.now : 0,
    bookingEnabled:(hasPermission(principal,'bot.use') || hasPermission(principal,'settings.booking.view')) && source.bookingEnabled === true,
  };
  if (hasPermission(principal,'settings.connections.view')) result.notificationsConfigured = source.notificationsConfigured === true;
  return result;
}

/** Apply to successful admin responses. Parent attaches its own projected access envelope. */
export function projectAdminResponse(principal,method,path,body) {
  requireAdminRoute(principal,method,path);
  if (principal.role === 'legacy') return clone(body);
  if (object(body) && own(body,'config') && own(body,'appointments')) {
    const result = projectSnapshot(body,principal);
    if (body.appointment && hasPermission(principal,'appointments.view')) result.appointment = projectAppointment(body.appointment,principal);
    if (object(body.result) && hasPermission(principal,'inbox.view')) result.result = pick(body.result,['status',...(finance(principal)?['failure']:[])]);
    return result;
  }
  // These routes return privileged records and are master-only in the registry.
  if (hasPermission(principal,'users.manage') && /^\/api\/admin\/(?:users|invitations)(?:\/|$)/.test(path)) return clone(body);
  if (hasPermission(principal,'ownerSms.manage') && path === '/api/admin/owner-sms-consent') return clone(body);
  if (isMaster(principal) && path === '/api/admin/booking-report/test') return pick(body,['status','to']);
  if (path === '/api/admin/maps-key') return pick(body,['key']);
  if (hasPermission(principal,'integrations.manage') && /^\/api\/admin\/(?:integration-accounts|jobber\/)/.test(path)) return clone(body);
  if (path === '/api/admin/status') return pick(body,['authenticated','setupRequired','passwordFromEnv','namedUsersEnabled']);
  if (path === '/api/admin/logout') return pick(body,['signedOut']);
  if (path === '/api/admin/password') return pick(body,['changed']);
  if (path === '/api/admin/integration-accounts') return projectIntegrations({accounts:body},principal).accounts || {};
  if (path === '/api/admin/activity' && hasAll(principal,['activity.view','finance.view'])) return clone(body);
  if (path === '/api/admin/templates/preview' && hasAll(principal,['settings.templates.manage','finance.view'])) return pick(body,['html','text','subject']);
  if (path === '/api/admin/service-area/map') return {base:{...point(body?.base),...pick(body?.base,['formatted'])},points:list(body?.points).map(row => ({...point(row),...pick(row,['miles','area'])})),generatedAt:body?.generatedAt,limits:pick(body?.limits,['standard','travel'])};
  if (path === '/api/admin/geo/check') return {...pick(body,['ok','reason','zipApproved','area','driveFromBaseMiles','driveFromBaseMin','distanceMethod']),location:point(body?.location),territory:pick(body?.territory,['city','zone','micro','corridor']),...(finance(principal)?pick(body,['travelFeeCents']):{})};
  throw forbidden(); // A newly added response needs an explicit projection.
}

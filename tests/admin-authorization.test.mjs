import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../shared/domain.mjs';
import { PERMISSIONS, PERMISSION_KEYS, MASTER_ONLY_PERMISSIONS, CONFIG_FIELD_PERMISSIONS, hasPermission, isMaster, canViewTab, canViewSettings } from '../shared/admin-permissions.mjs';
import { requireAdminRoute, assertConfigPatch, applyConfigPatch, projectSnapshot, projectAdminResponse, projectPrincipal } from '../server/admin-authorization.mjs';

const master = {id:'master-id',email:'owner@example.test',name:'Test owner',role:'master',permissions:[],version:1,sessionVersion:2};
const legacy = {role:'legacy'};
const member = (...permissions) => ({id:'member-id',email:'staff@example.test',name:'Test staff',role:'member',permissions,version:1,sessionVersion:1});
const denied = fn => assert.throws(fn,{status:403,code:'PERMISSION_DENIED'});
const config = () => structuredClone(DEFAULT_CONFIG);

test('capability catalog is explicit; forged, unknown and master-only member grants never authorize',()=>{
  assert.equal(new Set(PERMISSION_KEYS).size,PERMISSIONS.length);
  assert.ok(PERMISSIONS.every(item => item.key && item.label && item.group));
  for (const principal of [master,member('*'),legacy,null,{role:'unknown',permissions:PERMISSION_KEYS}]) {
    assert.equal(hasPermission(principal,'future.root'),false);
    assert.equal(hasPermission(principal,'__proto__'),false);
  }
  assert.equal(isMaster(master),true); assert.equal(isMaster(legacy),false);
  for (const key of MASTER_ONLY_PERMISSIONS) assert.equal(hasPermission(member(key),key),false);
  assert.equal(hasPermission(member(),'appointments.view'),false);
  assert.equal(hasPermission(member('appointments.view'),'appointments.manage'),false);
  assert.equal(hasPermission(master,'ownerSms.manage'),true);
});

test('navigation uses the same required views and finance prerequisites; unknown pages deny',()=>{
  assert.equal(canViewTab(member(),'settings'),false);
  assert.equal(canViewTab(member('account.password'),'settings'),true);
  assert.equal(canViewTab(member('analytics.view'),'analytics'),false);
  assert.equal(canViewTab(member('analytics.view','finance.view'),'analytics'),true);
  assert.equal(canViewTab(member('activity.view'),'activity'),false);
  assert.equal(canViewSettings(member('settings.answers.view'),'answers'),false);
  assert.equal(canViewSettings(member('settings.answers.view','finance.view'),'answers'),true);
  assert.equal(canViewTab(master,'users'),true);
  assert.equal(canViewTab(legacy,'users'),false);
  assert.equal(canViewTab(master,'new-page'),false);
  assert.equal(canViewSettings(master,'new-page'),false);
});

test('route registry denies unknown verbs, suffixes and routes even to master',()=>{
  for(const principal of [master,legacy,member('appointments.view')]) {
    denied(()=>requireAdminRoute(principal,'GET','/api/admin/future'));
    denied(()=>requireAdminRoute(principal,'DELETE','/api/admin/data'));
    denied(()=>requireAdminRoute(principal,'PATCH','/api/admin/requests/id/extra'));
    denied(()=>requireAdminRoute(principal,'POST','/api/admin/owner-sms-activation'));
    denied(()=>requireAdminRoute(principal,'POST','/api/admin/claim-master'));
  }
  denied(()=>requireAdminRoute(null,'GET','/api/admin/data'));
  assert.equal(requireAdminRoute(member(),'GET','/api/admin/data'),true);
  assert.equal(requireAdminRoute(member(),'POST','/api/admin/logout'),true);
});

test('view grants cannot mutate; owner, provider and user operations remain master-only',()=>{
  denied(()=>requireAdminRoute(member('appointments.view'),'POST','/api/admin/appointments'));
  denied(()=>requireAdminRoute(member('appointments.manage'),'POST','/api/admin/appointments'));
  assert.equal(requireAdminRoute(member('appointments.view','appointments.manage'),'POST','/api/admin/appointments'),true);
  denied(()=>requireAdminRoute(member('appointments.view','appointments.manage'),'POST','/api/admin/appointments/DVS-1/confirmation'));
  assert.equal(requireAdminRoute(member('appointments.view','appointments.send'),'POST','/api/admin/appointments/DVS-1/confirmation'),true);
  for(const [method,path] of [['GET','/api/admin/owner-sms-consent'],['POST','/api/admin/owner-sms-consent'],['GET','/api/admin/jobber/connect'],['POST','/api/admin/jobber/client-hub'],['POST','/api/admin/connections/refresh'],['GET','/api/admin/export'],['GET','/api/admin/users'],['POST','/api/admin/users/invite'],['PATCH','/api/admin/users/user-1'],['POST','/api/admin/users/user-1/reset-invite'],['POST','/api/admin/invitations/invite-1/revoke']]) {
    denied(()=>requireAdminRoute(member(...PERMISSION_KEYS),method,path));
    assert.equal(requireAdminRoute(master,method,path),true);
  }
  assert.equal(requireAdminRoute(member('settings.connections.view'),'GET','/api/admin/integration-accounts'),true);
  denied(()=>requireAdminRoute(member('activity.view'),'GET','/api/admin/activity'));
  assert.equal(requireAdminRoute(member('activity.view','finance.view'),'GET','/api/admin/activity'),true);
});

test('legacy retains only registered pre-migration behavior and cannot administer users or owner consent',()=>{
  for(const [method,path] of [['GET','/api/admin/data'],['POST','/api/admin/jobber/disconnect'],['GET','/api/admin/export']]) assert.equal(requireAdminRoute(legacy,method,path),true);
  denied(()=>requireAdminRoute(legacy,'GET','/api/admin/owner-sms-consent'));
  denied(()=>requireAdminRoute(legacy,'POST','/api/admin/owner-sms-consent'));
  denied(()=>requireAdminRoute(legacy,'GET','/api/admin/users'));
  denied(()=>requireAdminRoute(legacy,'POST','/api/admin/users/invite'));
  const original={config:{futureLegacyValue:'retained'},appointments:[{legacyField:'retained'}]};
  const result=projectSnapshot(original,legacy); assert.deepEqual(result,original); assert.notEqual(result,original);
});

test('all current settings are registered but future keys fail closed even when unchanged',()=>{
  const old=config(); assert.equal(assertConfigPatch(master,old,old),true);
  for(const key of Object.keys(old)) assert.ok(key==='version'||Object.keys(CONFIG_FIELD_PERMISSIONS).some(path=>path===key||path.startsWith(`${key}.`)),key);
  denied(()=>assertConfigPatch(master,{futureEnabled:true},{...old,futureEnabled:true}));
  denied(()=>assertConfigPatch(master,{integrations:{newProvider:false}},{...old,integrations:{...old.integrations,newProvider:false}}));
  denied(()=>assertConfigPatch(master,{clientHub:{url:'https://example.test'}},old));
  denied(()=>assertConfigPatch(master,JSON.parse('{"__proto__":{"role":"master"}}'),old));
  denied(()=>assertConfigPatch(master,{services:[{...old.services[0],futureSecret:'x'}]},old));
});

test('mixed settings writes reject atomically; nested deltas preserve omitted protected values',()=>{
  const old=config(), before=structuredClone(old);
  const p=member('settings.booking.view','settings.booking.manage','settings.business.view','settings.business.manage');
  denied(()=>applyConfigPatch(p,{businessName:'New office',bookingOwnerSmsEnabled:true},old));
  denied(()=>applyConfigPatch(p,{bookingEnabled:true,integrations:{sms:false}},old));
  denied(()=>applyConfigPatch(p,{bookingEnabled:true,approver:{name:'Dispatcher',phone:'6235550100'}},old));
  assert.deepEqual(old,before);
  const next=applyConfigPatch(p,{version:old.version,bookingEnabled:true,approver:{name:'Dispatcher'}},old);
  assert.equal(next.bookingEnabled,true); assert.equal(next.approver.name,'Dispatcher');
  assert.equal(next.approver.phone,old.approver.phone); assert.deepEqual(next.integrations,old.integrations);
  assert.deepEqual(old,before); assert.equal(next.version,old.version);
  denied(()=>assertConfigPatch(p,{bookingOwnerSmsEnabled:old.bookingOwnerSmsEnabled,integrations:old.integrations,approver:old.approver},old));
  assert.equal(assertConfigPatch(legacy,{bookingOwnerSmsEnabled:old.bookingOwnerSmsEnabled,integrations:old.integrations,approver:old.approver},old),true,'legacy keeps its existing full-config behavior');
});

test('named no-op writes cannot probe hidden field equality',()=>{
  const old=config(), p=member('settings.business.view','settings.business.manage');
  for(const sms of [old.integrations.sms,!old.integrations.sms]) {
    denied(()=>applyConfigPatch(p,{version:old.version,integrations:{sms}},old));
    denied(()=>applyConfigPatch(p,{version:old.version,businessName:'Allowed value',integrations:{sms}},old));
  }
  for(const phone of [old.bookingOwnerSmsPhone,'+16235550100']) denied(()=>applyConfigPatch(p,{version:old.version,bookingOwnerSmsPhone:phone},old));
  denied(()=>applyConfigPatch(p,{version:old.version,baseLocation:old.baseLocation},old));
  assert.equal(assertConfigPatch(p,{businessName:old.businessName},old),true,'authorized no-op fields remain valid');
});

test('named empty and version-only configuration writes are rejected before persistence',()=>{
  const old=config(), before=structuredClone(old);
  for(const principal of [member(),member('settings.business.view','settings.business.manage'),master]) {
    for(const body of [{},{version:old.version},{version:old.version,approver:{}},{integrations:{},messageTemplates:{}}]) denied(()=>applyConfigPatch(principal,body,old));
  }
  assert.deepEqual(old,before);
  assert.equal(assertConfigPatch(legacy,{version:old.version},old),true);
});

test('financial and sender control changes require additional explicit authority',()=>{
  const old=config();
  const services=member('settings.services.view','settings.services.manage');
  denied(()=>assertConfigPatch(services,{cleaningPriceCents:12345},old));
  assert.equal(assertConfigPatch({...services,permissions:[...services.permissions,'finance.view']},{cleaningPriceCents:12345},old),true);
  const templates=member('settings.templates.view','settings.templates.manage','finance.view');
  denied(()=>assertConfigPatch(templates,{messageTemplates:{ownerBookingSms:'Changed'}},old));
  denied(()=>assertConfigPatch(templates,{messageTemplates:{confirmationSms:'Changed'}},old));
  assert.equal(assertConfigPatch(templates,{messageTemplates:{confirmationEmailSubject:'Changed'}},old),true);
  for(const key of ['smsConfirmations','emailConfirmations','requirePhoneVerification']) denied(()=>assertConfigPatch(member('settings.booking.view','settings.booking.manage'),{[key]:!old[key]},old));
});

function fixture() {
  const privateAmount=987654321;
  return {
    config:{...config(),version:3,bookingOwnerSmsPhone:'+16235550100',dailyRevenueTargetCents:privateAmount,privateExtra:'DROP',messageTemplates:{confirmationSms:'private 987654321',ownerBookingSms:'private 987654321',confirmationEmailSubject:'private 987654321',confirmationEmailBody:'private 987654321'}},
    appointments:[{id:'A1',customerName:'Test Customer',phone:'+16235550101',email:'customer@example.test',address:'100 Test St',city:'Test City',zip:'85326',status:'confirmed',scheduledAt:'2026-11-01T20:00:00Z',route:'cleaning',package:'Private package 987654321',source:'ai_bot',technicianId:'T1',price:privateAmount,lineItems:[{name:'private 987654321',cents:privateAmount,extra:'DROP'}],notes:'private 987654321',jobberError:'private 987654321',concerns:['private 987654321'],newFinance:{amount:privateAmount},notifications:{sms:'accepted',body:'private 987654321'},jobber:{jobNumber:12,accessToken:'DROP'},airflowReadings:{beforeCfm:10,afterCfm:20,privateAmount},territory:{zone:1,privateAmount}}],
    requests:[{id:'R1',name:'Test Customer',status:'new',phone:'+16235550101',notes:'private 987654321',reason:'private 987654321',message:'private 987654321',transcript:[{role:'user',text:'private 987654321'}],totalCents:privateAmount}],
    approvals:[{id:'P1',status:'pending',customer:{name:'Test Customer',phone:'+16235550101',privateAmount},service:'private 987654321',notes:'private 987654321',reason:'private 987654321',failure:'private 987654321',totalCents:privateAmount,lineItems:[{name:'private 987654321',cents:privateAmount}],decision:{decision:'approve',by:'Test Dispatcher',note:'private 987654321'},notified:{sms:'accepted',body:'private 987654321'}}],
    technicians:[{id:'T1',name:'Test Technician',phone:'+16235550102',status:'available',jobberUserId:'USER1',bio:'private 987654321',unknown:'DROP'}],
    faqs:[{id:'F1',question:'Price?',answer:'private 987654321',unknown:'DROP'}],
    notifications:[{id:'N1',kind:'booking.created',created:1,status:'pending',attempts:0,data:{privateAmount}}],
    integrations:{sms:{enabled:true,configured:true,secret:'DROP'},accounts:{twilio:{status:'verified',displayName:'Test account',authToken:'DROP'}},lastError:{message:'private 987654321'},clientHub:{url:'https://example.test/private',privateAmount}},
    conversations:50,heldLocksCount:3,westValleyZips:['85326'],now:1,bookingEnabled:true,notificationsConfigured:true,futureSecret:'DROP',
  };
}

test('zero-permission snapshot has safe shapes and no denied-page records or metadata',()=>{
  const result=projectSnapshot(fixture(),member());
  for(const key of ['appointments','analyticsAppointments','requests','approvals','technicians','faqs','notifications','westValleyZips']) assert.deepEqual(result[key],[],key);
  assert.deepEqual(result.integrations,{});
  assert.equal(result.config.bookingOwnerSmsPhone,''); assert.deepEqual(result.config.services,[]);
  assert.deepEqual(result.config.sameDay,{enabled:false,cutoffHour:0,minNoticeHours:0,requireNearby:false});
  assert.equal(result.bookingEnabled,false); assert.equal(result.conversations,0);
  assert.doesNotMatch(JSON.stringify(result),/987654321|Test Customer|Test account|futureSecret|DROP/);
});

test('operational page access cannot leak finance through nested records or freeform notes',()=>{
  const source=fixture(), before=structuredClone(source);
  const p=member('appointments.view','inbox.view','settings.schedule.view','settings.services.view','settings.connections.view');
  const result=projectSnapshot(source,p);
  assert.equal(result.appointments[0].id,'A1'); assert.equal(result.requests[0].id,'R1'); assert.equal(result.approvals[0].id,'P1');
  assert.equal(result.appointments[0].notifications.sms,'accepted'); assert.equal(result.appointments[0].jobber.jobNumber,12);
  assert.equal(result.technicians[0].phone,'+16235550102');
  assert.doesNotMatch(JSON.stringify(result),/987654321|privateExtra|newFinance|accessToken|authToken|secret|unknown|DROP/);
  assert.equal(own(result.appointments[0],'price'),false); assert.equal(own(result.appointments[0],'notes'),false);
  assert.deepEqual(source,before);
  result.appointments[0].customerName='Edited copy'; assert.equal(source.appointments[0].customerName,'Test Customer');
});
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

test('finance permission alone gives no page data; analytics-only projection excludes customer detail',()=>{
  const source=fixture();
  const noPage=projectSnapshot(source,member('finance.view'));
  assert.deepEqual(noPage.appointments,[]); assert.deepEqual(noPage.requests,[]); assert.deepEqual(noPage.analyticsAppointments,[]);
  const report=projectSnapshot(source,member('analytics.view','finance.view'));
  assert.deepEqual(report.appointments,[]); assert.equal(report.analyticsAppointments[0].price,987654321);
  for(const key of ['customerName','phone','email','address','notes','jobber']) assert.equal(own(report.analyticsAppointments[0],key),false,key);
  assert.equal(report.technicians[0].phone,undefined); assert.equal(report.config.dailyRevenueTargetCents,987654321);
});

test('connection status access never exposes approver contacts, templates or other settings pages',()=>{
  const source=fixture();
  source.config.approver={name:'Private approver',phone:'+16235550199',email:'private-approver@example.test'};
  source.config.messageTemplates.confirmationSms='Private customer SMS template';
  source.config.businessName='Private business setting';
  for (const grants of [['settings.connections.view'],['settings.connections.view','finance.view']]) {
    const result=projectSnapshot(source,member(...grants));
    assert.equal(result.integrations.sms.configured,true);
    assert.equal(result.config.integrations.sms,source.config.integrations.sms);
    assert.deepEqual(result.config.approver,{name:'',phone:'',email:''});
    assert.deepEqual(result.config.messageTemplates,{confirmationSms:'',confirmationEmailSubject:'',confirmationEmailBody:'',ownerBookingSms:''});
    assert.equal(result.config.smsConfirmations,false); assert.equal(result.config.emailConfirmations,false);
    assert.equal(result.config.businessName,''); assert.deepEqual(result.config.services,[]);
    assert.equal(result.config.bookingOwnerSmsPhone,''); assert.deepEqual(result.appointments,[]); assert.deepEqual(result.requests,[]);
    assert.doesNotMatch(JSON.stringify(result),/Private approver|private-approver|16235550199|Private customer SMS template|Private business setting/);
  }
  const templates=projectSnapshot(source,member('settings.templates.view','finance.view'));
  assert.equal(templates.config.messageTemplates.confirmationSms,'Private customer SMS template');
  assert.equal(templates.config.messageTemplates.ownerBookingSms,'');
  assert.equal(projectSnapshot(source,member('settings.templates.view')).config.messageTemplates.confirmationSms,'');
  const booking=projectSnapshot(source,member('settings.booking.view','finance.view'));
  assert.equal(booking.config.approver.name,'Private approver');
  assert.equal(booking.config.approver.phone,''); assert.equal(booking.config.approver.email,'');
  const owner=projectSnapshot(source,master);
  assert.equal(owner.config.approver.phone,'+16235550199');
  assert.equal(owner.config.approver.email,'private-approver@example.test');
});

test('appointment action grants without page access do not expose dependent config or sender readiness',()=>{
  const source=fixture();
  source.config.serviceZips=['85326'];
  for(const grants of [['appointments.manage'],['appointments.manage','finance.view'],['appointments.send'],['appointments.manage','appointments.send','finance.view']]) {
    const result=projectSnapshot(source,member(...grants));
    assert.deepEqual(result.appointments,[]); assert.deepEqual(result.technicians,[]);
    assert.deepEqual(result.config.services,[]); assert.deepEqual(result.config.serviceZips,[]);
    assert.equal(result.config.cleaningPriceCents,undefined); assert.equal(result.config.assessmentPriceCents,undefined);
    assert.equal(result.config.scheduleSource,'BOB'); assert.deepEqual(result.integrations,{});
  }
  const allowed=projectSnapshot(source,member('appointments.view','appointments.manage','appointments.send','finance.view'));
  assert.ok(allowed.config.services.length>0); assert.deepEqual(allowed.config.serviceZips,['85326']);
  assert.equal(allowed.config.scheduleSource,source.config.scheduleSource); assert.equal(allowed.integrations.sms.configured,true);
});

test('master snapshot preserves recognized data but strips unknown fields and auth secrets',()=>{
  const result=projectSnapshot(fixture(),master);
  assert.equal(result.appointments[0].price,987654321); assert.equal(result.appointments[0].notes,'private 987654321');
  assert.equal(result.config.bookingOwnerSmsPhone,'+16235550100'); assert.equal(result.faqs[0].answer,'private 987654321');
  assert.doesNotMatch(JSON.stringify(result),/futureSecret|privateExtra|accessToken|authToken|newFinance|DROP/);
});

test('mutation response projection closes extra appointment and result leakage',()=>{
  const source=fixture(); const p=member('appointments.view','appointments.manage','inbox.view','inbox.manage');
  const body={...source,appointment:source.appointments[0],result:{status:'failed',failure:'private 987654321'},secret:'DROP'};
  const result=projectAdminResponse(p,'POST','/api/admin/appointments',body);
  assert.equal(result.appointment.id,'A1'); assert.equal(result.result.status,'failed');
  assert.doesNotMatch(JSON.stringify(result),/987654321|DROP/);
  denied(()=>projectAdminResponse(master,'GET','/api/admin/future',{private:'value'}));
  denied(()=>projectAdminResponse(member('activity.view'),'GET','/api/admin/activity',{items:[{details:'private'}]}));
  assert.deepEqual(projectAdminResponse(member('account.password'),'POST','/api/admin/password',{changed:true,sessionTokenHash:'DROP'}),{changed:true});
});

test('public principal excludes credential and session material and ignores unknown grants',()=>{
  const principal={...member('appointments.view','new.permission','users.manage'),sessionTokenHash:'DROP',passwordHash:'DROP',token:'DROP',disabled:false};
  const result=projectPrincipal(principal);
  assert.deepEqual(result.permissions,['appointments.view']); assert.equal(result.id,'member-id');
  assert.doesNotMatch(JSON.stringify(result),/DROP|sessionTokenHash|passwordHash|disabled/);
  assert.equal(projectPrincipal({role:'unknown'}),null);
});

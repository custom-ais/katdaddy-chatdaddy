// Explicit capability catalog. Adding an endpoint or setting never grants access.
const groups = [
  ['Appointments', [['appointments.view','View appointments'],['appointments.manage','Create/update bookings (automatic notifications may follow)'],['appointments.send','Send manual customer confirmations']]],
  ['Inbox', [['inbox.view','View requests and approvals'],['inbox.manage','Decide approvals/update requests (automatic notifications may follow)']]],
  ['Reports', [['analytics.view','View analytics'],['finance.view','View financial amounts and unrestricted record notes'],['activity.view','View activity logs (also requires financial access)']]],
  ['Booking Bot', [['bot.use','Use the live customer booking bot (can book and send notifications)']]],
  ['Connections', [['settings.connections.view','View connection status']]],
  ...[['booking','Booking and messages'],['schedule','Scheduling and team'],['services','Services and prices'],['coverage','Service area'],['business','Business and website'],['answers','Answers'],['templates','Templates']].map(([key,label]) => [label, [[`settings.${key}.view`,`View ${label.toLowerCase()}`],[`settings.${key}.manage`,`Edit ${label.toLowerCase()}`]]]),
  ['Account', [['account.password','Change own password']]],
  ['Master Admin only', [['users.manage','Manage users and permissions'],['integrations.manage','Manage providers and messaging controls'],['ownerSms.manage','Manage owner SMS consent and controls'],['exports.download','Download full data backup']]],
];
export const PERMISSIONS = Object.freeze(groups.flatMap(([group, items]) => items.map(([key,label]) => Object.freeze({key,label,group}))));
export const PERMISSION_KEYS = Object.freeze(PERMISSIONS.map(item => item.key));
export const MASTER_ONLY_PERMISSIONS = Object.freeze(['users.manage','integrations.manage','ownerSms.manage','exports.download']);
const known = new Set(PERMISSION_KEYS), masterOnly = new Set(MASTER_ONLY_PERMISSIONS);
export const isMaster = principal => principal?.role === 'master';
export function hasPermission(principal, key) {
  if (!known.has(key) || !principal) return false;
  if (isMaster(principal)) return true;
  // Parent authentication allows this principal only before named-user migration.
  if (principal.role === 'legacy') return key !== 'users.manage';
  if (principal.role !== 'member' || masterOnly.has(key)) return false;
  return Array.isArray(principal.permissions) && principal.permissions.includes(key);
}
export const SETTINGS_PERMISSIONS = Object.freeze({
  connections:'settings.connections.view', booking:'settings.booking.view', schedule:'settings.schedule.view', services:'settings.services.view',
  coverage:'settings.coverage.view', business:'settings.business.view', answers:'settings.answers.view', templates:'settings.templates.view',
  security:'account.password', users:'users.manage',
});
export const TAB_PERMISSIONS = Object.freeze({
  appointments:'appointments.view', inbox:'inbox.view', analytics:'analytics.view', activity:'activity.view', bot:'bot.use', users:'users.manage',
  settings:Object.freeze(Object.values(SETTINGS_PERMISSIONS)),
});
export function canViewSettings(principal, page) {
  if (['answers','templates'].includes(page) && !hasPermission(principal,'finance.view')) return false;
  return hasPermission(principal, SETTINGS_PERMISSIONS[page]);
}
export function canViewTab(principal, tab) {
  const permission = TAB_PERMISSIONS[tab];
  if (tab === 'activity' || tab === 'analytics') return hasPermission(principal,`${tab}.view`) && hasPermission(principal,'finance.view');
  if (tab === 'settings') return Object.keys(SETTINGS_PERMISSIONS).some(page => canViewSettings(principal,page));
  return hasPermission(principal,permission);
}

// Leaf paths, intentionally independent of DEFAULT_CONFIG. New keys fail closed.
export const CONFIG_FIELD_PERMISSIONS = Object.freeze({
  businessName:'settings.business.manage', phone:'settings.business.manage', email:'settings.business.manage',
  preparation:'settings.business.manage', cleaningProcess:'settings.business.manage', assessmentProcess:'settings.business.manage', assessmentProcessVersion:'settings.business.manage',
  bookingEnabled:'settings.booking.manage', scheduleAcknowledged:'settings.booking.manage', pricesAcknowledged:'settings.services.manage',
  scheduleSource:'integrations.manage', requirePhoneVerification:'integrations.manage', aiAssistant:'integrations.manage', aiProvider:'integrations.manage',
  'integrations.jobber':'integrations.manage', 'integrations.maps':'integrations.manage', 'integrations.verification':'integrations.manage', 'integrations.sms':'integrations.manage', 'integrations.email':'integrations.manage',
  smsConfirmations:'integrations.manage', emailConfirmations:'integrations.manage',
  bookingOwnerSmsEnabled:'ownerSms.manage', ownerErrorSmsEnabled:'ownerSms.manage', bookingOwnerSmsPhone:'ownerSms.manage',
  'messageTemplates.ownerBookingSms':'ownerSms.manage', 'messageTemplates.confirmationSms':'integrations.manage',
  'messageTemplates.confirmationEmailSubject':'settings.templates.manage', 'messageTemplates.confirmationEmailBody':'settings.templates.manage', messageEmailFormat:'settings.templates.manage',
  emergencyLeadHours:'settings.booking.manage', approvalServices:'settings.booking.manage',
  'approver.name':'settings.booking.manage', 'approver.phone':'integrations.manage', 'approver.email':'integrations.manage',
  baseAddress:'settings.coverage.manage', 'baseLocation.lat':'settings.coverage.manage', 'baseLocation.lng':'settings.coverage.manage',
  customServiceAreas:'settings.coverage.manage', serviceAreaMode:'settings.coverage.manage', serviceAreaMiles:'settings.coverage.manage', travelAreaMiles:'settings.coverage.manage',
  serviceZips:'settings.coverage.manage', travelZips:'settings.coverage.manage', coverageVersion:'settings.coverage.manage', travelZoneFeeCents:'settings.coverage.manage',
  travelFeeTiers:'settings.coverage.manage', maxDriveFromBaseMin:'settings.schedule.manage', maxDriveBetweenJobsMin:'settings.schedule.manage',
  nearbyFirst:'settings.schedule.manage', routeScoring:'settings.schedule.manage',
  'sameDay.enabled':'settings.schedule.manage','sameDay.cutoffHour':'settings.schedule.manage','sameDay.minNoticeHours':'settings.schedule.manage','sameDay.requireNearby':'settings.schedule.manage',
  'overflow.enabled':'settings.schedule.manage','overflow.start':'settings.schedule.manage','overflow.maxDurationMins':'settings.schedule.manage','overflow.minTicketCents':'settings.schedule.manage','overflow.requireNearby':'settings.schedule.manage',
  dailyRevenueTargetCents:'settings.schedule.manage', 'revenuePacing.enabled':'settings.schedule.manage', 'revenuePacing.period':'settings.schedule.manage', 'revenuePacing.targetCents':'settings.schedule.manage', 'revenuePacing.outsideJobCents':'settings.schedule.manage', services:'settings.services.manage', cleaningPriceCents:'settings.services.manage', assessmentPriceCents:'settings.services.manage', bundleAssessmentCents:'settings.services.manage', bundlePriceCents:'settings.services.manage',
  cleaningMinutes:'settings.services.manage', assessmentMinutes:'settings.services.manage', bundleMinutes:'settings.services.manage', assessmentCredited:'settings.services.manage',
  bufferMinutes:'settings.schedule.manage', minVisitMinutes:'settings.schedule.manage', maxJobsPerDay:'settings.schedule.manage', leadHours:'settings.schedule.manage', horizonDays:'settings.schedule.manage',
  weekdayStarts:'settings.schedule.manage', weekdayClose:'settings.schedule.manage', saturdayStarts:'settings.schedule.manage', saturdayClose:'settings.schedule.manage',
  blockedDates:'settings.schedule.manage', activeTechnicianIds:'settings.schedule.manage',
});

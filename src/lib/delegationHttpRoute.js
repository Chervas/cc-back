'use strict';
// Server-owned mount labels only. Never derive audit labels from request URLs,
// parameter values or unknown suffixes of a nested router's resolved baseUrl.
const PREFIXES = Object.freeze([
  '/api/marketing/google-ads/conversion-action-plans',
  '/api/marketing/google-ads/conversion-destinations',
  '/api/marketing/google-ads/conversion-receipts',
  '/api/clinical-episode-template-defaults',
  '/api/oauth/meta/marketing-disconnection',
  '/api/admin/web-runtime-reconciliations',
  '/oauth/meta/marketing-disconnection',
  '/api/oauth/google/ads/enrollment',
  '/api/clinical-episode-templates',
  '/api/clinical-template-catalog',
  '/api/admin/campaign-playbooks',
  '/api/admin/managed-campaigns',
  '/api/treatment-documentation',
  '/oauth/google/ads/enrollment',
  '/api/accounting/ingestion',
  '/api/common/notifications',
  '/api/historialdeservicios',
  '/api/oauth/meta/marketing',
  '/api/metasync/diagnostic',
  '/api/whatsapp/onboarding',
  '/api/automation-catalog',
  '/api/patient-follow-ups',
  '/api/treatment-programs',
  '/api/booking-equipment',
  '/api/campaign-requests',
  '/api/clinical-episodes',
  '/api/patient-direction',
  '/api/system-monitoring',
  '/api/auth/delegations',
  '/oauth/meta/marketing',
  '/api/access-policies',
  '/api/accounting/bank',
  '/api/clinic-supplies',
  '/api/clinicaservicio',
  '/api/consentimientos',
  '/api/grupos-clinicas',
  '/api/disponibilidad',
  '/api/especialidades',
  '/api/gruposclinicas',
  '/api/instalaciones',
  '/api/metasync/jobs',
  '/api/dental-plans',
  '/api/dependencias',
  '/api/job-requests',
  '/api/public-media',
  '/api/tratamientos',
  '/api/userclinicas',
  '/api/automations',
  '/api/email/admin',
  '/api/send-queues',
  '/api/accounting',
  '/api/campaigns',
  '/api/economics',
  '/api/googleads',
  '/api/marketing',
  '/api/pacientes',
  '/api/servicios',
  '/api/campanas',
  '/api/clinicas',
  '/api/doctores',
  '/api/metasync',
  '/api/personal',
  '/api/whatsapp',
  '/api/doctors',
  '/api/paneles',
  '/api/intake',
  '/api/citas',
  '/api/email',
  '/api/local',
  '/api/oauth',
  '/api/users',
  '/api/auth',
  '/api/meta',
  '/api/web',
  '/oauth',
  '/api'
]);
function prefixFor(req) {
  const value = typeof req.baseUrl === 'string' ? req.baseUrl.toLowerCase() : '';
  if (!value) return '';
  return PREFIXES.find(prefix => value === prefix || prefix !== '/api' && value.startsWith(prefix + '/')) || '/unclassified';
}
function routeFor(req, initialPrefix = '') {
  const live = prefixFor(req);
  // Express may have unwound a router before an asynchronous error response.
  const prefix = live.length >= initialPrefix.length ? live : initialPrefix;
  const value = req.route?.path;
  const pattern = typeof value === 'string' && /^\/[A-Za-z0-9_/:.*()?-]{0,179}$/.test(value) ? value : '/pending-route';
  return prefix + pattern;
}
module.exports = { PREFIXES, prefixFor, routeFor };

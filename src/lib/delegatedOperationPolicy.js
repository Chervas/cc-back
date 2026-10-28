'use strict';
// Delegation reproduces business permissions, never ownership of a login,
// security policy or provider grant. These decisions are made by the server.
const BUSINESS_REFERENCE_PURPOSES = new Set([
  'business_profile.write', 'google_ads.action', 'google_conversion.receipt', 'whatsapp.authorization.read',
]);
const securityKeys = new Set(['email', 'email_usuario', 'password', 'password_usuario', 'administratorPassword',
  'clinicas', 'roles', 'rol_clinica', 'subrol_clinica', 'isAdmin', 'isProfesional', 'estado_cuenta', 'es_provisional',
  'usuarios', 'members', 'memberships', 'permissions', 'permissionOverrides', 'securityPolicy']);
const membershipKeys = new Set(['usuarios', 'clinicas', 'clinicIds', 'clinic_ids', 'grupoClinicaId', 'members', 'memberships',
  'roles', 'rol_clinica', 'subrol_clinica', 'permissions', 'permissionOverrides', 'securityPolicy']);
function hasSecurityKeys(body) {
  return body && typeof body === 'object' && Object.keys(body).some(key => securityKeys.has(key));
}
function requiresOwnSession(req) {
  const method = String(req.method || '').toUpperCase();
  let path;
  try { path = decodeURIComponent(String(req.originalUrl || req.url || '').split('?')[0]).replace(/\/+$/, '').toLowerCase(); }
  catch { return true; }
  if (!path.startsWith('/') || /[\\\x00-\x20\x7f%]/.test(path) || path.includes('//')
    || path.split('/').some(part => part === '.' || part === '..')) return true;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (/^\/api\/auth(?:\/|$)/.test(path)) {
    return !(method === 'GET' && path === '/api/auth/me'
      || method === 'POST' && ['/api/auth/sign-out', '/api/auth/sign-in-with-token'].includes(path)
      || method === 'POST' && /^\/api\/auth\/delegations\/[0-9a-f-]{36}\/revoke$/i.test(path));
  }
  if (!write) return /(?:^|\/)(?:connect|disconnect|credentials|authorization|enrollment)(?:\/|$)/.test(path)
    && /^\/(?:api\/)?oauth\//.test(path);
  if (/^\/api\/whatsapp\/onboarding(?:\/|$)/.test(path)) return path !== '/api/whatsapp/onboarding/authorizations';
  if (path === '/api/whatsapp/embedded-signup/callback') return true;
  if (/^\/api\/whatsapp\/(?:routing(?:\/|$)|phones\/(?:disconnect|archive)$)/.test(path)) return true;
  if (/^\/api\/marketing\/google-ads\/conversion-destinations(?:\/|$)/.test(path)) return true;
  if (/^\/api\/access-policies(?:\/|$)/.test(path)) return true;
  if (/^\/api\/accounting\/firm\/(?:credentials|revoke)$/.test(path)) return true;
  if (/^\/api\/users(?:\/|$)/.test(path)) {
    return !(method === 'PATCH' && /^\/api\/users\/\d+$/.test(path) && !hasSecurityKeys(req.body));
  }
  if (/^\/api\/personal(?:\/|$)/.test(path)) {
    if (/^\/api\/personal\/(?:invitar|invite|fusionar|reclamar)$/.test(path)
      || /\/invitacion(?:es)?(?:\/|$)/.test(path)
      || method === 'DELETE' && /^\/api\/personal\/(?:me|\d+)\/clinicas\/\d+$/.test(path)) return true;
    if (method === 'PATCH' && /^\/api\/personal\/\d+$/.test(path)) return hasSecurityKeys(req.body);
  }
  if (/^\/api\/patient-direction\/(?:profiles|settings)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/(?:clinicas|gruposclinicas|grupos-clinicas)(?:\/\d+)?$/.test(path)) {
    if (method === 'POST' || method === 'DELETE') return true;
    if (req.body && Object.keys(req.body).some(key => membershipKeys.has(key))) return true;
    // These sections replace provider assignments/ownership for the group.
    if (/^\/api\/(?:gruposclinicas|grupos-clinicas)\//.test(path)
      && req.body && ['ads', 'facebook', 'instagram', 'google'].some(key => Object.hasOwn(req.body, key))) return true;
  }
  if (/^\/(?:api\/)?oauth\//.test(path)) {
    // Provider writes are admitted only by reviewed business routes. Grant,
    // enrollment, discovery/mapping and authorization routes stay own-session.
    return true;
  }
  return false;
}
module.exports = { requiresOwnSession, hasSecurityKeys,
  businessReferencePurpose: value => typeof value === 'string' && BUSINESS_REFERENCE_PURPOSES.has(value),
  isManagedBusinessSession: value => Boolean(value && (value.sessionVersion === 1
    || value.type === 'cc_delegated_access' && value.delegationVersion === 1
      && value.authDelegation?.childSessionRef === value.jti
      && Number(value.authDelegation.effectiveUserId) === value.userId)) };

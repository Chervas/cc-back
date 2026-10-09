'use strict';

// Entry contracts, not authorization grants. Downstream routes keep their
// signature, installation token, session, origin and payload checks.
const EXTERNAL_ROUTES = [
  ['GET', /^\/api\/whatsapp\/webhook\/?$/],
  ['POST', /^\/api\/whatsapp\/webhook\/?$/],
  ['GET', /^\/api\/whatsapp\/onboarding\/window$/],
  ['POST', /^\/api\/whatsapp\/onboarding\/(?:begin|finish|status|cancel|authorizations|complete)$/],
  ['GET', /^\/(?:api\/)?oauth\/(?:meta|google)\/callback\/?$/],
  ['GET', /^\/api\/(?:intake\/leads|leads)\/webhook\/?$/],
  ['POST', /^\/api\/(?:intake\/leads|leads)\/webhook\/?$/],
  ['GET', /^\/api\/intake\/config\/?$/],
  ['POST', /^\/api\/intake\/(?:leads|landing-leads|events|whatsapp-origin)\/?$/],
  ['POST', /^\/_clinicaclick\/(?:intake|events)\/?$/],
  ['GET', /^\/api\/email\/events\/provider\/health\/?$/],
  ['POST', /^\/api\/email\/(?:events\/provider|unsubscribe)\/?$/],
  ['GET', /^\/r\/[^/]+\/?$/],
  ['GET', /^\/api\/marketing\/web-installations\/[^/]+\/desired-state\/?$/],
  ['POST', /^\/api\/marketing\/web-installations\/[^/]+\/reports\/?$/],
  ['GET', /^\/api\/marketing\/web-installations\/[^/]+\/artifacts\/[^/]+\/(?:manifest|envelope|files\/[^/]+)\/?$/],
  ['GET', /^\/api\/consentimientos\/public\/[^/]+\/?$/],
  ['POST', /^\/api\/consentimientos\/public\/[^/]+\/sign\/?$/],
  ['POST', /^\/api\/consentimientos\/tablet\/login\/?$/],
  ['GET', /^\/api\/consentimientos\/tablet\/(?:session|packages)\/?$/],
  ['POST', /^\/api\/consentimientos\/tablet\/(?:packages|budget-signatures)\/[^/]+\/session\/?$/],
  ['GET', /^\/api\/economics\/public\/budget-signatures\/[^/]+\/?$/],
  ['POST', /^\/api\/economics\/public\/budget-signatures\/[^/]+\/sign\/?$/],
];

function externalRouteAllowed(method, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  // Do not normalize requests or read bodies: intake and WhatsApp need signed bytes.
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (/[\\\x00-\x20\x7f]/.test(decoded)
    || decoded.split('/').some(segment => segment === '.' || segment === '..')
    || decoded.includes('//')
    || /%(?:2f|5c|25)/i.test(pathname)) return false;
  const verb = method === 'HEAD' ? 'GET' : method;
  return EXTERNAL_ROUTES.some(([allowedMethod, pattern]) => allowedMethod === verb && pattern.test(pathname));
}

function gatewayHttpBoundary(env = process.env) {
  const gateway = String(env.RUNTIME_ROLE || '').trim().toLowerCase() === 'gateway';
  return (req, res, next) => {
    if (!gateway) return next();
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    const method = String(req.method || '').toUpperCase();
    const requestedMethod = method === 'OPTIONS'
      ? String(req.get('access-control-request-method') || '').toUpperCase()
      : method;
    if (externalRouteAllowed(requestedMethod, pathname)) return next();
    // Hosted sites have arbitrary read-only paths. They still pass through
    // webHostedOrigin's host and signed-artifact validation, not the API UI.
    let decoded = '';
    try { decoded = decodeURIComponent(pathname); } catch { /* Closed below. */ }
    if (['GET', 'HEAD'].includes(method) && pathname.startsWith('/')
      && decoded && !/[\\\x00-\x20\x7f%]/.test(decoded)
      && !decoded.split('/').some(segment => segment === '.' || segment === '..')
      && !decoded.includes('//')
      && !/^\/(?:api|oauth|socket\.io|_clinicaclick)(?:\/|$)/i.test(decoded)) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: { code: 'gateway_management_unavailable' } });
  };
}

function gatewaySocketBoundary(env = process.env) {
  const gateway = String(env.RUNTIME_ROLE || '').trim().toLowerCase() === 'gateway';
  return (_socket, next) => {
    if (!gateway) return next();
    const error = new Error('gateway_management_unavailable');
    error.data = { code: 'gateway_management_unavailable' };
    return next(error);
  };
}

module.exports = { externalRouteAllowed, gatewayHttpBoundary, gatewaySocketBoundary };

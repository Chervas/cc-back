'use strict';
// This adapter imports no admission model, runtime factory, environment,
// credential or provider. Installation is an explicit startup operation.
const { createHash } = require('node:crypto');
const SERVICES = Object.freeze(['business_profile', 'search_console', 'analytics', 'ads']);
const STATES = Object.freeze(['prepared', 'exchanging', 'candidate_ready', 'stage_intent', 'candidate_staged', 'interrupted', 'aborted', 'expired']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SCOPE = /^(clinic|group):[1-9]\d{0,9}$/;
const LOCAL = Object.freeze(['attemptId', 'scopeKey', 'service', 'state', 'revision', 'expiresAt', 'authorizationState', 'authorizationConfirmed', 'connected']);
const SAFE = new Set(['google_oauth_admission_attempt_invalid', 'google_oauth_admission_session_required',
  'google_oauth_admission_forbidden', 'google_oauth_admission_attempt_conflict', 'google_oauth_admission_attempt_unavailable', 'google_oauth_admission_disabled']);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const fail = (status = 400, code = 'google_oauth_admission_attempt_invalid') => { throw Object.assign(Error(code), { status, code }); };
const unavailable = () => fail(503, 'google_oauth_admission_attempt_unavailable');
const validScope = value => typeof value === 'string' && SCOPE.test(value) && Number(value.split(':')[1]) <= 2147483647;
const headers = res => { res.set('Cache-Control', 'private, no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff'); };
function errorJson(res, error) {
  const status = [400, 401, 403, 409, 503].includes(error?.status) ? error.status : 503;
  return res.status(status).json({ success: false, error: SAFE.has(error?.code) ? error.code : 'google_oauth_admission_attempt_unavailable' });
}
function selection(value, withAttempt) {
  const fields = withAttempt ? ['attempt_id', 'scope_key', 'google_service'] : ['scope_key', 'google_service'];
  if (!exact(value, fields) || !validScope(value.scope_key) || !SERVICES.includes(value.google_service)
    || withAttempt && (typeof value.attempt_id !== 'string' || !UUID.test(value.attempt_id))) fail();
  return Object.freeze({ ...(withAttempt ? { attemptId: value.attempt_id } : {}), scopeKey: value.scope_key, service: value.google_service });
}
function localDto(value, selected, begin, completionInstalled = false) {
  const fields = begin ? [...LOCAL, 'authorizationUrl'] : LOCAL;
  const withAssets = Object.hasOwn(value || {}, 'canChooseAssets');
  const canChooseAssets = withAssets && value.canChooseAssets === true;
  if (!exact(value, withAssets ? [...fields, 'canChooseAssets'] : fields)
    || value.attemptId !== selected.attemptId || value.scopeKey !== selected.scopeKey || value.service !== selected.service
    || !['prepared', 'cancelled', 'expired'].includes(value.state)
    || value.revision !== (value.state === 'prepared' ? 0 : 1)
    || !STATES.includes(value.authorizationState) || value.authorizationConfirmed !== false || value.connected !== false
    || withAssets && typeof value.canChooseAssets !== 'boolean'
    || canChooseAssets && (begin || !completionInstalled || selected.service !== 'search_console'
      || value.state !== 'prepared' || value.authorizationState !== 'candidate_staged') || typeof value.expiresAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt) unavailable();
  if (begin) {
    let url; try { url = new URL(value.authorizationUrl); } catch { unavailable(); }
    if (value.state !== 'prepared' || value.authorizationState !== 'prepared' || typeof value.authorizationUrl !== 'string'
      || value.authorizationUrl.length > 8192 || url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth'
      || url.username || url.password || url.port || url.hash) unavailable();
  }
  // This positive capability comes only from the runtime's signed-policy,
  // original-intent and current-authority checks, never the new-start gate.
  return { ...value, canChooseAssets };
}
function searchConsoleSite(value) {
  // Same canonical property/hash rules as the existing SC contract. Keep this
  // outer validator free of provider/credential imports when not installed.
  if (typeof value !== 'string' || value.length > 512 || /[\s\\%?#]/.test(value)) unavailable();
  const domain = value.startsWith('sc-domain:') ? value.slice(10) : null;
  const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (domain !== null) { if (!hostname.test(domain)) unavailable(); }
  else {
    let url; try { url = new URL(value); } catch { unavailable(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.href !== value
      || !value.endsWith('/') || !/^\/[A-Za-z0-9/_~.-]*$/.test(url.pathname) || !hostname.test(url.hostname)) unavailable();
  }
  return 'sc:' + createHash('sha256').update(value).digest('hex');
}
function assetsDto(value, selected) {
  if (!exact(value, ['attemptId', 'scopeKey', 'service', 'assets']) || value.attemptId !== selected.attemptId
    || value.scopeKey !== selected.scopeKey || value.service !== 'search_console' || !Array.isArray(value.assets) || value.assets.length > 1000) unavailable();
  const seen = new Set();
  const assets = value.assets.map(asset => {
    if (!exact(asset, ['assetRef', 'siteUrl', 'clinicIds']) || typeof asset.assetRef !== 'string' || !/^sc:[a-f0-9]{64}$/.test(asset.assetRef)
      || searchConsoleSite(asset.siteUrl) !== asset.assetRef || seen.has(asset.assetRef) || !Array.isArray(asset.clinicIds)
      || asset.clinicIds.length > 1000 || asset.clinicIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      || new Set(asset.clinicIds).size !== asset.clinicIds.length
      || selected.scopeKey.startsWith('clinic:') && asset.clinicIds.some(id => selected.scopeKey !== 'clinic:' + id)) unavailable();
    seen.add(asset.assetRef); return { assetRef: asset.assetRef, siteUrl: asset.siteUrl, clinicIds: [...asset.clinicIds] };
  });
  return { attemptId: selected.attemptId, scopeKey: selected.scopeKey, service: 'search_console', assets };
}
function publishedDto(value, selected) {
  if (!exact(value, ['attemptId', 'scopeKey', 'service', 'authorizationConfirmed', 'connected', 'configurationPending', 'replayed'])
    || value.attemptId !== selected.attemptId || value.scopeKey !== selected.scopeKey || value.service !== 'search_console'
    || value.authorizationConfirmed !== true || value.connected !== true || value.configurationPending !== false
    || typeof value.replayed !== 'boolean') unavailable();
  return { ...value };
}
function createGoogleOAuthAdmissionHttpAdapter({ runtime = null, authenticate, returnOrigin, now = () => new Date() } = {}) {
  if (typeof authenticate !== 'function' || typeof now !== 'function' || runtime !== null
    && ['capability', 'begin', 'status', 'callback'].some(name => typeof runtime?.[name] !== 'function')) unavailable();
  const configuredOrigin = returnOrigin ?? runtime?.settingsOrigin ?? 'https://crm.clinicaclick.com';
  let origin;
  try { origin = new URL(configuredOrigin); } catch { unavailable(); }
  const localDev = configuredOrigin === 'http://localhost:4203';
  if ((!localDev && origin.protocol !== 'https:') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) unavailable();
  const installed = runtime !== null;
  const completionInstalled = installed && typeof runtime.assets === 'function' && typeof runtime.publish === 'function';
  const router = require('express').Router({ strict: true });
  router.use((_req, res, next) => { headers(res); next(); });
  router.use(authenticate);
  router.use((req, res, next) => {
    try {
      if (req.authDelegation || req.authSession?.kind === 'delegated') fail(403, 'google_oauth_admission_forbidden');
      if (!Number.isSafeInteger(req.userData?.userId) || req.userData.userId <= 0 || req.userData.userId > 2147483647
        || typeof req.authSession?.id !== 'string' || !UUID.test(req.authSession.id)
        || !Number.isSafeInteger(req.authSession.expiresAt) || req.authSession.expiresAt * 1000 <= now().getTime()
        || typeof req.headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(req.headers.authorization)) {
        fail(401, 'google_oauth_admission_session_required');
      }
      next();
    } catch (error) { return errorJson(res, error); }
  });
  router.use(require('express').json({ limit: '4kb', strict: true }));
  async function capability(req, selected) {
    if (!installed) return false;
    const value = await runtime.capability(req, selected);
    if (!exact(value, ['enabled']) || typeof value.enabled !== 'boolean') unavailable();
    return value.enabled;
  }
  const emptyBody = req => { if (req.body !== undefined && !exact(req.body, [])) fail(); };
  router.get('/capability', async (req, res) => {
    try {
      emptyBody(req); const selected = selection(req.query, false), enabled = await capability(req, selected);
      return res.json({ mode: 'google_first_admission', ...selected, installed, enabled, canChooseAssets: false });
    } catch (error) { return errorJson(res, error); }
  });
  router.post('/begin', async (req, res) => {
    try {
      if (!exact(req.query, []) || !req.is('application/json')) fail();
      const selected = selection(req.body, true);
      if (!await capability(req, { scopeKey: selected.scopeKey, service: selected.service })) fail(503, 'google_oauth_admission_disabled');
      // Runtime owns original-session/full-scope authority, durable intent,
      // Owner begin and hash registration before returning this consent URL.
      return res.json(localDto(await runtime.begin(req, selected), selected, true));
    } catch (error) { return errorJson(res, error); }
  });
  router.get('/status', async (req, res) => {
    try {
      emptyBody(req); const selected = selection(req.query, true);
      if (!installed) fail(503, 'google_oauth_admission_disabled');
      // Pausing new starts must not suppress existing authenticated status.
      return res.json(localDto(await runtime.status(req, selected), selected, false, completionInstalled));
    } catch (error) { return errorJson(res, error); }
  });
  router.get('/assets', async (req, res) => {
    try {
      emptyBody(req); const selected = selection(req.query, true);
      if (selected.service !== 'search_console') fail();
      if (!completionInstalled) fail(503, 'google_oauth_admission_disabled');
      // Runtime checks the original recorded intent, current normal session,
      // scoped read authority and signed catalogue policy on this request.
      return res.json(assetsDto(await runtime.assets(req, selected), selected));
    } catch (error) { return errorJson(res, error); }
  });
  router.post('/confirm', async (req, res) => {
    try {
      if (!exact(req.query, []) || !req.is('application/json')
        || !exact(req.body, ['attempt_id', 'scope_key', 'google_service', 'clinic_id', 'asset_ref'])) fail();
      const selected = selection({ attempt_id: req.body.attempt_id, scope_key: req.body.scope_key, google_service: req.body.google_service }, true);
      if (selected.service !== 'search_console' || !Number.isSafeInteger(req.body.clinic_id) || req.body.clinic_id <= 0 || req.body.clinic_id > 2147483647
        || typeof req.body.asset_ref !== 'string' || !/^sc:[a-f0-9]{64}$/.test(req.body.asset_ref)
        || selected.scopeKey.startsWith('clinic:') && selected.scopeKey !== 'clinic:' + req.body.clinic_id) fail();
      if (!completionInstalled) fail(503, 'google_oauth_admission_disabled');
      // No extra status/start-capability request: publication owns its fresh
      // authority, exact asset/clinic proof, commit and repeat reconciliation.
      const input = Object.freeze({ ...selected, clinicId: req.body.clinic_id, assetRef: req.body.asset_ref });
      return res.json(publishedDto(await runtime.publish(req, input), selected));
    } catch (error) { return errorJson(res, error); }
  });
  router.use((error, _req, res, _next) => errorJson(res, Object.assign(Error(), { status: error?.type === 'entity.parse.failed'
    || error?.type === 'entity.too.large' ? 400 : 503, code: error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large'
      ? 'google_oauth_admission_attempt_invalid' : 'google_oauth_admission_attempt_unavailable' })));
  const redirect = (res, result) => {
    const target = new URL('/pages/settings', origin.origin); target.searchParams.set('panel', 'connected-accounts');
    if (result) {
      target.searchParams.set('action', 'resume_google_admission'); target.searchParams.set('attempt_id', result.attemptId);
      target.searchParams.set('google_service', result.service); target.searchParams.set('scope_key', result.scopeKey);
      if (result.outcome === 'declined_unresolved') target.searchParams.set('google_admission_outcome', 'declined_unresolved');
    } else target.searchParams.set('google_admission_error', '1');
    headers(res); return res.redirect(303, target.toString());
  };
  return Object.freeze({ router,
    async callback(req, res) {
      if (!installed) return false; // No new table, input parsing or loader call.
      let code;
      try {
        const query = req.query;
        if (typeof query.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(query.state)
          || query.error !== undefined && (typeof query.error !== 'string' || query.error.length > 4096)) fail();
        const denied = Boolean(query.error);
        if (query.code !== undefined && typeof query.code !== 'string' || denied && query.code !== undefined) fail();
        if (!denied) {
          if (typeof query.code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(query.code)) fail();
          code = Buffer.from(query.code, 'ascii');
        }
        // Ignore Google's unrelated scalar scope/authuser/prompt fields. Only
        // typed state/code-or-denial crosses the private callback boundary.
        const result = await runtime.callback(denied ? { state: query.state, denied: true } : { state: query.state, codeBuffer: code });
        if (exact(result, ['recognized']) && result.recognized === false) return false;
        if (!exact(result, ['recognized', 'action', 'returnPath', 'attemptId', 'scopeKey', 'service', 'outcome', 'authorizationState', 'authorizationConfirmed', 'connected'])
          || result.recognized !== true || result.action !== 'resume_google_admission' || result.returnPath !== '/pages/settings'
          || typeof result.attemptId !== 'string' || !UUID.test(result.attemptId) || !validScope(result.scopeKey)
          || !SERVICES.includes(result.service) || result.authorizationConfirmed !== false || result.connected !== false
          || !['pending', 'interrupted', 'aborted', 'expired', 'declined_unresolved'].includes(result.outcome)
          || (result.outcome === 'declined_unresolved' ? result.authorizationState !== null : !STATES.includes(result.authorizationState))
          || ['interrupted', 'aborted', 'expired'].includes(result.outcome) && result.authorizationState !== result.outcome) unavailable();
        redirect(res, result); return true;
      } catch { redirect(res, null); return true; } // Never fall through on a lookup/recognized failure.
      finally { if (code) code.fill(0); }
    },
  });
}
module.exports = { createGoogleOAuthAdmissionHttpAdapter, SERVICES };

'use strict';

const { randomUUID, createHash } = require('node:crypto');
const C = require('./googleOAuthAdmissionAttempt.contract');
const { closed } = require('./googleOAuthAdmissionAuthority.service');
const STATES = Object.freeze(['prepared', 'exchanging', 'candidate_ready', 'stage_intent', 'candidate_staged', 'interrupted', 'aborted', 'expired']);
const PROOF = Object.freeze(['attemptId', 'bindingDigest', 'service', 'expiresAt']);
const DTO = Object.freeze([...PROOF, 'state', 'authorizationConfirmed', 'connected']);
const SCOPES = Object.freeze({ business_profile: 'https://www.googleapis.com/auth/business.manage',
  search_console: 'https://www.googleapis.com/auth/webmasters.readonly', analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  ads: 'https://www.googleapis.com/auth/adwords' });
const fail = () => { throw C.problem('google_oauth_admission_attempt_unavailable', 503); };
function proof(value) {
  if (!C.exact(value, PROOF) || typeof value.attemptId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.attemptId)
    || typeof value.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bindingDigest) || !C.SERVICES.includes(value.service)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) fail();
  return Object.freeze({ ...value });
}
function envelope(context) {
  const value = C.input(context);
  return Object.freeze({ tenantRef: 'clinic:' + value.clinicIds[0], connectionRef: 'google-first:' + value.attemptId,
    assetRef: 'google-oauth:' + value.service + ':' + value.scopeKey,
    clinicSetDigest: createHash('sha256').update(JSON.stringify(value.clinicIds)).digest('hex') });
}
function response(value, expected, { begin = false, validateUrl } = {}) {
  proof(expected);
  const url = begin && Object.hasOwn(value || {}, 'authorizationUrl');
  if (!C.exact(value, url ? [...DTO, 'authorizationUrl'] : DTO)
    || PROOF.some(key => value[key] !== expected[key]) || !STATES.includes(value.state)
    || value.authorizationConfirmed !== false || value.connected !== false || begin && value.state === 'prepared' && !url
    || url && (value.state !== 'prepared' || typeof validateUrl !== 'function')) fail();
  if (url) validateUrl(value.authorizationUrl, expected.service);
  return Object.freeze({ ...value });
}
function createGoogleOAuthAdmissionOwner({ client, clientId, redirectUri } = {}) {
  let redirect;
  try { redirect = new URL(redirectUri); } catch { fail(); }
  if (typeof client?.execute !== 'function' || typeof clientId !== 'string'
    || !/^[A-Za-z0-9._-]{1,256}\.apps\.googleusercontent\.com$/.test(clientId)
    || redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.port || redirect.search || redirect.hash
    || redirect.pathname !== '/oauth/google/callback' || redirect.href !== redirectUri) fail();
  const validateUrl = (raw, service) => {
    if (typeof raw !== 'string' || raw.length > 8192) fail();
    let url; try { url = new URL(raw); } catch { fail(); }
    const keys = ['access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'];
    const actual = [...url.searchParams.keys()].sort();
    const scopes = url.searchParams.get('scope')?.split(' ').sort();
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth'
      || url.username || url.password || url.hash || url.port
      || JSON.stringify(actual) !== JSON.stringify(keys)
      || url.searchParams.get('client_id') !== clientId || url.searchParams.get('redirect_uri') !== redirectUri
      || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256'
      || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge')) || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state'))
      || url.searchParams.get('access_type') !== 'offline' || url.searchParams.get('prompt') !== 'consent'
      || JSON.stringify(scopes) !== JSON.stringify(['openid', 'email', 'profile', SCOPES[service]].sort())) fail();
  };
  async function call(name, supplied, refs, input) {
    let code, payload;
    try {
      const bound = proof(supplied);
      if (!C.exact(refs, ['tenantRef', 'connectionRef', 'assetRef', 'clinicSetDigest'])
        || !/^clinic:[1-9]\d{0,9}$/.test(refs.tenantRef)
        || refs.connectionRef !== 'google-first:' + bound.attemptId
        || !new RegExp('^google-oauth:' + bound.service + ':(clinic|group):[1-9]\\d{0,9}$').test(refs.assetRef)
        || typeof refs.clinicSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(refs.clinicSetDigest)) fail();
      const references = Object.freeze({ tenantRef: refs.tenantRef, connectionRef: refs.connectionRef, assetRef: refs.assetRef });
      payload = { ...bound, clinicSetDigest: refs.clinicSetDigest };
      if (name === 'finish') {
        if (!C.exact(input, ['state', 'codeBuffer']) || typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state)
          || !Buffer.isBuffer(input.codeBuffer) || !input.codeBuffer.length || input.codeBuffer.length > 4096
          || !/^[\x21-\x7e]+$/.test(input.codeBuffer.toString('ascii')) || input.codeBuffer.some(byte => byte < 33 || byte > 126)) throw C.problem();
        code = Buffer.from(input.codeBuffer);
        // The only transient credential-like field sent to Owner is the
        // single-use authorization code. No bearer, session, token or secret
        // reference is accepted. Existing HTTPS client signs this payload.
        payload.state = input.state; payload.code = code.toString('ascii');
      } else if (input !== undefined) throw C.problem();
      const requestId = name === 'begin' ? bound.attemptId : randomUUID();
      const result = await client.execute({ requestId, operation: 'google.oauth.admission.' + name + '.v1',
        ...references, payload }, { timeoutMs: 10000 });
      if (!C.exact(result, ['requestId', 'replayed', 'data']) || result.requestId !== requestId || typeof result.replayed !== 'boolean') fail();
      return response(result.data, bound, { begin: name === 'begin', validateUrl });
    } catch (error) { throw closed(error); }
    finally { if (code) code.fill(0); if (payload) { delete payload.code; delete payload.state; } }
  }
  return Object.freeze(Object.fromEntries(['begin', 'status', 'finish', 'abort'].map(name => [name,
    (bound, refs, input) => call(name, bound, refs, input)])));
}

module.exports = { createGoogleOAuthAdmissionOwner, proof, envelope, response, STATES, SCOPES };

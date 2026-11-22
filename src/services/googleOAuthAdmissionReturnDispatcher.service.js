'use strict';
const C = require('./googleOAuthAdmissionAttempt.contract');
const O = require('./googleOAuthAdmissionOwner.adapter');
const R = require('./googleOAuthAdmissionReturn.contract');
const { closed } = require('./googleOAuthAdmissionAuthority.service');
const ACTION = 'resume_google_admission';
const unavailable = () => { throw C.problem('google_oauth_admission_attempt_unavailable', 503); };

// Private composition only: no route, provider, credential configuration,
// mapping write, background retry or synthetic authenticated request.
function createGoogleOAuthAdmissionReturnDispatcher({ locator, owner, now = () => new Date() } = {}) {
  if (typeof locator?.resolve !== 'function' || typeof locator?.revalidate !== 'function'
    || typeof owner?.status !== 'function' || typeof owner?.finish !== 'function' || typeof now !== 'function') unavailable();
  function handoff(value) {
    if (!C.exact(value, ['proof', 'scope', 'returnPath']) || value.returnPath !== R.RETURN_PATH
      || !C.exact(value.scope, ['tenantRef', 'connectionRef', 'assetRef', 'clinicSetDigest'])) unavailable();
    const checked = O.proof(value.proof), scope = value.scope;
    const proof = O.proof({ attemptId: checked.attemptId, bindingDigest: checked.bindingDigest,
      service: checked.service, expiresAt: checked.expiresAt });
    const prefix = 'google-oauth:' + proof.service + ':';
    if (typeof scope.tenantRef !== 'string' || !/^clinic:[1-9]\d{0,9}$/.test(scope.tenantRef)
      || Number(scope.tenantRef.slice(7)) > 2147483647 || scope.connectionRef !== 'google-first:' + proof.attemptId
      || typeof scope.assetRef !== 'string' || !scope.assetRef.startsWith(prefix)
      || !/^(clinic|group):[1-9]\d{0,9}$/.test(scope.assetRef.slice(prefix.length))
      || Number(scope.assetRef.slice(prefix.length).split(':')[1]) > 2147483647
      || typeof scope.clinicSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(scope.clinicSetDigest)) unavailable();
    const scopeKey = scope.assetRef.slice(prefix.length);
    if (scopeKey.startsWith('clinic:') && scope.tenantRef !== scopeKey) unavailable();
    if (proof.expiresAt <= C.clock(now())) throw C.problem('google_oauth_admission_attempt_conflict', 409);
    return Object.freeze({ proof, scope: Object.freeze({ tenantRef: scope.tenantRef, connectionRef: scope.connectionRef,
      assetRef: scope.assetRef, clinicSetDigest: scope.clinicSetDigest }), returnPath: R.RETURN_PATH });
  }
  function result(bound, state, declined) {
    const outcome = declined ? 'declined_unresolved' : ['interrupted', 'aborted', 'expired'].includes(state) ? state : 'pending';
    return Object.freeze({ recognized: true, action: ACTION, returnPath: R.RETURN_PATH,
      attemptId: bound.proof.attemptId, scopeKey: bound.scope.assetRef.slice(('google-oauth:' + bound.proof.service + ':').length),
      service: bound.proof.service, outcome, authorizationState: state,
      authorizationConfirmed: false, connected: false });
  }
  return Object.freeze({
    async dispatch(input) {
      let code, recognized = false;
      try {
        const declined = C.exact(input, ['state', 'denied']) && input.denied === true;
        if ((!declined && !C.exact(input, ['state', 'codeBuffer'])) || typeof input.state !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw C.problem();
        const state = input.state;
        if (!declined) {
          if (!Buffer.isBuffer(input.codeBuffer) || !input.codeBuffer.length || input.codeBuffer.length > 4096
            || input.codeBuffer.some(byte => byte < 33 || byte > 126)) throw C.problem();
          code = Buffer.from(input.codeBuffer); // Snapshot before the first await.
        }
        const resolved = await locator.resolve({ state });
        if (resolved?.recognized === true) recognized = true;
        if (C.exact(resolved, ['recognized']) && resolved.recognized === false) return Object.freeze({ recognized: false });
        if (!C.exact(resolved, ['recognized', 'locator']) || resolved.recognized !== true
          || !resolved.locator || typeof resolved.locator !== 'object' || Array.isArray(resolved.locator)
          || Reflect.ownKeys(resolved.locator).length) unavailable();
        const original = handoff(await locator.revalidate(resolved.locator));
        const revalidate = async () => {
          const fresh = handoff(await locator.revalidate(resolved.locator));
          if (JSON.stringify(fresh) !== JSON.stringify(original)) throw C.problem('google_oauth_admission_attempt_conflict', 409);
        };
        if (declined) {
          // No durable-cancel interface is exported by the locator. Report
          // the decline honestly without inventing an aborted/cancelled phase.
          return result(original, null, true);
        }
        async function call(name, transient) {
          let received, failure;
          try { received = await owner[name](original.proof, original.scope, transient); }
          catch (error) { failure = error; }
          // Recheck even when ACK is unknown. No result/code is replayed as
          // part of error recovery; the next explicit return uses status.
          await revalidate();
          if (failure) throw failure;
          return O.response(received, original.proof);
        }
        let remote = await call('status');
        if (remote.state === 'prepared') {
          // The revalidation immediately above followed awaited status and
          // checked current local prepared state, session and exact scope.
          remote = await call('finish', Object.freeze({ state, codeBuffer: code }));
          if (remote.state === 'prepared') unavailable(); // Finish must burn before replying.
        }
        return result(original, remote.state, false);
      } catch (error) {
        throw Object.assign(closed(error), recognized || error?.recognized === true ? { recognized: true } : {});
      } finally { if (code) code.fill(0); }
    },
  });
}
module.exports = { createGoogleOAuthAdmissionReturnDispatcher, ACTION };

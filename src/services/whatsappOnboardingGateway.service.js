'use strict';
const S = require('./whatsappAuthorizationState.contract');
const C = require('../../services/integrations-broker/src/whatsapp-onboarding-contract');
const { configuredClient, assertGateway } = require('../lib/whatsappOnboardingBrokerClient');
const STATUS = Object.freeze({ whatsapp_authorization_invalid: 400, whatsapp_authorization_forbidden: 403,
  whatsapp_authorization_conflict: 409, whatsapp_authorization_expired: 410, whatsapp_authorization_consumed: 409,
  whatsapp_authorization_cancelled: 409, whatsapp_authorization_busy: 409, whatsapp_authorization_limit: 429, auth_invalid: 401, auth_email_verification_required: 403,
  auth_configuration_invalid: 503, meta_security_state_unavailable: 503, whatsapp_onboarding_disabled: 503,
  whatsapp_onboarding_configuration_invalid: 503, whatsapp_authorization_unavailable: 503,
  whatsapp_onboarding_binding_invalid: 503, whatsapp_onboarding_broker_unavailable: 503, whatsapp_onboarding_result_unknown: 503 });
function safe(error) {
  const code = Object.hasOwn(STATUS, error?.code) ? error.code : 'whatsapp_authorization_unavailable';
  return { code, status: STATUS[code], outcomeUnknown: code === 'whatsapp_onboarding_result_unknown' };
}
function request(raw, name) {
  if (name !== 'finish') return S.request(raw, name === 'begin' ? 'issue' : name === 'cancel' ? 'cancel' : 'status');
  S.exact(raw, ['requestId','userId','sessionRef','sessionExpiresAt','state','code','wabaId','phoneId']);
  const { wabaId, phoneId, ...rest } = raw;
  if (!C.id(wabaId) || phoneId !== null && !C.id(phoneId)) S.fail();
  return { ...S.request(rest, 'claim'), wabaId, phoneId };
}
const actor = input => Object.fromEntries(['requestId','userId','sessionRef','sessionExpiresAt'].map(k => [k, input[k]]));
function project(local, remote, state) {
  // A persisted candidate remains an authorization receipt after the short
  // OAuth exchange window ends. It is never permission to send or re-exchange.
  const status = local.status === 'cancelled' || remote.status === 'aborted' ? 'cancelled'
    : remote.status === 'staged' ? remote.accessBlocked || remote.configurationChanged ? 'blocked' : 'awaiting_activation'
      : local.status === 'expired' || remote.expired ? 'expired' : remote.accessBlocked || remote.configurationChanged ? 'blocked'
      : ({ awaiting: local.status === 'claimed' ? 'processing' : 'awaiting_authorization', exchanging: 'processing', staging: 'processing',
        staged: 'awaiting_activation', interrupted: 'interrupted', aborted: 'cancelled' })[remote.status];
  const result = { requestId: local.requestId, authorizationStatus: status, connected: false,
    channelRole: S.channelRole(local.channelRole), pending: ['awaiting_authorization','processing','awaiting_activation'].includes(status),
    expiresAt: local.expiresAt, scope: { ...local.scope }, clinicCount: local.clinicIds.length,
    cancellationConfirmed: local.status === 'cancelled' && remote.status === 'aborted',
    selected: status === 'awaiting_activation' ? { wabaId: remote.candidate.wabaId, phoneId: remote.candidate.phoneId } : null,
    phoneState: status === 'awaiting_activation' ? remote.phoneState ?? null : null };
  if (state && status === 'awaiting_authorization') result.authorization = { ...remote.authorization, state };
  return result;
}
function createService({ states = require('./whatsappAuthorizationState.service'), broker = configuredClient(), guard = assertGateway } = {}) {
  // Best effort only: the durable local cancellation or broker expiry remains
  // authoritative when transport is unavailable. Never report a remote ACK.
  const abort = async row => { try { await broker.abort(row); } catch {} };
  async function recheck(input, row, claimed = false) {
    try { guard(); return await states[claimed ? 'assertClaimActive' : 'status'](actor(input)); }
    catch (error) { await abort(row); throw error; }
  }
  async function run(name, raw) {
    try {
      guard(); const input = request(raw, name);
      if (name === 'begin') {
        const local = await states.issue(input);
        const result = await broker.begin(local);
        const fresh = await recheck(input, local);
        return project(fresh, result, local.state);
      }
      if (name === 'cancel') {
        const local = await states.cancel(actor(input));
        const result = await broker.abort(local);
        guard(); const fresh = await states.cancel(actor(input));
        return project(fresh, result);
      }
      if (name === 'status') {
        const local = await states.status(actor(input));
        const result = await broker[local.status === 'cancelled' ? 'abort' : 'status'](local);
        return project(await recheck(input, local), result);
      }
      let local;
      try { local = await states.claim({ ...actor(input), state: input.state, code: input.code }); }
      catch (error) {
        // A duplicate callback may inspect the same authorized attempt only.
        // No response/error can grant a second permission to submit its code.
        if (error?.code === 'whatsapp_authorization_consumed') return await run('status', actor(input));
        throw error;
      }
      if (local.mayExchange !== true) S.fail('whatsapp_authorization_conflict', 409);
      await recheck(input, local, true);
      const result = await broker.finish(local, { state: input.state, code: input.code, wabaId: input.wabaId, phoneId: input.phoneId });
      return project(await recheck(input, local, true), result);
    } catch (error) {
      const clean = safe(error);
      throw Object.assign(Error(clean.code), { code: clean.code, status: clean.status, httpStatus: clean.status, outcomeUnknown: clean.outcomeUnknown });
    }
  }
  return Object.freeze(Object.fromEntries(['begin','finish','status','cancel'].map(name => [name, input => run(name, input)])));
}
module.exports = { createService, safe, project, ...createService() };

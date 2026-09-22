'use strict';
const path = require('node:path'); const { DatabaseSync } = require('node:sqlite');
const E = require('./whatsapp-onboarding-contract'); const C = require('./whatsapp-authorized-contract'); const { BrokerError, fail } = require('./errors');
const M = require('./whatsapp-template-management');
const R = require('./whatsapp-inbound-media');
function validateAuthorization(value) {
  if (!C.keys(value, ['connectionRef','authorizationId','enrollmentBinding','phoneId','wabaId','candidateDigest','expiresAt'], ['enabled','templates'])
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.connectionRef) || !E.uuid(value.authorizationId)
    || !E.id(value.phoneId) || !E.id(value.wabaId) || !/^[a-f0-9]{64}$/.test(value.candidateDigest)
    || value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) || value.enabled !== undefined && typeof value.enabled !== 'boolean'
    || value.templates !== undefined && (!Array.isArray(value.templates) || value.templates.length > 1000)) fail('invalid_request');
  const enrollment = E.bindingFor(value.enrollmentBinding);
  if (!enrollment.customer) fail('invalid_request');
  for (const t of value.templates || []) if (!C.keys(t, ['id','name','language','contentDigest']) || !E.id(t.id)
    || !/^[a-z0-9_]{1,512}$/.test(t.name) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(t.language)
    || !/^[a-f0-9]{64}$/.test(t.contentDigest)) fail('invalid_request');
  if (new Set((value.templates || []).map(t => t.id)).size !== (value.templates || []).length
    || new Set((value.templates || []).map(t => t.name + ':' + t.language)).size !== (value.templates || []).length) fail('invalid_request');
  return { ...structuredClone(value), enabled: value.enabled === true };
}
function createWhatsappAuthorizedRegistry({ filename, authorizations, loadEnrollmentBinding, loadAuthorizations = () => [], now = () => Date.now() }) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !Array.isArray(authorizations) || !authorizations.length
    || authorizations.length > 1000 || typeof loadEnrollmentBinding !== 'function' || typeof now !== 'function') fail('invalid_request');
  const entries = authorizations.map(validateAuthorization);
  if (new Set(entries.map(v => v.connectionRef)).size !== entries.length || new Set(entries.map(v => v.authorizationId)).size !== entries.length
    || new Set(entries.map(v => v.phoneId)).size !== entries.length) fail('invalid_request');
  const db = new DatabaseSync(filename, { readOnly: true }); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000'); let closed = false;
  function inspect(binding, review = false) {
    if (closed || binding?.provider !== C.PROVIDER) fail('scope_denied');
    // Existing pinned connections remain independent of a new enrollment.
    // A conflicting dynamic identity is rejected for that new connection only.
    let definition = entries.find(v => v.connectionRef === binding.connectionRef);
    if(!definition){
      const dynamic=loadAuthorizations().map(validateAuthorization);
      definition=dynamic.find(v=>v.connectionRef===binding.connectionRef);
      if(definition)for(const key of ['connectionRef','authorizationId','phoneId'])
        if([...entries,...dynamic].filter(v=>v[key]===definition[key]).length!==1)fail('scope_denied');
    }
    if (!definition || !review && !definition.enabled || definition.expiresAt !== null && definition.expiresAt <= now()) fail('connection_blocked');
    const enrollmentBinding = definition.enrollmentBinding; const b = E.bindingFor(enrollmentBinding);
    const current = loadEnrollmentBinding(enrollmentBinding.connectionRef);
    if (!current || E.fingerprint(current) !== E.fingerprint(enrollmentBinding)) fail('connection_blocked');
    const row = db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(definition.authorizationId);
    if (!row || row.state !== 'staged' || row.connection !== enrollmentBinding.connectionRef || row.config_digest !== E.fingerprint(enrollmentBinding)
      || row.principal !== 'gateway:whatsapp-onboarding' || row.tenant !== 'clinic:' + b.clinicIds[0] || row.asset !== 'wa-enroll:' + b.scopeKey
      || row.clinic_digest !== E.clinicDigest(b) || row.clinic_count !== b.clinicIds.length || !/^[a-f0-9]{64}$/.test(row.scope_digest)
      || row.phone_id !== definition.phoneId || row.waba_id !== definition.wabaId || row.secret_digest !== definition.candidateDigest) fail('scope_denied');
    const metadata = E.grantMetadata(JSON.parse(row.credential_metadata), enrollmentBinding);
    if (metadata.phoneId !== definition.phoneId || metadata.wabaId !== definition.wabaId) fail('scope_denied');
    if ([metadata.expiresAt, metadata.dataAccessExpiresAt].some(v => v !== null && v <= now())) fail('credential_revoked');
    for (const key of new Set([b.scopeKey, ...b.clinicIds.map(id => 'clinic:' + id)]))
      if (db.prepare('SELECT 1 FROM whatsapp_onboarding_scope_blocks WHERE scope_key=?').get(key)) fail('asset_revoked');
    const connection = db.prepare('SELECT * FROM connections WHERE ref=?').get(row.connection);
    if (!connection || connection.state !== 'active' || connection.expires_at !== null && connection.expires_at <= now()) fail('connection_blocked');
    if (db.prepare('SELECT 1 FROM asset_revocations WHERE tenant=? AND connection=? AND asset IN (?,?)')
      .get(row.tenant, row.connection, row.asset, 'wa-phone:' + row.phone_id)) fail('asset_revoked');
    const matches = a => a && a.connection === row.connection && a.tenant === row.tenant && a.asset === row.asset
      && a.scope_digest === row.scope_digest && a.clinic_digest === row.clinic_digest;
    const phone = db.prepare('SELECT * FROM whatsapp_onboarding_assets WHERE phone_id=?').get(row.phone_id);
    if (!matches(phone) || phone.waba_id !== row.waba_id) fail('scope_denied');
    for (const wabaId of b.customer.selectionOnly ? [row.waba_id] : metadata.grantedWabaIds) {
      const reservation = db.prepare('SELECT * FROM whatsapp_onboarding_wabas WHERE waba_id=?').get(wabaId);
      if (reservation ? !matches(reservation) : !b.customer.selectionOnly) fail('scope_denied');
    }
    // The OAuth exchange deadline is deliberately historical after staged;
    // an optional operator deadline and real provider credential expiries still
    // apply. Null is an ongoing local grant, never a bypass for revocation.
    return { definition: structuredClone(definition), enrollmentBinding: structuredClone(enrollmentBinding), row: { ...row }, metadata };
  }
  function read(binding, review = false) {
    let began = false;
    try { if (closed) fail('connection_blocked'); db.exec('BEGIN'); began = true; const value = inspect(binding, review); db.exec('COMMIT'); began = false; return value; }
    catch (e) { if (began) try { db.exec('ROLLBACK'); } catch {} throw new BrokerError(e instanceof BrokerError ? e.code : 'connection_blocked'); }
  }
  return Object.freeze({
    assert: binding => read(binding),
    // Administrator CLI only: inspect a paused authorization without promoting
    // it. Every expiry, credential, scope and revocation check still applies.
    review: binding => read(binding, true),
    authorize({ request, binding, principal }) {
      const value = this.assert(binding); const b = E.bindingFor(value.enrollmentBinding);
      if (request.assetRef !== 'wa-phone:' + value.definition.phoneId || !b.clinicIds.some(id => request.tenantRef === 'clinic:' + id)
        || (request.operation === C.SEND || request.operation === R.READ || M.OPERATIONS.includes(request.operation)) && (!['staging:whatsapp','dev:whatsapp'].includes(principal.id) || request.payload.authorizationId !== value.definition.authorizationId
          || request.payload.phoneId !== value.definition.phoneId)
        || request.operation === C.REVOKE && principal.id !== 'control:whatsapp') fail('scope_denied');
      if (![C.SEND,C.REVOKE,R.READ,...M.OPERATIONS].includes(request.operation)) fail('operation_denied'); return value;
    },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
module.exports = { validateAuthorization, createWhatsappAuthorizedRegistry };

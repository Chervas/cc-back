'use strict';

// Read-only first-profile inventory. This is not an enrollment authority: it
// cannot create a scope, grant, mapping or association, or replace a retired one.
const { Op } = require('sequelize');
const C = require('./businessProfileAssociation.contract');
const O = require('./googleOAuthCohort.contract');
const contexts = new WeakMap();
const plain = row => row?.get ? row.get({ plain: true }) : row;
const INPUT = ['clinicId', 'scopeKey', 'connectionId', 'actorId', 'sessionRef', 'sessionExpiresAt'].sort().join(',');
const CODES = new Set(['gbp_first_profile_disabled', 'gbp_first_profile_existing_scope', 'gbp_first_profile_existing_history',
  'gbp_first_profile_scope_changed', 'gbp_first_profile_limit', 'gbp_first_profile_unavailable',
  'gbp_association_invalid', 'gbp_association_session_required', 'gbp_association_own_session_required',
  'gbp_association_identity_mismatch', 'gbp_association_scope_unconfigured', 'gbp_association_inherited_asset',
  'gbp_association_scope_changed',
  'scope_denied', 'asset_revoked', 'connection_blocked', 'credential_revoked', 'oauth_identity_mismatch',
  'provider_unauthorized', 'provider_failed', 'provider_timeout', 'broker_timeout', 'broker_unavailable',
  'broker_response_invalid', 'rate_limited', 'audit_unavailable', 'operation_denied', 'secret_unavailable']);
const safe = error => CODES.has(error?.code) ? error.code : 'gbp_first_profile_unavailable';
const status = error => ['scope_denied', 'operation_denied', 'gbp_association_own_session_required'].includes(safe(error)) ? 403
  : /session_required$/.test(safe(error)) ? 401
    : safe(error) === 'gbp_association_invalid' ? 400 : safe(error) === 'rate_limited' ? 429
      : ['gbp_first_profile_existing_scope', 'gbp_first_profile_existing_history', 'gbp_first_profile_scope_changed',
        'gbp_association_identity_mismatch', 'gbp_association_scope_unconfigured', 'gbp_association_inherited_asset',
        'gbp_association_scope_changed', 'asset_revoked', 'oauth_identity_mismatch'].includes(safe(error)) ? 409 : 503;
const fail = code => C.fail(code || 'gbp_first_profile_unavailable');
const enabledByDefault = () => ['GOOGLE_BUSINESS_PROFILE_FIRST_PROFILE_ENABLED', 'GOOGLE_BUSINESS_PROFILE_ASSOCIATION_ENABLED',
  'GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED', 'GOOGLE_OAUTH_BROKER_ENABLED'].every(key => process.env[key] === 'true');

async function inspectContext(handle) {
  const context = handle && contexts.get(handle);
  if (!context) fail('gbp_association_invalid');
  return context();
}

function createFirstProfileService({ models, sessions, client, enabled = enabledByDefault, now = Date.now }) {
  const m = () => typeof models === 'function' ? models() : models;
  const ownSessions = () => sessions || require('./accessSession.service');
  const broker = () => client || require('./businessProfileAssociationClient.service').configuredClient();
  const gate = () => { if (!enabled()) fail('gbp_first_profile_disabled'); };
  const bounded = rows => {
    if (!Array.isArray(rows) || rows.length > 1000) fail('gbp_first_profile_limit');
    return rows.map(plain);
  };
  function actor(input) {
    if (!input || Object.keys(input).sort().join(',') !== INPUT
      || ![input.clinicId, input.connectionId, input.actorId].every(id => Number.isSafeInteger(id) && C.positive(id))
      || input.scopeKey !== 'clinic:' + input.clinicId || !C.UUID.test(input.sessionRef)
      || !Number.isSafeInteger(input.sessionExpiresAt) || input.sessionExpiresAt <= now()) fail('gbp_association_session_required');
  }
  async function snapshot(input, expected, work) {
    actor(input); gate(); const db = m();
    return db.sequelize.transaction(async transaction => {
      if (!transaction?.LOCK?.UPDATE || transaction.finished) fail();
      const q = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
      const clinic = plain(await db.Clinica.findByPk(input.clinicId, { ...q, attributes: ['id_clinica', 'grupoClinicaId'] }));
      if (!clinic || Number(clinic.id_clinica) !== input.clinicId) fail('scope_denied');
      const oauth = plain(await db.GoogleOAuthBrokerBinding.findOne({ ...q, attributes: [...O.FIELDS, 'confirmed_at'],
        where: { google_connection_id: input.connectionId, cohort: 'business_profile' } }));
      if (!oauth || O.cohortOf(O.validate(oauth)) !== 'business_profile' || oauth.policy_version !== O.POLICY
        || !oauth.confirmed_at || !Number.isFinite(+new Date(oauth.confirmed_at)) || +new Date(oauth.confirmed_at) > now()) fail('gbp_association_identity_mismatch');
      try {
        await require('./googleOAuthCohortScope.service').authorizeConnection({ models: db, connectionId: input.connectionId,
          subject: oauth.google_user_id, requestScopeKey: input.scopeKey, actorId: input.actorId,
          sessionRef: input.sessionRef, expiresAt: new Date(input.sessionExpiresAt), transaction, sessions: ownSessions() });
      } catch (error) {
        if (['google_oauth_scope_forbidden', 'scope_denied'].includes(error?.code)) fail('scope_denied');
        if (error?.code === 'auth_invalid' || /TokenExpired|JsonWebToken|NotBefore/.test(error?.name || '')) fail('gbp_association_session_required');
        fail('gbp_first_profile_scope_changed');
      }
      const keys = [input.scopeKey, ...(clinic.grupoClinicaId != null ? ['group:' + Number(clinic.grupoClinicaId)] : [])];
      const assignments = bounded(await db.GoogleConnectionAssignment.findAll({ ...q,
        attributes: ['scopeKey', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status'],
        where: { scopeKey: { [Op.in]: keys } }, order: [['scopeKey', 'ASC']], limit: 1001 }));
      const selected = keys.map(key => assignments.filter(row => row.scopeKey === key)).find(rows => rows.length);
      if (selected?.length !== 1 || selected[0].status !== 'active' || Number(selected[0].googleConnectionId) !== input.connectionId) fail('scope_denied');
      const scope = plain(await db.BusinessProfileAssociationScope.findByPk(input.scopeKey, { ...q, attributes: ['scope_key', 'state'] }));
      if (scope !== null) fail('gbp_first_profile_existing_scope');
      const group = clinic.grupoClinicaId == null ? null : plain(await db.GrupoClinica.findByPk(Number(clinic.grupoClinicaId), {
        ...q, attributes: ['id_grupo', 'business_profile_assignment_mode', 'business_profile_primary_location_id'] }));
      const shares = bounded(await db.GroupAssetClinicAssignment.findAll({ ...q,
        attributes: ['assetId', 'clinicaId', 'grupoClinicaId'], where: { assetType: 'google.business_profile', clinicaId: input.clinicId }, limit: 1001 }));
      if (clinic.grupoClinicaId != null && !group || group?.business_profile_assignment_mode === 'group' || shares.length) fail('gbp_association_inherited_asset');
      if (await db.BusinessProfileBrokerRevocation.findOne({ ...q, attributes: ['external_location_id'], where: { clinica_id: input.clinicId } })) fail('asset_revoked');
      for (const name of ['ClinicBusinessLocation', 'BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindingGeneration', 'BusinessProfileAssociationRequest']) {
        const row = await db[name].findOne({ ...q, attributes: [name === 'ClinicBusinessLocation' ? 'id' : 'clinica_id'], where: { clinica_id: input.clinicId } });
        if (row !== null) fail('gbp_first_profile_existing_history');
      }
      const fingerprint = C.hash({ input, clinic, oauth: O.digest(oauth), confirmedAt: new Date(oauth.confirmed_at).toISOString(), assignments, group });
      if (expected && fingerprint !== expected) fail('gbp_first_profile_scope_changed');
      const captured = { fingerprint, scope: { clinica_id: input.clinicId, connection_ref: oauth.connection_ref, scope_ref: 'gbp-enroll:' + input.scopeKey } };
      if (work) await work(db, q);
      actor(input); gate(); return captured;
    });
  }
  async function eligibleTargets(input, fingerprint, targets) {
    const ids = targets.map(target => C.resource(target.locationName, 'locations'));
    const conflicts = new Set();
    await snapshot(input, fingerprint, async (db, q) => {
      if (!ids.length) return;
      // Collision inventory grants nothing and must not range-lock all clinic
      // locations while matching historical account-prefixed resource names.
      // The exact own-scope authority is checked before and after this read.
      const { lock, ...read } = q;
      const rows = bounded(await db.ClinicBusinessLocation.findAll({ ...read, attributes: ['location_id'], limit: 1001, where: {
        [Op.or]: [{ location_id: { [Op.in]: ids.flatMap(id => [id, 'locations/' + id]) } },
          ...ids.map(id => ({ location_id: { [Op.like]: '%/locations/' + id } }))] } }));
      for (const row of rows) conflicts.add(C.location(row.location_id));
      for (const name of ['BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindingGeneration', 'BusinessProfileBrokerRevocation']) {
        for (const row of bounded(await db[name].findAll({ ...read, attributes: ['external_location_id'],
          where: { external_location_id: { [Op.in]: ids } }, limit: 1001 }))) conflicts.add(row.external_location_id);
      }
    });
    return targets.filter(target => !target.reassociation && !conflicts.has(C.resource(target.locationName, 'locations')));
  }
  let active = 0;
  return {
    async preflight(input) {
      actor(input); input = Object.freeze({ ...input });
      if (!enabled()) return { enabled: false, clinicId: input.clinicId, canDiscover: false, canPrepare: false, reason: 'gbp_first_profile_disabled' };
      const captured = await snapshot(input);
      return { enabled: true, clinicId: input.clinicId, canDiscover: true, canPrepare: false,
        sourceFingerprint: captured.fingerprint, reason: 'owner_scope_required' };
    },
    async candidates(input) {
      actor(input); input = Object.freeze({ ...input }); gate(); if (active >= 4) fail('rate_limited'); active++;
      const handle = Object.freeze({});
      try {
        const captured = await snapshot(input), deadline = now() + 60000;
        contexts.set(handle, async () => {
          if (now() >= deadline) fail('provider_timeout');
          const latest = await snapshot(input, captured.fingerprint);
          if (now() >= deadline) fail('provider_timeout');
          return latest.scope;
        });
        // A missing Owner scope/grant denies this call. No legacy/global
        // inventory or operator descriptor can be substituted for that ACL.
        const targets = await broker().discoverFirstProfile(handle);
        if (!Array.isArray(targets) || targets.length > 1000) fail('broker_response_invalid');
        const accepted = await eligibleTargets(input, captured.fingerprint, targets);
        await inspectContext(handle);
        const accounts = new Map();
        for (const target of accepted) {
          if (!accounts.has(target.accountName)) accounts.set(target.accountName, { accountName: target.accountName,
            accountDisplayName: target.rawLocation.accountDisplayName || target.accountName, locations: [] });
          accounts.get(target.accountName).locations.push({ locationId: target.locationName, name: target.name, address: target.address });
        }
        return { enabled: true, clinicId: input.clinicId, sourceFingerprint: captured.fingerprint,
          inventory_mode: 'broker_first_profile_candidates', canPrepare: false, accounts: [...accounts.values()] };
      } finally { contexts.delete(handle); active--; }
    },
  };
}
let instance;
const get = () => instance ||= createFirstProfileService({ models: () => require('../../models') });
module.exports = { createFirstProfileService, inspectContext, safe, status,
  preflight: (...args) => get().preflight(...args), candidates: (...args) => get().candidates(...args) };

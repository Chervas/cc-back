'use strict';

// First-profile inventory and explicit local admission under an existing Owner
// ACL. Never adds Owner permissions, changes identity or adopts retired assets.
const { Op } = require('sequelize');
const C = require('./businessProfileAssociation.contract');
const O = require('./googleOAuthCohort.contract');
const contexts = new WeakMap();
const admissions = new WeakMap();
const plain = row => row?.get ? row.get({ plain: true }) : row;
const INPUT = ['clinicId', 'scopeKey', 'connectionId', 'actorId', 'sessionRef', 'sessionExpiresAt'].sort().join(',');
const CODES = new Set(['gbp_first_profile_disabled', 'gbp_first_profile_existing_scope', 'gbp_first_profile_existing_history',
  'gbp_first_profile_scope_changed', 'gbp_first_profile_limit', 'gbp_first_profile_unavailable',
  'gbp_association_invalid', 'gbp_association_session_required', 'gbp_association_own_session_required',
  'gbp_association_identity_mismatch', 'gbp_association_scope_unconfigured', 'gbp_association_inherited_asset',
  'gbp_association_scope_changed',
  'gbp_association_campaign_dependency', 'gbp_association_review_link_unavailable', 'gbp_association_not_found',
  'gbp_association_target_forbidden', 'gbp_association_location_in_use', 'gbp_association_busy', 'idempotency_conflict',
  'scope_denied', 'asset_revoked', 'connection_blocked', 'credential_revoked', 'oauth_identity_mismatch',
  'provider_unauthorized', 'provider_failed', 'provider_timeout', 'broker_timeout', 'broker_unavailable',
  'broker_response_invalid', 'rate_limited', 'audit_unavailable', 'operation_denied', 'secret_unavailable']);
const safe = error => CODES.has(error?.code) ? error.code : 'gbp_first_profile_unavailable';
const status = error => ['scope_denied', 'operation_denied', 'gbp_association_own_session_required'].includes(safe(error)) ? 403
  : /session_required$/.test(safe(error)) ? 401
    : safe(error) === 'gbp_association_invalid' ? 400 : ['rate_limited','gbp_association_busy'].includes(safe(error)) ? 429
      : ['gbp_first_profile_existing_scope', 'gbp_first_profile_existing_history', 'gbp_first_profile_scope_changed',
        'gbp_association_identity_mismatch', 'gbp_association_scope_unconfigured', 'gbp_association_inherited_asset',
        'gbp_association_scope_changed', 'gbp_association_campaign_dependency', 'gbp_association_review_link_unavailable',
        'gbp_association_target_forbidden', 'gbp_association_location_in_use', 'idempotency_conflict', 'asset_revoked', 'oauth_identity_mismatch'].includes(safe(error)) ? 409 : 503;
const fail = code => C.fail(code || 'gbp_first_profile_unavailable');
const enabledByDefault = () => ['GOOGLE_BUSINESS_PROFILE_FIRST_PROFILE_ENABLED', 'GOOGLE_BUSINESS_PROFILE_ASSOCIATION_ENABLED',
  'GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED', 'GOOGLE_OAUTH_BROKER_ENABLED'].every(key => process.env[key] === 'true');

async function inspectContext(handle) {
  const context = handle && contexts.get(handle);
  if (!context) fail('gbp_association_invalid');
  return context();
}
async function inspectAdmission(handle, input) {
  const check = handle && admissions.get(handle);
  if (!check) fail('gbp_association_invalid');
  return check(input);
}

function createFirstProfileService({ models, sessions, client, audit, repository, associationService, enabled = enabledByDefault, now = Date.now }) {
  const m = () => typeof models === 'function' ? models() : models;
  const ownSessions = () => sessions || require('./accessSession.service');
  const broker = () => client || require('./businessProfileAssociationClient.service').configuredClient();
  let repo, association;
  const getRepo = () => repository || (repo ||= require('./businessProfileAssociation.repository').createRepositoryForAssociation({
    models, sessions: ownSessions(), audit, now: () => new Date(now()), enabled }));
  const ordinary = () => associationService || (association ||= require('./businessProfileAssociation.service').createAssociationService({
    models, sessions: ownSessions(), client: broker(), repository: getRepo(), audit, now: () => new Date(now()), enabled }));
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
  async function cancelledReservation(db,q,input,scope,oauth) {
    if(scope.state!=='active'||scope.scope_key!==input.scopeKey||Number(scope.clinica_id)!==input.clinicId
      ||Number(scope.google_connection_id)!==input.connectionId||scope.google_user_id!==oauth.google_user_id
      ||scope.connection_ref!==oauth.connection_ref||scope.scope_ref!=='gbp-enroll:'+input.scopeKey)fail('gbp_first_profile_existing_scope');
    const accounts=C.array(scope.account_ids),locations=C.array(scope.location_ids);
    if(accounts.length!==1||locations.length!==1||!C.external(accounts[0])||!C.external(locations[0]))fail('gbp_first_profile_existing_scope');
    const requests=bounded(await db.BusinessProfileAssociationRequest.findAll({...q,where:{clinica_id:input.clinicId},order:[['attempt_id','ASC']],limit:1001}));
    if(!requests.length)fail('gbp_first_profile_existing_scope');
    for(const row of requests){
      const marker=C.object(C.object(row.target_snapshot).firstProfileAdmission);
      if(marker.version!==1||!C.HASH.test(marker.sourceFingerprint)||row.state!=='cancelled'||row.lease_token!=null||row.lease_until!=null
        ||row.scope_key!==input.scopeKey||Number(row.google_connection_id)!==input.connectionId||row.google_user_id!==oauth.google_user_id
        ||row.connection_ref!==oauth.connection_ref||row.scope_ref!==scope.scope_ref||row.previous_asset_ref!==null||row.source_mapping_id!==null
        ||row.current_snapshot!==null||!C.positive(row.target_mapping_id))fail('gbp_first_profile_existing_history');
    }
    if(!requests.some(row=>row.account_id===accounts[0]&&row.location_id===locations[0]))fail('gbp_first_profile_existing_scope');
    const mappings=bounded(await db.ClinicBusinessLocation.findAll({...q,where:{clinica_id:input.clinicId},order:[['id','ASC']],limit:1001}));
    if(mappings.length!==requests.length||new Set(requests.map(row=>Number(row.target_mapping_id))).size!==requests.length)fail('gbp_first_profile_existing_history');
    for(const row of mappings){
      const request=requests.find(value=>Number(value.target_mapping_id)===Number(row.id));
      if(!request||row.is_active||Number(row.google_connection_id)!==input.connectionId||C.location(row.location_id)!==request.location_id
        ||row.broker_read_connection_ref!==oauth.connection_ref||row.broker_read_asset_ref!==`gbp:${request.account_id}:${request.location_id}`)fail('gbp_first_profile_existing_history');
    }
    const bindings=bounded(await db.BusinessProfileBrokerBinding.findAll({...q,where:{clinica_id:input.clinicId},order:[['external_location_id','ASC']],limit:1001}));
    const generations=bounded(await db.BusinessProfileBrokerBindingGeneration.findAll({...q,where:{clinica_id:input.clinicId},order:[['generation_id','ASC']],limit:1001}));
    for(const row of [...bindings,...generations]){
      const request=requests.find(value=>value.attempt_id===row.association_attempt_id);
      if(!request||row.state!=='retired'||Number(row.google_connection_id)!==input.connectionId||row.external_location_id!==request.location_id
        ||row.connection_ref!==oauth.connection_ref||row.asset_ref!==`gbp:${request.account_id}:${request.location_id}`)fail('gbp_first_profile_existing_history');
      if(row.generation_id!=null&&Number(row.mapping_id)!==Number(request.target_mapping_id))fail('gbp_first_profile_existing_history');
    }
    if(bindings.some(row=>row.current_generation_id!=null&&!generations.some(generation=>generation.generation_id===row.current_generation_id)))fail('gbp_first_profile_existing_history');
    if(new Set(bindings.map(row=>row.external_location_id)).size!==new Set(requests.map(row=>row.location_id)).size)fail('gbp_first_profile_existing_history');
    return {previousScope:{...scope,account_ids:accounts,location_ids:locations},locations:[...new Set(requests.map(row=>row.location_id))],
      digest:C.hash({requests,mappings,bindings,generations})};
  }
  async function snapshot(input, expected, work, existingTransaction = null) {
    actor(input); gate(); const db = m();
    const read = async transaction => {
      if (!transaction?.LOCK?.UPDATE || transaction.finished) fail();
      const q = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
      const scope = plain(await db.BusinessProfileAssociationScope.findByPk(input.scopeKey, { ...q }));
      const clinic = plain(await db.Clinica.findByPk(input.clinicId, { ...q, attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] }));
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
      let recovery=null;
      if(scope!==null)recovery=await cancelledReservation(db,q,input,scope,oauth);
      const group = clinic.grupoClinicaId == null ? null : plain(await db.GrupoClinica.findByPk(Number(clinic.grupoClinicaId), {
        ...q, attributes: ['id_grupo', 'business_profile_assignment_mode', 'business_profile_primary_location_id'] }));
      const shares = bounded(await db.GroupAssetClinicAssignment.findAll({ ...q,
        attributes: ['assetId', 'clinicaId', 'grupoClinicaId'], where: { assetType: 'google.business_profile', clinicaId: input.clinicId }, limit: 1001 }));
      if (clinic.grupoClinicaId != null && !group || group?.business_profile_assignment_mode === 'group' || shares.length) fail('gbp_association_inherited_asset');
      if (await db.BusinessProfileBrokerRevocation.findOne({ ...q, attributes: ['external_location_id'], where: { clinica_id: input.clinicId } })) fail('asset_revoked');
      for (const name of scope===null?['ClinicBusinessLocation', 'BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindingGeneration', 'BusinessProfileAssociationRequest']:[]) {
        const row = await db[name].findOne({ ...q, attributes: [name === 'ClinicBusinessLocation' ? 'id' : 'clinica_id'], where: { clinica_id: input.clinicId } });
        if (row !== null) fail('gbp_first_profile_existing_history');
      }
      const impact = await require('./businessProfileReviewImpact.service').readReviewImpact({ models: db, clinic, transaction });
      const fingerprint = C.hash({ input, clinic, oauth: O.digest(oauth), confirmedAt: new Date(oauth.confirmed_at).toISOString(), assignments, group, impact, recovery });
      if (expected && fingerprint !== expected) fail('gbp_first_profile_scope_changed');
      const clinicName = typeof clinic.nombre_clinica === 'string' ? clinic.nombre_clinica.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,256) : '';
      const captured = { fingerprint, impact, recovery, clinicName, scope: { clinica_id: input.clinicId,
        connection_ref: oauth.connection_ref, scope_ref: 'gbp-enroll:' + input.scopeKey }, subject: oauth.google_user_id };
      if (work) await work(db, q, captured);
      actor(input); gate(); return captured;
    };
    return existingTransaction ? read(existingTransaction) : db.sequelize.transaction(read);
  }
  async function eligibleTargets(input, fingerprint, targets) {
    const ids = targets.map(target => C.resource(target.locationName, 'locations'));
    const conflicts = new Set();
    await snapshot(input, fingerprint, async (db, q, captured) => {
      if (!ids.length) return;
      // Collision inventory grants nothing and must not range-lock all clinic
      // locations while matching historical account-prefixed resource names.
      // The exact own-scope authority is checked before and after this read.
      const { lock, ...read } = q;
      const ownCancelled=row=>captured.recovery?.locations.includes(C.location(row.location_id??row.external_location_id))
        &&Number(row.clinica_id)===input.clinicId&&Number(row.google_connection_id)===input.connectionId;
      const rows = bounded(await db.ClinicBusinessLocation.findAll({ ...read, attributes: ['location_id','clinica_id','google_connection_id'], limit: 1001, where: {
        [Op.or]: [{ location_id: { [Op.in]: ids.flatMap(id => [id, 'locations/' + id]) } },
          ...ids.map(id => ({ location_id: { [Op.like]: '%/locations/' + id } }))] } }));
      for (const row of rows) if(!ownCancelled(row))conflicts.add(C.location(row.location_id));
      for (const name of ['BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindingGeneration', 'BusinessProfileBrokerRevocation']) {
        for (const row of bounded(await db[name].findAll({ ...read, attributes: ['external_location_id','clinica_id','google_connection_id'],
          where: { external_location_id: { [Op.in]: ids } }, limit: 1001 }))) if(name==='BusinessProfileBrokerRevocation'||!ownCancelled(row))conflicts.add(row.external_location_id);
      }
    });
    return targets.filter(target => !target.reassociation && !conflicts.has(C.resource(target.locationName, 'locations')));
  }
  let active = 0;
  async function catalogue(input) {
    if (active >= 4) fail('rate_limited'); active++;
    const handle = Object.freeze({});
    try {
      const captured = await snapshot(input), deadline = now() + 60000;
      contexts.set(handle, async () => {
        if (now() >= deadline) fail('provider_timeout');
        const latest = await snapshot(input, captured.fingerprint);
        if (now() >= deadline) fail('provider_timeout');
        return latest.scope;
      });
      const targets = await broker().discoverFirstProfile(handle);
      if (!Array.isArray(targets) || targets.length > 1000) fail('broker_response_invalid');
      const accepted = await eligibleTargets(input, captured.fingerprint, targets);
      await inspectContext(handle);
      return { captured, accepted, deadline };
    } finally { contexts.delete(handle); active--; }
  }
  function validateSelection(payload) {
    if (!payload || !['accountName,attemptId,locationName,sourceFingerprint','accountName,attemptId,locationName,reviewDestinationChangeAccepted,sourceFingerprint'].includes(Object.keys(payload).sort().join(','))
      || !C.UUID.test(payload.attemptId) || !C.HASH.test(payload.sourceFingerprint)
      || payload.reviewDestinationChangeAccepted !== undefined && typeof payload.reviewDestinationChangeAccepted !== 'boolean') fail('gbp_association_invalid');
    C.resource(payload.accountName, 'accounts'); C.resource(payload.locationName, 'locations');
  }
  const publicImpact = captured => ({ reviewDestinationChangeRequired: captured.impact.reviewDestinationChangeRequired,
    affectedReviewCampaignCount: captured.impact.affectedReviewCampaignCount });
  return {
    async preflight(input) {
      actor(input); input = Object.freeze({ ...input });
      if (!enabled()) return { enabled: false, clinicId: input.clinicId, canDiscover: false, canPrepare: false, reason: 'gbp_first_profile_disabled' };
      let captured;
      try { captured=await snapshot(input); }
      catch(error){if(['gbp_first_profile_existing_scope','gbp_first_profile_existing_history','gbp_association_inherited_asset','asset_revoked'].includes(error?.code))return {
        enabled:false,clinicId:input.clinicId,canDiscover:false,canPrepare:false,reason:error.code};throw error;}
      return { enabled: true, clinicId: input.clinicId, clinicName: captured.clinicName, canDiscover: true, canPrepare: true,
        sourceFingerprint: captured.fingerprint, reason: 'owner_scope_required', ...publicImpact(captured) };
    },
    async candidates(input) {
      actor(input); input = Object.freeze({ ...input }); gate();
      const { captured, accepted } = await catalogue(input);
        const accounts = new Map();
        for (const target of accepted) {
          if (!accounts.has(target.accountName)) accounts.set(target.accountName, { accountName: target.accountName,
            accountDisplayName: target.rawLocation.accountDisplayName || target.accountName, locations: [] });
          accounts.get(target.accountName).locations.push({ locationId: target.locationName, name: target.name, address: target.address });
        }
        return { enabled: true, clinicId: input.clinicId, sourceFingerprint: captured.fingerprint,
          inventory_mode: 'broker_first_profile_candidates', canPrepare: true, accounts: [...accounts.values()], ...publicImpact(captured) };
    },
    async prepare(input, payload) {
      actor(input); input = Object.freeze({ ...input }); gate(); validateSelection(payload); payload = Object.freeze({ ...payload });
      const response = async () => ({ ...(await ordinary().read(input, payload.attemptId)), firstProfileSourceFingerprint: payload.sourceFingerprint });
      if (await getRepo().firstHistory(input, payload)) return response();
      const handle = Object.freeze({});
      try {
        const { captured, accepted, deadline } = await catalogue(input);
        if (captured.fingerprint !== payload.sourceFingerprint) fail('gbp_first_profile_scope_changed');
        if (captured.impact.reviewDestinationChangeRequired && payload.reviewDestinationChangeAccepted !== true) fail('gbp_association_campaign_dependency');
        const selected = accepted.filter(target => target.accountName === payload.accountName && target.locationName === payload.locationName);
        if (selected.length !== 1) fail('gbp_association_target_forbidden');
        const candidate = selected[0];
        admissions.set(handle, async request => {
          if (request.models !== m() || !request.transaction?.LOCK?.UPDATE || request.transaction.finished
            || C.hash(request.input) !== C.hash(input) || C.hash(request.payload) !== C.hash(payload)) fail('gbp_association_invalid');
          if (now() >= deadline) fail('provider_timeout');
          const fresh = await snapshot(input, captured.fingerprint, async (db, q) => {
            const locationId = C.resource(candidate.locationName, 'locations');
            for (const name of ['BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindingGeneration', 'BusinessProfileBrokerRevocation']) {
              const rows=bounded(await db[name].findAll({ ...q, attributes: ['external_location_id','clinica_id','google_connection_id'],where: { external_location_id: locationId },limit:1001 }));
              if(rows.some(row=>name==='BusinessProfileBrokerRevocation'||!captured.recovery?.locations.includes(locationId)
                ||Number(row.clinica_id)!==input.clinicId||Number(row.google_connection_id)!==input.connectionId))fail('gbp_association_location_in_use');
            }
            if (now() >= deadline) fail('provider_timeout');
          }, request.transaction);
          return { candidate, previousScope:fresh.recovery?.previousScope??null, scope: { scope_key: input.scopeKey, clinica_id: input.clinicId, google_connection_id: input.connectionId,
            google_user_id: fresh.subject, connection_ref: fresh.scope.connection_ref, scope_ref: fresh.scope.scope_ref,
            account_ids: [C.resource(candidate.accountName, 'accounts')], location_ids: [C.resource(candidate.locationName, 'locations')], state: 'active' } };
        });
        await getRepo().enqueueFirst(input, payload, handle);
        return await response();
      } catch (error) {
        // A concurrent identical POST can commit while this request is still
        // discovering. Reuse only its fully matched durable intent; another
        // UUID, identity, session, selection or fingerprint remains a denial.
        if (!['gbp_first_profile_existing_scope','gbp_first_profile_existing_history'].includes(error?.code)
          || !await getRepo().firstHistory(input, payload)) throw error;
        return response();
      } finally { admissions.delete(handle); }
    },
  };
}
let instance;
const get = () => instance ||= createFirstProfileService({ models: () => require('../../models') });
module.exports = { createFirstProfileService, inspectContext, inspectAdmission, safe, status,
  preflight: (...args) => get().preflight(...args), candidates: (...args) => get().candidates(...args), prepare: (...args) => get().prepare(...args) };

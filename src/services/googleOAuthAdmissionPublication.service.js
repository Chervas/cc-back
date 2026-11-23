'use strict';

const { createHash } = require('node:crypto');
const { Op, Transaction } = require('sequelize');
const C = require('./googleOAuthAdmissionAttempt.contract');
const Cohort = require('./googleOAuthCohort.contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const SearchConsole = require('../../services/integrations-broker/src/google-search-console-contract');
const Analytics = require('../../services/integrations-broker/src/google-analytics-contract');
const { persistVerifiedAnalyticsMapping } = require('./googleReviewedAnalyticsMapping.service');
const { projectGA,firstAnalyticsSubjectDigest } = require('../../services/integrations-broker/src/google-property-discovery-contract');
const { projectSC } = require('../../services/integrations-broker/src/google-property-discovery-contract');
const { persistVerifiedSearchConsoleMapping } = require('./googleReviewedSearchConsoleMapping.service');

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9-]{32,64}$/;
const SUBJECT = /^(?!unknown$)[A-Za-z0-9._-]{1,128}$/;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const COMMAND = ['attemptId','scopeKey','service','clinicId','assetRef'];
const RECEIPT = [...COMMAND,'bindingDigest','clinicSetDigest','receiptId','googleUserId','connectionRef','secretVersion','mode','observedAt','validUntil','status'];
const MODES = ['reuse','provisioned'];
const MAPPINGS = {
  business_profile: ['ClinicBusinessLocation','google_connection_id','is_active'],
  search_console: ['ClinicWebAsset','googleConnectionId','isActive'],
  analytics: ['ClinicAnalyticsProperty','googleConnectionId','isActive'],
  ads: ['ClinicGoogleAdsAccount','googleConnectionId','isActive'],
};

const string = (value, pattern) => typeof value === 'string' && pattern.test(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const plain = value => value?.get ? value.get({ plain:true }) : value;
const conflict = () => { throw C.problem('google_oauth_admission_attempt_conflict',409); };
const unavailable = () => { throw C.problem('google_oauth_admission_attempt_unavailable',503); };
const forbidden = () => { throw C.problem('google_oauth_admission_forbidden',403); };

function command(value) {
  if (!C.exact(value, COMMAND) || !string(value.attemptId, ID) || !C.SERVICES.includes(value.service)
    || !positive(value.clinicId) || !string(value.assetRef, Cohort.COHORTS[value.service].asset)) throw C.problem();
  const scope = Cohort.requestedScope(value.scopeKey);
  if (scope.type === 'clinic' && scope.id !== value.clinicId) throw C.problem();
  return Object.freeze({ ...value });
}

function checkedReceipt(value, selection, context, limits) {
  const now = C.clock(limits.now), expiry = limits.attemptExpiry;
  const isSearchConsole = selection.service === 'search_console';
  if (!C.exact(value, isSearchConsole ? [...RECEIPT,'resource'] : RECEIPT) || COMMAND.some(key => value[key] !== selection[key])
    || value.bindingDigest !== C.bindingDigest(context) || value.clinicSetDigest !== digest(context.clinicIds)
    || !string(value.receiptId, ID) || !string(value.googleUserId, SUBJECT) || !string(value.connectionRef, REF)
    || !string(value.secretVersion, VERSION) || !MODES.includes(value.mode) || value.status !== 'confirmed_resource_access'
    || !Number.isSafeInteger(value.observedAt) || value.observedAt < limits.requestedAt || value.observedAt > now
    || !Number.isSafeInteger(value.validUntil) || value.validUntil <= now || value.validUntil > expiry
    || value.mode === 'provisioned' && (value.secretVersion !== selection.attemptId
      || value.connectionRef !== `google-first:${selection.service}:${selection.scopeKey}`)) conflict();
  if (!isSearchConsole) return Object.freeze({ ...value });
  try {
    if (!C.exact(value.resource,['siteUrl','permissionLevel'])) conflict();
    const site = SearchConsole.site(value.resource.siteUrl);
    if (site.assetRef !== selection.assetRef) conflict();
    const resource = projectSC(value.resource,site.siteUrl);
    return Object.freeze({ ...value, resource:Object.freeze({ siteUrl:resource.siteUrl,permissionLevel:resource.permissionLevel }) });
  } catch {
    conflict();
  }
}

function checkedAllocation(row, expectedKey, expectedId) {
  const type = expectedKey.startsWith('clinic:') ? 'clinic' : 'group';
  const id = Number(expectedKey.split(':')[1]);
  if (!row || row.scopeKey !== expectedKey || row.assignmentScope !== type || row.status !== 'active'
    || Number(row.googleConnectionId) !== expectedId
    || (type === 'clinic' ? Number(row.clinicaId) !== id || row.grupoClinicaId !== null
      : Number(row.grupoClinicaId) !== id || row.clinicaId !== null)) conflict();
}

// The API owns the user/session proof. The Owner client must authenticate and
// verify the checked resource and exact active credential version independently.
// Only these server dependencies may furnish receipts or audit events.
function createGoogleOAuthAdmissionPublication({ models, authority, owner, audit, verifyNativeAccess, now = () => new Date() } = {}) {
  if (!models || typeof models.sequelize?.transaction !== 'function' || typeof authority?.capture !== 'function'
    || typeof owner?.verifyPublication !== 'function' || typeof audit !== 'function' || typeof now !== 'function'
    || verifyNativeAccess !== undefined && typeof verifyNativeAccess !== 'function') unavailable();
  const M = models;
  const options = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, raw:true, logging:false });
  const transaction = work => M.sequelize.transaction({ isolationLevel:Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, work);
  const attemptExpiry = row => +row.expires_at;
  function receiptBounds(row) { return { now:now(), attemptExpiry:attemptExpiry(row), requestedAt:+row.requested_at }; }

  async function authenticate(captured, context, transaction) {
    C.assertLive(context,now());
    if (await captured.authorize(context,{ transaction }) !== true) forbidden();
    C.assertLive(context,now());
  }

  async function attempt(context, transaction) {
    const row = await M.GoogleOAuthAdmissionAttempt.findByPk(context.attemptId,options(transaction));
    if (!row) conflict();
    const value = C.assertBound(row,context);
    if (value.state !== 'prepared' || attemptExpiry(value) <= C.clock(now())) conflict();
    return value;
  }

  async function connectionFor(subject, transaction) {
    // Neither accessToken nor refreshToken is selected, even with historical rows.
    const [records] = await M.sequelize.query(`SELECT id, googleUserId, (accessToken IS NULL AND refreshToken IS NULL) AS credentials_external
      FROM GoogleConnections WHERE googleUserId=:subject ORDER BY id LIMIT 2 FOR UPDATE`,
    { replacements:{ subject }, transaction, logging:false });
    if (records.length > 1 || records.length === 1 && (records[0].googleUserId !== subject || Number(records[0].credentials_external) !== 1)) conflict();
    return records[0] || null;
  }

  function nativeBinding(receipt, connectionId) {
    return Cohort.validate({ google_user_id:receipt.googleUserId, cohort:receipt.service, google_connection_id:connectionId,
      connection_ref:receipt.connectionRef, asset_ref:receipt.assetRef, clinica_id:receipt.clinicId,
      scope_key:'connection:' + connectionId, policy_version:Cohort.POLICY,
      secret_version:receipt.secretVersion, confirmed_at:new Date(receipt.observedAt) });
  }

  async function reconcileBinding(receipt, connectionId, replayed, transaction) {
    const stored = await M.GoogleOAuthBrokerBinding.findOne({ ...options(transaction),
      where:{ google_user_id:receipt.googleUserId, cohort:receipt.service } });
    if (stored) Cohort.validate(stored);
    if (receipt.mode === 'reuse') {
      if (!stored || Number(stored.google_connection_id) !== connectionId || stored.connection_ref !== receipt.connectionRef
        || stored.secret_version !== receipt.secretVersion || stored.policy_version !== Cohort.POLICY
        || !(stored.confirmed_at instanceof Date) || +stored.confirmed_at > C.clock(now())) conflict();
      return stored;
    }
    const expected = nativeBinding(receipt,connectionId);
    if (stored) {
      if (Cohort.digest(stored) !== Cohort.digest(expected) || stored.secret_version !== expected.secret_version || !stored.confirmed_at) conflict();
      return stored;
    }
    if (replayed) conflict();
    const [model, connectionField, activeField] = MAPPINGS[receipt.service];
    const earlier = await M[model].findOne({ ...options(transaction), attributes:['id'],
      where:{ [connectionField]:connectionId, [activeField]:true } });
    if (earlier) conflict();
    await M.GoogleOAuthBrokerBinding.create(expected,{ transaction,logging:false });
    return expected;
  }

  async function assertHistory(receipt, context, connectionId, transaction) {
    const o = { ...options(transaction), attributes:['request_id'] };
    let result;
    if (receipt.service === 'business_profile') {
      result = await M.BusinessProfileBrokerRevocation.findOne({ ...o, where:{ external_location_id:receipt.assetRef.split(':')[2] } });
    } else if (receipt.service === 'ads') {
      result = await M.GoogleAdsBrokerRevocation.findOne({ ...o, where:{ asset_ref:receipt.assetRef,
        [Op.or]:[{ scope_key:context.scopeKey },{ tenant_clinic_id:{ [Op.in]:context.clinicIds } },{ google_connection_id:connectionId }] } });
    } else {
      result = await M.GooglePropertyBrokerRevocation.findOne({ ...o, where:{ kind:receipt.service,asset_ref:receipt.assetRef,
        clinica_id:{ [Op.in]:context.clinicIds } } });
    }
    if (result) conflict();
  }

  async function assign(context, receipt, connectionId, replayed, transaction) {
    const scope = Cohort.requestedScope(context.scopeKey);
    const clinic = await M.Clinica.findByPk(receipt.clinicId,{ ...options(transaction),attributes:['id_clinica','grupoClinicaId'] });
    if (!clinic || Number(clinic.id_clinica) !== receipt.clinicId || scope.type === 'group' && Number(clinic.grupoClinicaId) !== scope.id) conflict();
    const otherKey = scope.type === 'group' ? 'clinic:' + receipt.clinicId
      : clinic.grupoClinicaId == null ? null : 'group:' + Number(clinic.grupoClinicaId);
    const candidates = otherKey ? [context.scopeKey,otherKey].sort() : [context.scopeKey];
    const rows = await M.GoogleConnectionAssignment.findAll({ ...options(transaction), attributes:['scopeKey','assignmentScope','googleConnectionId','clinicaId','grupoClinicaId','status'],
      where:{ scopeKey:{ [Op.in]:candidates } },order:[['scopeKey','ASC']],limit:3 });
    if (rows.length > candidates.length || new Set(rows.map(row => row.scopeKey)).size !== rows.length) conflict();
    const existing = rows.find(row => row.scopeKey === context.scopeKey);
    if (existing) checkedAllocation(existing,context.scopeKey,connectionId);
    const indirect = rows.find(row => row.scopeKey === otherKey);
    // A live inheritance of another identity or a direct override on the
    // target clinic uses an explicit replacement flow. Never rewrite either.
    if (indirect && (scope.type === 'group' || indirect.status === 'active' || indirect.status === 'reauthorization_required')) {
      checkedAllocation(indirect,otherKey,connectionId);
    }
    if (existing) return;
    if (replayed) conflict();
    await M.GoogleConnectionAssignment.create({ scopeKey:context.scopeKey, assignmentScope:scope.type,
      clinicaId:scope.type === 'clinic' ? scope.id : null, grupoClinicaId:scope.type === 'group' ? scope.id : null,
      googleConnectionId:connectionId, status:'active', authorizedByUserId:context.actorId,
      connectedAt:new Date(receipt.observedAt), lastValidatedAt:new Date(receipt.observedAt) },{ transaction,logging:false });
  }

  function checkedIdentity(value, selection) {
    if (!C.exact(value,['attemptId','scopeKey','service','googleUserId','subjectDigest'])
      || value.attemptId !== selection.attemptId || value.scopeKey !== selection.scopeKey || value.service !== 'analytics'
      || !string(value.googleUserId,SUBJECT) || value.subjectDigest !== firstAnalyticsSubjectDigest(value.googleUserId)) conflict();
    return Object.freeze({ ...value });
  }

  async function analyticsClaim(context, selection, identity, transaction) {
    const o = options(transaction), scope = Cohort.requestedScope(context.scopeKey);
    const clinic = await M.Clinica.findByPk(selection.clinicId,{ ...o,attributes:['id_clinica','grupoClinicaId'] });
    if (!clinic || Number(clinic.id_clinica) !== selection.clinicId || scope.type === 'group' && Number(clinic.grupoClinicaId) !== scope.id) conflict();
    const otherKey = scope.type === 'group' ? 'clinic:'+selection.clinicId : clinic.grupoClinicaId == null ? null : 'group:'+Number(clinic.grupoClinicaId);
    const keys = otherKey ? [context.scopeKey,otherKey].sort() : [context.scopeKey];
    const allocations = await M.GoogleConnectionAssignment.findAll({ ...o,
      attributes:['scopeKey','assignmentScope','googleConnectionId','clinicaId','grupoClinicaId','status'],
      where:{ scopeKey:{ [Op.in]:keys } },order:[['scopeKey','ASC']],limit:3 });
    if (allocations.length > keys.length || new Set(allocations.map(row=>row.scopeKey)).size !== allocations.length) conflict();
    const connection = await connectionFor(identity.googleUserId,transaction), connectionId = connection ? Number(connection.id) : null;
    if (connection && !positive(connectionId)) conflict();
    for (const allocation of allocations) {
      if (allocation.scopeKey === context.scopeKey || scope.type === 'group' || ['active','reauthorization_required'].includes(allocation.status)) {
        if (connectionId === null) conflict();
        checkedAllocation(allocation,allocation.scopeKey,connectionId);
      }
    }
    // Lookup is global by canonical subject/cohort, not just this clinic.
    // A first authorization must never replace an existing Analytics version.
    const bindings = await M.GoogleOAuthBrokerBinding.findAll({ ...o,where:{ google_user_id:identity.googleUserId,cohort:'analytics' },limit:2 });
    if (bindings.length > 1) conflict();
    const previous = await M.GoogleOAuthAdmissionPublication.findByPk(selection.attemptId,o);
    if (previous && (previous.scope_key !== context.scopeKey || previous.service !== 'analytics'
      || Number(previous.clinic_id) !== selection.clinicId || previous.asset_ref !== selection.assetRef
      || Number(previous.google_connection_id) !== connectionId)) conflict();
    await assertHistory(selection,context,connectionId,transaction);
    if (!previous) {
      if (connectionId !== null && await M.ClinicAnalyticsProperty.findOne({ ...o,attributes:['id'],
        where:{ googleConnectionId:connectionId,isActive:true } })) conflict();
      const resource = Analytics.property('properties/'+selection.assetRef.slice(4));
      const existingMapping = await M.ClinicAnalyticsProperty.findOne({ ...o,attributes:['id'],
        where:{ clinicaId:selection.clinicId,propertyName:resource.propertyName } });
      const existingBinding = await M.AnalyticsBrokerBinding.findOne({ ...o,attributes:['mapping_id'],
        where:{ clinica_id:selection.clinicId,property_name:resource.propertyName } });
      if (existingMapping || existingBinding) conflict();
    }
    if (bindings.length) {
      if (!previous || connectionId === null) conflict();
      const binding = Cohort.validate(bindings[0]);
      if (binding.connection_ref !== 'google-first:analytics:'+context.scopeKey || binding.secret_version !== selection.attemptId
        || binding.asset_ref !== selection.assetRef || Number(binding.clinica_id) !== selection.clinicId
        || Number(binding.google_connection_id) !== connectionId || !binding.confirmed_at) conflict();
    } else if (previous) conflict();
    return digest({ subjectDigest:identity.subjectDigest,connectionId,allocations,
      analyticsBinding:bindings.length ? Cohort.digest(bindings[0]) : null,
      publication:previous ? [previous.receipt_id,previous.receipt_digest,previous.google_connection_id] : null,
      targetClinic:[Number(clinic.id_clinica),clinic.grupoClinicaId == null ? null : Number(clinic.grupoClinicaId)] });
  }

  function projection(selection, replayed, analyticsResource) {
    const configured = selection.service === 'search_console' || selection.service === 'analytics' && Boolean(analyticsResource);
    return { attemptId:selection.attemptId, scopeKey:selection.scopeKey, service:selection.service,
      authorizationConfirmed:true, connected:configured, configurationPending:!configured, replayed };
  }

  async function publish(req,input) {
    try {
      const selection = command(input);
      const captured = await authority.capture(req,{ attemptId:selection.attemptId,scopeKey:selection.scopeKey,service:selection.service });
      const context = C.input(captured.context);
      if (context.attemptId !== selection.attemptId || context.scopeKey !== selection.scopeKey || context.service !== selection.service
        || !context.clinicIds.includes(selection.clinicId)) forbidden();
      const preview = await transaction(async tx => {
        await authenticate(captured,context,tx);
        return attempt(context,tx);
      });
      const request = { ...selection, bindingDigest:preview.binding_digest, clinicSetDigest:preview.clinic_digest, expiresAt:attemptExpiry(preview) };
      let identity,claim;
      const checkClaim = async tx => {
        if (identity && await analyticsClaim(context,selection,identity,tx) !== claim) conflict();
      };
      if (selection.service === 'analytics' && verifyNativeAccess) {
        if (typeof owner.previewIdentity !== 'function') unavailable();
        identity = checkedIdentity(await owner.previewIdentity(Object.freeze({ ...request })),selection);
        claim = await transaction(async tx => {
          await authenticate(captured,context,tx);await attempt(context,tx);
          return analyticsClaim(context,selection,identity,tx);
        });
        request.expectedSubjectDigest = identity.subjectDigest;
      }
      const receipt = checkedReceipt(await owner.verifyPublication(Object.freeze(request)),selection,context,receiptBounds(preview));
      if (identity && receipt.googleUserId !== identity.googleUserId) conflict();
      let analyticsResource;
      if (verifyNativeAccess) {
        await transaction(async tx => {
          await authenticate(captured,context,tx);
          await attempt(context,tx);await checkClaim(tx);
        });
        const verified = await verifyNativeAccess({ receipt,context });
        if (selection.service === 'analytics') {
          const resource = Analytics.property('properties/' + selection.assetRef.slice(4));
          analyticsResource = Object.freeze(projectGA(verified,resource.propertyName));
        } else if (verified !== true) unavailable();
      }
      const receiptDigest = digest(receipt);

      return await transaction(async tx => {
        await authenticate(captured,context,tx);
        const row = await attempt(context,tx);
        await checkClaim(tx);
        checkedReceipt(receipt,selection,context,receiptBounds(row));
        const previous = await M.GoogleOAuthAdmissionPublication.findByPk(selection.attemptId,options(tx));
        if (previous && (previous.receipt_digest !== receiptDigest || previous.receipt_id !== receipt.receiptId
          || previous.scope_key !== context.scopeKey || previous.service !== context.service
          || Number(previous.clinic_id) !== selection.clinicId || previous.asset_ref !== selection.assetRef)) conflict();
        let connection = await connectionFor(receipt.googleUserId,tx);
        if (!connection) {
          if (receipt.mode !== 'provisioned' || previous) conflict();
          connection = plain(await M.GoogleConnection.create({ googleUserId:receipt.googleUserId,userId:null,accessToken:null,refreshToken:null },
            { transaction:tx,logging:false }));
        }
        const connectionId = Number(connection.id);
        if (!positive(connectionId) || previous && Number(previous.google_connection_id) !== connectionId) conflict();
        await assertHistory(receipt,context,connectionId,tx);
        await reconcileBinding(receipt,connectionId,Boolean(previous),tx);
        await assign(context,receipt,connectionId,Boolean(previous),tx);
        if (receipt.service === 'search_console') {
          // The confirmed receipt is supplied by the broker, including the
          // canonical locator for the selected property's hash. All native
          // ownership records share the authorization/audit transaction.
          await persistVerifiedSearchConsoleMapping(M,tx,{
            clinicId:receipt.clinicId,connectionId,googleUserId:receipt.googleUserId,
            connectionRef:receipt.connectionRef,assetRef:receipt.assetRef,...receipt.resource,
          },{ existingOnly:Boolean(previous) });
        }
        if (analyticsResource) {
          await persistVerifiedAnalyticsMapping(M,tx,{
            clinicId:receipt.clinicId,connectionId,googleUserId:receipt.googleUserId,
            connectionRef:receipt.connectionRef,assetRef:receipt.assetRef,property:analyticsResource,
          },{ existingOnly:Boolean(previous) });
        }
        if (!previous) {
          const record = { attempt_id:selection.attemptId, receipt_id:receipt.receiptId, receipt_digest:receiptDigest,
            google_connection_id:connectionId, scope_key:context.scopeKey, service:context.service,
            clinic_id:selection.clinicId, asset_ref:selection.assetRef, published_at:new Date(C.clock(now())) };
          await M.GoogleOAuthAdmissionPublication.create(record,{ transaction:tx,logging:false });
          await audit({ ...record },{ transaction:tx,context,receipt });
        }
        await authenticate(captured,context,tx);
        checkedReceipt(receipt,selection,context,receiptBounds(row));
        return projection(selection,Boolean(previous),analyticsResource);
      });
    } catch (error) {
      const code = error?.status ?? error?.httpStatus;
      if (code === 401) throw C.problem('google_oauth_admission_session_required',401);
      if (code === 403) forbidden();
      if (code === 400) throw C.problem();
      if (code === 409 || error?.name === 'SequelizeUniqueConstraintError'
        || ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error?.original?.code)) conflict();
      unavailable();
    }
  }

  return Object.freeze({ publish });
}

module.exports = { createGoogleOAuthAdmissionPublication };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash,randomUUID } = require('node:crypto');
const C = require('./googleOAuthAdmissionAttempt.contract');
const { createGoogleOAuthAdmissionAuthority } = require('./googleOAuthAdmissionAuthority.service');
const { createGoogleOAuthAdmissionCoordinator } = require('./googleOAuthAdmissionCoordinator.service');
const { createGoogleOAuthAdmissionOwner } = require('./googleOAuthAdmissionOwner.adapter');
const { createGoogleOAuthAdmissionReturnLocator } = require('./googleOAuthAdmissionReturnLocator.service');
const { createGoogleOAuthAdmissionReturnDispatcher } = require('./googleOAuthAdmissionReturnDispatcher.service');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');

const SCHEMA = 'clinicaclick-google-first-admission-crm/1';
const CONFIG_KEYS = ['schema','environment','startsEnabled','origin','keyId','keyFile','caFile','clientId','redirectUri','scopes'];
const IDENTITY_OPERATION = /^google\.oauth\.admission\.(begin|status|finish|abort)\.v1$/;
const IDENTITY_PREVIEW = 'google.oauth.admission.identity.preview.v1';
const VERIFY_SELECTION = 'google.oauth.admission.publication.verify.v1';
const CATALOGUE_READY = 'google.oauth.admission.catalogue.ready.v1';
const CATALOGUE = 'google.oauth.admission.catalogue.v1';
const SCOPE_KEY = /^(clinic|group):[1-9]\d{0,9}$/;
const uint = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const unavailable = () => { throw C.problem('google_oauth_admission_attempt_unavailable',503); };
const forbidden = () => { throw C.problem('google_oauth_admission_forbidden',403); };
const conflict = () => { throw C.problem('google_oauth_admission_attempt_conflict',409); };
const clinicDigest = ids => createHash('sha256').update(JSON.stringify(ids)).digest('hex');

function privateFile(filename, { config = false } = {}) {
  let fd;
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) unavailable();
    fd = fs.openSync(filename,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd,{ bigint:true });
    const owner = BigInt(process.getuid());
    const groups = process.getgroups().map(BigInt);
    const acceptable = before.uid === 0n && ((before.mode & 0o777n) === 0o600n
      || (before.mode & 0o777n) === 0o640n && groups.includes(before.gid));
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 65536n
      || !(acceptable || !config && before.uid === owner && (before.mode & 0o777n) === 0o600n)) unavailable();
    // Config may select a credential, so its containing path must be pinned
    // to trusted principals as well as its file and mode.
    if (config) for (let parent = path.dirname(filename); ; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) unavailable();
      if (parent === '/') break;
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd,{ bigint:true });
    if (['dev','ino','size','ctimeNs','mtimeNs'].some(key => before[key] !== after[key])
      || bytes.length !== Number(before.size)) unavailable();
    return bytes;
  } catch {
    unavailable();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readPolicy(value, environment) {
  const publicationConfigured = Object.hasOwn(value || {},'publicationEnabled');
  if (!C.exact(value,publicationConfigured ? [...CONFIG_KEYS,'publicationEnabled'] : CONFIG_KEYS)
    || publicationConfigured && typeof value.publicationEnabled !== 'boolean'
    || value.schema !== SCHEMA || !['dev','staging'].includes(environment)
    || value.environment !== environment || typeof value.startsEnabled !== 'boolean'
    || typeof value.keyId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.keyId)
    || typeof value.clientId !== 'string' || !/^[A-Za-z0-9._-]{1,256}\.apps\.googleusercontent\.com$/.test(value.clientId)
    || ['origin','redirectUri','keyFile','caFile'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 2048)
    || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 64) unavailable();
  let origin, redirect;
  try {
    origin = new URL(value.origin);
    redirect = new URL(value.redirectUri);
  } catch { unavailable(); }
  if (origin.protocol !== 'https:' || origin.href !== value.origin || origin.pathname !== '/' || origin.username
    || origin.password || origin.search || origin.hash || redirect.protocol !== 'https:'
    || redirect.href !== value.redirectUri || redirect.pathname !== '/oauth/google/callback' || redirect.username
    || redirect.password || redirect.port || redirect.search || redirect.hash || !path.isAbsolute(value.keyFile)
    || !path.isAbsolute(value.caFile) || value.caFile === value.keyFile) unavailable();
  const scopes = new Map();
  for (const entry of value.scopes) {
    if (!C.exact(entry,['scopeKey','clinicIds','services']) || typeof entry.scopeKey !== 'string' || !SCOPE_KEY.test(entry.scopeKey)
      || scopes.has(entry.scopeKey) || !uint(Number(entry.scopeKey.split(':')[1])) || !Array.isArray(entry.clinicIds)
      || !entry.clinicIds.length || entry.clinicIds.length > C.MAX_CLINICS
      || entry.clinicIds.some((id,index) => !uint(id) || index && id <= entry.clinicIds[index-1])
      || entry.scopeKey.startsWith('clinic:') && (entry.clinicIds.length !== 1 || entry.scopeKey !== 'clinic:' + entry.clinicIds[0])
      || !Array.isArray(entry.services) || !entry.services.length || new Set(entry.services).size !== entry.services.length
      || entry.services.some(service => !C.SERVICES.includes(service))) unavailable();
    scopes.set(entry.scopeKey,Object.freeze({ clinicIds:Object.freeze([...entry.clinicIds]), services:Object.freeze([...entry.services]) }));
  }
  return Object.freeze({ ...value, scopes });
}

function controlClient(policy,readFile,clientFactory) {
  let key;
  try {
    key = readFile(policy.keyFile);
    return clientFactory({ origin:policy.origin,keyId:policy.keyId,privateKey:key,
      ca:readFile(policy.caFile),audience:`clinicaclick:google-first-oauth:${policy.environment}:v1`,timeoutMs:10000 });
  } catch {
    unavailable();
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
}

function loadConfig(env,readFile) {
  const filename = env.GOOGLE_OAUTH_FIRST_ADMISSION_CONFIG_FILE;
  const installed = env.GOOGLE_OAUTH_FIRST_ADMISSION_INSTALLED;
  if (!filename && installed !== 'true') return null;
  if (!filename || installed !== 'true' || env.RUNTIME_ROLE !== 'api' || !['dev','staging'].includes(env.JOB_RUNTIME_NAMESPACE)) unavailable();
  try {
    const value = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(readFile(filename,{ config:true })));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
    return value;
  } catch {
    unavailable();
  }
}

function createGoogleOAuthAdmissionRuntime({
  config, environment, models, sessions, readFile = privateFile, clientFactory = createIntegrationsBrokerClient,
  readAuthority, now = () => new Date(),
} = {}) {
  const policy = readPolicy(config,environment);
  if (typeof readFile !== 'function' || typeof clientFactory !== 'function' || typeof now !== 'function'
    || typeof models?.GoogleOAuthAdmissionAttempt?.findByPk !== 'function'
    || typeof models?.GoogleOAuthAdmissionPublication?.findByPk !== 'function'
    || typeof models?.GoogleOAuthAdmissionReturn?.findByPk !== 'function'
    || typeof models?.GoogleOAuthBrokerRequest?.findAll !== 'function') unavailable();
  const client = controlClient(policy,readFile,clientFactory);
  const owner = createGoogleOAuthAdmissionOwner({ client:{
    execute(command,options) {
      if (!IDENTITY_OPERATION.test(command?.operation)) unavailable();
      return client.execute(command,options);
    },
  }, clientId:policy.clientId, redirectUri:policy.redirectUri });
  const authority = createGoogleOAuthAdmissionAuthority({ models,sessions,now });
  const coordinator = createGoogleOAuthAdmissionCoordinator({
    model:models.GoogleOAuthAdmissionAttempt, publicationModel:models.GoogleOAuthAdmissionPublication,
    sequelize:models.sequelize, authority, owner, now,
  });
  const locator = createGoogleOAuthAdmissionReturnLocator({
    models,sessions,authority,clientId:policy.clientId,redirectUri:policy.redirectUri,now,
  });
  const dispatcher = createGoogleOAuthAdmissionReturnDispatcher({ locator,owner,now });
  let publisher;
  let assets;
  let status = coordinator.status;
  if (policy.publicationEnabled) {
    if (typeof readAuthority?.available !== 'function' || typeof readAuthority?.verify !== 'function') unavailable();
    const { createGoogleOAuthAdmissionPublication } = require('./googleOAuthAdmissionPublication.service');
    const { createRepository } = require('./platformAudit.repository');
    const { fromFlow,ACTIONS } = require('../../services/platform-audit/src/integration-oauth-event');
    const { site } = require('../../services/integrations-broker/src/google-search-console-contract');
    const { property } = require('../../services/integrations-broker/src/google-analytics-contract');
    const audit = createRepository(models.PlatformAuditEvent);

    function approvedScope({ scopeKey,service,clinicSetDigest },clinicId) {
      const allowed = policy.scopes.get(scopeKey);
      if (!['search_console','analytics'].includes(service) || !allowed?.services.includes(service)
        || clinicSetDigest !== clinicDigest(allowed.clinicIds)
        || clinicId !== undefined && !allowed.clinicIds.includes(clinicId)) forbidden();
      return allowed;
    }
    async function callOwner(operation,selection,extras = {},timeoutMs = 25000) {
      const { attemptId,service,scopeKey,bindingDigest,clinicSetDigest,expiresAt } = selection;
      const allowed = approvedScope(selection,extras.clinicId);
      const requestId = randomUUID();
      const response = await client.execute({ requestId,operation,tenantRef:'clinic:'+allowed.clinicIds[0],
        connectionRef:'google-first:'+attemptId,assetRef:'google-oauth:'+service+':'+scopeKey,
        payload:{ attemptId,service,bindingDigest,clinicSetDigest,expiresAt,...extras },
      },{ timeoutMs });
      if (!C.exact(response,['requestId','data','replayed']) || response.requestId !== requestId || typeof response.replayed !== 'boolean') unavailable();
      return response.data;
    }
    async function checkOriginal(req,selection) {
      const captured = await authority.capture(req,selection);
      const context = C.input(captured.context);
      const selected = { ...selection, bindingDigest:C.bindingDigest(context), clinicSetDigest:clinicDigest(context.clinicIds) };
      approvedScope(selected);
      const expiresAt = await models.sequelize.transaction(async transaction => {
        if (await captured.authorize(context,{ transaction }) !== true) forbidden();
        const locked = { transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false };
        const existing = await models.GoogleOAuthAdmissionAttempt.findByPk(context.attemptId,locked);
        if (!existing) conflict();
        const row = C.assertBound(existing,context);
        if (row.state !== 'prepared' || +row.expires_at <= C.clock(now())
          || await models.GoogleOAuthAdmissionPublication.findByPk(context.attemptId,{ ...locked,attributes:['attempt_id'] })) conflict();
        if (await captured.authorize(context,{ transaction }) !== true) forbidden();
        C.assertLive(context,now());
        if (+row.expires_at <= C.clock(now())) conflict();
        return +row.expires_at;
      });
      return { ...selected,expiresAt };
    }
    async function canRead(selection) {
      const { clinicIds } = approvedScope(selection);
      const { scopeKey,service } = selection;
      return await readAuthority.available({ scopeKey,service,clinicIds }) === true;
    }
    status = async (req,selection) => {
      const current = await coordinator.status(req,selection);
      if (!['search_console','analytics'].includes(selection.service) || current.state !== 'prepared' || current.authorizationState !== 'candidate_staged') return current;
      const verified = await checkOriginal(req,selection);
      if (!(await canRead(verified))) return current;
      const ready = await callOwner(CATALOGUE_READY,verified,{},10000);
      const { attemptId,scopeKey,service } = selection;
      if (!C.exact(ready,['attemptId','scopeKey','service','canChooseAssets']) || ready.attemptId !== attemptId
        || ready.scopeKey !== scopeKey || ready.service !== service || typeof ready.canChooseAssets !== 'boolean') unavailable();
      if (!ready.canChooseAssets) return current;
      const fresh = await checkOriginal(req,selection);
      if (fresh.bindingDigest !== verified.bindingDigest || !(await canRead(fresh)) || fresh.expiresAt <= C.clock(now())) conflict();
      return { ...current,canChooseAssets:true };
    };
    assets = async (req,selection) => {
      const verified = await checkOriginal(req,selection);
      if (!(await canRead(verified))) unavailable();
      const result = await callOwner(CATALOGUE,verified);
      const { attemptId,scopeKey,service } = selection;
      const { clinicIds } = approvedScope(verified);
      if (!C.exact(result,['attemptId','scopeKey','service','assets']) || result.attemptId !== attemptId
        || result.scopeKey !== scopeKey || result.service !== service || !Array.isArray(result.assets) || result.assets.length > 256) unavailable();
      const seen = new Set();
      for (const entry of result.assets) {
        const resourceValid = service === 'analytics'
          ? C.exact(entry,['assetRef','propertyName','displayName','clinicIds']) && property(entry.propertyName).assetRef === entry.assetRef
            && typeof entry.displayName === 'string' && entry.displayName.trim() && entry.displayName.length <= 100 && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(entry.displayName)
          : C.exact(entry,['assetRef','siteUrl','clinicIds']) && entry.assetRef === site(entry.siteUrl).assetRef;
        if (!resourceValid || seen.has(entry.assetRef) || !Array.isArray(entry.clinicIds) || !entry.clinicIds.length
          || entry.clinicIds.some((id,index) => !clinicIds.includes(id) || index && id <= entry.clinicIds[index-1])) unavailable();
        seen.add(entry.assetRef);
      }
      const fresh = await checkOriginal(req,selection);
      if (fresh.bindingDigest !== verified.bindingDigest || !(await canRead(fresh)) || fresh.expiresAt <= C.clock(now())) conflict();
      return result;
    };

    publisher = createGoogleOAuthAdmissionPublication({ models,authority,now,owner:{
      async previewIdentity(selection) {
        if (!(await canRead(selection))) unavailable();
        return callOwner(IDENTITY_PREVIEW,selection,{},10000);
      },
      async verifyPublication(selection) {
        if (!(await canRead(selection))) unavailable();
        return callOwner(VERIFY_SELECTION,selection,{ clinicId:selection.clinicId,selectedAssetRef:selection.assetRef,
          ...(selection.service === 'analytics' ? { expectedSubjectDigest:selection.expectedSubjectDigest } : {}) });
      },
    },verifyNativeAccess:proof => readAuthority.verify(proof),
    async audit(record,{ transaction,context,receipt }) {
      const current = now();
      const health = await audit.health(current,{ includeUnresolved:false,transaction });
      if (health.pending >= 9998 || health.oldestAgeSeconds >= 3600) unavailable();
      await audit.append(fromFlow({
        policy_version:'google-oauth-cohorts-v1',request_scope_key:context.scopeKey,
        clinic_ids:context.clinicIds,actor_user_id:context.actorId,session_ref:context.sessionRef,
        cohort:record.service,activation_id:record.attempt_id,connection_ref:receipt.connectionRef,asset_ref:record.asset_ref,
      },ACTIONS[1],'completed','activation_confirmed',current),{ transaction });
    } });
  }

  async function authorizeStart(req, selection) {
    const granted = policy.scopes.get(selection.scopeKey);
    if (!policy.startsEnabled || !granted?.services.includes(selection.service)) return false;
    const captured = await authority.capture(req,selection);
    const clinics = captured.context.clinicIds;
    if (clinics.length !== granted.clinicIds.length || !clinics.every((id,index) => id === granted.clinicIds[index])) return false;
    if (selection.service === 'analytics') {
      // Do not emit a new consent URL for a partially installed GA4 flow.
      // Pausing starts never gates callbacks/status or a recorded completion.
      if (!publisher || await readAuthority.available({ scopeKey:selection.scopeKey,service:selection.service,clinicIds:[...clinics] }) !== true) return false;
      const fresh = await authority.capture(req,selection);
      if (C.bindingDigest(C.input(fresh.context)) !== C.bindingDigest(C.input(captured.context))) forbidden();
    }
    return true;
  }
  return Object.freeze({
    async capability(req,{ scopeKey,service }) {
      const enabled = await authorizeStart(req,{ attemptId:randomUUID(),scopeKey,service });
      return { enabled };
    },
    async begin(req,selection) {
      if (!(await authorizeStart(req,selection))) forbidden();
      const started = await coordinator.start(req,selection);
      if (!started.authorizationUrl) return started;
      // The URL is withheld until both the original authorization and the
      // database locator have committed. A browser cannot supply state.
      await locator.registerBegin(req,selection,started);
      return started;
    },
    status,
    callback:dispatcher.dispatch,
    ...(publisher ? { assets,publish:publisher.publish } : {}),
    settingsOrigin:environment === 'dev' ? 'http://localhost:4203' : 'https://crm.clinicaclick.com',
  });
}

function installGoogleOAuthAdmissionRuntime({
  env = process.env, readFile = privateFile,
  dependencies = config => ({
    models:require('../../models'),sessions:require('./accessSession.service'),
    ...(config?.publicationEnabled === true ? { readAuthority:{
      available(context) { return (context.service === 'analytics' ? require('./analyticsBroker.service') : require('./searchConsoleBroker.service')).firstReadAuthority.available(context); },
      verify(proof) { return (proof.context.service === 'analytics' ? require('./analyticsBroker.service') : require('./searchConsoleBroker.service')).firstReadAuthority.verify(proof); },
    } } : {}),
  }),
} = {}) {
  const config = loadConfig(env,readFile);
  if (config === null) return null;
  return createGoogleOAuthAdmissionRuntime({
    ...dependencies(config), config, environment:env.JOB_RUNTIME_NAMESPACE, readFile,
  });
}

function createFirstPropertyRevoker(service,{ env = process.env,readFile = privateFile,clientFactory = createIntegrationsBrokerClient } = {}) {
  let policy,client;
  return Object.freeze({
    execute(command,options) {
      const prefix = 'google-first:' + service + ':';
      const scopeKey = typeof command?.connectionRef === 'string' && command.connectionRef.startsWith(prefix) ? command.connectionRef.slice(prefix.length) : '';
      if (!SCOPE_KEY.test(scopeKey) || command.operation !== (service === 'analytics' ? 'google.analytics.asset.revoke.v1' : 'google.search_console.asset.revoke.v1')
        || typeof command.tenantRef !== 'string' || !/^clinic:[1-9]\d{0,9}$/.test(command.tenantRef)
        || !(service === 'analytics' ? /^ga4:[1-9]\d{0,19}$/ : /^sc:[a-f0-9]{64}$/).test(command.assetRef) || !C.exact(command.payload,[])) forbidden();
      if (!policy) policy = readPolicy(loadConfig(env,readFile),env.JOB_RUNTIME_NAMESPACE);
      const scope = policy.scopes.get(scopeKey);
      if (!scope?.services.includes(service) || !scope.clinicIds.includes(Number(command.tenantRef.slice(7)))) forbidden();
      client ||= controlClient(policy,readFile,clientFactory);
      return client.execute(command,options);
    },
  });
}

const createFirstSearchConsoleRevoker = options => createFirstPropertyRevoker('search_console',options);
const createFirstAnalyticsRevoker = options => createFirstPropertyRevoker('analytics',options);
module.exports = { createGoogleOAuthAdmissionRuntime,installGoogleOAuthAdmissionRuntime,createFirstSearchConsoleRevoker,createFirstAnalyticsRevoker };

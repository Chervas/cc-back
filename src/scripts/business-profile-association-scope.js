#!/usr/bin/env node
'use strict';
// Operator-owned authority setup only. Does not associate a location, read a
// credential, call Google/broker, initialize models, or start application jobs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../services/googleOAuthCohort.contract');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (value, code = 'gbp_scope_setup_invalid') => { if (!value) throw Error(code); };
function configuration(value) {
  const fields = ['schema','clinicId','connectionId','googleUserId','connectionRef','accountIds','locationIds','expectedMappingId','expectedAssetRef','oauthBindingDigest'];
  need(value && Object.keys(value).sort().join(',') === fields.sort().join(','));
  need(value.schema === 'clinicaclick-gbp-association-scope/1');
  for (const key of ['clinicId','connectionId']) need(Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 2147483647);
  need(typeof value.googleUserId === 'string' && /^[1-9]\d{0,127}$/.test(value.googleUserId));
  need(typeof value.connectionRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.connectionRef));
  for (const key of ['accountIds','locationIds']) need(Array.isArray(value[key]) && value[key].length > 0 && value[key].length <= (key === 'accountIds' ? 10 : 1000)
    && value[key].every(id => typeof id === 'string' && /^[1-9]\d{0,29}$/.test(id)) && new Set(value[key]).size === value[key].length);
  need(value.expectedMappingId === null || Number.isSafeInteger(value.expectedMappingId) && value.expectedMappingId > 0);
  need(value.expectedAssetRef === null || typeof value.expectedAssetRef === 'string' && /^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(value.expectedAssetRef));
  need((value.expectedMappingId === null) === (value.expectedAssetRef === null));
  need(typeof value.oauthBindingDigest === 'string' && /^[a-f0-9]{64}$/.test(value.oauthBindingDigest));
  return { ...value, accountIds: [...value.accountIds].sort(), locationIds: [...value.locationIds].sort() };
}
function desired(config) {
  return { scope_key: 'clinic:' + config.clinicId, clinica_id: config.clinicId, google_connection_id: config.connectionId,
    google_user_id: config.googleUserId, connection_ref: config.connectionRef, scope_ref: 'gbp-enroll:clinic:' + config.clinicId,
    account_ids: config.accountIds, location_ids: config.locationIds, state: 'active' };
}
function validateSnapshot(config, snapshot, allowInstalled = false) {
  const row = snapshot.oauth;
  C.validate(row);
  need(C.cohortOf(row) === 'business_profile' && Number(row.google_connection_id) === config.connectionId
    && row.google_user_id === config.googleUserId && row.connection_ref === config.connectionRef && C.digest(row) === config.oauthBindingDigest
    && row.confirmed_at && Number.isFinite(new Date(row.confirmed_at).getTime()) && new Date(row.confirmed_at).getTime() <= Date.now(),
  'gbp_scope_setup_identity_changed');
  // mysql2 returns a computed SQL boolean as BIGINT text when the operator
  // enables bigNumberStrings to preserve external identifiers.
  need(snapshot.clinic?.id_clinica === config.clinicId && [1,'1'].includes(snapshot.connection?.credentials_external)
    && snapshot.connection.id === config.connectionId && snapshot.connection.googleUserId === config.googleUserId,
  'gbp_scope_setup_identity_changed');
  const keys = ['clinic:' + config.clinicId, ...(snapshot.clinic.grupoClinicaId ? ['group:' + snapshot.clinic.grupoClinicaId] : [])];
  const assignment = keys.map(key => snapshot.assignments.filter(row => row.scopeKey === key)).find(rows => rows.length);
  need(assignment?.length === 1 && assignment[0].status === 'active' && assignment[0].googleConnectionId === config.connectionId,
    'gbp_scope_setup_assignment_changed');
  need(snapshot.mappings.length === (config.expectedMappingId === null ? 0 : 1), 'gbp_scope_setup_mapping_changed');
  if (snapshot.mappings.length) {
    const mapping = snapshot.mappings[0];
    const external = /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(mapping.location_id || '')?.[1];
    const binding = snapshot.binding;
    need(mapping.id === config.expectedMappingId && mapping.clinica_id === config.clinicId
      && mapping.google_connection_id === config.connectionId && mapping.broker_read_connection_ref === config.connectionRef
      && mapping.broker_read_asset_ref === config.expectedAssetRef && mapping.is_active === 1
      && external === config.expectedAssetRef.split(':')[2]
      && binding && binding.external_location_id === external && binding.state === 'active'
      && binding.clinica_id === config.clinicId && binding.google_connection_id === config.connectionId
      && binding.connection_ref === config.connectionRef && binding.asset_ref === config.expectedAssetRef, 'gbp_scope_setup_mapping_changed');
  }
  need(snapshot.revocations.length === 0, 'gbp_scope_setup_revoked');
  need(snapshot.scope === null || allowInstalled && digest(snapshot.scope) === digest(desired(config)), 'gbp_scope_setup_already_configured');
  return desired(config);
}
function readPrivate(filename) {
  need(path.isAbsolute(filename) && fs.realpathSync(filename) === filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); need(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.size <= 65536); return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
}
function writePrivate(filename, value) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function snapshot(db, config, locking = false) {
  const rows = async (sql, values = []) => (await db.query({ sql: sql + (locking ? ' FOR UPDATE' : ''), values, timeout: 5000 }))[0];
  const [clinic] = await rows('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=?', [config.clinicId]);
  const connections = await rows('SELECT id,googleUserId,(accessToken IS NULL AND refreshToken IS NULL) AS credentials_external FROM GoogleConnections WHERE id=? OR googleUserId=? ORDER BY id', [config.connectionId, config.googleUserId]);
  need(connections.length === 1, 'gbp_scope_setup_identity_changed');
  const connection = connections[0];
  const [oauth] = await rows('SELECT google_user_id,cohort,google_connection_id,connection_ref,asset_ref,clinica_id,scope_key,policy_version,confirmed_at FROM GoogleOAuthBrokerBindings WHERE google_user_id=? AND cohort=?', [config.googleUserId,'business_profile']);
  const assignments = await rows('SELECT scopeKey,googleConnectionId,status FROM GoogleConnectionAssignments WHERE scopeKey IN (?,?) ORDER BY scopeKey', ['clinic:' + config.clinicId, 'group:' + (clinic?.grupoClinicaId || 0)]);
  const mappings = await rows('SELECT id,clinica_id,google_connection_id,location_id,is_active,broker_read_connection_ref,broker_read_asset_ref FROM ClinicBusinessLocations WHERE clinica_id=? AND is_active=1 ORDER BY id', [config.clinicId]);
  const [binding] = config.expectedAssetRef ? await rows('SELECT external_location_id,connection_ref,asset_ref,clinica_id,google_connection_id,state FROM BusinessProfileBrokerBindings WHERE external_location_id=?', [config.expectedAssetRef.split(':')[2]]) : [];
  const revocations = await rows('SELECT external_location_id FROM BusinessProfileBrokerRevocations WHERE clinica_id=? AND google_connection_id=? ORDER BY external_location_id', [config.clinicId,config.connectionId]);
  const [scope] = await rows('SELECT scope_key,clinica_id,google_connection_id,google_user_id,connection_ref,scope_ref,account_ids,location_ids,state FROM BusinessProfileAssociationScopes WHERE scope_key=?', ['clinic:' + config.clinicId]);
  if (scope) for (const key of ['account_ids','location_ids']) if (typeof scope[key] === 'string') scope[key] = JSON.parse(scope[key]);
  return { clinic: clinic || null, connection: connection || null, oauth: oauth || null, assignments, mappings, binding: binding || null, revocations, scope: scope || null };
}
async function run(argv) {
  need(process.getuid() === 0, 'gbp_scope_setup_root_required');
  const [action, runtime, input, output, approved] = argv;
  need(['plan','apply','reconcile'].includes(action) && ['dev','staging'].includes(runtime)
    && path.isAbsolute(input || '') && path.isAbsolute(output || '') && argv.length === (action === 'plan' ? 4 : 5));
  const read = JSON.parse(readPrivate(input));
  const config = configuration(action === 'plan' ? read : read.config);
  if (action !== 'plan') need(read.schema === 'clinicaclick-gbp-association-scope-plan/1' && read.runtime === runtime
    && /^[a-f0-9]{64}$/.test(approved || '') && digest(read) === approved
    && read.operatorSha256 === crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), 'gbp_scope_setup_plan_changed');
  const observed = require('./security-email-login-metadata').observedEnvironment(runtime);
  const env = observed.env;
  if (runtime === 'staging') {
    const target = require('../lib/rdsSchemaMigrationTransport');
    need(env.DB_TLS_REQUIRED === 'true' && env.JOB_RUNTIME_NAMESPACE === 'staging'
      && env.DB_HOST === target.HOST && env.DB_NAME === target.DATABASE, 'gbp_scope_setup_runtime_invalid');
  }
  else need(env.DB_NAME === 'clinicaclick_dev_isolated' && ['localhost','127.0.0.1'].includes(env.DB_HOST), 'gbp_scope_setup_runtime_invalid');
  const db = await require('mysql2/promise').createConnection({ host: env.DB_HOST, user: env.DB_USERNAME, password: env.DB_PASSWORD,
    database: env.DB_NAME, ...require('../lib/databaseTlsConfig').buildDatabaseTlsOptions(env), supportBigNumbers: true, bigNumberStrings: true });
  let lock = false;
  try {
    if (action === 'plan') {
      await db.query('SET TRANSACTION READ ONLY'); await db.beginTransaction();
      const before = await snapshot(db, config); validateSnapshot(config, before); await db.rollback();
      const plan = { schema: 'clinicaclick-gbp-association-scope-plan/1', runtime, config,
        createdAt: new Date().toISOString(), beforeDigest: digest(before), desired: desired(config),
        operatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') };
      writePrivate(output, plan); return { status: 'planned', planSha256: digest(plan), associationsChanged: 0 };
    }
    if (action === 'apply') need(Date.now() - Date.parse(read.createdAt) >= 0 && Date.now() - Date.parse(read.createdAt) <= 3600000, 'gbp_scope_setup_plan_expired');
    if (action === 'reconcile') {
      await db.query('SET TRANSACTION READ ONLY'); await db.beginTransaction();
      const current = await snapshot(db, config); validateSnapshot(config, current, true);
      need(current.scope !== null, 'gbp_scope_setup_not_applied'); await db.rollback();
      writePrivate(output, { status: 'reconciled', at: new Date().toISOString(), scope: current.scope, planSha256: approved, associationsChanged: 0 });
      return { status: 'reconciled', associationsChanged: 0 };
    }
    const [[held]] = await db.query("SELECT GET_LOCK('cc_gbp_association_scope_setup',0) AS held");
    need(Number(held.held) === 1, 'gbp_scope_setup_busy'); lock = true;
    writePrivate(output, { status: 'started_inspect_before_retry', at: new Date().toISOString(), planSha256: approved, scopeKey: desired(config).scope_key });
    await db.beginTransaction();
    try {
      const current = await snapshot(db, config, true); validateSnapshot(config, current);
      need(digest(current) === read.beforeDigest, 'gbp_scope_setup_plan_stale');
      const row = desired(config), fields = Object.keys(row);
      await db.query('INSERT INTO BusinessProfileAssociationScopes (' + fields.map(k => '`' + k + '`').join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ')',
        fields.map(k => ['account_ids','location_ids'].includes(k) ? JSON.stringify(row[k]) : row[k]));
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    const after = await snapshot(db, config); validateSnapshot(config, after, true);
    writePrivate(output + '.completed.json', { status: 'scope_configured', at: new Date().toISOString(), planSha256: approved, scope: after.scope, associationsChanged: 0 });
    return { status: 'scope_configured', associationsChanged: 0 };
  } finally {
    if (lock) await db.query("SELECT RELEASE_LOCK('cc_gbp_association_scope_setup')").catch(() => {});
    await db.end();
  }
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ status: 'stopped_inspect_no_replay', code: /^gbp_scope_setup_[a-z_]+$/.test(error.message) ? error.message : 'gbp_scope_setup_unavailable' })); process.exitCode = 1;
});
module.exports = { configuration, desired, validateSnapshot, digest, snapshot, run };

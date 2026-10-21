'use strict';
// Explicit operator action: publishes source templates only; never adopts them
// into a clinic and never changes episodes, patient references or intake.
const ROOT = '/home/ubuntu/wt/back-dev';
const schemaRelease = require('./clinical-forms-schema-release');
const fail = code => { throw Error(code); };
function argumentsFor(args) {
  const targetArgument = args.find(arg => /^--target=(dev|crm)$/.test(arg));
  if (args.length !== 3 || !args.includes('--apply-source-presets') || !targetArgument) fail('CLINICAL_CATALOG_EXPLICIT_TARGET_ACTION_REQUIRED');
  const actor = args.find(arg => /^--actor-id=[1-9]\d*$/.test(arg));
  const actorId = actor ? Number(actor.slice(11)) : null;
  if (!Number.isSafeInteger(actorId) || !require('../lib/role-helpers').isGlobalAdmin(actorId)) fail('CLINICAL_CATALOG_GLOBAL_ADMIN_REQUIRED');
  return { actorId, target: targetArgument.slice(9) };
}
function assertSource({ cwd, sourceRoot, branch, dirty }) {
  if (cwd !== ROOT || sourceRoot !== ROOT || branch !== 'dev' || dirty) fail('CLINICAL_CATALOG_CLEAN_CANONICAL_DEV_SOURCE_REQUIRED');
}
function assertTarget(target, config) {
  try { schemaRelease.assertTarget(target, config); } catch { fail('CLINICAL_CATALOG_LOCAL_EXPLICIT_TARGET_REQUIRED'); }
}
async function verifyDatabase(sql, target, config, actorId) {
  assertTarget(target, config);
  const [rows] = await sql.query('SELECT DATABASE() database_name,CURRENT_USER() database_user,@@port server_port');
  if (rows[0]?.database_name !== config.database || String(rows[0]?.database_user).split('@')[0] !== config.user || Number(rows[0]?.server_port) !== 3306) fail('CLINICAL_CATALOG_DATABASE_IDENTITY_INVALID');
  if (target === 'dev') {
    const [anchors] = await sql.query("SELECT EXISTS(SELECT 1 FROM Clinicas WHERE id_clinica=1 AND nombre_clinica='Clinica ficticia DEV') AS fictional_anchor");
    if (Number(anchors[0]?.fictional_anchor) !== 1) fail('CLINICAL_CATALOG_FICTIONAL_ANCHOR_REQUIRED');
  }
  const [actors] = await sql.query('SELECT EXISTS(SELECT 1 FROM Usuarios WHERE id_usuario=:actorId) AS actor_exists', { replacements: { actorId } });
  if (Number(actors[0]?.actor_exists) !== 1) fail('CLINICAL_CATALOG_ACTOR_NOT_PRESENT');
}
async function withCatalogLock(sql, target, work) {
  const name = schemaRelease.lockNameForTarget(target);
  const [[lock]] = await sql.query('SELECT GET_LOCK(:name,0) acquired', { replacements: { name } });
  if (Number(lock?.acquired) !== 1) fail('CLINICAL_CATALOG_OTHER_OPERATOR_ACTIVE');
  try { return await work(); }
  finally { await sql.query('SELECT RELEASE_LOCK(:name)', { replacements: { name } }); }
}
function assertPreparedSchema(state) {
  if (schemaRelease.pending(state).length) fail('CLINICAL_CATALOG_SCHEMA_RELEASE_REQUIRED');
}
async function prepare({ catalog, actorId }) {
  const { items } = await catalog.presets(), results = [], existing = [];
  let cursor;
  do { const page = await catalog.list({ admin: true, query: { limit: 100, ...(cursor ? { cursor } : {}) } }); existing.push(...page.items); cursor = page.next_cursor; } while (cursor);
  for (const preset of items) {
    const retained = existing.find(item => item.catalog_key === preset.catalog_key);
    if (retained) { results.push({ catalog_key: retained.catalog_key, id: retained.id, source_version: retained.published_version, created: false, retained: true }); continue; }
    const result = await catalog.create({ actorId, payload: { ...preset, expected_version: 0, publish: true } });
    results.push({ catalog_key: result.item.catalog_key, id: result.item.id, source_version: result.item.version, created: result.created });
  }
  return results;
}
async function run(args) {
  const { actorId, target } = argumentsFor(args), path = require('node:path'), { execFileSync } = require('node:child_process');
  assertSource({ cwd: process.cwd(), sourceRoot: path.resolve(__dirname, '../..'), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() });
  const config = require('../lib/cliniccloud-import/operator-database').databaseOptions(target);
  assertTarget(target, config);
  const { database, user, password, host, port, ...dialectOptions } = config;
  const { Sequelize, DataTypes } = require('sequelize');
  // All model operations reuse the lock's SQL session; do not reap it while idle.
  const sql = new Sequelize(database, user, password, { host, port, dialect: 'mysql', dialectOptions, logging: false, pool: { min: 1, max: 1 } });
  try {
    await verifyDatabase(sql, target, config, actorId);
    return await withCatalogLock(sql, target, async () => {
      assertPreparedSchema(await schemaRelease.capture(sql, target, config));
      // Load only the source catalog's models, without the app/model index,
      // workers, dotenv mutation, clinic copy models or patient services.
      const db = { sequelize: sql };
      for (const file of ['medicalareacontract', 'clinicaltemplatecatalogentry', 'clinicaltemplatecatalogversion', 'clinicaltemplatecatalogadoption']) {
        const model = require('../../models/' + file)(sql, DataTypes); db[model.name] = model;
      }
      return { target, source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source_only: true,
        clinic_copies_created: 0, items: await prepare({ catalog: require('../services/clinicalTemplateCatalog.service').createClinicalTemplateCatalogService({ db }), actorId }) };
    });
  } finally { await sql.close(); }
}
if (require.main === module) {
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.code || (String(error.message).startsWith('CLINICAL_CATALOG_') ? error.message : 'CLINICAL_CATALOG_SOURCE_PREPARATION_FAILED')); process.exitCode = 1;
  });
}
module.exports = { prepare, argumentsFor, assertSource, assertTarget, verifyDatabase, withCatalogLock, assertPreparedSchema, run };

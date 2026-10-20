#!/usr/bin/env node
'use strict';

// One-row operator, no application bootstrap, patient reads, sender or jobs.
// prepare/dry-run are SELECT-only; apply requires the exact reviewed hash and
// performs one guarded UPDATE inside a transaction with canonical validation.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const P = require('../lib/cliniccloud-import/bs-contorno-cor43-closure');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, writePrivateJson, syncDirectory } = require('../lib/cliniccloud-import/io');
const ROOT = '/home/ubuntu/wt/back-staging';
const GATES = ['BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED', 'BOOKING_EQUIPMENT_ENABLED'];
const TABLES = new Set(['Clinicas', 'Tratamientos', 'Instalaciones', 'DoctorClinicas', 'InstallationPhysicalAliases',
  'BookingEquipment', 'BookingEquipmentClinics', 'BookingEquipmentRoomPolicies', 'Usuarios',
  'INFORMATION_SCHEMA.TABLES', 'INFORMATION_SCHEMA.COLUMNS', 'INFORMATION_SCHEMA.STATISTICS', 'INFORMATION_SCHEMA.TRIGGERS']);
const UPDATE_SQL = 'UPDATE Tratamientos SET precio_base=:amount,activo=:active,clinical_config=CAST(:afterConfig AS JSON),updatedAt=:updatedAt '
  + 'WHERE id_tratamiento=2122 AND clinica_id=72 AND codigo=\'BS26-COR43-PROGRAM\' AND activo=0 AND precio_base IS NULL '
  + 'AND updatedAt <=> :beforeUpdatedAt AND clinical_config=CAST(:beforeConfig AS JSON)';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const copy = value => JSON.parse(JSON.stringify(value));
const canonicalRow = value => {
  const result = copy(value?.toJSON ? value.toJSON() : value);
  if (typeof result.clinical_config === 'string') result.clinical_config = JSON.parse(result.clinical_config);
  for (const field of ['createdAt', 'updatedAt']) if (typeof result[field] === 'string') {
    const text = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(result[field]) ? result[field].replace(' ', 'T') + 'Z' : result[field];
    if (!Number.isFinite(Date.parse(text))) fail('COR43_OPERATOR_ROW_CLOCK_INVALID');
    result[field] = new Date(text).toISOString();
  }
  return result;
};

function sqlAllowed(sql, { writable = false, casVerified = false, writes = 0 } = {}) {
  const text = String(typeof sql === 'string' ? sql : sql?.query || '').trim();
  if (/;\s*\S/.test(text) || /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE\s*\(|GET_LOCK\s*\(|RELEASE_LOCK\s*\(|SLEEP\s*\()/i.test(text)) return false;
  if (/^SELECT\b/i.test(text)) {
    const tables = [...text.matchAll(/\b(?:FROM|JOIN)\s+(`?[a-zA-Z][a-zA-Z0-9_]*`?(?:\.`?[a-zA-Z][a-zA-Z0-9_]*`?)?)/gi)]
      .map(match => match[1].replace(/`/g, ''));
    return tables.every(table => TABLES.has(table));
  }
  if (/^(?:START TRANSACTION(?: READ ONLY)?|COMMIT|ROLLBACK);?$/i.test(text)
    || /^SET TRANSACTION ISOLATION LEVEL (?:READ COMMITTED|REPEATABLE READ);?$/i.test(text)) return true;
  return writable && casVerified && writes === 0 && text === UPDATE_SQL;
}

function privateJson(filename) {
  if (!filename || !path.isAbsolute(filename)) fail('COR43_OPERATOR_PRIVATE_INPUT_REQUIRED');
  const root = fs.realpathSync('/home/ubuntu/secure-imports'), parent = fs.realpathSync(path.dirname(filename)), stat = fs.lstatSync(filename);
  if (parent !== root && !parent.startsWith(root + path.sep) || !stat.isFile() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077) fail('COR43_OPERATOR_PRIVATE_INPUT_REQUIRED');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function journal(filename) {
  const root = fs.realpathSync('/home/ubuntu/secure-imports'), parent = fs.realpathSync(path.dirname(filename));
  if (!path.isAbsolute(filename) || parent !== root && !parent.startsWith(root + path.sep)) fail('COR43_OPERATOR_PRIVATE_JOURNAL_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  syncDirectory(parent);
  return { append(record) { fs.writeSync(fd, JSON.stringify({ recorded_at: new Date().toISOString(), ...record }) + '\n'); fs.fsyncSync(fd); },
    close() { fs.closeSync(fd); } };
}

function sourceIdentity() {
  if (cp.execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()) fail('COR43_OPERATOR_PUBLISHED_SOURCE_DIRTY');
  const commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const runtime = JSON.parse(cp.execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
    .find(item => item.name === 'pm2-back-staging');
  if (!runtime || runtime.pm2_env?.pm_cwd !== ROOT || runtime.pm2_env.status !== 'online') fail('COR43_OPERATOR_RUNTIME_MISMATCH');
  const env = require(path.join(ROOT, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(ROOT, '.env')));
  const gates = Object.fromEntries(GATES.map(key => [key, runtime.pm2_env[key] ?? env[key] ?? 'false']));
  if (Object.values(gates).some(value => value !== 'true')) fail('COR43_OPERATOR_RUNTIME_CAPABILITY_DISABLED');
  return { source_root: ROOT, source_commit: commit, gates };
}
function loadedIdentity(identity) {
  const files = Object.keys(require.cache).filter(file => file.startsWith(ROOT + path.sep) && !file.includes('/node_modules/'))
    .map(file => ({ path: file.slice(ROOT.length + 1), sha256: hash(fs.readFileSync(file)) })).sort((a, b) => a.path.localeCompare(b.path));
  return { ...identity, loaded_source_files: files, loaded_source_sha256: hash(files) };
}
function assertSource(expected) {
  const actual = sourceIdentity();
  if (actual.source_commit !== expected.source_commit || hash(actual.gates) !== hash(expected.gates)
    || expected.loaded_source_files.some(file => hash(fs.readFileSync(path.join(ROOT, file.path))) !== file.sha256)) fail('COR43_OPERATOR_SOURCE_CHANGED');
}
function canonicalAfter(plan, contract) {
  const config = contract.applyImportedPriceReview(plan.before.clinical_config,
    contract.mergeClinicalConfig(plan.before.clinical_config, plan.payload.clinical_config), {
      confirm: true, amount: 145, actorId: plan.decision.actor_id, now: new Date(plan.reviewed_at),
    });
  const candidate = { ...copy(plan.before), precio_base: 145, activo: plan.activation, clinical_config: config };
  if (hash(candidate) !== plan.after_sha256) fail('COR43_OPERATOR_PUBLISHED_NORMALIZERS_DIFFER');
  return candidate;
}

async function publishedContext({ writable = false } = {}) {
  const identity = sourceIdentity(), r = relative => require(path.join(ROOT, relative));
  const Sequelize = r('node_modules/sequelize'), options = r('src/lib/cliniccloud-import/operator-database').databaseOptions('crm');
  const state = { writable, casVerified: false, writes: 0, selects: 0 };
  const sequelize = new Sequelize(options.database, options.user, options.password, { host: options.host, port: options.port,
    dialect: 'mysql', timezone: '+00:00', logging: false, pool: { min: 0, max: 1, idle: 1000, acquire: 15000 },
    dialectOptions: { ...(options.ssl ? { ssl: options.ssl } : {}), maxPreparedStatements: 32 },
    hooks: { afterConnect: connection => new Promise((resolve, reject) => {
      const statements = ['SET SESSION MAX_EXECUTION_TIME = 15000', 'SET SESSION innodb_lock_wait_timeout = 5',
        ...(!writable ? ['SET SESSION TRANSACTION READ ONLY'] : [])];
      const next = () => {
        if (!statements.length) return resolve();
        connection.query(statements.shift(), error => error ? reject(error) : next());
      };
      next();
    }) } });
  const query = sequelize.query.bind(sequelize);
  sequelize.query = async (sql, opts) => {
    if (!sqlAllowed(sql, state)) fail('COR43_OPERATOR_SQL_GUARD_REJECTED');
    const text = String(typeof sql === 'string' ? sql : sql.query).trim();
    if (/^SELECT\b/i.test(text)) state.selects++; else if (text === UPDATE_SQL) state.writes++;
    return query(sql, opts);
  };
  const db = { sequelize, Sequelize };
  for (const filename of ['clinica', 'tratamiento', 'instalacion', 'doctorclinica', 'installationphysicalalias',
    'bookingequipment', 'bookingequipmentclinic', 'bookingequipmentroompolicy']) {
    const model = r('models/' + filename)(sequelize, Sequelize.DataTypes); db[model.name] = model;
  }
  db.BookingEquipment.associate(db);
  db.Instalacion.belongsTo(db.Clinica, { as: 'clinica', foreignKey: 'clinica_id', targetKey: 'id_clinica' });
  const originalClinicByPk = db.Clinica.findByPk.bind(db.Clinica);
  db.Clinica.findByPk = (id, opts = {}) => originalClinicByPk(id, { ...opts, attributes: ['id_clinica', 'grupoClinicaId', 'equipment_booking_enabled'] });
  const contract = r('src/lib/treatment-catalog-contract'), validate = r('src/lib/treatment-catalog-resources').validateCatalogResources;
  return { db, state, contract, identity,
    validate: (candidate, transaction) => validate(candidate, db, { transaction, environment: identity.gates }),
    assertNoBootstrap() { if (require.cache[require.resolve(path.join(ROOT, 'models'))]) fail('COR43_OPERATOR_MODELS_INDEX_LOADED'); },
    async close() { await sequelize.close(); } };
}

async function capture(context, transaction, { locked = false, actorId = 1 } = {}) {
  const { db } = context, share = locked ? { lock: transaction.LOCK.SHARE } : {};
  const selectSchema = text => db.sequelize.query(text, { type: db.Sequelize.QueryTypes.SELECT, transaction });
  const engine = await selectSchema("SELECT ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Tratamientos'");
  const columns = await selectSchema("SELECT COLUMN_NAME,DATA_TYPE,NUMERIC_SCALE,DATETIME_PRECISION FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Tratamientos' AND COLUMN_NAME IN ('id_tratamiento','precio_base','clinical_config','updatedAt') ORDER BY COLUMN_NAME");
  const primary = await selectSchema("SELECT COLUMN_NAME,SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Tratamientos' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX");
  const triggers = await selectSchema("SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='Tratamientos' ORDER BY TRIGGER_NAME");
  const column = name => columns.find(value => value.COLUMN_NAME === name);
  if (engine.length !== 1 || engine[0].ENGINE !== 'InnoDB' || primary.length !== 1 || primary[0].COLUMN_NAME !== 'id_tratamiento'
    || triggers.length || column('clinical_config')?.DATA_TYPE !== 'json' || column('precio_base')?.DATA_TYPE !== 'decimal'
    || Number(column('precio_base')?.NUMERIC_SCALE) !== 2 || column('updatedAt')?.DATA_TYPE !== 'datetime'
    || ![0, 3].includes(Number(column('updatedAt')?.DATETIME_PRECISION))) fail('COR43_OPERATOR_STORAGE_CONTRACT_INVALID');
  const storage = { engine, columns, primary, triggers };
  const clinic = await db.Clinica.findByPk(72, { transaction, ...share });
  const treatment = await db.Tratamiento.findByPk(2122, { transaction, ...(locked ? { lock: transaction.LOCK.UPDATE } : {}) });
  // Seal exactly the equivalence family that the published canonical validator
  // resolves, including a foreign-group/invalid row (which it must reject).
  const selectedAliases = await db.InstallationPhysicalAlias.findAll({ where: { installation_id: 85 },
    order: [['installation_id', 'ASC']], transaction, ...share });
  const canonicalIds = [...new Set([Number(selectedAliases[0]?.canonical_installation_id || 85)])];
  const relatedAliases = await db.InstallationPhysicalAlias.findAll({ where: {
    [db.Sequelize.Op.or]: [{ installation_id: { [db.Sequelize.Op.in]: canonicalIds } },
      { canonical_installation_id: { [db.Sequelize.Op.in]: canonicalIds } }] }, order: [['installation_id', 'ASC']], transaction, ...share });
  const aliases = [...new Map([...selectedAliases, ...relatedAliases].map(value => [Number(value.installation_id), value])).values()]
    .sort((left, right) => Number(left.installation_id) - Number(right.installation_id));
  const roomIds = [...new Set([85, ...aliases.flatMap(value => [Number(value.installation_id), Number(value.canonical_installation_id)])])];
  const rooms = await db.Instalacion.findAll({ where: { id: { [db.Sequelize.Op.in]: roomIds } }, order: [['id', 'ASC']], transaction, ...share });
  const professionals = await db.DoctorClinica.findAll({ where: { doctor_id: 221, clinica_id: 72 },
    attributes: ['id', 'doctor_id', 'clinica_id', 'activo', 'recibe_citas'], order: [['id', 'ASC']], transaction, ...share });
  const equipment = await db.BookingEquipment.findAll({ where: { id: { [db.Sequelize.Op.in]: [4, 10] } }, order: [['id', 'ASC']], transaction, ...share });
  const equipmentClinics = await db.BookingEquipmentClinic.findAll({ where: { clinic_id: 72, equipment_id: { [db.Sequelize.Op.in]: [4, 10] } },
    order: [['equipment_id', 'ASC']], transaction, ...share });
  const equipmentRoomPolicies = await db.BookingEquipmentRoomPolicy.findAll({ where: { installation_id: { [db.Sequelize.Op.in]: roomIds } },
    order: [['installation_id', 'ASC']], transaction, ...share });
  const ownerClinicIds = [...new Set([...rooms.map(value => Number(value.clinica_id)), ...equipment.map(value => Number(value.owner_clinic_id))])]
    .filter(id => Number.isSafeInteger(id) && id > 0).sort((left, right) => left - right);
  const ownerClinics = await db.Clinica.findAll({ where: { id_clinica: { [db.Sequelize.Op.in]: ownerClinicIds } },
    attributes: ['id_clinica', 'grupoClinicaId', 'equipment_booking_enabled'], order: [['id_clinica', 'ASC']], transaction, ...share });
  const actors = await db.sequelize.query('SELECT id_usuario,estado_cuenta FROM Usuarios WHERE id_usuario=:actor', {
    replacements: { actor: actorId }, type: db.Sequelize.QueryTypes.SELECT, transaction });
  if (Number(clinic?.id_clinica) !== 72 || Number(clinic?.grupoClinicaId) !== 29 || !treatment
    || actorId !== 1 || actors.length !== 1 || actors[0].estado_cuenta !== 'activo') fail('COR43_OPERATOR_SCOPE_OR_ACTOR_INVALID');
  const configuration = copy({ storage, clinic, ownerClinics, rooms, professionals, aliases, equipment, equipmentClinics, equipmentRoomPolicies });
  return { target: 'crm', group_id: 29, clinic_id: 72, captured_at: new Date().toISOString(), treatment: canonicalRow(treatment),
    configuration_sha256: hash(configuration), configuration };
}

function assertBundle(bundle, approvedSha256 = null, { applying = false, now = Date.now() } = {}) {
  P.assertPlan(bundle?.plan);
  if (bundle.mode !== 'cor43_published_helpers_select_only' || bundle.actor_id !== 1 || !bundle.source?.loaded_source_files?.length
    || hash(bundle.backup) !== bundle.backup_sha256 || hash(bundle.backup.treatment) !== bundle.plan.before_sha256
    || hash(bundle.backup) !== hash(bundle.plan.snapshot)
    || hash(bundle.backup.configuration) !== bundle.backup.configuration_sha256
    || bundle.backup.configuration_sha256 !== bundle.plan.configuration_sha256 || bundle.metadata?.business_writes !== 0
    || bundle.plan.activation !== true || bundle.plan.decision.actor_id !== 1
    || bundle.source.source_root !== ROOT || !/^[a-f0-9]{40}$/.test(bundle.source.source_commit)
    || bundle.source.loaded_source_sha256 !== hash(bundle.source.loaded_source_files)
    || bundle.source.loaded_source_files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.split('/').includes('..'))
    || hash(bundle.source) !== hash(bundle.plan.canonical_validation?.published_source)) fail('COR43_OPERATOR_BUNDLE_INVALID');
  if (applying && (approvedSha256 !== bundle.plan.plan_sha256 || now < Date.parse(bundle.plan.created_at)
    || now - Date.parse(bundle.plan.created_at) > P.MAX_AGE_MS)) fail('COR43_OPERATOR_EXACT_FRESH_APPROVAL_REQUIRED');
}

async function prepare({ decision, sourceEvidence, privateOutput }) {
  const context = await publishedContext();
  try {
    const bundle = await context.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const backup = await capture(context, transaction, { actorId: decision.actor_id });
      const reviewedAt = new Date().toISOString(), initial = P.buildPlan({ snapshot: backup, decision, sourceEvidence, createdAt: reviewedAt, reviewedAt });
      const candidatePlan = { ...initial, activation: true, payload: { ...initial.payload, activo: true,
        clinical_config: { ...initial.payload.clinical_config, catalog_status: 'active' } }, after_sha256: initial.activation_candidate_sha256 };
      const candidate = canonicalAfter(candidatePlan, context.contract);
      await context.validate(candidate, transaction);
      const source = loadedIdentity(context.identity), checked = new Date().toISOString(), proof = { validator: 'validateCatalogResources', ok: true, issues: [], treatment_id: 2122,
        clinic_id: 72, before_sha256: initial.before_sha256, candidate_sha256: hash(candidate), configuration_sha256: backup.configuration_sha256,
        checked_at: checked, published_source: source };
      const plan = P.buildPlan({ snapshot: backup, decision, sourceEvidence, canonicalValidation: proof, reviewedAt, createdAt: new Date().toISOString() });
      if (hash(canonicalAfter(plan, context.contract)) !== plan.after_sha256) fail('COR43_OPERATOR_PUBLISHED_NORMALIZERS_DIFFER');
      context.assertNoBootstrap();
      return { mode: 'cor43_published_helpers_select_only', actor_id: decision.actor_id, backup, backup_sha256: hash(backup), plan,
        source, metadata: { read_only: true, business_writes: 0, provider_calls: 0,
          patient_rows_read: false, models_index_loaded: false, select_queries: context.state.selects } };
    });
    assertBundle(bundle); assertSource(bundle.source); writePrivateJson(privateOutput, bundle);
    return { mode: 'prepared_select_only', treatment_id: 2122, plan_sha256: bundle.plan.plan_sha256,
      active_proposal: bundle.plan.activation, price: 145, tax_percent: 21, source_commit: bundle.source.source_commit, business_writes: 0 };
  } finally { await context.close(); }
}

async function applyBundle({ bundle, approvedSha256, context, log, assertPublishedSource = assertSource, now = () => new Date().toISOString() }) {
  assertBundle(bundle, approvedSha256, { applying: true, now: Date.parse(now()) }); assertPublishedSource(bundle.source);
  let commitAttempted = false;
  try {
    const after = await context.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const current = await capture(context, transaction, { locked: true, actorId: 1 });
      try {
        P.verifyAfter(bundle.plan, current.treatment, { now: now() });
        if (current.configuration_sha256 !== bundle.plan.configuration_sha256) fail('COR43_OPERATOR_CONFIGURATION_CHANGED');
        return { replayed: true, treatment: current.treatment };
      } catch (error) { if (error.code === 'COR43_OPERATOR_CONFIGURATION_CHANGED') throw error; }
      P.assertPrecondition(bundle.plan, current.treatment, { configurationSha256: current.configuration_sha256, now: now() });
      const candidate = canonicalAfter(bundle.plan, context.contract); await context.validate(candidate, transaction);
      assertPublishedSource(bundle.source);
      log.append({ phase: 'locked_full_row_cas_and_canonical_validation', treatment_id: 2122, before_sha256: bundle.plan.before_sha256,
        plan_sha256: bundle.plan.plan_sha256, actor_id: 1, backup_sha256: bundle.backup_sha256 });
      context.state.casVerified = true;
      const [_, changed] = await context.db.sequelize.query(UPDATE_SQL, { replacements: { amount: 145, active: 1,
        afterConfig: JSON.stringify(candidate.clinical_config), updatedAt: now().slice(0, 19).replace('T', ' '),
        beforeUpdatedAt: current.treatment.updatedAt.slice(0, 19).replace('T', ' '), beforeConfig: JSON.stringify(current.treatment.clinical_config) },
      transaction, type: context.db.Sequelize.QueryTypes.UPDATE });
      context.state.casVerified = false;
      if (changed !== 1) fail('COR43_OPERATOR_EXACT_UPDATE_COUNT_REQUIRED');
      const verified = await capture(context, transaction);
      P.verifyAfter(bundle.plan, verified.treatment, { now: now() });
      if (verified.configuration_sha256 !== bundle.plan.configuration_sha256) fail('COR43_OPERATOR_CONFIGURATION_CHANGED');
      log.append({ phase: 'verified_before_commit', treatment_id: 2122, after_sha256: hash(verified.treatment) });
      commitAttempted = true;
      return { replayed: false, treatment: verified.treatment };
    });
    log.append({ phase: after.replayed ? 'replay_verified_no_update' : 'commit_completed', treatment_id: 2122, after_sha256: hash(after.treatment) });
    return { mode: after.replayed ? 'already_applied_verified' : 'committed', treatment_id: 2122, updated: after.replayed ? 0 : 1,
      programmes_changed: 0, purchases_changed: 0, appointments_changed: 0, messages_sent: 0, after: after.treatment };
  } catch (error) {
    context.state.casVerified = false;
    if (commitAttempted) { log.append({ phase: 'commit_result_requires_independent_review', treatment_id: 2122 }); fail('COR43_OPERATOR_COMMIT_RESULT_REQUIRES_REVIEW'); }
    throw error;
  }
}

async function run(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--decision', '--source-evidence', '--package', '--approved-sha256', '--private-journal', '--private-output']);
  if (args['--target'] !== 'crm' || !['prepare', 'dry-run', 'apply'].includes(args['--mode'])) fail('COR43_OPERATOR_EXPLICIT_MODE_REQUIRED');
  if (['prepare', 'dry-run'].includes(args['--mode'])) return prepare({ decision: privateJson(args['--decision']),
    sourceEvidence: privateJson(args['--source-evidence']), privateOutput: args['--private-output'] });
  const bundle = privateJson(args['--package']); assertBundle(bundle, args['--approved-sha256'], { applying: true });
  const log = journal(args['--private-journal']), context = await publishedContext({ writable: true });
  try {
    const result = await applyBundle({ bundle, approvedSha256: args['--approved-sha256'], context, log });
    context.assertNoBootstrap();
    // A new, separate read-only connection, not the committed transaction.
    const independent = await publishedContext();
    try {
      const current = await independent.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, tx => capture(independent, tx));
      P.verifyAfter(bundle.plan, current.treatment);
      if (current.configuration_sha256 !== bundle.plan.configuration_sha256) fail('COR43_OPERATOR_INDEPENDENT_CONFIGURATION_CHANGED');
      log.append({ phase: 'independent_readback_verified', treatment_id: 2122, after_sha256: hash(current.treatment) });
      result.mode = result.updated ? 'committed_and_independently_verified' : 'already_applied_and_independently_verified';
      writePrivateJson(args['--private-output'], result); return { ...result, after: undefined };
    } finally { await independent.close(); }
  } finally { log.close(); await context.close(); }
}
if (require.main === module) run(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
  console.error(/^COR43_/.test(error.message) ? error.message : 'COR43_OPERATOR_FAILED_REVIEW_PRIVATE_EVIDENCE'); process.exitCode = 1;
});
module.exports = { ROOT, UPDATE_SQL, canonicalRow, sqlAllowed, canonicalAfter, assertBundle, capture, applyBundle, prepare, run };

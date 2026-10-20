#!/usr/bin/env node
'use strict';

// Closed operator: three existing programme definitions, never patient data or
// bookings. Persistence is exclusively the published service's update method.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const planner = require('../lib/cliniccloud-import/bs-program-catalog-closure');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, writePrivateJson, syncDirectory } = require('../lib/cliniccloud-import/io');
const PUBLISHED_ROOT = '/home/ubuntu/wt/back-staging';
const IDS = Object.freeze([22, 25, 26]);
const GATES = Object.freeze(['BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED', 'BOOKING_PHASE_OFFSETS_ENABLED',
  'BOOKING_EQUIPMENT_ENABLED', 'TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED']);
const fail = code => { throw Error(code); };
const copy = value => JSON.parse(JSON.stringify(value));
// Sequelize DTO dates are Date objects. Seal the durable JSON representation,
// not Date's empty enumerable-key representation in the stable object hasher.
const sealPreview = preview => copy(preview);

function privateJson(filename) {
  const root = fs.realpathSync('/home/ubuntu/secure-imports'), parent = fs.realpathSync(path.dirname(filename));
  const stat = fs.lstatSync(filename);
  if (!path.isAbsolute(filename) || (parent !== root && !parent.startsWith(root + path.sep)) || !stat.isFile()
      || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('BS_CLOSURE_PRIVATE_INPUT_REQUIRED');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function sourceIdentity() {
  const commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PUBLISHED_ROOT, encoding: 'utf8' }).trim();
  if (cp.execFileSync('git', ['status', '--porcelain'], { cwd: PUBLISHED_ROOT, encoding: 'utf8' }).trim()) fail('BS_CLOSURE_PUBLISHED_SOURCE_DIRTY');
  const processes = JSON.parse(cp.execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const runtime = processes.find(item => item.name === 'pm2-back-staging');
  if (!runtime || runtime.pm2_env.pm_cwd !== PUBLISHED_ROOT || runtime.pm2_env.status !== 'online') fail('BS_CLOSURE_PUBLISHED_RUNTIME_MISMATCH');
  const env = require(path.join(PUBLISHED_ROOT, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(PUBLISHED_ROOT, '.env')));
  const gates = Object.fromEntries(GATES.map(key => [key, runtime.pm2_env[key] ?? env[key] ?? 'false']));
  if (Object.values(gates).some(value => value !== 'true')) fail('BS_CLOSURE_PUBLISHED_CAPABILITY_DISABLED');
  return { source_root: PUBLISHED_ROOT, source_commit: commit, gates };
}
function loadedSourceIdentity(identity) {
  const files = Object.keys(require.cache).filter(filename => filename.startsWith(PUBLISHED_ROOT + path.sep)
    && !filename.includes('/node_modules/')).map(filename => ({ path: filename.slice(PUBLISHED_ROOT.length + 1), sha256: hash(fs.readFileSync(filename)) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { ...identity, loaded_source_files: files, loaded_source_tree_sha256: hash(files) };
}
function assertSource(expected) {
  const current = sourceIdentity();
  if (current.source_commit !== expected.source_commit || hash(current.gates) !== hash(expected.gates)
      || expected.loaded_source_files.some(file => hash(fs.readFileSync(path.join(PUBLISHED_ROOT, file.path))) !== file.sha256)) fail('BS_CLOSURE_PUBLISHED_SOURCE_CHANGED');
}
function canonicalFullRow(row) {
  const result = copy(row);
  for (const field of ['created_at', 'updated_at']) if (result[field] != null) {
    const value = result[field];
    const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    if (!Number.isFinite(Date.parse(iso))) fail('BS_CLOSURE_CAS_TIMESTAMP_INVALID');
    result[field] = new Date(iso).toISOString();
  }
  return result;
}
function assertFullRow(expected, current) {
  if (!current || hash(canonicalFullRow(expected)) !== hash(canonicalFullRow(current))) fail('BS_CLOSURE_FULL_ROW_CAS_CONFLICT');
}
function sqlAllowed(sql, { writable, operation, casVerified = false }) {
  const text = String(typeof sql === 'string' ? sql : sql?.query || '').trim();
  if (/^SELECT\b/i.test(text)) return !/\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE\s*\()/i.test(text);
  if (!writable) return false;
  if (/^(?:START TRANSACTION|COMMIT|ROLLBACK);?$/i.test(text)
      || /^SET TRANSACTION ISOLATION LEVEL (?:READ COMMITTED|REPEATABLE READ|SERIALIZABLE);?$/i.test(text)) return true;
  return !!operation && casVerified && IDS.includes(operation.program_id)
    && (/^UPDATE\s+`?TreatmentPrograms`?\s+SET\b/i.test(text) || /^INSERT INTO\s+`?TreatmentProgramRevisions`?\s*\(/i.test(text));
}
function assertBundle(bundle, approvedSha256, { now = Date.now(), applying = false } = {}) {
  planner.assertPlan(bundle?.plan);
  if (bundle.mode !== 'published_canonical_service_select_only_not_http' || bundle.target !== 'crm'
      || hash(bundle.snapshot) !== bundle.plan.snapshot_sha256 || bundle.backup_sha256 !== hash(bundle.snapshot)
      || bundle.previews_sha256 !== hash(bundle.previews) || !bundle.configuration_and_programs_unchanged
      || bundle.actor_id !== 1 || !bundle.source?.loaded_source_files?.length
      || !bundle.plan.operations.length || bundle.plan.operations.some(operation => !IDS.includes(operation.program_id)
        || operation.after.status !== 'active' || operation.activation !== true)) fail('BS_CLOSURE_BUNDLE_INVALID');
  if (applying && (approvedSha256 !== bundle.plan.package_sha256 || now < Date.parse(bundle.plan.created_at)
      || now - Date.parse(bundle.plan.created_at) > planner.MAX_SNAPSHOT_AGE_MS)) fail('BS_CLOSURE_APPROVAL_OR_FRESHNESS_INVALID');
}
function journal(filename) {
  const root = fs.realpathSync('/home/ubuntu/secure-imports'), parent = fs.realpathSync(path.dirname(filename));
  if (!path.isAbsolute(filename) || (parent !== root && !parent.startsWith(root + path.sep))) fail('BS_CLOSURE_PRIVATE_JOURNAL_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  syncDirectory(parent);
  return { append(record) { fs.writeSync(fd, JSON.stringify({ recorded_at: new Date().toISOString(), ...record }) + '\n'); fs.fsyncSync(fd); }, close() { fs.closeSync(fd); } };
}

async function publishedContext({ writable = false, onLockedRow = null } = {}) {
  const identity = sourceIdentity();
  // Only the six verified capability flags enter this short-lived process.
  // Credentials remain the published CRM operator helper's private input.
  for (const [key, value] of Object.entries(identity.gates)) process.env[key] = value;
  const requirePublished = relative => require(path.join(PUBLISHED_ROOT, relative));
  const Sequelize = requirePublished('node_modules/sequelize');
  const { databaseOptions, connectOperatorDatabase } = requirePublished('src/lib/cliniccloud-import/operator-database');
  const captureModule = requirePublished('src/scripts/bs-client-program-replies');
  const { createTreatmentProgramsService } = requirePublished('src/services/treatmentPrograms.service');
  const options = databaseOptions('crm');
  const context = { identity, operation: null, casVerified: false, operationUpdates: 0, operationRevisions: 0,
    selects: 0, transactions: 0, updates: 0, revisions: 0, locked_cas: 0 };
  const sequelize = new Sequelize(options.database, options.user, options.password, { host: options.host, port: options.port, dialect: 'mysql', logging: false,
    pool: { max: 1, min: 0, idle: 1000, acquire: 15000 }, dialectOptions: { ...(options.ssl ? { ssl: options.ssl } : {}), maxPreparedStatements: 32 },
    ...(!writable ? { hooks: { afterConnect: connection => new Promise((resolve, reject) => connection.query('SET SESSION TRANSACTION READ ONLY', error => error ? reject(error) : resolve())) } } : {}) });
  const originalQuery = sequelize.query.bind(sequelize);
  sequelize.query = async (sql, opts) => {
    if (!sqlAllowed(sql, { writable, operation: context.operation, casVerified: context.casVerified })) fail('BS_CLOSURE_SQL_GUARD_REJECTED');
    const text = String(typeof sql === 'string' ? sql : sql.query).trim();
    if (/^SELECT\b/i.test(text)) context.selects++;
    else if (/^UPDATE\b/i.test(text)) { if (context.operationUpdates !== 0) fail('BS_CLOSURE_EXCESS_PROGRAM_WRITE'); context.operationUpdates++; context.updates++; }
    else if (/^INSERT INTO\b/i.test(text)) { if (context.operationUpdates !== 1 || context.operationRevisions !== 0) fail('BS_CLOSURE_EXCESS_REVISION_WRITE'); context.operationRevisions++; context.revisions++; }
    else context.transactions++;
    return originalQuery(sql, opts);
  };
  const db = { sequelize, Sequelize };
  for (const name of ['clinica', 'treatmentprogram', 'treatmentprogramrevision', 'tratamiento', 'instalacion', 'doctorclinica',
    'installationphysicalalias', 'bookingequipment', 'bookingequipmentclinic', 'bookingequipmentroompolicy']) {
    const model = requirePublished('models/' + name)(sequelize, Sequelize.DataTypes); db[model.name] = model;
  }
  db.BookingEquipment.associate(db);
  db.Instalacion.belongsTo(db.Clinica, { as: 'clinica', foreignKey: 'clinica_id', targetKey: 'id_clinica' });
  if (writable) {
    const findOne = db.TreatmentProgram.findOne.bind(db.TreatmentProgram);
    db.TreatmentProgram.findOne = async opts => {
      const row = await findOne(opts);
      if (opts?.lock && opts.transaction) {
        const operation = context.operation;
        if (!operation || !row || Number(row.id) !== operation.program_id) fail('BS_CLOSURE_UNEXPECTED_LOCKED_PROGRAM');
        const [raw] = await sequelize.query('SELECT * FROM TreatmentPrograms WHERE id = :id', {
          replacements: { id: operation.program_id }, type: Sequelize.QueryTypes.SELECT, transaction: opts.transaction, raw: true });
        assertFullRow(operation.before, raw); context.locked_cas++; context.casVerified = true;
        if (onLockedRow) await onLockedRow(operation, raw);
      }
      return row;
    };
  }
  const connection = await connectOperatorDatabase('crm');
  return { ...context, db, state: context, service: createTreatmentProgramsService({ db }),
    capture: () => captureModule.capture(connection), stableSnapshot: captureModule.stableSnapshot,
    assertNoBootstrap() { if (require.cache[require.resolve(path.join(PUBLISHED_ROOT, 'models'))]) fail('BS_CLOSURE_MODELS_INDEX_LOADED'); },
    async close() { await connection.end(); await sequelize.close(); } };
}

async function prepare({ decision, privateOutput }) {
  const context = await publishedContext();
  try {
    const snapshot = await context.capture(), initial = planner.buildPlan({ snapshot, decision }), previews = [];
    const replies = require(path.join(PUBLISHED_ROOT, 'src/lib/cliniccloud-import/bs-client-program-replies'));
    for (const operation of initial.operations) {
      const row = operation.before;
      const current = (await context.service.get({ id: operation.public_id, clinicId: operation.clinic_id })).item;
      if (current.version !== operation.expected_version || hash(replies.canonicalApiValues(current)) !== hash(replies.values(row))) fail('BS_CLOSURE_CURRENT_API_DIFFERS');
      const item = (await context.service.preview({ clinicId: operation.clinic_id, payload: { ...operation.after, status: 'active' } })).item;
      previews.push(sealPreview({ program_id: operation.program_id, expected_version: operation.expected_version, before_sha256: operation.before_sha256,
        checked_at: new Date().toISOString(), mode: 'published_canonical_service_select_only_not_http', current, item }));
    }
    const after = await context.capture(), unchanged = hash(context.stableSnapshot(snapshot)) === hash(context.stableSnapshot(after));
    if (!unchanged) fail('BS_CLOSURE_CHANGED_DURING_PREVIEW');
    const plan = planner.buildPlan({ snapshot, decision, previews });
    context.assertNoBootstrap();
    const bundle = { mode: 'published_canonical_service_select_only_not_http', target: 'crm', actor_id: 1,
      snapshot, backup_sha256: hash(snapshot), plan, previews, previews_sha256: hash(previews), configuration_and_programs_unchanged: unchanged,
      source: loadedSourceIdentity(context.identity), metadata: { read_only: true, application_bootstrapped: false, models_index_loaded: false,
        patient_rows_read: false, messages_sent: 0, business_writes: 0, select_queries: context.state.selects } };
    assertBundle(bundle, null); writePrivateJson(privateOutput, bundle);
    return { mode: 'prepared_read_only', package_sha256: plan.package_sha256, source_commit: bundle.source.source_commit,
      operations: plan.operations.map(operation => ({ program_id: operation.program_id, expected_version: operation.expected_version,
        status: operation.after.status, tax_percent: operation.after.price_profile.tax_percent })), writes: 0 };
  } finally { await context.close(); }
}

async function applyBundle({ bundle, approvedSha256, journal: log, capture, update, assertPublishedSource = () => {}, beforeWrite = () => {}, now = () => Date.now() }) {
  assertBundle(bundle, approvedSha256, { applying: true, now: now() });
  assertPublishedSource(bundle.source);
  let snapshot = await capture();
  const targetIds = new Set(bundle.plan.operations.map(operation => operation.program_id));
  const protectedStateMatches = actual => hash(actual.configuration) === hash(bundle.snapshot.configuration)
    && hash(actual.programs.filter(row => !targetIds.has(Number(row.id)))) === hash(bundle.snapshot.programs.filter(row => !targetIds.has(Number(row.id))))
    && bundle.snapshot.revisions.every(old => hash(old) === hash(actual.revisions.find(row => Number(row.id) === Number(old.id))));
  if (!protectedStateMatches(snapshot)) fail('BS_CLOSURE_PROTECTED_STATE_CHANGED');
  const outcomes = [];
  for (const operation of bundle.plan.operations) {
    assertPublishedSource(bundle.source);
    if (now() < Date.parse(bundle.plan.created_at) || now() - Date.parse(bundle.plan.created_at) > planner.MAX_SNAPSHOT_AGE_MS) fail('BS_CLOSURE_PLAN_EXPIRED_DURING_APPLY');
    snapshot = await capture();
    if (!protectedStateMatches(snapshot)) fail('BS_CLOSURE_PROTECTED_STATE_CHANGED');
    const current = snapshot.programs.find(row => Number(row.id) === operation.program_id);
    const state = planner.assessCurrent(operation, current);
    if (state === 'applied_requires_revision_verification' && planner.verifyAppliedRevision(operation, current, snapshot.revisions)) {
      log.append({ phase: 'already_applied_verified', program_id: operation.program_id, operation_sha256: operation.operation_sha256 });
      outcomes.push({ program_id: operation.program_id, state: 'already_applied_verified' }); continue;
    }
    if (state !== 'pending') fail('BS_CLOSURE_CONCURRENT_CHANGE');
    await beforeWrite(operation);
    log.append({ phase: 'intent', program_id: operation.program_id, actor_id: 1, expected_version: operation.expected_version,
      before_sha256: operation.before_sha256, payload_sha256: operation.payload_sha256, operation_sha256: operation.operation_sha256 });
    await update(operation, log);
    snapshot = await capture();
    const after = snapshot.programs.find(row => Number(row.id) === operation.program_id);
    if (!planner.verifyAppliedRevision(operation, after, snapshot.revisions) || !protectedStateMatches(snapshot)) fail('BS_CLOSURE_POST_APPLY_VERIFICATION_FAILED');
    log.append({ phase: 'applied_verified', program_id: operation.program_id, actor_id: 1, version: Number(after.version_number), after_sha256: hash(after) });
    outcomes.push({ program_id: operation.program_id, state: 'applied_verified', version: Number(after.version_number) });
  }
  return { mode: 'applied_via_published_canonical_service', package_sha256: bundle.plan.package_sha256,
    source_commit: bundle.source.source_commit, outcomes, other_programs_and_configuration_preserved: true,
    existing_revisions_preserved: true, protected_domain_dml: 0, appointments_created: 0, purchases_created: 0, messages_sent: 0 };
}

async function run(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--decision', '--package', '--approved-sha256', '--private-journal', '--private-output']);
  if (args['--target'] !== 'crm' || !['prepare', 'apply'].includes(args['--mode'])) fail('BS_CLOSURE_EXPLICIT_MODE_REQUIRED');
  if (args['--mode'] === 'prepare') return prepare({ decision: privateJson(args['--decision']), privateOutput: args['--private-output'] });
  const bundle = privateJson(args['--package']); assertBundle(bundle, args['--approved-sha256'], { applying: true });
  const log = journal(args['--private-journal']);
  const context = await publishedContext({ writable: true, onLockedRow: async (operation, row) => log.append({ phase: 'locked_full_row_cas_verified',
    program_id: operation.program_id, canonical_row_sha256: hash(canonicalFullRow(row)) }) });
  try {
    const result = await applyBundle({ bundle, approvedSha256: args['--approved-sha256'], journal: log, capture: context.capture,
      assertPublishedSource: assertSource, update: async operation => {
        context.state.operation = operation;
        context.state.casVerified = false; context.state.operationUpdates = 0; context.state.operationRevisions = 0;
        const counters = [context.state.updates, context.state.revisions, context.state.locked_cas];
        try { await context.service.update({ id: operation.public_id, clinicId: operation.clinic_id, actorId: 1, payload: operation.payload }); }
        finally { context.state.operation = null; }
        if (context.state.updates !== counters[0] + 1 || context.state.revisions !== counters[1] + 1
            || context.state.locked_cas !== counters[2] + 1) fail('BS_CLOSURE_UNEXPECTED_WRITE_COUNT');
      } });
    context.assertNoBootstrap();
    result.sql_guard = { program_updates: context.state.updates, immutable_revision_inserts: context.state.revisions,
      locked_full_row_cas: context.state.locked_cas, select_queries: context.state.selects, other_domain_dml: 0 };
    writePrivateJson(args['--private-output'], result); return result;
  } finally { log.close(); await context.close(); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^BS_CLOSURE_/.test(error.message) ? error.message : 'BS_CLOSURE_OPERATION_FAILED'); process.exitCode = 1;
});
module.exports = { PUBLISHED_ROOT, IDS, sqlAllowed, canonicalFullRow, assertFullRow, assertBundle, applyBundle, prepare, sealPreview, run };

'use strict';
// Explicit operator entrypoint, never imported by a service main or BrokerStore.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DDL, TABLES } = require('./google-business-profile-reassociation');
const { canonical } = require('./canonical');
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(canonical(value));
const need = (value, code) => { if (!value) throw Error(code); };
const PROTECTED = [['google_business_profile_enrollments', 'id'], ['google_business_profile_scope_heads', 'tenant,connection,scope'],
  ['google_business_profile_retirements', 'tenant,connection,asset'], ['asset_revocations', 'tenant,connection,asset']];
function snapshot(db) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const protectedRows = {};
  for (const [table, order] of PROTECTED) {
    const rows = db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).all();
    protectedRows[table] = { count: rows.length, sha256: digest(rows) };
  }
  return { objects, protectedRows };
}
function planSchema(db) {
  const before = snapshot(db);
  need(!before.objects.some(row => TABLES.includes(row.tbl_name)), 'gbp_reassociation_schema_already_present');
  return { schema: 'clinicaclick-gbp-reassociation-ledger-schema/1', before,
    ddlSha256: digest(DDL), statementCount: DDL.length };
}
function verifySchema(db, plan) {
  const current = snapshot(db);
  need(digest(current.protectedRows) === digest(plan.before.protectedRows), 'gbp_reassociation_existing_state_changed');
  const oldObjects = current.objects.filter(row => !TABLES.includes(row.tbl_name));
  need(digest(oldObjects) === digest(plan.before.objects), 'gbp_reassociation_unrelated_schema_changed');
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec('CREATE TABLE google_business_profile_enrollments(id TEXT PRIMARY KEY)');
    for (const sql of DDL) expected.exec(sql);
    const additions = expected.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
      .filter(row => TABLES.includes(row.tbl_name));
    need(digest(current.objects.filter(row => TABLES.includes(row.tbl_name))) === digest(additions), 'gbp_reassociation_schema_mismatch');
  } finally { expected.close(); }
  return { protectedRows: current.protectedRows, newTableCounts: Object.fromEntries(TABLES.map(table => [table,
    db.prepare('SELECT count(*) AS n FROM ' + table).get().n])) };
}
function applySchema(db, plan) {
  need(plan.schema === 'clinicaclick-gbp-reassociation-ledger-schema/1' && plan.ddlSha256 === digest(DDL)
    && plan.statementCount === DDL.length, 'gbp_reassociation_schema_plan_changed');
  db.exec('BEGIN IMMEDIATE');
  try {
    need(digest(snapshot(db)) === digest(plan.before), 'gbp_reassociation_schema_plan_stale');
    for (const sql of DDL) db.exec(sql);
    const result = verifySchema(db, plan);
    need(Object.values(result.newTableCounts).every(count => count === 0), 'gbp_reassociation_schema_nonempty');
    db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function fileIdentity(filename) {
  need(path.isAbsolute(filename) && fs.realpathSync(filename) === filename, 'gbp_reassociation_state_path_invalid');
  const stat = fs.lstatSync(filename);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077), 'gbp_reassociation_state_permissions_invalid');
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}
function writePrivate(filename, value) {
  need(path.isAbsolute(filename) && fs.realpathSync(path.dirname(filename)) === path.dirname(filename), 'gbp_reassociation_output_invalid');
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function readPrivate(filename) {
  fileIdentity(filename); const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { need(fs.fstatSync(fd).size <= 4 * 1024 * 1024, 'gbp_reassociation_plan_too_large'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}
function run(argv) {
  need(process.getuid() === 0, 'gbp_reassociation_operator_root_required');
  const [action, input, output, approved] = argv;
  need(['plan', 'apply', 'reconcile'].includes(action) && argv.length === (action === 'plan' ? 3 : 4), 'gbp_reassociation_operator_arguments');
  const sourcePins = () => Object.fromEntries(['google-business-profile-reassociation-migration.js',
    'google-business-profile-reassociation.js', 'google-business-profile-enrollment-contract.js', 'canonical.js']
    .map(name => [name, sha(fs.readFileSync(path.join(__dirname, name)))]));
  if (action === 'plan') {
    const stateIdentity = fileIdentity(input);
    const db = new DatabaseSync(input, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; BEGIN');
      const plan = { ...planSchema(db), stateFile: input, stateIdentity, sourcePins: sourcePins(), createdAt: new Date().toISOString() };
      db.exec('ROLLBACK'); writePrivate(output, plan);
      return { status: 'planned', planSha256: digest(plan), writes: 0 };
    } finally { db.close(); }
  }
  const plan = readPrivate(input);
  need(/^[a-f0-9]{64}$/.test(approved || '') && digest(plan) === approved, 'gbp_reassociation_plan_pin_mismatch');
  need(digest(sourcePins()) === digest(plan.sourcePins), 'gbp_reassociation_operator_source_changed');
  need(digest(fileIdentity(plan.stateFile)) === digest(plan.stateIdentity), 'gbp_reassociation_state_identity_changed');
  if (action === 'apply') need(Date.now() >= Date.parse(plan.createdAt)
    && Date.now() - Date.parse(plan.createdAt) <= 3600000, 'gbp_reassociation_schema_plan_expired');
  const db = new DatabaseSync(plan.stateFile, { readOnly: action === 'reconcile' });
  try {
    if (action === 'reconcile') {
      db.exec('PRAGMA query_only=ON; BEGIN'); const result = verifySchema(db, plan); db.exec('ROLLBACK');
      writePrivate(output, { status: 'reconciled', planSha256: approved, at: new Date().toISOString(), ...result });
      return { status: 'reconciled', writes: 0 };
    }
    writePrivate(output, { status: 'intent_inspect_before_retry', planSha256: approved, at: new Date().toISOString() });
    const result = applySchema(db, plan);
    writePrivate(output + '.completed.json', { status: 'applied', planSha256: approved, at: new Date().toISOString(), ...result });
    return { status: 'applied', statements: DDL.length, authorityRowsAdded: 0 };
  } finally { db.close(); }
}
if (require.main === module) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ status: 'stopped_inspect_no_replay', code: /^gbp_reassociation_[a-z_]+$/.test(error.message)
    ? error.message : 'gbp_reassociation_schema_unavailable' })); process.exitCode = 1; }
}
module.exports = { snapshot, planSchema, applySchema, verifySchema, digest, run };

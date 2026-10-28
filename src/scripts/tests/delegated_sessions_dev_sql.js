#!/usr/bin/env node
'use strict';
// PREPARED ONLY. --plan is offline; --run requires the reviewed plan SHA.
// No application listener, real account, provider, production session or
// global migration is used. All SQL business/auth rows live in named QA tables.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID, randomBytes } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION = '20261028110000-create-delegated-sessions.js';
const TABLES = Object.freeze({ Usuarios: 'QADelegation20261028Users', AuthSessions: 'QADelegation20261028AuthSessions',
  AuthEmailChallenges: 'QADelegation20261028EmailChallenges', DelegatedSessions: 'QADelegation20261028Sessions',
  PlatformAuditEvents: 'QADelegation20261028AuditEvents' });
const FILES = [path.relative(ROOT, __filename), 'migrations/' + MIGRATION, 'models/usuario.js', 'models/authsession.js',
  'models/authemailchallenge.js', 'models/delegatedsession.js', 'models/platformauditevent.js',
  'src/services/accessSession.service.js', 'src/services/delegatedSession.service.js', 'src/services/platformAudit.repository.js',
  'src/services/platformAudit.delegation.js', 'src/lib/delegationAuditContext.js', 'services/platform-audit/src/event.js',
  'services/platform-audit/src/delegation-event.js', 'ops/security/schema-contract.json', 'models/index.js', 'src/config/config.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const pins = () => Object.fromEntries(FILES.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]));
function plan() {
  return { schema: 'clinicaclick-delegation-owned-dev-sql/1', database: 'clinicaclick_dev_isolated',
    allowedNamespaces: ['dev', 'DEV'], runtimeEnv: '/etc/clinicaclick-dev/runtime.env', tables: TABLES, sourcePins: pins(),
    migration: MIGRATION, globalMigrationApplied: false, realAccountRowsAccessed: false,
    sql: { first: 'SELECT DATABASE() AS database_name', prerequisites: 'all five QA tables absent; one exclusive local fixture lock',
      reads: 'QA-prefixed rows plus information_schema and migration-name metadata only',
      writes: 'only QA-prefixed fixtures; normal literal table references remapped before SQL dispatch',
      ddl: 'owned prerequisite model tables and actual selected migration remapped to QA registry',
      forbidden: ['runtime/grant changes', 'foreign_key_checks disable', 'real Usuarios/AuthSessions reads or writes',
        'SequelizeMeta writes', 'unselected migrations', 'provider/network operations'],
      cleanup: 'finally drop only tables reserved/created by this run; compare full schema metadata with baseline' },
    cases: ['real normal managed email-MFA session on synthetic prefixed users/proof',
      'selected migration column/index/RESTRICT foreign-key contract', 'one-use PKCE/nonce, replay and two concurrent exchanges',
      'audit append failure rolls back activation plus event', 'parent/target credential binding and target permissions identity',
      'child refresh preserves expiry and original parent session', 'child revoke preserves sibling and normal parent',
      'normal parent revoke invalidates all its children', 'exact final baseline and zero leftover fixture tables'],
    limitation: 'MFA proof is synthetic SQL fixture data; real email/browser MFA acceptance remains a separate UI test.' };
}
function output(file, value) {
  if (!path.isAbsolute(file) || fs.realpathSync(path.dirname(file)) !== path.dirname(file)
    || (fs.statSync(path.dirname(file)).mode & 0o077)) fail('delegation_qa_private_output_required');
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function remap(sql) {
  let text = String(sql);
  for (const [source, target] of Object.entries(TABLES)) text = text.replace(new RegExp('\\b' + source + '\\b', 'g'), target);
  return text;
}
function guard(sql) {
  const text = String(sql).trim().replace(/;$/, '');
  if (!text || /;|\/\*|--|#/.test(text) || /\b(?:GRANT|REVOKE|TRUNCATE|LOAD|OUTFILE|DUMPFILE|CALL|FOREIGN_KEY_CHECKS)\b/i.test(text)) fail('delegation_qa_sql_scope');
  if (/^(?:START TRANSACTION|COMMIT|ROLLBACK|SET TRANSACTION|SET SESSION TRANSACTION)/i.test(text)) return;
  const names = [...text.matchAll(/\b(?:FROM|JOIN|INTO|REFERENCES|TABLE(?: IF (?:NOT )?EXISTS)?)\s+`?([A-Za-z0-9_]+)`?/gi)].map(row => row[1]);
  const update = /^UPDATE\s+`?([A-Za-z0-9_]+)`?/i.exec(text); if (update) names.push(update[1]);
  if (/^SELECT\b/i.test(text) && names.length && names.every(name => name.toLowerCase() === 'information_schema')) return;
  if (/^SHOW TABLES(?: LIKE '[A-Za-z0-9_]+')?$/i.test(text)) return;
  if (!names.length || names.some(name => !Object.values(TABLES).includes(name))) fail('delegation_qa_sql_scope');
  if (!/^(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|DROP TABLE|SHOW (?:INDEX|FULL COLUMNS)|ALTER TABLE)/i.test(text)) fail('delegation_qa_sql_scope');
}
function ownedDispatch(execute, created) {
  return async (statement, options) => {
    let text = statement;
    if (typeof statement !== 'string') {
      if (!statement || Object.getPrototypeOf(statement) !== Object.prototype) fail('delegation_qa_sql_shape');
      const keys = Reflect.ownKeys(statement).sort().join(',');
      if (!['query', 'bind,query', 'query,values'].includes(keys)) fail('delegation_qa_sql_shape');
      for (const key of Object.keys(statement)) {
        const descriptor = Object.getOwnPropertyDescriptor(statement, key);
        if (!descriptor || descriptor.get || descriptor.set) fail('delegation_qa_sql_shape');
      }
      text = statement.query;
      const bindings = statement.bind ?? statement.values;
      if (typeof text !== 'string' || bindings !== undefined && (!bindings || !Array.isArray(bindings)
        && Object.getPrototypeOf(bindings) !== Object.prototype)) fail('delegation_qa_sql_shape');
    }
    const mapped = remap(text).trim().replace(/^CREATE TABLE IF NOT EXISTS\s+/i, 'CREATE TABLE '); guard(mapped);
    const creating = /^CREATE TABLE\s+`?([A-Za-z0-9_]+)`?/i.exec(mapped);
    const result = await execute(typeof statement === 'string' ? mapped : { ...statement, query: mapped }, { ...options, logging: false });
    // An index/sync failure after this point retains physical ownership. A
    // CREATE collision or lost acknowledgement is never adopted for DROP.
    if (creating) created.push(creating[1]);
    return result;
  };
}
async function run(reviewed, approvePlan) {
  if (hash(fs.readFileSync(reviewed)) !== approvePlan) fail('delegation_qa_plan_approval_required');
  assert.deepEqual(JSON.parse(fs.readFileSync(reviewed)), plan(), 'plan/source changed; generate and review a new offline plan');
  const env = require('dotenv').parse(fs.readFileSync('/etc/clinicaclick-dev/runtime.env'));
  if (env.DB_NAME !== 'clinicaclick_dev_isolated' || !['dev', 'DEV'].includes(env.JOB_RUNTIME_NAMESPACE)) fail('delegation_qa_dev_boundary');
  Object.assign(process.env, env);
  const db = require('../../../models'), sql = db.sequelize, Sequelize = require('sequelize');
  const original = sql.query.bind(sql), schema = require('../../lib/securitySchemaContract');
  const raw = async (statement, replacements = []) => (await original(statement, { replacements, logging: false }))[0];
  const created = [], report = { status: 'running', database: 'clinicaclick_dev_isolated', tables: Object.values(TABLES), checks: [] };
  let baseline, lockFd, lockFile, lockIdentity;
  try {
    const [identity] = await raw('SELECT DATABASE() AS database_name');
    if (identity?.database_name !== 'clinicaclick_dev_isolated') fail('delegation_qa_dev_boundary');
    lockFile = path.join(path.dirname(reviewed), 'delegation-dev-sql-fixture.lock');
    lockFd = fs.openSync(lockFile, 'wx', 0o600); lockIdentity = fs.fstatSync(lockFd);
    const existing = await raw('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:names)', { names: Object.values(TABLES) });
    if (existing.length) fail('delegation_qa_tables_already_exist');
    baseline = await schema.snapshot(raw); report.baselineDigest = schema.digest(baseline);
    // The only dispatch path for fixture ORM/raw commands. Queries are never
    // logged; raw literal normal-session tables are mapped to the QA registry.
    sql.query = ownedDispatch(original, created);
    const model = (file, table) => {
      const result = require('../../../models/' + file)(sql, Sequelize.DataTypes);
      result.tableName = TABLES[table]; result.options.tableName = TABLES[table]; return result;
    };
    const fixture = { sequelize: sql, Sequelize,
      Usuario: model('usuario', 'Usuarios'), AuthSession: model('authsession', 'AuthSessions'),
      AuthEmailChallenge: model('authemailchallenge', 'AuthEmailChallenges'),
      DelegatedSession: model('delegatedsession', 'DelegatedSessions'), PlatformAuditEvent: model('platformauditevent', 'PlatformAuditEvents') };
    for (const own of [fixture.Usuario, fixture.AuthSession, fixture.AuthEmailChallenge, fixture.PlatformAuditEvent]) {
      await own.sync();
      if (!created.includes(own.tableName)) fail('delegation_qa_table_not_owned');
    }
    const qi = sql.getQueryInterface(), mappedQi = {
      createTable: async (name, fields, options) => {
        if (name !== 'DelegatedSessions') fail('delegation_qa_migration_scope');
        const mappedFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { ...value,
          ...(value.references ? { references: { ...value.references, model: TABLES[value.references.model] || fail('delegation_qa_foreign_key_scope') } } : {}) }]));
        return qi.createTable(TABLES[name], mappedFields, options);
      },
      addIndex: (name, fields, options) => { if (name !== 'DelegatedSessions') fail('delegation_qa_migration_scope'); return qi.addIndex(TABLES[name], fields, options); },
    };
    await require('../../../migrations/' + MIGRATION).up(mappedQi, Sequelize.DataTypes);
    const observed = await schema.snapshot(raw), reverse = Object.fromEntries(Object.entries(TABLES).map(([a, b]) => [b, a]));
    const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      ['TABLE_NAME', 'REFERENCED_TABLE_NAME'].includes(key) ? reverse[value] || value
        : key === 'CONSTRAINT_NAME' && typeof value === 'string' ? value.replace(TABLES.DelegatedSessions, 'DelegatedSessions') : value]));
    const actual = { ...observed, migrations: [MIGRATION] };
    for (const key of ['tables', 'columns', 'indexes', 'checks', 'foreignKeys']) actual[key] = observed[key].filter(row => row.TABLE_NAME === TABLES.DelegatedSessions).map(normalize);
    const contract = require('../../../ops/security/schema-contract.json');
    assert.deepEqual(schema.compare(actual, { defaults: {}, tables: { DelegatedSessions: contract.tables.DelegatedSessions }, migrations: [{ name: MIGRATION }] }),
      { compatible: true, issues: [], missingMigrations: [] }); report.checks.push('real selected migration schema/index/restrict-FK contract');
    const secret = randomBytes(32).toString('hex'), at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const access = require('../../services/accessSession.service');
    const audit = require('../../services/platformAudit.repository').createRepository(fixture.PlatformAuditEvent);
    const normal = access.createService({ models: fixture, audit, now: () => at,
      config: () => ({ mode: 'enforce', ttl: 1800, secret, emailMfaMode: 'enforce' }) });
    const actor = await fixture.Usuario.create({ id_usuario: 1, nombre: 'TESTONLY DELEGATION ADMIN', email_usuario: 'delegation-admin@example.invalid', password_usuario: 'TESTONLY_FAKE_HASH', estado_cuenta: 'activo', es_provisional: false });
    const target = await fixture.Usuario.create({ id_usuario: 53, nombre: 'TESTONLY DELEGATION TARGET', email_usuario: 'delegation-target@example.invalid', password_usuario: 'TESTONLY_FAKE_TARGET_HASH', estado_cuenta: 'activo', es_provisional: false });
    const challengeId = randomUUID();
    await fixture.AuthEmailChallenge.create({ challenge_id: challengeId, user_id: 1, challenge_hash: hash(randomUUID()),
      code_hash: hash(randomUUID()), credential_binding: normal.credentialBinding(actor), email_hash: hash(actor.email_usuario),
      state: 'verified', created_at: at, expires_at: new Date(at.getTime() + 300000), absolute_expires_at: new Date(at.getTime() + 600000), last_sent_at: at, verified_at: at });
    const issuedParent = await sql.transaction(transaction => normal.issue(actor, { transaction, emailChallengeId: challengeId }));
    assert.equal((await normal.verifyNormal(issuedParent.token)).userId, 1);
    const delegatedAudit = require('../../services/platformAudit.delegation').createService({ repository: audit,
      enabled: () => 'true', contractVersion: () => '27', now: () => at });
    const cfg = { enabled: true, secret, origin: 'https://delegation-qa.example.invalid', runtimeNamespace: env.JOB_RUNTIME_NAMESPACE };
    const createService = extra => require('../../services/delegatedSession.service').createService({ models: fixture, normalSessions: normal,
      audit: delegatedAudit, config: () => cfg, now: () => at, ...extra });
    const service = createService(), verifier = 'v'.repeat(43), nonce = 'n'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
    const create = () => service.create({ token: issuedParent.token, targetUserId: 53, pkceChallenge: challenge, tabNonce: nonce, origin: cfg.origin });
    const exchange = (pending, extra = {}, api = service) => api.exchange({ handoff: pending.handoff, pkceVerifier: verifier, tabNonce: nonce, origin: cfg.origin, ...extra });
    const pending = await create(); await assert.rejects(exchange(pending, { pkceVerifier: 'x'.repeat(43) }));
    const outcomes = await Promise.allSettled([exchange(pending), exchange(pending)]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    const child = outcomes.find(value => value.status === 'fulfilled').value; await assert.rejects(exchange(pending));
    const verified = await service.verify(child.token); assert.equal(verified.userId, 53); assert.equal(verified.authDelegation.adminUserId, 1);
    assert.equal(await fixture.AuthSession.count(), 1); assert.equal((await target.reload()).ultimo_login, null);
    const refreshed = await service.refresh(child.token); assert.equal(refreshed.token, child.token);
    report.checks.push('real normal MFA parent; SQL concurrent PKCE one winner/replay; target-only identity/no target session or login; bounded refresh');
    const auditCount = await fixture.PlatformAuditEvent.count(), second = await create();
    const afterRequestCount = await fixture.PlatformAuditEvent.count(); assert.equal(afterRequestCount, auditCount + 1);
    const failing = createService({ audit: { assertReady: delegatedAudit.assertReady, lifecycle: async (event, options) => {
      await delegatedAudit.lifecycle(event, options); if (event.action === 'delegation.started') throw Error('TESTONLY audit rollback');
    } } });
    await assert.rejects(exchange(second, {}, failing), /TESTONLY audit rollback/);
    assert.equal((await fixture.DelegatedSession.findByPk(second.delegationId)).state, 'pending');
    assert.equal(await fixture.PlatformAuditEvent.count(), afterRequestCount);
    const sibling = await exchange(second);
    await service.revoke({ token: child.token, delegationId: child.delegation.delegationId });
    await assert.rejects(service.verify(child.token)); await service.verify(sibling.token); await normal.verifyNormal(issuedParent.token);
    await target.update({ password_usuario: 'TESTONLY_ROTATED_HASH' }); await assert.rejects(service.verify(sibling.token));
    await target.update({ password_usuario: 'TESTONLY_FAKE_TARGET_HASH' }); await service.verify(sibling.token);
    await normal.revoke(issuedParent.token); await assert.rejects(service.verify(sibling.token));
    report.checks.push('real audit+activation atomic rollback; child-only revoke; target credential and parent revoke invalidate child');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.reason = /^[a-z0-9_]+$/.test(error.code || '') ? error.code : 'delegation_owned_sql_failed'; throw Object.assign(Error(report.reason), { report }); }
  finally {
    let cleanupError;
    try {
      for (const table of [...created].reverse()) { guard('DROP TABLE IF EXISTS `' + table + '`'); await original('DROP TABLE IF EXISTS `' + table + '`', { logging: false }); }
      if (baseline) {
        const after = await schema.snapshot(raw); report.afterDigest = schema.digest(after);
        report.cleanupVerified = report.afterDigest === report.baselineDigest;
        if (!report.cleanupVerified) cleanupError = 'delegation_qa_baseline_changed';
      }
    } catch { cleanupError = 'delegation_qa_cleanup_unconfirmed'; }
    try { await sql.close(); } finally {
      if (lockFd !== undefined) { fs.closeSync(lockFd); const current = fs.lstatSync(lockFile);
        if (current.ino === lockIdentity.ino && current.dev === lockIdentity.dev) fs.unlinkSync(lockFile); }
    }
    if (cleanupError) throw Object.assign(Error(cleanupError), { report: { ...report, status: 'failed', reason: cleanupError } });
  }
  return report;
}
async function main(argv) {
  const action = argv.shift(), opts = {};
  while (argv.length) { const key = argv.shift(), value = argv.shift(); if (!['--out', '--plan', '--approve-plan'].includes(key) || !value || opts[key]) fail('delegation_qa_arguments'); opts[key] = value; }
  if (action === '--plan' && opts['--out'] && Object.keys(opts).length === 1) { output(opts['--out'], plan()); return { status: 'offline_plan_written', plan: opts['--out'], sha256: hash(fs.readFileSync(opts['--out'])) }; }
  if (action !== '--run' || !opts['--plan'] || !opts['--out'] || !/^[a-f0-9]{64}$/.test(opts['--approve-plan'] || '')) fail('delegation_qa_arguments');
  let result; try { result = await run(opts['--plan'], opts['--approve-plan']); } catch (error) { if (error.report) output(opts['--out'], error.report); throw error; }
  output(opts['--out'], result); return { status: result.status, report: opts['--out'], cleanupVerified: result.cleanupVerified };
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ status: 'failed', reason: /^[a-z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'delegation_owned_sql_failed' }) + '\n'); process.exitCode = 1;
});
module.exports = { plan, remap, guard, ownedDispatch, main, TABLES };

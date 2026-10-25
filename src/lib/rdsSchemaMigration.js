'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { snapshot, digest, compare } = require('./securitySchemaContract');
const P = require('./rdsSchemaMigrationPolicy');
const T = require('./rdsSchemaMigrationTransport');
const E = require('./mysqlEnumExtension');
const STATE = '/var/lib/clinicaclick-rds-schema-release';
const SAFE = /^rds_schema_[a-z_]+$/;
const safeCode = error => SAFE.test(error?.message || '') ? error.message : 'rds_schema_operation_failed';

function privateDirectory(dir, owner = 0) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  P.need(path.resolve(dir) === dir && fs.realpathSync(dir) === dir && stat.isDirectory()
    && stat.uid === owner && (stat.mode & 511) === 448, 'rds_schema_private_directory');
}
function writePrivate(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return { path: file, sha256: P.sha(bytes) };
}
function readPrivate(file, owner = 0) {
  privateDirectory(path.dirname(file), owner);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    P.need(before.isFile() && before.uid === owner && (before.mode & 511) === 384 && before.nlink === 1
      && before.size > 0 && before.size <= 32 * 1024 * 1024, 'rds_schema_private_file');
    const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd); const named = fs.lstatSync(file);
    P.need(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode', 'nlink'].every(key => before[key] === after[key] && before[key] === named[key]), 'rds_schema_file_changed');
    return { value: JSON.parse(bytes), reference: { path: file, sha256: P.sha(bytes) } };
  } finally { fs.closeSync(fd); }
}
function createStore(root = STATE, owner = 0) {
  privateDirectory(root, owner); privateDirectory(root + '/claims', owner); privateDirectory(root + '/runs', owner);
  return {
    owner, root,
    start(planRef) {
      P.need(!fs.existsSync(root + '/active.json'), 'rds_schema_previous_attempt_requires_reconciliation');
      const operationNonce = randomUUID(); const directory = root + '/runs/' + operationNonce;
      privateDirectory(directory, owner);
      // The claim is permanent even for a known pre-DDL refusal. Make a new plan.
      P.need(!fs.existsSync(root + '/claims/' + planRef.sha256 + '.json'), 'rds_schema_plan_already_consumed');
      writePrivate(root + '/claims/' + planRef.sha256 + '.json', { operationNonce, planRef });
      writePrivate(root + '/active.json', { operationNonce, planRef, directory });
      const fd = fs.openSync(directory + '/journal.jsonl', 'wx', 0o600);
      let writesDispatched = 0; let backupRequested = false; let backupKnown = false;
      const journal = event => {
        if (event.event === 'statement_request') writesDispatched++;
        if (event.event === 'backup_request') backupRequested = true;
        if (event.event === 'backup_create_ack') backupKnown = true;
        fs.writeSync(fd, JSON.stringify({ atEpochMs: Date.now(), ...event }) + '\n'); fs.fsyncSync(fd);
      };
      let finished = false;
      return { operationNonce, directory, journal,
        finish(result, accepted) {
          P.need(!finished, 'rds_schema_terminal_once'); finished = true;
          journal({ event: 'terminal', status: result.status, accepted, writesDispatched });
          fs.closeSync(fd);
          const resultRef = writePrivate(directory + '/result.json', { ...result, operationNonce, writesDispatched });
          // Failure after a dispatched SQL write or uncertain snapshot request
          // blocks all later applies, including newly generated plans.
          if (accepted || writesDispatched === 0 && (!backupRequested || backupKnown)
            && (!result.transportOpened || result.closure?.physicalCloseObserved === true)) {
            const active = readPrivate(root + '/active.json', owner);
            P.need(active.value.operationNonce === operationNonce, 'rds_schema_ledger_changed');
            fs.unlinkSync(root + '/active.json');
          }
          return resultRef;
        } };
    },
  };
}

async function schemaSnapshot(admin) {
  return { ...await snapshot(admin.query), triggers: await admin.query('SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING,ACTION_STATEMENT,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME') };
}

// Gate the real mysql2 dispatch used by Sequelize, not a mirror SQL generator.
// The same physical connection owns the lock, all DDL and SequelizeMeta writes.
function migrationInterface({ admin, aws, journal, migrationName, Sequelize = require('sequelize'), ddlTimeoutMs = 300000 }) {
  const raw = admin.raw; const originals = { query: raw.query, execute: raw.execute };
  let tail = Promise.resolve(); let closed = false; let poisoned = false;
  for (const method of ['query', 'execute']) {
    raw[method] = function guardedQuery(options, values, callback) {
      if (typeof values === 'function') { callback = values; values = undefined; }
      const sql = typeof options === 'string' ? options : options.sql;
      const emitter = new EventEmitter();
      let kind;
      try { P.need(!closed && typeof callback === 'function', 'rds_schema_query_interface_required'); kind = P.statementKind(sql, values, admin.identity?.database || T.DATABASE); }
      catch (error) { queueMicrotask(() => callback(error)); return emitter; }
      const task = tail.then(async () => {
        const isDdl = kind === 'ddl' || kind === 'enum_extension';
        const target = kind === 'enum_extension' ? E.statement(sql) : null;
        const metadata = () => new Promise((resolve, reject) => {
          originals.query.call(raw, { sql: E.metadataSql, timeout: 30000 }, [target.table, target.name], (error, rows) => {
            if (error || !Array.isArray(rows) || rows.length !== 1) return reject(Error('rds_schema_enum_metadata_invalid'));
            try { resolve(E.column(rows[0])); } catch (caught) { reject(caught); }
          });
        });
        P.need(!poisoned, 'rds_schema_prior_statement_failed');
        aws.assertFresh((isDdl ? ddlTimeoutMs : 30000) + 30000);
        if (target) E.validate(await metadata(), target);
        return new Promise((resolve, reject) => {
          try {
            if (isDdl) journal({ event: 'statement_request', migration: migrationName, sqlSha256: P.sha(sql), kind: 'ddl' });
          } catch (error) { reject(error); return; }
          // Serialize query AND execute, including their warning readback. No
          // query can replace the warning context of the preceding DDL.
          originals[method].call(raw, { sql, timeout: isDdl ? ddlTimeoutMs : 30000 }, values, (error, result, fields) => {
            if (error) { reject(Error('rds_schema_statement_outcome_requires_reconciliation')); return; }
            originals.query.call(raw, { sql: 'SHOW WARNINGS', timeout: 5000 }, async (warningError, warnings) => {
              if (warningError || !Array.isArray(warnings) || warnings.length || Number(result?.warningStatus || 0) !== 0) {
                reject(Error('rds_schema_statement_warnings_require_reconciliation')); return;
              }
              try {
                if (target) E.validate(target, await metadata(), false);
                if (isDdl) journal({ event: 'statement_ack', migration: migrationName, sqlSha256: P.sha(sql), kind: 'ddl', warnings: 0 });
              } catch (caught) { reject(caught); return; }
              resolve({ result, fields });
            });
          });
        });
      });
      tail = task.then(() => {}, () => { poisoned = true; });
      task.then(value => callback(null, value.result, value.fields), error => callback(error));
      return emitter;
    };
  }
  const restore = async () => { await tail; closed = true; raw.query = originals.query; raw.execute = originals.execute; };
  const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
  sequelize.connectionManager.getConnection = async () => raw;
  sequelize.connectionManager.releaseConnection = async () => {};
  const actual = sequelize.getQueryInterface(); const exposed = {};
  for (const name of P.METHODS) exposed[name] = actual[name].bind(actual);
  exposed.sequelize = Object.freeze({ query: sequelize.query.bind(sequelize), transaction: () => { throw Error('rds_schema_ddl_is_not_transactional'); } });
  return { queryInterface: Object.freeze(exposed), restore };
}

function createRunner({ sourceInfo, awsFactory = T.createAws, connect = T.connectAdmin, storeFactory = createStore,
  now = Date.now, operatorUid = () => process.getuid(), fileOwner = 0 } = {}) {
  async function open(profile) {
    const aws = awsFactory({ profile }); const db = await aws.inspect(); const secret = await aws.secret(db);
    const admin = await connect({ aws, db, secret }); return { aws, admin };
  }
  function infoFor(source) { P.need(operatorUid() === 0, 'rds_schema_root_required'); return sourceInfo(source, true); }
  return {
    async plan({ source, selected = [], profile = 'clinicaclick-prov-temp', out }) {
      const info = infoFor(source); const moduleFiles = P.migrationFiles(source, selected);
      const { admin } = await open(profile); let plan; let closure;
      try { plan = P.buildPlan({ info, before: await schemaSnapshot(admin), identity: admin.identity, selected, moduleFiles, profile, at: now() }); }
      finally { closure = await admin.close(); }
      const dir = out ? path.dirname(out) : '/home/ubuntu/qa-evidence/rds-schema-plan-' + randomUUID();
      privateDirectory(dir, fileOwner); const planRef = writePrivate(out || dir + '/plan.json', plan);
      return { status: 'rds_schema_plan_ready', planRef, sourceRevision: info.revision, selected: plan.selected,
        toApply: plan.toApply, unselectedPendingCount: plan.unselectedPending.length, compatibilityBefore: plan.compatibilityBefore,
        statementPolicy: plan.policy, closure, instruction: 'Review selected migration code at this Git SHA; approve this exact plan SHA. Unselected history is never applied.' };
    },
    async apply({ source, planFile, approvePlan }) {
      const info = infoFor(source); const { value: plan, reference: planRef } = readPrivate(planFile, fileOwner);
      P.need(approvePlan === planRef.sha256, 'rds_schema_explicit_plan_approval_required');
      const moduleFiles = P.migrationFiles(source, plan.selected.map(item => item.name));
      P.need(plan.sourceRevision === info.revision && plan.contractDigest === info.contractDigest
        && digest(moduleFiles) === digest(plan.moduleFiles), 'rds_schema_plan_stale');
      P.need(Number.isSafeInteger(plan.createdAtEpochMs) && plan.createdAtEpochMs <= now()
        && now() - plan.createdAtEpochMs <= 900000 && Array.isArray(plan.toApply) && plan.toApply.length > 0, 'rds_schema_plan_expired_or_empty');
      const run = storeFactory().start(planRef); let admin; let backup; let result; let error; let closure;
      try {
        const aws = awsFactory({ profile: plan.awsProfile }); await aws.inspect();
        backup = await aws.backup({ operationNonce: run.operationNonce, journal: run.journal });
        const db = await aws.inspect(); const secret = await aws.secret(db); admin = await connect({ aws, db, secret });
        const lock = await admin.query("SELECT GET_LOCK('clinicaclick_rds_schema_release',0) AS acquired");
        P.need(String(lock[0]?.acquired) === '1', 'rds_schema_migration_busy');
        const before = await schemaSnapshot(admin);
        P.validatePlan(plan, { info, before, identity: admin.identity, moduleFiles, at: now() });
        P.need(backup.status === 'available' && backup.physicalDbId === admin.identity.physicalDbId
          && Date.parse(backup.createdAt) >= plan.createdAtEpochMs, 'rds_schema_backup_not_bound_to_plan');
        if (aws.ensureFresh) await aws.ensureFresh(15 * 60 * 1000);
        aws.assertFresh(15 * 60 * 1000);
        const ddlDeadline = now() + plan.policy.maxDdlPhaseMs;
        const ddlAws = { assertFresh(milliseconds) {
          P.need(now() + Math.min(milliseconds, 300000) <= ddlDeadline, 'rds_schema_ddl_budget_exhausted');
          aws.assertFresh(milliseconds);
        } };
        await admin.query('SET SESSION lock_wait_timeout=15');
        await admin.query('SET SESSION innodb_lock_wait_timeout=15');
        if (plan.policy.bootstrapSequelizeMeta) {
          const sql = 'CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
          run.journal({ event: 'statement_request', kind: 'sequelize_meta_bootstrap', sqlSha256: P.sha(sql) });
          await admin.query(sql);
          run.journal({ event: 'statement_ack', kind: 'sequelize_meta_bootstrap', sqlSha256: P.sha(sql), warnings: 0 });
        }
        const Sequelize = require('sequelize'); const completed = [];
        for (const name of plan.toApply) {
          const loaded = P.loadMigration(source, name, plan.moduleFiles, Sequelize);
          const bridge = migrationInterface({ admin, aws: ddlAws, journal: run.journal, migrationName: name, Sequelize });
          try { await loaded.migration.up(bridge.queryInterface, loaded.facade); } finally { await bridge.restore(); }
          const sql = 'INSERT INTO SequelizeMeta (name) VALUES (?)';
          aws.assertFresh(60000); run.journal({ event: 'statement_request', migration: name, kind: 'sequelize_meta', sqlSha256: P.sha(sql) });
          const inserted = await admin.query(sql, [name]);
          P.need(inserted.affectedRows === 1, 'rds_schema_meta_ack_unknown');
          run.journal({ event: 'statement_ack', migration: name, kind: 'sequelize_meta', sqlSha256: P.sha(sql), affectedRows: 1, warnings: 0 });
          completed.push(name);
        }
        const after = await schemaSnapshot(admin); const compatibility = compare(after, info.contract);
        P.need(compatibility.compatible && plan.toApply.every(name => after.migrations.includes(name)), 'rds_schema_postcheck_incompatible');
        result = { status: 'rds_schema_applied_and_verified', sourceRevision: info.revision, planRef, completed,
          afterDigest: digest(after), after, compatibility, identity: admin.identity, backup,
          releaseGate: { revision: info.revision, requiredMigrations: completed, stagingPromotion: 'fast-forward-only',
            applicationCrudPreflightStillRequired: true, preflightArgs: completed.flatMap(name => ['--require-migration', name]),
            gitOrServicesChangedByTool: false } };
      } catch (caught) { error = caught; }
      finally {
        if (admin) { try { closure = await admin.close(); } catch (caught) { error ||= caught; } }
        else if (error?.closure) closure = error.closure;
      }
      if (error) {
        const resultRef = run.finish({ status: 'rds_schema_failed_preserve_partial', reason: safeCode(error), planRef,
          backup: backup || null, closure: closure || null, transportOpened: Boolean(admin) || error.transportOpened === true,
          automaticReplayAllowed: false }, false);
        throw Object.assign(Error(safeCode(error)), { resultRef });
      }
      const resultRef = run.finish({ ...result, closure }, true);
      return { status: result.status, resultRef, sourceRevision: info.revision, completed: result.completed,
        releaseGate: result.releaseGate, backup, closure, compatible: true };
    },
    async verify({ source, runDirectory }) {
      const info = infoFor(source); const { value: result, reference: resultRef } = readPrivate(path.join(runDirectory, 'result.json'), fileOwner);
      P.need(result.status === 'rds_schema_applied_and_verified' && result.sourceRevision === info.revision, 'rds_schema_successful_run_required');
      const { value: plan, reference: planRef } = readPrivate(result.planRef.path, fileOwner);
      P.need(planRef.sha256 === result.planRef.sha256, 'rds_schema_plan_changed');
      const { admin } = await open(plan.awsProfile); let after; let closure;
      try { P.need(digest(admin.identity) === digest(result.identity), 'rds_schema_identity_changed'); after = await schemaSnapshot(admin); }
      finally { closure = await admin.close(); }
      const compatibility = compare(after, info.contract);
      P.need(compatibility.compatible && digest(after) === result.afterDigest && result.completed.every(name => after.migrations.includes(name)), 'rds_schema_verify_drift');
      return { status: 'rds_schema_verified', sourceRevision: info.revision, resultRef, requiredMigrations: result.completed, compatible: true, closure };
    },
  };
}

module.exports = { STATE, safeCode, privateDirectory, writePrivate, readPrivate, createStore, schemaSnapshot, migrationInterface, createRunner };

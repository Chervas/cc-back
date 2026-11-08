'use strict';
// Three phases of the existing owned InnoDB continuity fixture. No transport,
// credentials, bootstrap, server options or production model index are added.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (value, label, ms = 12000) => {
  let timer;
  try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('ENTERPRISE_LOCK_TIMEOUT_' + label)), ms); })]); }
  finally { clearTimeout(timer); }
};
const plain = row => row?.get ? row.get({ plain: true }) : row;
const sqlCode = error => error?.original?.code || error?.parent?.code || error?.code || null;
const lockError = error => ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(sqlCode(error));
const STOP = Object.assign(Error('FICTITIOUS_ENTERPRISE_ROLLBACK'), { code: 'FICTITIOUS_ENTERPRISE_ROLLBACK' });

module.exports = async context => {
  const { models, sql, now, report, initial, currentIds, baseline, untouched, phase, baselines, withRetirementTransaction } = context;
  assert(['pre_handover', 'post_handover', 'lineage'].includes(phase));
  assert.equal(models.sequelize, sql); assert.equal(report.database, 'campaign_optimization_qa');
  assert(/^\/tmp\/cc-campaign-opt-mysql-[A-Za-z0-9]+$/.test(report.root));
  assert.equal(sql.options.dialectOptions.socketPath, path.join(report.root, 'mysql.sock'));
  assert.equal(report.performanceSchema, undefined);
  assert.equal(typeof withRetirementTransaction, 'function', 'Pass the production retirement transaction wrapper');
  const trace = report.enterpriseLockOrder ||= { phases: [], cases: [], baselineSha256: {}, providerRequests: 0 };
  assert(!trace.phases.includes(phase));
  const queryFunction = sql.query, originalTransaction = sql.transaction.bind(sql), originalQuery = sql.query.bind(sql);
  const roles = new AsyncLocalStorage(), patched = [], oldModules = new Map();
  let active = null;
  const services = path.resolve(__dirname, '../../../services');
  function old(name) {
    const filename = path.join(services, name), source = baselines?.[name];
    assert(path.isAbsolute(source) && source.startsWith('/home/ubuntu/qa-evidence/'), 'A pinned private baseline path is required for ' + name);
    if (oldModules.has(filename)) return oldModules.get(filename).exports;
    const bytes = fs.readFileSync(source), digest = createHash('sha256').update(bytes).digest('hex');
    if (trace.baselineSha256[name]) assert.equal(trace.baselineSha256[name], digest);
    trace.baselineSha256[name] = digest;
    const value = new Module(filename, module); value.filename = filename;
    value.paths = Module._nodeModulePaths(path.dirname(filename)); oldModules.set(filename, value);
    const originalRequire = value.require.bind(value);
    value.require = request => {
      if (request.startsWith('.')) {
        const resolved = Module._resolveFilename(request, value), dependency = path.basename(resolved);
        if (path.dirname(resolved) === services && baselines?.[dependency]) return old(dependency);
      }
      return originalRequire(request);
    };
    value._compile(bytes.toString('utf8'), filename); return value.exports;
  }
  const load = (name, red) => red ? old(name) : require(path.join(services, name));
  const closedClient = { execute: async () => { trace.providerRequests++; throw Error('ENTERPRISE_PROVIDER_FORBIDDEN'); } };
  const sessions = { verifyReference: async (reference, options) => {
    assert.equal(reference.userId, 99); assert(options.transaction); assert.equal(options.requireEmail, true);
    if (+reference.expiresAt <= +now()) throw Object.assign(Error('auth_invalid'), { code: 'auth_invalid' });
  } };
  const actor = scopeKey => ({ scopeKey, actorId: 99, sessionRef: randomUUID(), sessionExpiresAt: new Date(+now() + 10800000) });
  const scope = { assignmentScope: 'group', groupId: 28, scopeKey: 'group:28' }, clinicIds = [1, 70];
  const snapshots = async () => {
    const values = {};
    for (const name of ['MetaMarketingOAuthRequest', 'MetaMarketingEnrollmentRequest', 'MetaMarketingRecovery',
      'MetaMarketingBusinessHandover', 'MetaMarketingCredentialRenewal', 'MetaMarketingCredentialMaintenance',
      'MetaMarketingEffectiveCredential', 'MetaMarketingBrokerBinding', 'MetaMarketingBrokerRevocation',
      'MetaMarketingEnrollmentIdentity', 'MetaMarketingEnrollmentClaim', 'MetaScopeBlock', 'PlatformAuditEvent']) {
      if (models[name]) values[name] = await models[name].findAll({ raw: true, logging: false,
        order: models[name].primaryKeyAttributes.map(key => [key, 'ASC']) });
    }
    values.mappings = await models.ClinicMetaAsset.findAll({ attributes: ['id', 'metaConnectionId', 'assetType',
      'metaAssetId', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive', 'updatedAt'].filter(key => models.ClinicMetaAsset.rawAttributes[key]),
    raw: true, logging: false, order: [['id', 'ASC']] });
    // Hash the enclosing fixture's fictitious source/WhatsApp baseline without
    // adding any new credential-bearing projection to this fixture.
    if (baseline) values.enclosing = await baseline();
    return JSON.stringify(values);
  };
  const before = await snapshots(), rejectedBefore = report.rejected.length;
  const recovery = await models.MetaMarketingRecovery.findOne({ where: { scope_key: 'group:28' }, raw: true });
  assert(recovery); const oldEnrollment = initial.find(row => row.scope_key === 'group:28'); assert(oldEnrollment);
  const connectionId = Number(recovery.source_connection_id); assert(Number.isSafeInteger(connectionId) && connectionId > 0);
  const current = phase === 'pre_handover' ? oldEnrollment
    : await models.MetaMarketingEnrollmentRequest.findOne({ where: { scope_key: 'group:28', state: 'active' }, raw: true,
      order: [['requested_at', 'DESC'], ['enrollment_id', 'DESC']] });
  assert(current);
  const mappings = await models.ClinicMetaAsset.findAll({ where: { id: JSON.parse(current.mapping_ids) },
    attributes: ['id', 'assetType'], raw: true });
  const page = mappings.find(row => row.assetType === 'facebook_page')?.id;
  const account = mappings.find(row => row.assetType === 'ad_account')?.id; assert(page && account);

  const outcome = value => value?.error ? { code: sqlCode(value.error), name: value.error.name,
    message: String(value.error.message).slice(0, 256) } : value ? { settled: true, error: false } : null;
  async function observeRecordWait(tables, earlyOutcome = null) {
    const deadline = Date.now() + 4000; let observations = 0;
    while (Date.now() < deadline) {
      const [rows] = await originalQuery('SHOW ENGINE INNODB STATUS', { logging: false });
      const status = String(rows[0]?.Status || ''), transactions = status.split('\nTRANSACTIONS\n')[1]?.split('\nFILE I/O\n')[0] || '';
      const blocks = transactions.split(/(?=---TRANSACTION )/);
      const table = tables.find(value => blocks.some(block => block.includes('LOCK WAIT') && block.includes('RECORD LOCKS') && block.includes(value)));
      observations++;
      if (table) return { observer: 'SHOW ENGINE INNODB STATUS', table, recordLock: true, lockWait: true, observations };
      if (earlyOutcome?.()) throw Error('ENTERPRISE_RACE_SETTLED_BEFORE_RECORD_WAIT');
      await pause(20);
    }
    throw Error('ENTERPRISE_EXPECTED_RECORD_WAIT_NOT_OBSERVED');
  }
  async function activeWaitDiagnostic() {
    const [rows] = await originalQuery('SHOW ENGINE INNODB STATUS', { logging: false });
    const transactions = String(rows[0]?.Status || '').split('\nTRANSACTIONS\n')[1]?.split('\nFILE I/O\n')[0] || '';
    return transactions.split(/(?=---TRANSACTION )/).filter(block => block.includes('LOCK WAIT')).slice(0, 4).map(block => {
      const target = /index\s+(\S+)\s+of table\s+([^\n]+?)\s+trx id/.exec(block);
      return { index: target?.[1] || null, table: target?.[2] || null, privateActiveWaitBlock: block.slice(0, 8192) };
    });
  }
  function patch(modelName, method, wrapper) {
    const model = models[modelName], previous = model[method]; patched.push(() => { model[method] = previous; });
    model[method] = function (...args) { return wrapper.call(this, previous, args); };
  }
  const matches = (point, modelName, rows, args) => point && point.model === modelName
    && (point.id === undefined || rows.some(row => String(plain(row)?.[point.key]) === String(point.id))
      || modelName === 'MetaMarketingEnrollmentRequest' && String(args[0]) === String(point.id));
  for (const modelName of ['MetaMarketingEnrollmentRequest', 'MetaMarketingRecovery', 'MetaMarketingBusinessHandover', 'Clinica']) {
    for (const method of ['findByPk', 'findOne', 'findAll']) patch(modelName, method, async function (original, args) {
      const options = method === 'findByPk' ? args[1] : args[0], role = roles.getStore();
      let value;
      try { value = await original.apply(this, args); }
      catch (error) { if (active && lockError(error)) active.sqlErrors.push(sqlCode(error)); throw error; }
      if (!active || !options?.transaction || !options.lock) return value;
      const rows = value === null ? [] : Array.isArray(value) ? value : [value];
      if (role === 'reader') {
        for (const row of rows) {
          const entry = { model: modelName, id: plain(row)?.[models[modelName].primaryKeyAttributes[0]], transaction: options.transaction.id };
          if (!active.readerLocks.some(value => value.model === entry.model && value.id === entry.id)) active.readerLocks.push(entry);
        }
      }
      if (role === 'human' && modelName === 'MetaMarketingEnrollmentRequest') {
        for (const row of rows) {
          const id = plain(row)?.enrollment_id;
          if (id && !active.enrollmentLocks.includes(id)) active.enrollmentLocks.push(id);
        }
      }
      if (role === 'reader') {
        if (!active.paused && matches(active.pauseAt, modelName, rows, args)) {
          active.pauseObserved = { model: modelName, method, transaction: options.transaction.id,
            locks: active.readerLocks.map(value => ({ ...value })) };
          active.paused = true; active.readerReady.release(); await active.releaseReader.promise;
        } else if (active.paused && matches(active.stopAt, modelName, rows, args)) {
          active.readerTargetAcquired = true; throw STOP;
        }
      }
      return value;
    });
  }
  sql.query = async function (statement, options = {}) {
    const text = typeof statement === 'string' ? statement : statement?.query || statement?.sql || '';
    if (active) {
      const role = roles.getStore() || 'other';
      const entry = { sql: text, transaction: options.transaction?.id || null, bind: options.bind || null };
      (active.statementByRole ||= {})[role] = entry;
      const history = (active.statementHistoryByRole ||= {})[role] ||= []; history.push(entry); if (history.length > 8) history.shift();
    }
    if (active && roles.getStore() === 'human' && options.transaction && /^(?:\s*)(?:INSERT|UPDATE|DELETE)\b/i.test(text)) active.writes++;
    if (active?.clinicHeld && roles.getStore() === 'human' && options.transaction && /\bFOR UPDATE\b/i.test(text)
      && !/\bNOWAIT\b/i.test(text) && /MetaMarketing(?:EnrollmentRequests|BusinessHandovers)/.test(text)) active.lateLocks++;
    try { return await originalQuery(statement, options); }
    catch (error) {
      if (active && lockError(error)) active.sqlErrors.push(sqlCode(error));
      if (active && sqlCode(error) === 'ER_LOCK_NOWAIT') { active.nowaits = (active.nowaits || 0) + 1; active.clinicHeld = false; }
      throw error;
    }
  };
  const rollbackOnly = work => originalTransaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
    const value = await work(transaction); if (active) active.humanValue = value; throw STOP;
  });
  const retire = async (kind, red, { twice = false, auditFailure = false } = {}) => {
    let auditHookCalls = 0;
    const work = async ({ transaction, preparedContext }) => {
      const input = { scope, clinicIds, ...(preparedContext ? { preparedContext } : {}) };
      if (kind === 'outer') return load('oauthScopedDisconnect.service.js', red).deactivateMetaMappingsForScope({ scope,
        connectionId, actorId: 99, transaction, models, ...(preparedContext ? { preparedContext } : {}) });
      if (kind === 'preserve') {
        const preserve = load('metaScopeBlock.service.js', red).preserve;
        const args = { ...input, connectionId, actorId: 99, transaction, models };
        await preserve(args);
        if (twice) {
          const retiredState = async () => JSON.stringify({
            recovery: await models.MetaMarketingRecovery.findAll({ attributes: ['recovery_id', 'state', 'retired_at'],
              where: { scope_key: 'group:28' }, transaction, raw: true, order: [['recovery_id', 'ASC']] }),
            business: await models.MetaMarketingBusinessHandover.findAll({ attributes: ['handover_id', 'state', 'retired_at'],
              where: { scope_key: 'group:28' }, transaction, raw: true, order: [['handover_id', 'ASC']] }),
          });
          const firstRetired = await retiredState(); await preserve(args);
          assert.equal(await retiredState(), firstRetired, 'Repeated preserve must retain every first retirement timestamp');
          if (active) active.repeatedRetiredAtUnchanged = true;
        }
        const queued = (await models.MetaMarketingEnrollmentRequest.findByPk(current.enrollment_id, { transaction, raw: true })).state;
        assert.equal(queued, 'revoke_pending'); return { queued };
      }
      if (kind === 'recovery') return load('metaMarketingLegacyRecovery.service.js', red).createRecovery({ models, now, enabled: () => true }).retireForScope(input, transaction);
      return load('metaMarketingBusinessSource.service.js', red).createSource({ models, now }).retireForScope(input, transaction);
    };
    if (auditFailure) models.PlatformAuditEvent.addHook('beforeCreate', 'enterprise-audit-failure', row => {
      if (JSON.parse(row.body).action === 'integration.meta.scope_block') {
        auditHookCalls++; throw Error('FICTITIOUS_ENTERPRISE_AUDIT_FAILURE');
      }
    });
    try {
      if (red) return await rollbackOnly(transaction => work({ transaction }));
      return await withRetirementTransaction({ scope, clinicIds, connectionId, actorId: 99 },
        async context => { const value = await work(context); if (active) active.humanValue = value; throw STOP; });
    } finally {
      if (auditFailure) {
        models.PlatformAuditEvent.removeHook('beforeCreate', 'enterprise-audit-failure');
        assert.equal(auditHookCalls, 1, 'Actual scope-block audit must invoke its injected failure exactly once');
      }
    }
  };
  // The first confirmed H stores the exact prior epoch/version pin.
  const previous = () => models.MetaMarketingBusinessHandover.findOne({
    where: { old_enrollment_id: oldEnrollment.enrollment_id, state: 'active' }, raw: true });
  const confirmed = async red => {
    const h = await previous(); assert(h);
    return load('metaMarketingBusinessSource.service.js', red).createSource({ models, now }).getConfirmedHandover({
      enrollmentId: oldEnrollment.enrollment_id, connectionId: Number(oldEnrollment.meta_connection_id),
      epoch: Number(h.expected_epoch), versionId: h.expected_version_id, scopeKey: 'group:28' });
  };
  async function race({ name, red, human, pauseAt, stopAt, expectedHuman = 'rollback' }) {
    active = { name, red, pauseAt, stopAt, readerReady: barrier(), releaseReader: barrier(), sqlErrors: [], writes: 0, enrollmentLocks: [], readerLocks: [],
      paused: false, readerTargetAcquired: false };
    const scenario = active; let reader, other;
    try {
      reader = roles.run('reader', () => originalTransaction({ isolationLevel: 'REPEATABLE READ' },
        transaction => require('../../../services/metaMarketingLeadReader.service').forModels(models).preparePair(page, account, { transaction })))
        .then(value => (scenario.readerOutcome = { value }), error => (scenario.readerOutcome = { error }));
      await bounded(scenario.readerReady.promise, name + '_READER');
      other = roles.run('human', human).then(value => (scenario.humanOutcome = { value }), error => (scenario.humanOutcome = { error }));
      const wait = await bounded(observeRecordWait(['MetaMarketingEnrollmentRequests', 'MetaMarketingBusinessHandovers', 'MetaMarketingRecoveries'],
        () => scenario.readerOutcome || scenario.humanOutcome), name + '_WAIT');
      scenario.releaseReader.release();
      const results = await bounded(Promise.all([reader, other]), name + '_SETTLED');
      if (red) assert(scenario.sqlErrors.some(code => ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code)), name + ' must reproduce a real a8 SQL lock cycle');
      else {
        assert.deepEqual(scenario.sqlErrors, [], name + ' must resolve without deadlock/lock timeout');
        assert(scenario.readerTargetAcquired, name + ' must reach the real reader lock');
        if (expectedHuman === 'rollback') assert.equal(results[1].error, STOP, name + ' must complete the real mutation before intentional rollback');
        else {
          assert.equal(results[1].error, undefined, name + ' must complete the real metadata request');
          if (expectedHuman === 'confirmed') assert.equal(results[1].value?.currentStatus?.enrollmentId, current.enrollment_id);
          else assert.equal(results[1].value?.enabled, true);
        }
      }
      trace.cases.push({ phase, name, baseline: red, wait, sqlErrors: [...new Set(scenario.sqlErrors)], writes: scenario.writes,
        pauseObserved: scenario.pauseObserved, readerTargetAcquired: scenario.readerTargetAcquired,
        humanCode: results[1].error?.code || results[1].error?.message || null });
    } catch (error) {
      trace.diagnostic = { phase, name, baseline: red, failure: outcome({ error }), pauseObserved: scenario.pauseObserved,
        readerLocks: [...scenario.readerLocks], enrollmentLocks: [...scenario.enrollmentLocks], sqlErrors: [...new Set(scenario.sqlErrors)],
        readerOutcome: outcome(scenario.readerOutcome), humanOutcome: outcome(scenario.humanOutcome) };
      throw error;
    } finally {
      scenario.releaseReader.release(); await bounded(Promise.allSettled([reader, other].filter(Boolean)), name + '_CLEANUP'); active = null;
    }
    assert.equal(await snapshots(), before, name + ' must roll back all local changes');
  }
  const e = id => ({ model: 'MetaMarketingEnrollmentRequest', key: 'enrollment_id', id });
  const h = id => ({ model: 'MetaMarketingBusinessHandover', key: 'handover_id', id });
  async function requestJournalFence({ name, red, modelName, row, idField, work, expectedPrefix }) {
    const ready = barrier(), release = barrier(); let request;
    active = { name, red, sqlErrors: [], writes: 0, enrollmentLocks: [] }; const scenario = active;
    const holder = roles.run('journal_holder', () => originalTransaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
      assert(await models[modelName].findByPk(row[idField], { transaction, lock: transaction.LOCK.UPDATE }));
      ready.release(); await release.promise; throw STOP;
    })).catch(error => { if (error !== STOP) throw error; });
    try {
      await bounded(ready.promise, name + '_JOURNAL_HELD');
      request = roles.run('human', work).then(value => ({ value }), error => ({ error }));
      const wait = await bounded(observeRecordWait([models[modelName].getTableName()]), name + '_JOURNAL_WAIT');
      const prefix = [...scenario.enrollmentLocks];
      if (red) assert.notDeepEqual(prefix.slice(0, expectedPrefix.length), expectedPrefix, 'a8 request must omit the current lineage prefix');
      else assert.deepEqual(prefix.slice(0, expectedPrefix.length), expectedPrefix, 'Actual request must hold current head and every ancestor before journal');
      release.release(); const outcome = await bounded(request, name + '_JOURNAL_SETTLED');
      assert.deepEqual(scenario.sqlErrors, []); assert.equal(scenario.writes, 0);
      assert(!outcome.error || !lockError(outcome.error));
      trace.cases.push({ phase, name, baseline: red, wait, enrollmentLocks: prefix,
        expectedPrefix, writes: scenario.writes, humanCode: outcome.error?.code || null });
    } finally {
      release.release(); await bounded(Promise.allSettled([holder, request].filter(Boolean)), name + '_JOURNAL_CLEANUP'); active = null;
    }
    assert.equal(await snapshots(), before);
  }
  async function stalePreparedHead() {
    const order = require('../../../services/metaMarketingTransactionOrder.service').createOrder({ models,
      unavailable: () => { throw Object.assign(Error('FICTITIOUS_STALE_ORDER'), { code: 'FICTITIOUS_STALE_ORDER' }); } });
    const prepared = await order.prepareEnrollment(current.enrollment_id); assert(prepared);
    const copy = await models.MetaMarketingEnrollmentRequest.findByPk(current.enrollment_id, { raw: true });
    const insertedId = randomUUID(), insertedFlow = randomUUID(); let called = 0;
    // A committed competing journal is born strictly after the metadata hint.
    // It is an isolated fixture locator only and is never treated as authority.
    await models.MetaMarketingEnrollmentRequest.create({ ...copy, enrollment_id: insertedId, flow_id: insertedFlow,
      prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(),
      requested_at: new Date(+now() + 1000), lease_token: null, lease_until: null });
    try {
      active = { name: 'stale_prepared_head', sqlErrors: [], writes: 0, enrollmentLocks: [] }; const scenario = active;
      await assert.rejects(() => roles.run('human', () => originalTransaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
        await order.lockPrepared(prepared, transaction); called++;
        await models.MetaMarketingEnrollmentRequest.update({ attempts: Number(copy.attempts) + 1 },
          { where: { enrollment_id: current.enrollment_id }, transaction });
        throw STOP;
      })), { code: 'FICTITIOUS_STALE_ORDER' });
      assert.equal(called, 0); assert.equal(scenario.writes, 0); assert.deepEqual(scenario.sqlErrors, []);
      trace.cases.push({ phase, name: 'committed_head_appeared_after_prepare_before_prefix', baseline: false,
        staleDeniedBeforeWork: true, callbackCount: called, writes: scenario.writes, providerRequests: 0 });
    } finally {
      active = null;
      assert.equal(await models.MetaMarketingEnrollmentRequest.destroy({ where: { enrollment_id: insertedId, flow_id: insertedFlow } }), 1);
    }
    assert.equal(await snapshots(), before);
    const fresh = await order.prepareEnrollment(current.enrollment_id);
    await assert.rejects(() => rollbackOnly(async transaction => {
      await order.lockPrepared(fresh, transaction);
      await models.MetaMarketingEnrollmentRequest.update({ attempts: Number(copy.attempts) + 1 },
        { where: { enrollment_id: current.enrollment_id }, transaction });
    }), error => error === STOP);
    assert.equal(await snapshots(), before, 'Fresh SQL-only retry must also roll back its owned marker');
  }
  async function mixedBirthWaitingClinic(kind) {
    const producers = [], waits = []; let workCalls = 0;
    const template = await models[kind === 'enrollment' ? 'MetaMarketingEnrollmentRequest' : 'MetaMarketingBusinessHandover']
      .findByPk(current.enrollment_id, { raw: true }); assert(template);
    active = { name: 'mixed_' + kind + '_birth_waiting_clinic', sqlErrors: [], writes: 0,
      enrollmentLocks: [], nowaits: 0, lateLocks: 0, clinicHeld: false };
    const scenario = active;
    try {
      const result = await roles.run('human', () => withRetirementTransaction({ scope, clinicIds, connectionId, actorId: 99,
        afterFreshAuthorization: async () => {
          scenario.clinicHeld = true; const inserted = barrier(), id = randomUUID();
          const producer = roles.run('birth', () => originalTransaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
            // A rollback-only metadata locator, never a provider grant or a
            // successful activation. Its owner then requests the real Clinic.
            if (kind === 'enrollment') await models.MetaMarketingEnrollmentRequest.create({ ...template,
              enrollment_id: id, flow_id: randomUUID(), scope_key: 'clinic:70', clinic_ids: '[70]',
              prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(),
              requested_at: new Date(+now() + 1000), lease_token: null, lease_until: null }, { transaction });
            else await models.MetaMarketingBusinessHandover.create({ ...template, handover_id: id, new_enrollment_id: id,
              state_hash: createHash('sha256').update(id).digest('hex'), code_digest: null, pending_scope_key: null,
              begin_request_id: randomUUID(), finish_request_id: randomUUID(), activate_request_id: randomUUID(),
              abort_request_id: randomUUID(), drain_request_id: randomUUID(), revoke_request_id: randomUUID(),
              requested_at: new Date(+now() + 1000), lease_token: null, lease_until: null }, { transaction });
            inserted.release();
            await models.Clinica.findByPk(70, { transaction, lock: transaction.LOCK.UPDATE, attributes: ['id_clinica'] });
            throw STOP;
          })).catch(error => { if (error !== STOP) throw error; });
          producers.push(producer); await bounded(inserted.promise, kind + '_BORN');
          waits.push(await bounded(observeRecordWait(['Clinicas']), kind + '_WAITING_REAL_CLINIC'));
        } }, async () => { workCalls++; throw STOP; })).then(value => ({ value }), error => ({ error }));
      assert.equal(result.error?.code, 'meta_security_state_unavailable');
      assert.equal(producers.length, 2, 'Only the production wrapper two SQL attempts may run');
      assert.equal(workCalls, 0); assert.equal(scenario.writes, 0); assert.equal(scenario.lateLocks, 0);
      assert.equal(scenario.nowaits, 2); assert.deepEqual(scenario.sqlErrors, []);
      trace.cases.push({ phase, name: scenario.name, baseline: false, waits, nowaitRejections: scenario.nowaits,
        attempts: producers.length, workCalls, writes: scenario.writes, lateLocks: scenario.lateLocks,
        markerOnly: true, providerRequests: 0 });
    } finally { await bounded(Promise.allSettled(producers), kind + '_BIRTH_CLEANUP'); active = null; }
    assert.equal(await snapshots(), before, 'Both uncommitted locator births and withdrawal attempts must roll back');
  }
  async function withdrawalGuards() {
    const keys = ['META_MARKETING_LEGACY_RECOVERY_ENABLED', 'META_MARKETING_OAUTH_ENABLED', 'META_MARKETING_BUSINESS_ENABLED',
      'META_MARKETING_CREDENTIAL_RENEWAL_ENABLED', 'META_MARKETING_BUSINESS_MAINTENANCE_ENABLED'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const future = () => new Date(+now() + 366 * 86400000);
    const expired = await require('../../../services/metaMarketingEffectiveCredential.service').createEffectiveCredentials({ models, now: future }).getCredentialStatus(current);
    assert.equal(expired.expired, true);
    try {
      for (const key of keys) process.env[key] = 'false';
      await assert.rejects(() => withRetirementTransaction({ scope, clinicIds, connectionId, actorId: 99 }, async ({ transaction, preparedContext, inheritedClinicIds }) => {
        const input = { scope, clinicIds: inheritedClinicIds, preparedContext };
        await require('../../../services/metaMarketingLegacyRecovery.service').createRecovery({ models, now: future, enabled: () => false }).retireForScope(input, transaction);
        const result = await require('../../../services/metaMarketingBusinessSource.service').createSource({ models, now: future }).retireForScope(input, transaction);
        assert.equal(result.enrollmentsQueued, 1); throw STOP;
      }), error => error === STOP);
    } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    assert.equal(await snapshots(), before);
    const assignment = await models.MetaConnectionAssignment.findOne({ where: { scopeKey: 'clinic:1' }, raw: true });
    assert(assignment); await models.MetaConnectionAssignment.update({ status: 'active' }, { where: { id: assignment.id }, silent: true });
    try {
      await assert.rejects(() => withRetirementTransaction({ scope, clinicIds, connectionId, actorId: 99 }, async ({ inheritedClinicIds, clinicIds: all, preparedContext }) => {
        assert.deepEqual(all, [1, 70]); assert.deepEqual(inheritedClinicIds, [70]); assert.deepEqual(preparedContext.clinicIds, [70]);
        throw STOP;
      }), error => error === STOP);
      assert.equal((await models.MetaConnectionAssignment.findByPk(assignment.id, { raw: true })).status, 'active');
    } finally { await models.MetaConnectionAssignment.update({ status: assignment.status }, { where: { id: assignment.id }, silent: true }); }
    assert.equal(await snapshots(), before);
    trace.cases.push({ phase, name: 'legacy_write_without_mfa_gates_off_expired_withdrawal_and_clinic_override',
      baseline: false, admissionFlagsClosed: true, realExpiredStatus: expired.expired, withdrawalQueuedThenRolledBack: true,
      legacyAuthorization: true, clinicOverridePreserved: true });
  }
  try {
    if (phase === 'pre_handover') {
      assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(oldEnrollment.enrollment_id, { raw: true })).state, 'active');
      for (const red of [true, false]) await race({ name: 'recovery_retire_vs_actual_user_reader', red,
        human: () => retire('recovery', red), pauseAt: e(current.enrollment_id),
        stopAt: { model: 'MetaMarketingRecovery', key: 'recovery_id', id: recovery.recovery_id } });
    }
    if (phase === 'post_handover') {
      for (const red of [true, false]) {
        await race({ name: 'business_retire_vs_actual_business_reader', red, human: () => retire('business', red),
          pauseAt: e(current.enrollment_id), stopAt: h(current.enrollment_id) });
        await race({ name: 'confirmed_handover_vs_actual_business_reader', red, human: () => confirmed(red),
          pauseAt: e(current.enrollment_id), stopAt: h(current.enrollment_id), expectedHuman: 'confirmed' });
        await race({ name: 'outer_mapping_disconnect_vs_actual_business_reader', red, human: () => retire('outer', red),
          pauseAt: e(current.enrollment_id), stopAt: { model: 'Clinica', key: 'id_clinica', id: 1 } });
      }
      await mixedBirthWaitingClinic('enrollment'); await mixedBirthWaitingClinic('handover');
    }
    if (phase === 'lineage') {
      const edge = await models.MetaMarketingBusinessHandover.findByPk(current.enrollment_id, { raw: true }); assert(edge);
      const prior = await models.MetaMarketingBusinessHandover.findByPk(edge.old_enrollment_id, { raw: true }); assert(prior, 'A genuine second same-scope handover is required');
      for (const red of [true, false]) {
        await race({ name: 'two_handover_confirmed_lineage_vs_reader', red, human: () => confirmed(red),
          pauseAt: e(current.enrollment_id), stopAt: h(current.enrollment_id), expectedHuman: 'confirmed' });
        const service = load('metaMarketingBusiness.service.js', red).createService({ models, sessions, client: closedClient,
          now, enabled: () => true, returnOrigin: 'https://app.example.invalid' });
        await race({ name: 'two_handover_current_request_vs_reader', red,
          human: () => service.reconcile(actor('group:28'), current.enrollment_id),
          pauseAt: h(current.enrollment_id), stopAt: e(edge.old_enrollment_id), expectedHuman: 'request' });
      }
      const expectedPrefix = [current.enrollment_id, edge.old_enrollment_id, oldEnrollment.enrollment_id];
      const renewal = await models.MetaMarketingCredentialRenewal.findOne({ where: { enrollment_id: oldEnrollment.enrollment_id,
        state: 'active' }, raw: true, order: [['requested_at', 'DESC']] });
      assert(renewal, 'The genuine original USER renewal fixture supplies its confirmed request');
      const maintenance = await models.MetaMarketingCredentialMaintenance.findOne({ where: { enrollment_id: edge.old_enrollment_id,
        state: 'succeeded' }, raw: true, order: [['requested_at', 'DESC']] });
      assert(maintenance, 'The genuine first Business generation supplies completed maintenance');
      for (const red of [true, false]) {
        await requestJournalFence({ name: 'two_handover_user_renewal_request_journal', red,
          modelName: 'MetaMarketingCredentialRenewal', row: renewal, idField: 'renewal_id', expectedPrefix,
          work: () => load('metaMarketingCredentialRenewal.service.js', red).createService({ models, sessions,
            client: closedClient, now, enabled: () => true, returnOrigin: 'https://app.example.invalid' }).reconcile(actor('group:28'), renewal.renewal_id) });
        await requestJournalFence({ name: 'two_handover_business_maintenance_request_journal', red,
          modelName: 'MetaMarketingCredentialMaintenance', row: maintenance, idField: 'maintenance_id', expectedPrefix,
          work: () => load('metaMarketingCredentialMaintenance.service.js', red).createMaintenance({ models,
            client: closedClient, now, enabled: () => true }).reconcile(maintenance.maintenance_id) });
      }
      await stalePreparedHead();
      await withdrawalGuards();
      // Unrelated-scope isolation and repeat/audit rollback checks follow once
      // the production wrapper has fenced all current scope generations.
      const holderRelease = barrier(), held = barrier(); let withdrawal;
      const foreignRecoveryIds = (await models.MetaMarketingRecovery.findAll({ attributes: ['recovery_id'],
        where: { scope_key: 'group:29' }, raw: true, logging: false })).map(row => row.recovery_id).sort();
      const foreignHandoverIds = (await models.MetaMarketingBusinessHandover.findAll({ attributes: ['handover_id'],
        where: { scope_key: 'group:29' }, raw: true, logging: false })).map(row => row.handover_id).sort();
      assert(foreignRecoveryIds.length > 0 && foreignRecoveryIds.length <= 1000);
      assert(foreignHandoverIds.length > 0 && foreignHandoverIds.length <= 1000);
      const holderProof = { lockMode: 'existing_primary_keys_only', recoveryIds: foreignRecoveryIds, handoverIds: foreignHandoverIds };
      active = { name: 'unrelated_scope_repeat_withdrawal_and_audit_rollback', sqlErrors: [], writes: 0,
        enrollmentLocks: [], readerLocks: [] }; const unrelatedScenario = active;
      const holder = roles.run('unrelated', () => originalTransaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
        for (const recoveryId of foreignRecoveryIds) {
          const row = await models.MetaMarketingRecovery.findByPk(recoveryId, { attributes: ['recovery_id', 'scope_key'],
            transaction, lock: transaction.LOCK.UPDATE, raw: true });
          assert(row); assert.equal(row.scope_key, 'group:29');
        }
        for (const handoverId of foreignHandoverIds) {
          const row = await models.MetaMarketingBusinessHandover.findByPk(handoverId, { attributes: ['handover_id', 'scope_key'],
            transaction, lock: transaction.LOCK.UPDATE, raw: true });
          assert(row); assert.equal(row.scope_key, 'group:29');
        }
        held.release(); await holderRelease.promise; throw STOP;
      })).catch(error => { if (error !== STOP) throw error; });
      try {
        await bounded(held.promise, 'UNRELATED_HELD');
        withdrawal = roles.run('human', () => retire('preserve', false, { twice: true }))
          .then(value => (unrelatedScenario.humanOutcome = { value }), error => (unrelatedScenario.humanOutcome = { error }));
        const result = await bounded(withdrawal, 'UNRELATED_WITHDRAWAL', 4000);
        assert.equal(result.error, STOP);
      } catch (error) {
        trace.unrelatedDiagnostic = { failure: outcome({ error }), holderProof, humanOutcome: outcome(unrelatedScenario.humanOutcome),
          statementByRole: unrelatedScenario.statementByRole, statementHistoryByRole: unrelatedScenario.statementHistoryByRole,
          enrollmentLocks: [...unrelatedScenario.enrollmentLocks], sqlErrors: [...new Set(unrelatedScenario.sqlErrors)],
          activeWaitsBeforeHolderRelease: await activeWaitDiagnostic() };
        const selects = (unrelatedScenario.statementHistoryByRole?.unrelated || []).filter(entry => /^\s*SELECT\b/i.test(entry.sql)
          && /MetaMarketingRecoveries|MetaMarketingBusinessHandovers/.test(entry.sql)).slice(-2);
        trace.unrelatedDiagnostic.holderExplain = [];
        for (const entry of selects) {
          const [plan] = await bounded(originalQuery('EXPLAIN ' + entry.sql, { logging: false,
            ...(entry.bind ? { bind: entry.bind } : {}) }), 'UNRELATED_HOLDER_EXPLAIN', 1500);
          trace.unrelatedDiagnostic.holderExplain.push({ sql: entry.sql, bind: entry.bind,
            plan: plan.map(row => Object.fromEntries(['table', 'possible_keys', 'key', 'type', 'rows', 'Extra'].map(key => [key, row[key] ?? null]))) });
        }
        assert.equal(trace.unrelatedDiagnostic.holderExplain.length, 2, 'Both exact holder SELECT plans must be recorded before changing the fixture');
        throw error;
      } finally {
        holderRelease.release(); await bounded(Promise.allSettled([holder, withdrawal].filter(Boolean)), 'UNRELATED_RELEASE');
        if (trace.unrelatedDiagnostic) trace.unrelatedDiagnostic.humanOutcomeAfterCleanup = outcome(unrelatedScenario.humanOutcome);
        active = null;
      }
      assert.equal(await snapshots(), before);
      await assert.rejects(() => retire('preserve', false, { auditFailure: true }), /FICTITIOUS_ENTERPRISE_AUDIT_FAILURE/);
      assert.equal(await snapshots(), before, 'Audit failure must roll back the actual complete withdrawal');
      trace.cases.push({ phase, name: 'unrelated_scope_repeat_withdrawal_and_audit_rollback', baseline: false,
        unrelatedHistoryLocksHeld: true, repeatedWithdrawalRolledBack: true, auditFailureRolledBack: true,
        repeatedRetiredAtUnchanged: unrelatedScenario.repeatedRetiredAtUnchanged === true, holderProof });
    }
    assert.equal(await snapshots(), before);
    if (baseline) assert.equal(await baseline(), untouched);
    assert.equal(report.rejected.length, rejectedBefore); assert.equal(trace.providerRequests, 0);
    trace.phases.push(phase);
    report.checks.push('Actual enterprise ' + phase + ' InnoDB reader/request/withdrawal barriers retain all preexisting journals and enclosing WhatsApp bytes; every mutation path is rolled back and provider transports stay closed.');
  } finally {
    sql.query = queryFunction; while (patched.length) patched.pop()();
  }
};

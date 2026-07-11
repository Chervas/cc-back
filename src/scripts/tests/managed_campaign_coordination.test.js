'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const coordination = require('../../services/managedCampaignCoordination.service');

function errorCode(code, status = null) {
  return (error) => error?.code === code && (status === null || error?.httpStatus === status);
}

function opIn(whereValue) {
  return whereValue?.[Op.in] || [];
}

function activeUser(id) {
  return {
    id_usuario: id,
    nombre: id === 1 ? 'Admin' : 'Operadora',
    apellidos: id === 1 ? 'Global' : 'Campañas',
    email_usuario: `user${id}@example.test`,
    avatar: `/avatar-${id}.png`,
    password_usuario: 'NEVER_SERIALIZE',
    telefono: 'NEVER_SERIALIZE',
    notas_usuario: 'NEVER_SERIALIZE',
  };
}

function harness({
  status = 'active',
  version = 3,
  assignedTo = null,
  nextAction = null,
  blocker = null,
  activeUserIds = [1, 44],
  failAudit = false,
} = {}) {
  const campaign = {
    id: 'campaign-1',
    status,
    version,
    assigned_to_user_id: assignedTo,
    next_action: nextAction,
    operational_blocker: blocker,
    updated_by_user_id: 9,
    review_config: { client_next_action: 'Acción visible al cliente' },
    policy_readiness: { status: 'warning', reasons: ['technical'] },
    get() { return { ...this }; },
  };
  const initial = structuredClone({
    status: campaign.status,
    version: campaign.version,
    assigned_to_user_id: campaign.assigned_to_user_id,
    next_action: campaign.next_action,
    operational_blocker: campaign.operational_blocker,
    updated_by_user_id: campaign.updated_by_user_id,
    review_config: campaign.review_config,
    policy_readiness: campaign.policy_readiness,
  });
  const calls = { transactions: 0, users: [], finds: [], updates: [], audits: [] };
  const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
  let transactionTail = Promise.resolve();
  const sequelize = {
    transaction(callback) {
      const run = async () => {
        calls.transactions += 1;
        const snapshot = structuredClone({
          status: campaign.status,
          version: campaign.version,
          assigned_to_user_id: campaign.assigned_to_user_id,
          next_action: campaign.next_action,
          operational_blocker: campaign.operational_blocker,
          updated_by_user_id: campaign.updated_by_user_id,
          review_config: campaign.review_config,
          policy_readiness: campaign.policy_readiness,
        });
        try {
          return await callback(transaction);
        } catch (error) {
          Object.assign(campaign, snapshot);
          throw error;
        }
      };
      const result = transactionTail.then(run, run);
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
  const userModel = {
    async findAll(options) {
      calls.users.push(options);
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'SHARE');
      assert.equal(options.where.estado_cuenta, 'activo');
      return opIn(options.where.id_usuario)
        .filter((id) => activeUserIds.includes(id))
        .map((id) => ({ id_usuario: id }));
    },
  };
  const campaignModel = {
    async findByPk(id, options) {
      calls.finds.push({ id, options });
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      return id === campaign.id ? campaign : null;
    },
    async update(values, options) {
      calls.updates.push({ values: structuredClone(values), options });
      assert.equal(options.transaction, transaction);
      if (options.where.id !== campaign.id || options.where.version !== campaign.version) return [0];
      Object.assign(campaign, values);
      return [1];
    },
  };
  const auditModel = {
    async create(values, options) {
      calls.audits.push({ values: structuredClone(values), options });
      assert.equal(options.transaction, transaction);
      if (failAudit) throw new Error('audit persistence failed');
      return { ...values, created_at: '2026-07-11T05:00:00.000Z' };
    },
  };
  return { campaign, initial, calls, sequelize, userModel, campaignModel, auditModel };
}

function update(h, input, overrides = {}) {
  return coordination.updateManagedCampaignCoordination({
    campaignId: 'campaign-1',
    actorUserId: 1,
    allowedOperatorIds: new Set([1, 44]),
    input,
    sequelize: h.sequelize,
    campaignModel: h.campaignModel,
    auditModel: h.auditModel,
    userModel: h.userModel,
    uuid: () => 'audit-uuid',
    ...overrides,
  });
}

function testStrictPayloadValidation() {
  const invalidVersions = [undefined, null, 0, -1, 1.2, '7', '7x', true, [], {}];
  for (const expected_version of invalidVersions) {
    assert.throws(
      () => coordination.parseCoordinationInput({ expected_version, next_action: 'Revisar' }),
      errorCode('coordination_expected_version_invalid')
    );
  }
  assert.throws(
    () => coordination.parseCoordinationInput({ expected_version: 1 }),
    errorCode('coordination_patch_required')
  );
  assert.throws(
    () => coordination.parseCoordinationInput({ expected_version: 1, status: 'active' }),
    errorCode('coordination_unknown_fields')
  );
  for (const value of [0, -2, 4.2, '44', true, [], {}]) {
    assert.throws(
      () => coordination.parseCoordinationInput({ expected_version: 1, assigned_to_user_id: value }),
      errorCode('coordination_assignee_invalid')
    );
  }
  for (const value of [7, true, [], {}]) {
    assert.throws(
      () => coordination.parseCoordinationInput({ expected_version: 1, next_action: value }),
      errorCode('coordination_text_invalid')
    );
  }
  assert.throws(
    () => coordination.parseCoordinationInput({
      expected_version: 1,
      operational_blocker: 'x'.repeat(coordination.COORDINATION_TEXT_MAX + 1),
    }),
    errorCode('coordination_text_too_long')
  );
  assert.deepEqual(coordination.parseCoordinationInput({
    expected_version: 2,
    assigned_to_user_id: null,
    next_action: '  Próximo paso  ',
    operational_blocker: '   ',
  }), {
    expectedVersion: 2,
    patch: {
      assigned_to_user_id: null,
      next_action: 'Próximo paso',
      operational_blocker: null,
    },
    requestedFields: ['assigned_to_user_id', 'next_action', 'operational_blocker'],
  });
}

async function testOperatorCatalogAndPermissions() {
  assert.deepEqual(
    Array.from(coordination.campaignOperatorIds([1, 44], ' 44,51,invalid,-2,3.5,1e2,0x34, 52 ')),
    [1, 44, 51, 52]
  );
  let query;
  const items = await coordination.listActiveCampaignOperators({
    allowedOperatorIds: new Set([1, 44, 51]),
    userModel: {
      async findAll(options) {
        query = options;
        return [activeUser(44)];
      },
    },
  });
  assert.deepEqual(query.attributes, ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar']);
  assert.deepEqual(opIn(query.where.id_usuario), [1, 44, 51]);
  assert.equal(query.where.estado_cuenta, 'activo');
  assert.deepEqual(items, [{
    id: 44,
    display_name: 'Operadora Campañas',
    email: 'user44@example.test',
    avatar: '/avatar-44.png',
  }]);
  assert.doesNotMatch(JSON.stringify(items), /NEVER_SERIALIZE|password|telefono|notas/);

  await assert.rejects(
    () => coordination.requireActiveCampaignOperator({
      userId: 90,
      allowedOperatorIds: new Set([1, 44]),
      userModel: { findOne: async () => activeUser(90) },
    }),
    errorCode('campaign_operator_only', 403)
  );
  await assert.rejects(
    () => coordination.requireActiveCampaignOperator({
      userId: 44,
      allowedOperatorIds: new Set([1, 44]),
      userModel: { findOne: async () => null },
    }),
    errorCode('campaign_operator_inactive', 403)
  );
}

async function testCombinedUpdateAndAudit() {
  const h = harness({ assignedTo: null, nextAction: 'Anterior', blocker: 'Falta landing' });
  const result = await update(h, {
    expected_version: 3,
    assigned_to_user_id: 44,
    next_action: '  Revisar keywords  ',
    operational_blocker: null,
  });
  assert.equal(result.changed, true);
  assert.equal(result.version, 4);
  assert.equal(result.audit.id, 'audit-uuid');
  assert.equal(h.calls.updates.length, 1);
  assert.deepEqual(h.calls.updates[0].options.where, { id: 'campaign-1', version: 3 });
  assert.deepEqual(h.calls.updates[0].values, {
    assigned_to_user_id: 44,
    next_action: 'Revisar keywords',
    operational_blocker: null,
    updated_by_user_id: 1,
    version: 4,
  });
  assert.equal(h.calls.audits.length, 1);
  assert.deepEqual(h.calls.audits[0].values, {
    id: 'audit-uuid',
    managed_campaign_id: 'campaign-1',
    event_type: 'coordination_updated',
    actor_user_id: 1,
    from_version: 3,
    to_version: 4,
    changes: {
      assigned_to_user_id: { before: null, after: 44 },
      next_action: { before: 'Anterior', after: 'Revisar keywords' },
      operational_blocker: { before: 'Falta landing', after: null },
    },
  });
  assert.equal(h.campaign.status, h.initial.status);
  assert.deepEqual(h.campaign.review_config, h.initial.review_config);
  assert.deepEqual(h.campaign.policy_readiness, h.initial.policy_readiness);
}

async function testNoopAndStaleNoop() {
  const h = harness({ assignedTo: 44, nextAction: 'Revisar', blocker: null });
  const result = await update(h, {
    expected_version: 3,
    assigned_to_user_id: 44,
    next_action: '  Revisar ',
    operational_blocker: '',
  });
  assert.deepEqual(result, { changed: false, audit: null, version: 3 });
  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.calls.audits.length, 0);
  assert.equal(h.campaign.updated_by_user_id, 9);

  await assert.rejects(
    () => update(h, { expected_version: 2, next_action: 'Revisar' }),
    (error) => errorCode('operation_version_conflict', 409)(error) && error.currentVersion === 3
  );
  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.calls.audits.length, 0);
}

async function testAssigneeAndActorValidation() {
  const h = harness();
  await assert.rejects(
    () => update(h, { expected_version: 3, assigned_to_user_id: 90 }),
    errorCode('coordination_assignee_invalid', 400)
  );
  assert.equal(h.calls.transactions, 0, 'A non-allowlisted target must fail before opening a transaction');

  const inactiveTarget = harness({ activeUserIds: [1] });
  await assert.rejects(
    () => update(inactiveTarget, { expected_version: 3, assigned_to_user_id: 44 }),
    errorCode('coordination_assignee_invalid', 400)
  );
  assert.equal(inactiveTarget.calls.finds.length, 0);
  assert.equal(inactiveTarget.calls.audits.length, 0);

  const inactiveActor = harness({ activeUserIds: [44] });
  await assert.rejects(
    () => update(inactiveActor, { expected_version: 3, next_action: 'Revisar' }),
    errorCode('campaign_operator_inactive', 403)
  );
  assert.equal(inactiveActor.calls.finds.length, 0);

  const unassign = harness({ assignedTo: 44 });
  await update(unassign, { expected_version: 3, assigned_to_user_id: null });
  assert.equal(unassign.campaign.assigned_to_user_id, null);
}

async function testLifecycleCasAndRollback() {
  for (const status of ['completed', 'cancelled']) {
    const h = harness({ status });
    await assert.rejects(
      () => update(h, { expected_version: 3, next_action: 'No permitido' }),
      errorCode('terminal_campaign_coordination_locked', 409)
    );
    assert.equal(h.calls.updates.length, 0);
    assert.equal(h.calls.audits.length, 0);
  }
  for (const status of ['draft', 'launching', 'active', 'paused', 'blocked']) {
    const h = harness({ status });
    const result = await update(h, { expected_version: 3, next_action: `Acción ${status}` });
    assert.equal(result.changed, true, `${status} must remain operationally editable`);
  }

  const rollback = harness({ nextAction: 'Antes', failAudit: true });
  await assert.rejects(
    () => update(rollback, { expected_version: 3, next_action: 'Después' }),
    /audit persistence failed/
  );
  assert.equal(rollback.calls.updates.length, 1);
  assert.equal(rollback.calls.audits.length, 1);
  assert.equal(rollback.campaign.next_action, 'Antes');
  assert.equal(rollback.campaign.version, 3);
  assert.equal(rollback.campaign.updated_by_user_id, 9);

  const concurrent = harness();
  const attempts = await Promise.allSettled([
    update(concurrent, { expected_version: 3, next_action: 'Primera' }),
    update(concurrent, { expected_version: 3, next_action: 'Segunda' }),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((item) => item.status === 'rejected'
    && item.reason?.code === 'operation_version_conflict').length, 1);
  assert.equal(concurrent.calls.updates.length, 1);
  assert.equal(concurrent.calls.audits.length, 1);
  assert.equal(concurrent.campaign.version, 4);
}

async function testAuditDtoAndAppendOnlyModel() {
  const dto = coordination.operationAuditDto({
    id: 'audit-1',
    event_type: 'coordination_updated',
    actor_user_id: 44,
    actor: { ...activeUser(44), password_usuario: 'NEVER_SERIALIZE' },
    from_version: 3,
    to_version: 4,
    changes: { next_action: { before: null, after: 'Revisar' } },
    created_at: '2026-07-11T05:00:00.000Z',
    internal_secret: 'NEVER_SERIALIZE',
  });
  assert.deepEqual(dto, {
    id: 'audit-1',
    event_type: 'coordination_updated',
    actor_user_id: 44,
    actor_name: 'Operadora Campañas',
    from_version: 3,
    to_version: 4,
    changes: { next_action: { before: null, after: 'Revisar' } },
    created_at: '2026-07-11T05:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(dto), /NEVER_SERIALIZE|password|internal_secret/);

  const hooks = db.ManagedCampaignOperationAudit.options.hooks;
  for (const hookName of ['beforeUpdate', 'beforeBulkUpdate', 'beforeDestroy', 'beforeBulkDestroy']) {
    assert.ok(hooks[hookName], `Missing append-only hook ${hookName}`);
    const hook = Array.isArray(hooks[hookName]) ? hooks[hookName][0] : hooks[hookName];
    assert.throws(() => hook(), errorCode('managed_campaign_operation_audit_append_only'));
  }
  assert.ok(db.ManagedCampaign.associations.assignee);
  assert.ok(db.ManagedCampaign.associations.operation_audits);
  assert.ok(db.ManagedCampaignOperationAudit.associations.actor);
}

async function testMigrationAndApiSourceContract() {
  const migration = require('../../../migrations/20260711017000-add-managed-campaign-coordination');
  const calls = [];
  const queryInterface = {
    addColumn: async (...args) => calls.push(['addColumn', ...args]),
    createTable: async (...args) => calls.push(['createTable', ...args]),
    addIndex: async (...args) => calls.push(['addIndex', ...args]),
    dropTable: async (...args) => calls.push(['dropTable', ...args]),
    removeColumn: async (...args) => calls.push(['removeColumn', ...args]),
  };
  const Sequelize = {
    TEXT: 'TEXT',
    STRING: (length) => `STRING(${length})`,
    INTEGER: { UNSIGNED: 'INTEGER_UNSIGNED' },
    JSON: 'JSON',
    DATE: 'DATE',
    literal: (value) => value,
  };
  await migration.up(queryInterface, Sequelize);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.slice(0, 3)), [
    ['addColumn', 'ManagedCampaigns', 'next_action'],
    ['addColumn', 'ManagedCampaigns', 'operational_blocker'],
    ['createTable', 'ManagedCampaignOperationAudits', calls[2][2]],
  ]);
  const auditColumns = calls.find((call) => call[0] === 'createTable')[2];
  assert.equal(auditColumns.managed_campaign_id.onDelete, 'RESTRICT');
  assert.equal(auditColumns.changes.type, 'JSON');
  assert.equal(auditColumns.updated_at, undefined, 'Append-only audit must not have updated_at');
  assert.equal(calls.filter((call) => call[0] === 'addIndex').length, 2);
  calls.length = 0;
  await migration.down(queryInterface);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ['dropTable', 'ManagedCampaignOperationAudits'],
    ['removeColumn', 'ManagedCampaigns', 'operational_blocker'],
    ['removeColumn', 'ManagedCampaigns', 'next_action'],
  ]);

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8'
  );
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/adminManagedCampaigns.routes.js'),
    'utf8'
  );
  assert.match(routeSource, /router\.get\('\/operators', controller\.getOperators\)/);
  assert.match(
    routeSource,
    /router\.get\('\/access', controller\.getAccess\);\s*router\.use\(controller\.requireActiveOperator\);/,
    'Every administrative route after /access must require an allowlisted active account'
  );
  assert.match(routeSource, /router\.patch\('\/:id\/coordination', controller\.updateCoordination\)/);
  assert.match(routeSource, /router\.get\('\/:id\/coordination-audits', controller\.listCoordinationAudits\)/);
  assert.doesNotMatch(routeSource, /(?:patch|delete)\('\/:id\/coordination-audits/);
  assert.ok(routeSource.indexOf("router.get('/operators'") < routeSource.indexOf("router.get('/:id'"));
  assert.ok(routeSource.indexOf("router.patch('/:id/coordination'") < routeSource.indexOf("router.patch('/:id'"));

  const createStart = controllerSource.indexOf('exports.createCampaign');
  const updateStart = controllerSource.indexOf('exports.updateCampaign');
  const transitionStart = controllerSource.indexOf('exports.transitionCampaign');
  const createSource = controllerSource.slice(createStart, updateStart);
  const updateSource = controllerSource.slice(updateStart, transitionStart);
  for (const source of [createSource, updateSource]) {
    assert.match(source, /coordination_requires_dedicated_endpoint/);
  }
  assert.doesNotMatch(createSource, /assigned_to_user_id:\s*positiveInt/);
  assert.doesNotMatch(updateSource, /patch\.assigned_to_user_id/);

  const coordinationStart = controllerSource.indexOf('exports.updateCoordination');
  const auditsStart = controllerSource.indexOf('exports.listCoordinationAudits');
  const coordinationSource = controllerSource.slice(coordinationStart, auditsStart);
  assert.match(coordinationSource, /assertOperator\(req, res\)/);
  assert.match(coordinationSource, /updateManagedCampaignCoordination/);
  const auditSource = controllerSource.slice(auditsStart, createStart);
  assert.match(auditSource, /requireActiveOperatorRequest/);
  assert.match(auditSource, /order:\s*\[\['created_at', 'DESC'\], \['id', 'DESC'\]\]/);
  assert.match(auditSource, /Math\.min\(100/);
  assert.match(auditSource, /attributes:\s*\['id_usuario', 'nombre', 'apellidos'\]/);

  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, '../../services/managedCampaignCoordination.service.js'),
    'utf8'
  );
  assert.match(serviceSource, /campaignModel\.findByPk\([\s\S]*lock: transaction\.LOCK\.UPDATE/);
  assert.match(serviceSource, /where:\s*\{ id: campaignId, version: currentVersion \}/);
  assert.match(serviceSource, /auditModel\.create\([\s\S]*\}, \{ transaction \}\)/);
  assert.doesNotMatch(serviceSource, /auditModel\.(?:update|upsert|destroy)/);
  assert.match(controllerSource, /exports\.requireActiveOperator = asyncHandler/);

  const clientControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/managedCampaigns.controller.js'),
    'utf8'
  );
  const publicCampaignStart = clientControllerSource.indexOf('function publicCampaign');
  const publicCampaignEnd = clientControllerSource.indexOf('async function loadRows', publicCampaignStart);
  const publicCampaignSource = clientControllerSource.slice(publicCampaignStart, publicCampaignEnd);
  assert.doesNotMatch(publicCampaignSource, /operational_blocker|assigned_to_user_id/,
    'Internal coordination fields must not enter the client campaign DTO');
  assert.match(publicCampaignSource, /next_action:\s*plain\.review_config\?\.client_next_action/,
    'The client next action must remain isolated from the internal operations queue');
}

async function run() {
  testStrictPayloadValidation();
  await testOperatorCatalogAndPermissions();
  await testCombinedUpdateAndAudit();
  await testNoopAndStaleNoop();
  await testAssigneeAndActorValidation();
  await testLifecycleCasAndRollback();
  await testAuditDtoAndAppendOnlyModel();
  await testMigrationAndApiSourceContract();
  console.log('managed_campaign_coordination.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });

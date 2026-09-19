'use strict';
// Real MySQL journal + signed SQLite broker. Only Google/AWS/session proof are
// fictitious; no application database or external network is reachable.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const migrationName = '20260918190000-create-google-ads-action-journal.js';
  const migration = require('../../../migrations/' + migrationName);
  await migration.up(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
  const recoveryName = '20260918203000-google-action-recovery-ownership.js';
  const recovery = require('../../../migrations/' + recoveryName);
  await recovery.up(sql.getQueryInterface()); await recovery.up(sql.getQueryInterface());
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, D);
  await models.PlatformAuditEvent.sync();
  for (const [name, file] of [['GoogleAdsActionPlan', 'googleadsactionplan'], ['GoogleAdsActionCommand', 'googleadsactioncommand']]) {
    models[name] = require('../../../models/' + file)(sql, D);
  }
  for (const [name, fields] of [
    ['Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER, estado_clinica: { type: D.BOOLEAN, defaultValue: true } }],
    ['ClinicGoogleAdsAccount', { id: { type: D.INTEGER, primaryKey: true }, customerId: D.STRING, isActive: D.BOOLEAN,
      clinicaId: D.INTEGER, assignmentScope: D.STRING, grupoClinicaId: D.INTEGER }],
    ['GroupAssetClinicAssignment', { assetType: D.STRING, assetId: D.INTEGER, clinicaId: D.INTEGER }],
    ['UsuarioClinica', { id_usuario: D.INTEGER, id_clinica: D.INTEGER, rol_clinica: D.STRING, estado_invitacion: D.STRING }],
  ]) { models[name] = sql.define(name, fields, { timestamps: false }); await models[name].sync(); }
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }]);
  await models.ClinicGoogleAdsAccount.create({ id: 11, customerId: '1234567890', isActive: true,
    clinicaId: 59, assignmentScope: 'group', grupoClinicaId: 5 });
  const role = require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];
  await models.UsuarioClinica.bulkCreate([59, 71].map(id_clinica => ({ id_usuario: 91002, id_clinica,
    rol_clinica: role, estado_invitacion: 'aceptada' })));
  const { createGoogleAdsActionJournal } = require('../../services/googleAdsActionJournal.service');
  const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
  const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
  const { adsFixture, CUSTOMER, MANAGER, ASSET, ACCESS } = require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const C = require('../../../services/integrations-broker/src/google-action-management-contract');
  const cleanups = [], f = adsFixture({ after: fn => cleanups.push(fn) }), scope = scopeFixture();
  scope.mapping.clinicaId = 59; scope.binding.connection_ref = f.binding.connectionRef;
  scope.mapping.broker_read_connection_ref = f.binding.connectionRef;
  f.policy.grants.forEach(grant => { grant.tenantRef = 'clinic:59'; });
  f.policy.grants[0].operations = [...f.policy.grants[0].operations, ...Object.values(C.OPERATIONS)];
  f.binding.googleDataManager = { quotaProjectId: 'fictitious-project', destinations: [{ assetRef: ASSET,
    conversionActionId: '456', events: ['lead'], sources: ['WEB'], enhancedPolicy: null }] };
  f.binding.googleAdsActionManagement = { accounts: [{ assetRef: ASSET, events: C.EVENTS,
    currencies: ['EUR'], allowCreate: true, allowNormalize: true }] };
  let at = Date.now(), allowed = true, sessionValid = true, enabled = true, writes = 0, beforeRemote, afterRemote, providerUnknown = false;
  const rows = [], calls = [];
  const http = async request => {
    assert.equal(request.hostname, 'googleads.googleapis.com'); assert.equal(request.token.toString(), ACCESS);
    assert.equal(request.loginCustomerId, MANAGER);
    if (request.path.endsWith('/googleAds:search')) return { results: structuredClone(rows) };
    assert.equal(request.path, `/v24/customers/${CUSTOMER}/conversionActions:mutate`);
    if (request.json.validateOnly) return {};
    writes++;
    const results = request.json.operations.map(operation => {
      if (operation.update) {
        const row = rows.find(row => row.conversionAction.resourceName === operation.update.resourceName);
        Object.assign(row.conversionAction, operation.update); return { resourceName: row.conversionAction.resourceName };
      }
      const id = String(456 + rows.length), action = { ...operation.create, id,
        resourceName: `customers/${CUSTOMER}/conversionActions/${id}`, ownerCustomer: `customers/${CUSTOMER}`,
        includeInConversionsMetric: false };
      rows.push({ customer: { id: CUSTOMER }, conversionAction: action }); return { resourceName: action.resourceName };
    });
    if (providerUnknown) throw Object.assign(Error('PRIVATE-PROVIDER-DETAIL'), { code: 'provider_timeout' });
    return { results };
  };
  const runtimeConfig = require('../../../services/integrations-broker/src/google-main');
  const { createGoogleAdsDeveloperSecret } = require('../../../services/integrations-broker/src/google-ads-developer-secret');
  const remote = new (require('../../../services/integrations-broker/src/broker').Broker)({ store: f.store, policy: f.policy,
    secrets: f.secrets, now: () => at, operations: { ...f.engine.operations,
      ...require('../../../services/integrations-broker/src/google-action-management').createGoogleActionManagement({ store: f.store, http,
        withDeveloperSecret: createGoogleAdsDeveloperSecret({ client: f.sdk, accountId: runtimeConfig.ACCOUNT,
          prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtimeConfig.SECRET_KEY }), now: () => at }).operations } });
  const client = { execute: async command => {
    const q = await models.GoogleAdsActionCommand.findByPk(command.requestId);
    assert.equal(q?.state, 'attempted', 'command must be visible on another SQL connection before transport');
    calls.push(structuredClone(command)); await beforeRemote?.(command);
    const signed = require('../../../services/integrations-broker/src/auth').signRequest(command, {
      keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience, now: at });
    const result = await remote.execute(signed.raw, signed.headers); await afterRemote?.(command); return result;
  } };
  const broker = createGoogleAdsBroker({ ...scope.options, client, actionManagementEnabled: () => enabled, now: () => at });
  const sessions = { verifyReference: async () => { if (!sessionValid) throw Object.assign(Error('private'), { status: 401 }); } };
  const make = () => createGoogleAdsActionJournal({ models, sessions, now: () => at, enabled: () => enabled });
  let service = make();
  const context = { actor: { userId: 91002, sessionRef: randomUUID(), expiresAt: at + 3600000 }, scopeKey: 'group:5',
    runtime: { deliveryMode: 'broker', broker, brokerContext: await broker.prepare(scope.mapping), account: scope.mapping },
    beforeExecute: async () => allowed };
  const input = event => ({ mode: 'create', currency: 'EUR', targets: [{ event, actionId: null }] });
  const run = (family, payload, requestId = randomUUID(), ctx = context, confirm = family === 'apply') => service.execute(ctx, family, payload,
    { requestId, confirmExternalMutation: confirm });
  try {
    const planId = randomUUID();
    const prepared = await run('prepare', input('lead'), planId);
    assert.equal(prepared.plan.state, 'prepared'); assert.equal(writes, 0);
    const count = calls.length; service = make();
    assert.equal((await run('prepare', input('lead'), planId)).planId, planId); assert.equal(calls.length, count);
    await assert.rejects(run('prepare', input('contact'), planId), { code: 'google_action_conflict' });
    for (const changed of [{ ...context, actor: { ...context.actor, userId: 91003 } },
      { ...context, scopeKey: 'clinic:59' }]) {
      // Actor 91003 lacks ACL; others retain ACL but cannot adopt the plan.
      await assert.rejects(run('status', { planId }, randomUUID(), changed));
    }
    assert.equal(calls.length, count);
    const renewed = { ...context, actor: { ...context.actor, sessionRef: randomUUID(), expiresAt: at + 7200000 } };
    const renewalRead = await run('status', { planId }, randomUUID(), renewed);
    assert.equal(renewalRead.canApply, false); assert.equal(renewalRead.canCancel, true);
    await assert.rejects(run('apply', { planId }, randomUUID(), renewed), { code: 'google_action_not_found' });
    await assert.rejects(run('validate', { planId }, randomUUID(), renewed), { code: 'google_action_not_found' });
    await assert.rejects(run('apply', { planId }, randomUUID(), context, false), { code: 'google_action_confirmation_required' });
    await run('validate', { planId });
    report.checks.push('plan/input/session/scope ownership persists across service restart; confirmation and validateOnly preserve zero mutations');

    const applyId = randomUUID(); afterRemote = command => { if (command.operation === C.OPERATIONS.apply) throw Object.assign(Error('private'), { code: 'broker_timeout' }); };
    await assert.rejects(run('apply', { planId }, applyId), { code: 'broker_timeout' }); assert.equal(writes, 1);
    afterRemote = null; service = make(); const beforeReplay = calls.length;
    const replay = await run('apply', { planId }, applyId); assert.equal(replay.outcomeUnknown, true); assert.equal(replay.commandState, 'attempted');
    await assert.rejects(run('apply', { planId }), { code: 'google_action_conflict' }); assert.equal(calls.length, beforeReplay);
    const recovered = await run('status', { planId }, randomUUID(), renewed); assert.equal(recovered.plan.state, 'applied'); assert.equal(recovered.outcomeUnknown, false);
    assert.equal(recovered.plan.results[0].actionId, '456'); assert.equal(writes, 1);
    assert.equal((await models.GoogleAdsActionCommand.findByPk(applyId)).state, 'completed');
    const recoveredEvent = JSON.parse((await models.PlatformAuditEvent.findOne({ where: { correlation_id: applyId, stage: 'completed' } })).body);
    assert.equal(recoveredEvent.reason, 'result_recovered'); assert.equal(recoveredEvent.sessionRef, renewed.actor.sessionRef);
    assert.equal(recoveredEvent.initiatorSessionRef, context.actor.sessionRef);
    assert.equal(recoveredEvent.relatedCommandRef, recovered.commandId);
    report.checks.push('lost broker ACK + CRM restart recovers receipt by status, with exactly one real broker mutation and no retransmitted apply');

    const parallelId = randomUUID();
    await Promise.all(Array.from({ length: 6 }, () => run('prepare', input('contact'), parallelId)));
    assert.equal(calls.filter(c => c.requestId === parallelId).length, 1);
    const contenders = await Promise.allSettled(Array.from({ length: 6 }, () => run('apply', { planId: parallelId })));
    assert.equal(contenders.filter(r => r.status === 'fulfilled').length, 1); assert.equal(writes, 2);
    assert(contenders.filter(r => r.status === 'rejected').every(r => r.reason.code === 'google_action_conflict'));
    report.checks.push('six concurrent prepare requests dispatch once; six different apply UUIDs have one winner');

    const deniedPlan = (await run('prepare', input('schedule'))).planId; const beforeDenied = calls.length;
    await models.UsuarioClinica.destroy({ where: { id_usuario: 91002, id_clinica: 71 } });
    await assert.rejects(run('apply', { planId: deniedPlan })); assert.equal(calls.length, beforeDenied);
    await models.UsuarioClinica.create({ id_usuario: 91002, id_clinica: 71, rol_clinica: role, estado_invitacion: 'aceptada' });
    sessionValid = false; await assert.rejects(run('status', { planId }), { code: 'google_action_session_required' }); sessionValid = true;
    allowed = false; await assert.rejects(run('status', { planId }), { code: 'scope_denied' }); allowed = true;
    enabled = false; await assert.rejects(run('apply', { planId: deniedPlan }), { code: 'broker_cohort_disabled' }); enabled = true;
    assert.equal(calls.length, beforeDenied);
    report.checks.push('current SQL permission of another clinic, revoked session, caller scope and disabled cohort block before broker transport');

    await models.Clinica.update({ estado_clinica: false }, { where: { id_clinica: 71 } });
    const beforePaused = calls.length;
    await assert.rejects(run('apply', { planId: deniedPlan }), { code: 'conversion_paused' });
    await assert.rejects(run('prepare', input('purchase')), { code: 'conversion_paused' });
    assert.equal(calls.length, beforePaused);
    assert.equal((await run('status', { planId })).plan.state, 'applied');
    await models.Clinica.update({ estado_clinica: true }, { where: { id_clinica: 71 } });
    report.checks.push('paused clinic sharing the account blocks preparation/apply, while authenticated read-only receipt recovery remains available');

    const missingAck = randomUUID(); afterRemote = command => { if (command.requestId === missingAck) throw Object.assign(Error('private'), { code: 'broker_timeout' }); };
    await assert.rejects(run('prepare', input('purchase'), missingAck), { code: 'broker_timeout' }); afterRemote = null;
    const restored = await run('status', { planId: missingAck }); assert.equal(restored.plan.changes[0].event, 'purchase');
    at += 300001; await assert.rejects(run('apply', { planId: missingAck }), { code: 'action_plan_expired' });
    assert.equal(writes, 2);
    report.checks.push('lost prepare ACK restores its bounded metadata; an expired plan cannot apply');

    const uncertain = (await run('prepare', input('qualified_lead'))).planId; providerUnknown = true;
    await assert.rejects(run('apply', { planId: uncertain })); providerUnknown = false;
    assert.equal(writes, 3); assert.equal((await run('status', { planId: uncertain })).plan.state, 'attempted');
    await assert.rejects(run('apply', { planId: uncertain }), { code: 'google_action_conflict' });
    report.checks.push('provider response loss remains attempted in broker and unknown in CRM; status cannot invent success or authorize a second apply');

    const postDenied = (await run('prepare', input('schedule'))).planId;
    afterRemote = command => { if (command.operation === C.OPERATIONS.apply) allowed = false; };
    await assert.rejects(run('apply', { planId: postDenied }), { code: 'scope_denied' }); afterRemote = null; allowed = true;
    assert.equal((await run('status', { planId: postDenied })).plan.state, 'applied'); assert.equal(writes, 4);
    report.checks.push('permission loss after provider commit suppresses response; restored authorization recovers the original receipt');

    rows[0].conversionAction.primaryForGoal = true;
    const normalized = (await run('prepare', { mode: 'normalize', currency: null, targets: [{ event: 'lead', actionId: '456' }] })).planId;
    models.GoogleAdsActionPlan.addHook('beforeUpdate', 'reject-receipt', row => {
      if (row.changed('receipt')) throw Error('FICTITIOUS_COMMIT_FAILURE');
    });
    await assert.rejects(run('apply', { planId: normalized }), { code: 'google_action_management_broker_failed' });
    models.GoogleAdsActionPlan.removeHook('beforeUpdate', 'reject-receipt');
    assert.equal((await run('status', { planId: normalized })).plan.results[0].change, 'normalize'); assert.equal(writes, 5);
    assert.equal(rows[0].conversionAction.primaryForGoal, false);
    report.checks.push('SQL receipt transaction failure after normalization preserves apply identity and recovers the broker receipt without a second write');

    // Exercise the actual Express routes over HTTP, with the production journal,
    // SQL ACL and broker. A deliberately fictitious session verifier is confined
    // to this loopback router; it is not a public authenticated UI acceptance.
    const httpNode = require('node:http'), app = require('express')(); app.use(require('express').json({ limit: '32kb' }));
    const apiSessions = { ...sessions, bearer: value => value, verify: async value => {
      if (value !== 'Bearer FICTITIOUS_QA_SESSION') throw Error('no session');
      return { sessionVersion: 1, userId: context.actor.userId, jti: context.actor.sessionRef, exp: context.actor.expiresAt / 1000 };
    } };
    app.use('/plans', require('../../routes/googleAdsActionPlans.routes').createRouter({ models, sessions: apiSessions,
      journal: service, resolveRuntime: async options => { assert.equal(options.requireBroker, true); return context.runtime; } }));
    const server = httpNode.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const agent = new httpNode.Agent({ keepAlive: false });
    agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
    const request = (suffix, body, authenticated = true) => new Promise((resolve, reject) => {
      const req = httpNode.request({ host: '127.0.0.1', port: server.address().port, agent, path: '/plans' + suffix, method: 'POST',
        headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer FICTITIOUS_QA_SESSION' } : {}) } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const text = Buffer.concat(chunks).toString(); assert.doesNotMatch(text, /FICTITIOUS|PRIVATE|secretArn|connectionRef|googleSubject/);
          resolve({ status: res.statusCode, body: JSON.parse(text), cache: res.headers['cache-control'] });
        });
      }); req.on('error', reject); req.end(JSON.stringify(body));
    });
    try {
      const body = { group_id: 5, customer_id: CUSTOMER, request_id: randomUUID(), ...input('lead') };
      assert.equal((await request('/', body, false)).status, 401);
      for (const bad of [{ ...body, clinic_id: 59 }, { ...body, connectionRef: 'injected' }, { ...body, group_id: '5suffix' }]) {
        assert.equal((await request('/', bad)).status, 400);
      }
      const response = await request('/', body); assert.equal(response.status, 200); assert.equal(response.cache, 'private, no-store');
      const follow = { group_id: 5, customer_id: CUSTOMER, request_id: randomUUID() };
      assert.equal((await request('/' + body.request_id + '/validate', follow)).status, 200);
      assert.equal((await request('/' + body.request_id + '/apply', { ...follow, request_id: randomUUID(), confirm_external_mutation: false })).status, 409);
      const accepted = await request('/' + body.request_id + '/apply', { ...follow, request_id: randomUUID(), confirm_external_mutation: true });
      assert.equal(accepted.status, 200); assert.equal(accepted.body.plan.state, 'applied'); assert.equal(writes, 5);
      assert.equal((await request('/' + randomUUID() + '/status', { ...follow, request_id: randomUUID() })).status, 404);
      const httpClosedPlan = randomUUID(), httpClosedCalls = calls.length;
      const cancelBody = { ...follow, request_id: randomUUID(), input: input('purchase') };
      assert.equal((await request('/' + httpClosedPlan + '/cancel', { ...cancelBody, confirm_external_mutation: true })).status, 400);
      const closedResponse = await request('/' + httpClosedPlan + '/cancel', cancelBody);
      assert.equal(closedResponse.status, 200); assert.equal(closedResponse.body.closed, true);
      assert.equal(closedResponse.body.canApply, false); assert.equal(closedResponse.body.plan, null);
      assert.equal((await request('/' + httpClosedPlan + '/status', { ...follow, request_id: randomUUID() })).body.closed, true);
      assert.equal(calls.length, httpClosedCalls);

    } finally { agent.destroy(); await new Promise(resolve => server.close(resolve)); }
    report.checks.push('real loopback HTTP routes enforce closed bodies, managed-session proof, explicit confirmation, SQL clinic permissions and no-store; no credentials leak');

    // Closing a preparation must survive restart and renewed sessions, without
    // discarding history or ever unlocking an attempted external mutation.
    const cancelledPlan = (await run('prepare', input('purchase'))).planId;
    const beforeCancel = calls.length;
    await assert.rejects(run('cancel', { planId: cancelledPlan, input: input('lead') }), { code: 'google_action_conflict' });
    await models.Clinica.update({ estado_clinica: false }, { where: { id_clinica: 71 } });
    const cancelled = await run('cancel', { planId: cancelledPlan, input: input('purchase') }, randomUUID(), renewed);
    assert.equal(cancelled.closed, true); assert.equal(cancelled.canApply, false); assert.equal(cancelled.canCancel, false);
    assert.equal(calls.length, beforeCancel);
    assert.equal((await run('status', { planId: cancelledPlan }, randomUUID(), renewed)).closed, true);
    assert.equal(calls.length, beforeCancel);
    await models.Clinica.update({ estado_clinica: true }, { where: { id_clinica: 71 } });
    service = make(); await assert.rejects(run('apply', { planId: cancelledPlan }), { code: 'google_action_closed' });
    await assert.rejects(run('cancel', { planId: uncertain, input: input('qualified_lead') }), { code: 'google_action_conflict' });
    await assert.rejects(run('cancel', { planId, input: input('lead') }), { code: 'google_action_conflict' });
    const tombstone = randomUUID();
    assert.equal((await run('cancel', { planId: tombstone, input: input('purchase') })).closed, true);
    assert.equal((await run('status', { planId: tombstone })).plan, null);
    await assert.rejects(run('prepare', input('purchase'), tombstone), { code: 'google_action_closed' });
    assert.equal(calls.length, beforeCancel);
    report.checks.push('renewed same-user session cancels unattempted preparations even when a clinic is paused; persisted closure blocks apply/late prepare, and never cancels attempted or applied mutations');

    let releaseRead, admitRead;
    const waiting = new Promise(resolve => { admitRead = resolve; });
    const barrier = new Promise(resolve => { releaseRead = resolve; });
    const racing = randomUUID();
    afterRemote = async command => { if (command.requestId === racing) { admitRead(); await barrier; } };
    const inFlight = run('prepare', input('purchase'), racing);
    await waiting;
    try { assert.equal((await run('cancel', { planId: racing, input: input('purchase') }, randomUUID(), renewed)).closed, true); }
    finally { releaseRead(); }
    assert.equal((await inFlight).closed, true); afterRemote = null;
    const abandoned = await models.GoogleAdsActionCommand.findByPk(racing);
    assert.equal(abandoned.state, 'completed'); assert.equal(abandoned.last_error, 'google_action_closed');
    const abandonedAudit = JSON.parse((await models.PlatformAuditEvent.findOne({ where: { correlation_id: racing, stage: 'completed' } })).body);
    assert.equal(abandonedAudit.outcome, 'unknown'); assert.equal(abandonedAudit.reason, 'command_cancelled');
    assert.equal(abandonedAudit.sessionRef, renewed.actor.sessionRef);
    report.checks.push('cancellation wins against a late preparation ACK; the cancelled read remains closed with unknown outcome and both initiating/recovering session references');

    const auditBefore = calls.length, failingAdmission = randomUUID();
    models.PlatformAuditEvent.addHook('beforeCreate', 'audit-failure', () => { throw Error('FICTITIOUS_AUDIT_DOWN'); });
    await assert.rejects(run('prepare', input('purchase'), failingAdmission));
    models.PlatformAuditEvent.removeHook('beforeCreate', 'audit-failure');
    assert.equal(calls.length, auditBefore); assert.equal(await models.GoogleAdsActionCommand.findByPk(failingAdmission), null);
    const failedCompletion = randomUUID();
    models.PlatformAuditEvent.addHook('beforeCreate', 'audit-failure', row => {
      if (row.stage === 'completed') throw Error('FICTITIOUS_AUDIT_DOWN');
    });
    await assert.rejects(run('prepare', input('purchase'), failedCompletion));
    models.PlatformAuditEvent.removeHook('beforeCreate', 'audit-failure');
    assert.equal((await models.GoogleAdsActionCommand.findByPk(failedCompletion)).state, 'attempted');
    assert.equal((await models.GoogleAdsActionPlan.findByPk(failedCompletion)).receipt, null);
    assert.equal((await run('status', { planId: failedCompletion }, randomUUID(), renewed)).plan.state, 'prepared');
    assert.equal((await models.GoogleAdsActionCommand.findByPk(failedCompletion)).state, 'completed');
    const incompleteLegacy = (await run('prepare', input('purchase'))).planId;
    await models.GoogleAdsActionPlan.update({ scope_digest: null }, { where: { plan_id: incompleteLegacy } });
    await assert.rejects(run('status', { planId: incompleteLegacy }), { code: 'google_action_recovery_unavailable' });
    const rollbackPlan = (await run('prepare', input('purchase'))).planId, rollbackCommand = randomUUID();
    models.PlatformAuditEvent.addHook('beforeCreate', 'cancel-failure', row => {
      if (JSON.parse(row.body).reason === 'preparation_cancelled') throw Error('FICTITIOUS_CANCEL_AUDIT_DOWN');
    });
    await assert.rejects(run('cancel', { planId: rollbackPlan, input: input('purchase') }, rollbackCommand));
    models.PlatformAuditEvent.removeHook('beforeCreate', 'cancel-failure');
    assert.equal((await models.GoogleAdsActionPlan.findByPk(rollbackPlan)).closed_at, null);
    assert.equal(await models.GoogleAdsActionCommand.findByPk(rollbackCommand), null);
    assert.equal(await models.PlatformAuditEvent.count({ where: { correlation_id: rollbackCommand } }), 0);
    const raceWrites = writes;
    const competing = await Promise.allSettled([run('apply', { planId: rollbackPlan }),
      run('cancel', { planId: rollbackPlan, input: input('purchase') }, randomUUID(), renewed)]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    const winningPlan = await models.GoogleAdsActionPlan.findByPk(rollbackPlan);
    assert.equal(writes - raceWrites, winningPlan.closed_at ? 0 : 1);
    assert.equal(Boolean(winningPlan.apply_command_id), !winningPlan.closed_at);
    report.checks.push('cancellation/audit commit rolls back together; simultaneous apply and cancellation have exactly one winner, preserving the durable exclusion');
    const metadataOnly = JSON.stringify(await models.PlatformAuditEvent.findAll());
    assert.doesNotMatch(metadataOnly, /FICTITIOUS|PRIVATE|refreshToken|accessToken|googleSubject|targets/);
    report.checks.push('SQL outbox failure rolls admission back before transport and receipt completion back after transport; fresh authorized status recovers the original attempt; legacy rows without captured ownership fail closed');

    await assert.rejects(require('../../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime({
      userId: 91002, groupId: 5, assignmentScope: 'group', customerId: CUSTOMER, requireBroker: true,
      accountModel: { findAll: async () => [scope.mapping] }, broker: { prepare: async () => null },
      credentials: { load: async () => assert.fail('local credential lookup forbidden') },
      ensureAccessToken: async () => assert.fail('OAuth forbidden'),
    }), { code: 'google_action_broker_required' });
    report.checks.push('explicit plan API rejects a legacy mapping before any local credential read or OAuth request');

    await assert.rejects(recovery.down(sql.getQueryInterface()), /Preserve recovery ownership/);
    await assert.rejects(migration.down(sql.getQueryInterface()), /Preserve Google action/);
    const schema = require('../../lib/securitySchemaContract');
    const snapshot = await schema.snapshot(async (query, values) => (await sql.query(query, { replacements: values }))[0]);
    const contract = { tables: {}, migrations: [migrationName, recoveryName].map(name => ({ name,
      sha256: createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../../../migrations', name))).digest('hex') })) };
    for (const name of ['GoogleAdsActionPlans', 'GoogleAdsActionCommands']) {
      const table = snapshot.tables.find(row => row.TABLE_NAME === name);
      contract.tables[name] = { ENGINE: table.ENGINE, TABLE_COLLATION: table.TABLE_COLLATION,
        columns: snapshot.columns.filter(row => row.TABLE_NAME === name).map(({ TABLE_NAME, ...row }) => row),
        indexes: [...new Set(snapshot.indexes.filter(row => row.TABLE_NAME === name).map(row => row.INDEX_NAME))].map(index => ({ name: index,
          columns: snapshot.indexes.filter(row => row.TABLE_NAME === name && row.INDEX_NAME === index).map(({ TABLE_NAME, ...row }) => row) })),
        checks: snapshot.checks.filter(row => row.TABLE_NAME === name).map(({ TABLE_NAME, ...row }) => row) };
    }
    report.schema = path.join(report.root, 'action-schema.json'); fs.writeFileSync(report.schema, JSON.stringify(contract, null, 2));
    console.log('SCHEMA_EVIDENCE=' + report.schema);
    const published = require('../../../ops/security/schema-contract.json');
    for (const name of Object.keys(contract.tables)) {
      // These journals predate generated-column metadata in the contract.
      // Require an empty expression; do not discard it from the observation.
      const expected = published.tables[name];
      assert.deepEqual(contract.tables[name], { ...expected, columns: expected.columns.map(column => ({
        ...column, GENERATION_EXPRESSION: column.GENERATION_EXPRESSION ?? '',
      })) });
    }
    for (const migration of contract.migrations) assert.deepEqual(published.migrations.find(row => row.name === migration.name), migration);
    report.schema = path.join(report.root, 'action-schema.json'); fs.writeFileSync(report.schema, JSON.stringify(contract, null, 2));
    report.checks.push('repeatable migration uses InnoDB and binary identities; destructive rollback refuses nonempty operation history');
    assert.equal(JSON.stringify(await models.GoogleAdsActionPlan.findAll()).includes('PRIVATE'), false);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}).catch(error => { console.error(error); process.exitCode = 1; });

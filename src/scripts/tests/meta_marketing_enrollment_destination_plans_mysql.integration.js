'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Sequelize = require('sequelize');
const { DataTypes } = Sequelize;
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const OAuth = require('../../services/metaMarketingOAuth.contract');
const C = require('../../services/metaMarketingEnrollment.contract');
const Discovery = require('../../../services/integrations-broker/src/meta-marketing-discovery-contract');
const Admission = require('../../../services/integrations-broker/src/meta-marketing-admission-contract');
const migration = require('../../../migrations/20261122213000-create-meta-marketing-enrollment-destination-plans');
const { effectiveRequirements, migrationFiles, loadMigration } = require('../../lib/rdsSchemaMigrationPolicy');
const { migrationInterface } = require('../../lib/rdsSchemaMigration');
const { snapshot, compare } = require('../../lib/securitySchemaContract');
const schema = require('../../../ops/security/schema-contract.json');
const TABLE = 'MetaMarketingEnrollmentDestinationPlans';
const MIGRATION = '20261122213000-create-meta-marketing-enrollment-destination-plans.js';
const FEATURE = 'meta_marketing_group_destinations';

async function verifySchemaRollout(sql, report) {
  const info = { contract: schema };
  const legacy = effectiveRequirements(info, [], {}, 'gateway');
  assert(legacy.contract.disabledFeatureGroups.includes(FEATURE));
  assert.equal(legacy.contract.tables[TABLE], undefined);
  assert.equal(legacy.contract.migrations.some(value => value.name === MIGRATION), false);
  const enabled = effectiveRequirements(info, [], { META_MARKETING_GROUP_DESTINATION_PLAN_ENABLED: 'true' }, 'staging');
  const selected = effectiveRequirements(info, [MIGRATION], {}, 'staging');
  assert(selected.scope.selectedFeatureGroups.includes(FEATURE));
  assert.deepEqual(selected.contract.tables[TABLE], enabled.contract.tables[TABLE]);
  const source = path.resolve(__dirname, '../../..'), pins = migrationFiles(source, [MIGRATION]);
  const required = selected.contract.migrations.find(value => value.name === MIGRATION);
  assert.equal(pins.find(value => value.path === 'migrations/' + MIGRATION).sha256, required.sha256);

  await sql.getQueryInterface().createTable('SequelizeMeta', { name: { type: Sequelize.STRING(255), primaryKey: true } });
  const raw = await sql.connectionManager.getConnection();
  const journal = [];
  const { migration: reviewed, facade } = loadMigration(source, MIGRATION, pins, Sequelize);
  const guard = migrationInterface({ admin: { raw, identity: { database: report.database, engineVersion: report.mysql } },
    aws: { assertFresh() {} }, journal: event => journal.push(event), migrationName: MIGRATION, Sequelize });
  try { await reviewed.up(guard.queryInterface, facade); }
  finally {
    await guard.restore();
    await sql.connectionManager.releaseConnection(raw);
  }
  assert.deepEqual(journal.map(row => row.event), ['statement_request', 'statement_ack']);
  assert.equal(journal[0].sqlSha256, journal[1].sqlSha256);
  assert.equal(journal[1].warnings, 0);
  await sql.query('INSERT INTO SequelizeMeta (name) VALUES (?)', { replacements: [MIGRATION] });
  const actual = await snapshot((query, replacements) => sql.query(query, { replacements, type: Sequelize.QueryTypes.SELECT }));
  const result = compare(actual, { tables: { [TABLE]: selected.contract.tables[TABLE] }, migrations: [required] });
  assert.equal(result.compatible, true, JSON.stringify(result));
  report.checks.push('Standard schema release selects and pins guarded DDL and verifies table metadata, while an old gateway without the gate does not require it.');
}

async function prepareModels(sql, models) {
  for (const [name, file] of [
    ['Clinica', 'clinica'], ['GrupoClinica', 'grupoclinica'], ['UsuarioClinica', 'usuarioclinica'],
    ['MetaConnection', 'MetaConecction'], ['ClinicMetaAsset', 'ClinicMetaAsset'], ['MetaConnectionAssignment', 'metaconnectionassignment'],
    ['GroupAssetClinicAssignment', 'groupassetclinicassignment'], ['PlatformAuditEvent', 'platformauditevent'],
    ['MetaScopeBlock', 'metascopeblock'], ['MetaMarketingRecovery', 'metamarketingrecovery'],
    ['MetaMarketingBrokerBinding', 'metamarketingbrokerbinding'], ['MetaMarketingBrokerRevocation', 'metamarketingbrokerrevocation'],
    ['MetaMarketingOAuthSlot', 'metamarketingoauthslot'], ['MetaMarketingOAuthRequest', 'metamarketingoauthrequest'],
    ['MetaMarketingEnrollmentRequest', 'metamarketingenrollmentrequest'], ['MetaMarketingEnrollmentClaim', 'metamarketingenrollmentclaim'],
    ['MetaMarketingEnrollmentIdentity', 'metamarketingenrollmentidentity'],
  ]) {
    const model = require('../../../models/' + file)(sql, DataTypes);
    for (const attribute of Object.values(model.rawAttributes)) delete attribute.references;
    model.refreshAttributes();
    await model.sync();
    models[name] = model;
  }
  models.MetaMarketingEnrollmentDestinationPlan = require('../../../models/metamarketingenrollmentdestinationplan')(sql, DataTypes);
  await require('../../../migrations/20260919110000-meta-marketing-enrollment-due-index').up(sql.getQueryInterface());
}

const ACTOR = 91001, APP = '99101';
const SCOPES = ['ads_management', 'ads_read', 'leads_retrieval', 'pages_manage_ads', 'pages_manage_metadata', 'pages_read_engagement',
  'pages_show_list', 'public_profile'];

function asset(kind, id) {
  return { assetRef: 'meta-' + kind + ':' + id, kind, id: String(id), parentPageId: null, name: '  Clínica ficticia nº ' + id + '  ',
    ...(kind === 'ad_account' ? { accountStatus: 1, currency: 'EUR', timezone: 'Europe/Madrid' } : {}) };
}

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await prepareModels(sql, models);
  const qi = sql.getQueryInterface(), commands = [], inventory = new Map(), owners = new Map();
  const { createService } = require('../../services/metaMarketingEnrollment.service');
  const { createDestinations } = require('../../services/metaMarketingEnrollmentDestinations.service');
  let clock = Date.now(), rollout = true, lostReply = false, afterActivate, catalogReads = 0;
  const now = () => new Date(clock);
  const advance = (ms = 130000) => { clock += ms; };
  const sessions = { async verifyNormalReference(ref, options) { assert.equal(ref.userId, ACTOR); assert(options.transaction); } };
  const destinations = createDestinations({ models, enabled: () => rollout, admitted: () => true });
  const scope = require('../../services/metaMarketingOAuthScope.service').createScope({ models, sessions, now });
  const enrollment = createService({ models, sessions, destinations, now, enabled: () => true, workerEnabled: () => true,
    oauth: { async assets(_input, id) { catalogReads++; return { inventory: { ...inventory.get(id), observedAt: clock, expiresAt: clock + 200000 } }; },
      async cancelAfterEnrollment() {} },
    client: { async execute(command) {
      const { operation, requestId, payload } = command, { enrollmentId } = payload;
      commands.push({ operation, enrollmentId, payload });
      let saved = owners.get(enrollmentId);
      if (operation === C.E.OPERATIONS.prepare) {
        assert.deepEqual(Object.keys(payload).sort(), ['assetRefs', 'candidateDigest', 'enrollmentId', 'flowId', 'scopeDigest']);
        const visible = inventory.get(payload.flowId);
        const assets = C.assets(visible.assets.filter(value => payload.assetRefs.includes(value.assetRef)).map(C.E.identity));
        saved = { enrollmentId, flowId: payload.flowId, scopeKey: visible.scopeKey, scopeDigest: payload.scopeDigest,
          candidateDigest: payload.candidateDigest, clinicSetDigest: visible.clinicSetDigest, selectionDigest: C.hash(enrollmentId),
          assets, status: 'prepared', accessBlocked: true, preparedAt: clock, activatedAt: null };
        owners.set(enrollmentId, saved);
      } else if (operation === C.E.OPERATIONS.activate) {
        assert.deepEqual(Object.keys(payload).sort(), ['enrollmentId', 'scopeDigest', 'selectionDigest']);
        assert.equal(saved.status, 'prepared');
        Object.assign(saved, { status: 'active', accessBlocked: false, activatedAt: clock });
        if (lostReply) { lostReply = false; throw Object.assign(Error('FICTITIOUS_ACK_LOST'), { code: 'broker_timeout' }); }
        await afterActivate?.();
      } else if (operation === C.E.OPERATIONS.revoke) {
        Object.assign(saved, { status: 'revoked', accessBlocked: true });
      }
      return { requestId, replayed: false, data: structuredClone(saved ?? { enrollmentId, status: 'not_found', accessBlocked: true }) };
    } },
  });

  async function group(groupId) {
    const clinicIds = [groupId * 10 + 1, groupId * 10 + 2], scopeKey = 'group:' + groupId, flowId = randomUUID();
    await models.GrupoClinica.create({ id_grupo: groupId, nombre_grupo: 'Grupo ficticio' });
    await models.Clinica.bulkCreate(clinicIds.map(id_clinica => ({ id_clinica, nombre_clinica: 'Clínica ficticia', grupoClinicaId: groupId, estado_clinica: true })));
    await models.UsuarioClinica.bulkCreate(clinicIds.map(id_clinica => ({ id_clinica, id_usuario: ACTOR, rol_clinica: 'propietario', estado_invitacion: 'aceptada' })));
    const input = { scopeKey, actorId: ACTOR, sessionRef: randomUUID(), sessionExpiresAt: new Date(clock + 3600000) };
    const slot = { scope_key: scopeKey, connection_ref: Admission.connectionRef(scopeKey), asset_ref: 'meta-enroll:' + scopeKey,
      clinic_ids: JSON.stringify(clinicIds), app_id: APP, scopes: JSON.stringify(SCOPES), redirect_uri: 'https://app.example.invalid/oauth/meta/marketing/callback',
      expires_at: new Date(clock + 86400000), state: 'active' };
    await models.MetaMarketingOAuthSlot.create(slot);
    const fresh = await sql.transaction(transaction => scope.capture(input, transaction));
    const credential = { versionId: flowId, digest: C.hash('QAFixture' + groupId), appId: APP, subjectId: String(99000 + groupId), tokenType: 'USER',
      scopes: SCOPES, expiresAt: clock + 3600000, dataAccessExpiresAt: null, granularScopes: [] };
    await models.MetaMarketingOAuthRequest.create({ ...slot, flow_id: flowId, state_hash: C.hash(flowId), slot_digest: fresh.slotDigest,
      scope_digest: fresh.scopeDigest, actor_user_id: ACTOR, session_ref: input.sessionRef, session_expires_at: input.sessionExpiresAt,
      return_origin: 'https://app.example.invalid', requested_at: now(), expires_at: new Date(clock + 600000), state: 'staged',
      candidate_metadata: JSON.stringify(credential), next_attempt_at: now(), completed_at: now() });
    const assets = [asset('ad_account', groupId * 100 + 1), asset('ad_account', groupId * 100 + 2), asset('facebook_page', groupId * 100 + 3)];
    inventory.set(flowId, { flowId, candidateVersionId: flowId, candidateDigest: credential.digest, scopeKey, scopeDigest: fresh.scopeDigest,
      clinicSetDigest: OAuth.hash(slot.clinic_ids), accessBlocked: true, availableKinds: Discovery.kinds(credential), assets });
    const refs = assets.map(value => value.assetRef);
    const plan = { version: 1, rows: [
      { clinicId: clinicIds[0], assignments: { ad_account: refs[0], facebook_page: refs[2] } },
      { clinicId: clinicIds[1], assignments: { ad_account: refs[1], facebook_page: null } },
    ] };
    return { groupId, clinicIds, input, flowId, refs, plan, reserve: value => enrollment.reserve(input, flowId, refs, value),
      rows: () => models.GroupAssetClinicAssignment.findAll({ where: { grupoClinicaId: groupId }, raw: true }),
      settings: () => models.GrupoClinica.findByPk(groupId, { raw: true }),
      mappings: () => models.ClinicMetaAsset.findAll({ where: { grupoClinicaId: groupId }, raw: true }) };
  }

  const legacy = await group(5);
  assert.equal((await enrollment.overview(legacy.input)).groupDestinationPlanVersion, undefined);
  const old = await legacy.reserve();
  assert.equal(old.destinationPlan, undefined);
  await verifySchemaRollout(sql, report);
  await migration.down(qi);
  await migration.up(qi, DataTypes);
  const columns = await qi.describeTable(TABLE);
  assert.deepEqual(Object.keys(columns), ['enrollment_id', 'plan', 'digest', 'asset_labels']);
  assert.equal(columns.enrollment_id.primaryKey, true);
  assert.equal(columns.asset_labels.allowNull, true);
  assert(Object.entries(columns).filter(([key]) => key !== 'asset_labels').every(([, column]) => column.allowNull === false));
  assert.equal((await enrollment.overview(legacy.input)).groupDestinationPlanVersion, undefined);
  assert.equal((await enrollment.run({ enrollmentId: old.requestId })).advanced, 1);
  const oldPrepared = await enrollment.status(legacy.input, old.requestId);
  assert.equal(oldPrepared.destinationDigest, undefined);
  assert.equal(oldPrepared.pendingAssetLabels, undefined);
  assert.equal((await enrollment.confirm(legacy.input, old.requestId, oldPrepared.selectionDigest)).state, 'activate_pending');
  assert.equal((await enrollment.run({ enrollmentId: old.requestId })).advanced, 1);
  assert.equal((await enrollment.status(legacy.input, old.requestId)).connected, true);
  assert.deepEqual(await legacy.rows(), []);

  const active = await group(6);
  assert.equal((await enrollment.overview(active.input)).groupDestinationPlanVersion, 1);
  await assert.rejects(active.reserve(), { code: 'meta_enrollment_invalid', httpStatus: 400 });
  await assert.rejects(active.reserve({ version: 1, rows: [active.plan.rows[0]] }), { code: 'meta_enrollment_invalid', httpStatus: 400 });
  const beforeReserve = catalogReads;
  const first = await active.reserve(active.plan);
  assert.equal(catalogReads, beforeReserve + 1);
  assert.deepEqual(first.destinationPlan, active.plan);
  const expectedLabels = active.refs.map(assetRef => ({ assetRef, name: 'Clínica ficticia nº ' + assetRef.split(':')[1] }));
  assert.deepEqual(first.pendingAssetLabels, expectedLabels);
  assert(first.assets.every(asset => Object.keys(asset).sort().join(',') === 'assetRef,id,kind,parentPageId'));
  assert.equal((await active.reserve({ ...active.plan, rows: [...active.plan.rows].reverse() })).destinationDigest, first.destinationDigest);
  const changed = structuredClone(active.plan);
  changed.rows[0].assignments.facebook_page = null;
  await assert.rejects(active.reserve(changed), { code: 'meta_enrollment_selection_fixed' });
  assert.deepEqual(await active.rows(), []);
  assert.deepEqual(await active.mappings(), []);
  assert.equal((await active.settings()).meta_ad_account_assignment_updated_at, null);
  await assert.rejects(migration.down(qi), /Preserve Meta enrollment destination history/);

  assert.equal((await enrollment.run({ enrollmentId: first.requestId })).advanced, 1);
  const prepared = await enrollment.status(active.input, first.requestId);
  assert.equal(prepared.state, 'prepared');
  const priorReload = catalogReads;
  assert.deepEqual((await enrollment.overview(active.input)).selection.pendingAssetLabels, expectedLabels);
  const labelsRow = await models.MetaMarketingEnrollmentDestinationPlan.findByPk(first.requestId);
  assert.deepEqual(labelsRow.asset_labels, expectedLabels);
  await labelsRow.update({ asset_labels: [
    { assetRef: 'meta-facebook_page:' + active.refs[0].split(':')[1], name: 'Wrong type with same numeric ID' },
    { assetRef: 'meta-instagram_business:999', name: 'Outside this selection' },
    { assetRef: active.refs[0], name: 'Contains a control\u007f' },
    { assetRef: active.refs[1], name: 'act_' + active.refs[1].split(':')[1] },
    expectedLabels[2],
  ] });
  const relabeled = (await enrollment.overview(active.input)).selection;
  assert.deepEqual(relabeled.pendingAssetLabels, [expectedLabels[2]]);
  assert.equal(relabeled.destinationDigest, prepared.destinationDigest);
  assert.equal(relabeled.selectionDigest, prepared.selectionDigest);
  assert.equal(catalogReads, priorReload);
  await labelsRow.update({ asset_labels: expectedLabels });
  report.checks.push('Pending names round-trip from the already validated catalog, no extra catalog call on reserve or reload, and wrong ref, wrong kind, ID-only and control-character labels cannot appear. Names are outside both canonical digests.');
  await assert.rejects(enrollment.confirm(active.input, first.requestId, prepared.selectionDigest), { code: 'meta_enrollment_scope_changed' });
  await assert.rejects(enrollment.confirm(active.input, first.requestId, prepared.selectionDigest, C.hash('wrong')), { code: 'meta_enrollment_scope_changed' });
  await assert.rejects(enrollment.confirm({ ...active.input, sessionRef: randomUUID() }, first.requestId, prepared.selectionDigest,
    prepared.destinationDigest), { code: 'meta_enrollment_scope_forbidden', httpStatus: 403 });
  const membership = { where: { id_usuario: ACTOR, id_clinica: active.clinicIds[1] } };
  await models.UsuarioClinica.update({ rol_clinica: 'personaldeclinica' }, membership);
  await assert.rejects(enrollment.confirm(active.input, first.requestId, prepared.selectionDigest,
    prepared.destinationDigest), { code: 'meta_oauth_scope_forbidden', httpStatus: 403 });
  await models.UsuarioClinica.update({ rol_clinica: 'propietario' }, membership);
  rollout = false; // An already stored selection can still be completed during staged rollback.
  const resumed = await enrollment.overview(active.input);
  assert.equal(resumed.groupDestinationPlanVersion, 1);
  assert.deepEqual(resumed.selection.destinationPlan, active.plan);
  await enrollment.confirm(active.input, first.requestId, prepared.selectionDigest, prepared.destinationDigest);
  lostReply = true;
  assert.equal((await enrollment.run({ enrollmentId: first.requestId })).failed, 1);
  assert.deepEqual(await active.rows(), []);
  assert.deepEqual(await active.mappings(), []);
  advance();
  models.PlatformAuditEvent.addHook('beforeCreate', 'abort-activation', row => {
    if (JSON.parse(row.body).reason === 'meta_enrollment_activated') throw new Error('QA_ACTIVATION_AUDIT_ROLLBACK');
  });
  assert.equal((await enrollment.run({ enrollmentId: first.requestId })).failed, 1);
  models.PlatformAuditEvent.removeHook('beforeCreate', 'abort-activation');
  assert.deepEqual(await active.rows(), []);
  assert.deepEqual(await active.mappings(), []);
  assert.equal((await active.settings()).facebook_assignment_updated_at, null);
  advance();
  assert.equal((await enrollment.run({ enrollmentId: first.requestId })).advanced, 1);
  assert.equal(commands.filter(item => item.enrollmentId === first.requestId && item.operation === C.E.OPERATIONS.activate).length, 1);
  const actual = await active.rows(), mappings = await active.mappings(), policy = await active.settings();
  const map = actual.map(row => [row.clinicaId, row.assetType, mappings.find(mapping => mapping.id === row.assetId).metaAssetId]);
  assert.deepEqual(map.sort(), [
    [active.clinicIds[0], 'meta.ad_account', String(active.groupId * 100 + 1)],
    [active.clinicIds[0], 'meta.facebook_page', String(active.groupId * 100 + 3)],
    [active.clinicIds[1], 'meta.ad_account', String(active.groupId * 100 + 2)],
  ]);
  assert(policy.meta_ad_account_assignment_updated_at && policy.facebook_assignment_updated_at);
  assert.equal(policy.facebook_assignment_mode, 'clinic');
  assert.equal(policy.facebook_primary_asset_id, null);
  assert.equal(policy.instagram_assignment_updated_at, null);
  const completed = await enrollment.status(active.input, first.requestId);
  assert.equal(completed.connected, true);
  assert.equal(completed.pendingAssetLabels, undefined);
  const { listScopedMetaAssets } = require('../../services/effectiveMarketingAssets.service');
  const readClinic = clinicId => listScopedMetaAssets({ clinicId, groupId: active.groupId });
  const [left, right] = await Promise.all(active.clinicIds.map(readClinic));
  assert.deepEqual(left.ad_accounts.map(asset => asset.ad_account_id), ['act_' + (active.groupId * 100 + 1)]);
  assert.deepEqual(right.ad_accounts.map(asset => asset.ad_account_id), ['act_' + (active.groupId * 100 + 2)]);
  assert.deepEqual(left.facebook_pages.map(asset => asset.page_id), [String(active.groupId * 100 + 3)]);
  assert.deepEqual(right.facebook_pages, []);
  const page = actual.find(row => row.assetType === 'meta.facebook_page');
  await models.GroupAssetClinicAssignment.update({ clinicaId: active.clinicIds[1] }, { where: { id: page.id } });
  assert.equal((await enrollment.status(active.input, first.requestId)).connected, true);
  assert.deepEqual((await readClinic(active.clinicIds[0])).facebook_pages, []);
  assert.deepEqual((await readClinic(active.clinicIds[1])).facebook_pages.map(asset => asset.page_id), [String(active.groupId * 100 + 3)]);
  report.checks.push('MySQL migration falls back to old pending admissions before/after schema rollout; staged group destination plan survives resume, same-flow replay, acknowledgement loss and a rolled-back activation; concrete shares and explicit empty marker committed once.');
  report.checks.push('Original session and full-scope clinic roles required; real effective reader respects both clinic destinations and later valid edits without closing the group grant.');

  rollout = true;
  const cancelled = await group(7), saved = await cancelled.reserve(cancelled.plan);
  assert.equal((await enrollment.run({ enrollmentId: saved.requestId })).advanced, 1);
  await enrollment.cancel(cancelled.input, saved.requestId);
  assert.equal((await enrollment.run({ enrollmentId: saved.requestId })).advanced, 1);
  assert.equal((await enrollment.status(cancelled.input, saved.requestId)).state, 'revoked');
  assert.deepEqual(await cancelled.rows(), []);
  assert.deepEqual(await cancelled.mappings(), []);

  const overlapping = await group(8);
  await models.GrupoClinica.update({ facebook_assignment_updated_at: now() }, { where: { id_grupo: overlapping.groupId } });
  await assert.rejects(overlapping.reserve(overlapping.plan), { code: 'meta_enrollment_assignment_review' });
  assert.deepEqual(await overlapping.mappings(), []);

  const late = await group(9), latePending = await late.reserve(late.plan);
  assert.equal((await enrollment.run({ enrollmentId: latePending.requestId })).advanced, 1);
  const latePrepared = await enrollment.status(late.input, latePending.requestId);
  await enrollment.confirm(late.input, latePending.requestId, latePrepared.selectionDigest, latePrepared.destinationDigest);
  const independentChange = new Date(Math.floor(clock / 1000) * 1000);
  afterActivate = () => models.GrupoClinica.update({ facebook_assignment_updated_at: independentChange }, { where: { id_grupo: late.groupId } });
  const conflicted = await enrollment.run({ enrollmentId: latePending.requestId });
  assert.equal(conflicted.cancelled, 1);
  afterActivate = null;
  assert.equal((await enrollment.status(late.input, latePending.requestId)).state, 'revoke_pending');
  assert.equal((await enrollment.run({ enrollmentId: latePending.requestId })).advanced, 1);
  assert.equal((await enrollment.status(late.input, latePending.requestId)).state, 'revoked');
  assert.deepEqual(await late.rows(), []);
  assert.deepEqual(await late.mappings(), []);
  assert.equal(+(await late.settings()).facebook_assignment_updated_at, +independentChange);
  report.checks.push('Cancellation preserves the journal but writes no destinations or assets. Prior explicit group policy closes admission without replacing it.');
  report.checks.push('A changed group policy after Owner activation rolls back local writes and queues confirmed revocation; the independent change remains.');
}).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });

'use strict';

// Own --skip-networking MySQL, fictional leads and real InnoDB foreign keys.
// No host DB, provider, queues, WhatsApp or normal job runner is available.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DataTypes: D, Sequelize } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const define = (name, fields, options = {}) => sql.define(name, fields, { timestamps: false, ...options });
  models.Sequelize = Sequelize;
  models.GrupoClinica = define('GrupoClinica', { id_grupo: { type: D.INTEGER, primaryKey: true } }, { tableName: 'GruposClinicas' });
  models.Clinica = define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true },
    grupoClinicaId: { type: D.INTEGER, references: { model: 'GruposClinicas', key: 'id_grupo' } }, estado_clinica: D.BOOLEAN }, { tableName: 'Clinicas' });
  models.ClinicMetaAsset = define('ClinicMetaAsset', { id: { type: D.INTEGER, primaryKey: true }, assetType: D.STRING,
    metaAssetId: D.STRING, metaConnectionId: D.INTEGER, assignmentScope: D.STRING, clinicaId: D.INTEGER,
    grupoClinicaId: D.INTEGER, isActive: D.BOOLEAN });
  models.CampaignWorkspaceSetting = define('CampaignWorkspaceSetting', { id: { type: D.STRING, primaryKey: true },
    scope_type: D.STRING, scope_id: D.INTEGER, accounts: D.JSON });
  models.ExternalCampaignAssignment = define('ExternalCampaignAssignment', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
    provider: D.STRING, customer_id: D.STRING, campaign_id: D.STRING, clinica_id: D.INTEGER, status: D.STRING });
  models.JobRequest = define('JobRequest', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
    type: D.STRING, status: D.STRING, payload: D.JSON }, { tableName: 'JobRequests' });
  models.LeadIntake = define('LeadIntake', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
    clinica_id: { type: D.INTEGER, references: { model: 'Clinicas', key: 'id_clinica' } }, grupo_clinica_id: D.INTEGER,
    event_id: { type: D.STRING, unique: true }, external_source: D.STRING(64), external_id: D.STRING(128),
    source: D.STRING, channel: D.STRING, source_detail: D.STRING, utm_source: D.STRING, utm_medium: D.STRING,
    clinic_match_source: D.STRING, clinic_match_value: D.STRING, status_lead: D.STRING, nombre: D.STRING, email: D.STRING,
    telefono: D.STRING, email_hash: D.STRING, phone_hash: D.STRING, archived_at: D.DATE, asignado_a: D.INTEGER, notas: D.TEXT,
  }, { tableName: 'LeadIntakes', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['external_source', 'external_id'] }] });
  models.LeadAttributionAudit = require('../../../models/leadattributionaudit')(sql, D);
  models.FormSubmissionEvent = require('../../../models/formsubmissionevent')(sql, D);
  models.LeadAttributionAudit.associate(models);
  models.FormSubmissionEvent.associate(models);
  await sql.sync();
  await models.GrupoClinica.create({ id_grupo: 9 });
  await models.Clinica.bulkCreate([71, 72].map(id => ({ id_clinica: id, grupoClinicaId: 9, estado_clinica: true })));
  await models.ClinicMetaAsset.bulkCreate([
    { id: 10, assetType: 'facebook_page', metaAssetId: '401', metaConnectionId: 1,
      assignmentScope: 'group', clinicaId: null, grupoClinicaId: 9, isActive: true },
    { id: 11, assetType: 'ad_account', metaAssetId: 'act_301', metaConnectionId: 1,
      assignmentScope: 'group', clinicaId: null, grupoClinicaId: 9, isActive: true },
  ]);
  await models.CampaignWorkspaceSetting.create({ id: 'fictional-scope', scope_type: 'group', scope_id: 9,
    accounts: [{ provider: 'meta_ads', account_id: '301', include_future: true, campaign_ids: [] }] });

  const { persistMetaLead } = require('../../services/metaLeadReception.service');
  const { storeMetaLeadFormResponse } = require('../../services/metaLeadFormResponse.service');
  const ioContext = new AsyncLocalStorage(), transaction = sql.transaction.bind(sql);
  sql.transaction = (options, callback) => {
    if (typeof options === 'function') return transaction(tx => ioContext.run({ sqlTransaction: true }, () => options(tx)));
    return callback ? transaction(options, tx => ioContext.run({ sqlTransaction: true }, () => callback(tx))) : transaction(options);
  };
  const event = id => ({ lead_id: id, page_id: '401', form_id: '501', ad_id: '701' });
  const response = () => ({ version: 2, formId: '501', name: 'Formulario ficticio', fields: [
    { key: 'nombre', label: 'Nombre', type: 'FULL_NAME', values: ['Contacto ficticio'] },
    { key: 'opciones', label: 'Opciones de prueba', type: 'CUSTOM', values: ['Uno', 'Dos'] },
    { key: 'vacio', label: 'Pregunta sin respuesta', type: 'CUSTOM', values: [] },
  ] });
  const authority = { async assert({ transaction } = {}) {
    const rows = await models.ClinicMetaAsset.findAll({ where: { isActive: true }, raw: true, transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    assert.equal(rows.length, 2);
    return { page: { mappingId: 10, id: '401', connectionId: 1, clinicIds: [71, 72] },
      account: { mappingId: 11, id: '301', connectionId: 1, clinicIds: [71, 72] } };
  } };
  const retrieved = (id, extra = {}) => ({
    lead: { id, form_id: '501', ad_id: '701', campaign_id: '601', created_time: '2030-01-01T12:00:00Z',
      is_organic: false, field_data: [{ name: 'full_name', values: ['Contacto ficticio'] }, { name: 'phone_number', values: ['34600000000'] }] },
    clinic: { id_clinica: 71, grupoClinicaId: 9 },
    identity: { account_id: '301', campaign_id: '601', adset_id: '651', ad_id: '701' },
    pageAssetId: 10, accountAssetId: 11, connectionId: 1, recipientClinicId: 71, authority,
    responseVersion: 2, formResponse: response(), ...extra,
  });
  let leadCreates = 0, leadUpdates = 0;
  models.LeadIntake.addHook('afterCreate', 'count-fixture-creation', () => { leadCreates++; });
  models.LeadIntake.addHook('beforeUpdate', 'count-fixture-update', () => { leadUpdates++; });

  const failed = '8001';
  models.FormSubmissionEvent.addHook('beforeCreate', 'reject-fse', () => { throw Error('FICTITIOUS_FSE_FAILURE'); });
  await assert.rejects(persistMetaLead({ models, event: event(failed), retrieved: retrieved(failed) }), /FICTITIOUS_FSE_FAILURE/);
  assert.equal(await models.LeadIntake.count(), 0);
  assert.equal(await models.LeadAttributionAudit.count(), 0);
  assert.equal(await models.FormSubmissionEvent.count(), 0);
  models.FormSubmissionEvent.removeHook('beforeCreate', 'reject-fse');
  report.checks.push('FSE failure rolls back the actual native consumer LeadIntake and mandatory attribution audit in one InnoDB transaction');

  const firstId = '8002';
  const delivered = await Promise.all([1, 2, 3].map(() => persistMetaLead({ models, event: event(firstId), retrieved: retrieved(firstId) })));
  assert.equal(delivered.filter(item => !item.duplicate).length, 1);
  assert.equal(await models.LeadIntake.count(), 1);
  assert.equal(await models.LeadAttributionAudit.count(), 1);
  assert.equal(await models.FormSubmissionEvent.count(), 1);
  const saved = await models.FormSubmissionEvent.findOne({ raw: true });
  assert.equal(saved.page_url, null);
  assert.equal(saved.source_detail, 'meta_leadgen:' + firstId);
  assert.deepEqual(saved.fields_json.fields[1].values, ['Uno', 'Dos']);
  assert.deepEqual(saved.fields_json.fields[2].values, []);
  assert.equal(saved.email_normalized, null);
  assert.equal(saved.phone_normalized, null);
  const audit = await models.LeadAttributionAudit.findOne({ raw: true });
  assert.doesNotMatch(JSON.stringify(audit), /Contacto ficticio|Opciones de prueba|Uno|Dos/);
  report.checks.push('Three concurrent native deliveries commit exactly one lead/audit/private FSE; MySQL JSON key ordering is idempotent and no answers enter reporting audit');

  const legacyId = '8003';
  const legacy = await persistMetaLead({ models, event: event(legacyId), retrieved: retrieved(legacyId, { responseVersion: 1, formResponse: null }) });
  await legacy.lead.update({ status_lead: 'contactado', asignado_a: 42, notas: 'Nota ficticia conservada' });
  const beforeLead = JSON.stringify(await models.LeadIntake.findByPk(legacy.lead.id, { raw: true }));
  const beforeAudits = JSON.stringify(await models.LeadAttributionAudit.findAll({ order: [['id', 'ASC']], raw: true }));
  const beforeCreates = leadCreates, beforeUpdates = leadUpdates;
  const parent = await sql.transaction({ isolationLevel: 'REPEATABLE READ' });
  let otherHasParent = false;
  try {
    const lockedLead = await models.LeadIntake.findByPk(legacy.lead.id, { transaction: parent, lock: parent.LOCK.UPDATE });
    const first = await storeMetaLeadFormResponse({ models, event: event(legacyId), lead: lockedLead,
      clinic: retrieved(legacyId).clinic, formResponse: response(), providerCreatedAt: retrieved(legacyId).lead.created_time, transaction: parent });
    assert.equal(first.stored, true);
    const duplicate = sql.transaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const locked = await models.LeadIntake.findByPk(legacy.lead.id, { transaction, lock: transaction.LOCK.UPDATE });
      otherHasParent = true;
      return storeMetaLeadFormResponse({ models, event: event(legacyId), lead: locked, clinic: retrieved(legacyId).clinic,
        formResponse: response(), providerCreatedAt: retrieved(legacyId).lead.created_time, transaction });
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(otherHasParent, false, 'backfill must serialize on the actual parent row');
    await parent.commit();
    assert.equal((await duplicate).stored, false);
  } finally { if (!parent.finished) await parent.rollback(); }
  assert.equal(await models.FormSubmissionEvent.count(), 2);
  assert.equal(JSON.stringify(await models.LeadIntake.findByPk(legacy.lead.id, { raw: true })), beforeLead);
  assert.equal(JSON.stringify(await models.LeadAttributionAudit.findAll({ order: [['id', 'ASC']], raw: true })), beforeAudits);
  assert.equal(leadCreates, beforeCreates);
  assert.equal(leadUpdates, beforeUpdates);
  report.checks.push('Two backfill transactions serialize on the existing Lead row and create one FSE without changing lead state/contact/owner/notes/timestamps or audit, and without invoking Lead create/update hooks');

  const changed = response(); changed.fields[1].values = ['Changed'];
  await assert.rejects(sql.transaction(async transaction => {
    const locked = await models.LeadIntake.findByPk(legacy.lead.id, { transaction, lock: transaction.LOCK.UPDATE });
    return storeMetaLeadFormResponse({ models, event: event(legacyId), lead: locked, clinic: retrieved(legacyId).clinic,
      formResponse: changed, providerCreatedAt: retrieved(legacyId).lead.created_time, transaction });
  }), error => error.code === 'meta_lead_form_conflict');
  await assert.rejects(sql.transaction(async transaction => {
    const locked = await models.LeadIntake.findByPk(legacy.lead.id, { transaction, lock: transaction.LOCK.UPDATE });
    return storeMetaLeadFormResponse({ models, event: event(legacyId), lead: locked, clinic: { id_clinica: 72, grupoClinicaId: 9 },
      formResponse: response(), providerCreatedAt: retrieved(legacyId).lead.created_time, transaction });
  }), error => error.code === 'meta_lead_form_identity_mismatch');
  assert.equal(await models.FormSubmissionEvent.count(), 2);
  report.checks.push('A changed response or another-clinic backfill is rejected without overwriting the committed private response');

  const recoverId = '8004';
  const recover = await persistMetaLead({ models, event: event(recoverId), retrieved: retrieved(recoverId, { responseVersion: 1, formResponse: null }) });
  await models.JobRequest.create({ type: 'campaign_meta_lead_receive', status: 'completed', payload: {
    ...event(recoverId), receipt_ref: 'a0000000-0000-4000-8000-000000000001', page_asset_id: 10, account_asset_id: 11,
    __runtime_namespace: 'staging',
  } });
  let providerReads = 0;
  const reader = {
    async preparePair(pageId, accountId) { assert.equal(pageId, 10); assert.equal(accountId, 11); return {}; },
    async read(_pair, operation, payload) {
      assert.notEqual(ioContext.getStore()?.sqlTransaction, true, 'provider I/O must finish outside its SQL transaction');
      assert.equal(operation, 'receiptRead'); assert.equal(payload.responseVersion, 2);
      providerReads++;
      return { event: event(recoverId), lead: retrieved(recoverId).lead, identity: retrieved(recoverId).identity,
        form_response: response(), recipientClinicId: 71 };
    },
    async assertPair(_pair, options) { return authority.assert(options); },
  };
  const enrichment = require('../../services/metaLeadFormEnrichment.service').createMetaLeadFormEnrichment({ models, reader, runtime: 'staging' });
  const dry = await enrichment.run({ leadIds: [recover.lead.id], clinicIds: [71] });
  assert.equal(dry.results[0].status, 'ready', JSON.stringify(dry));
  assert.equal(providerReads, 0);
  const recoverBefore = JSON.stringify(await models.LeadIntake.findByPk(recover.lead.id, { raw: true }));
  const auditsBefore = JSON.stringify(await models.LeadAttributionAudit.findAll({ order: [['id', 'ASC']], raw: true }));
  const createsBefore = leadCreates, updatesBefore = leadUpdates;
  const applied = await Promise.all([1, 2].map(() => enrichment.run({ leadIds: [recover.lead.id], clinicIds: [71], apply: true })));
  const statuses = applied.map(result => result.results[0].status).sort();
  assert.deepEqual(statuses, ['already_enriched', 'enriched'], JSON.stringify(applied));
  assert.equal(await models.FormSubmissionEvent.count(), 3);
  assert.equal(JSON.stringify(await models.LeadIntake.findByPk(recover.lead.id, { raw: true })), recoverBefore);
  assert.equal(JSON.stringify(await models.LeadAttributionAudit.findAll({ order: [['id', 'ASC']], raw: true })), auditsBefore);
  assert.equal(leadCreates, createsBefore); assert.equal(leadUpdates, updatesBefore);
  assert.equal(await models.JobRequest.count(), 1);
  const afterReads = providerReads;
  assert.equal((await enrichment.run({ leadIds: [recover.lead.id], clinicIds: [71], apply: true })).results[0].status, 'already_enriched');
  assert.equal(providerReads, afterReads);
  report.checks.push('Actual enrichment service dry-run makes zero provider reads; concurrent apply uses stored receipt and verified audit, creates one private FSE, preserves Lead/Audit bytes and JobRequest count, and later apply skips provider I/O');
  report.closedProviderAdapterReads = providerReads;
  const [constraints] = await sql.query("SELECT COUNT(*) count FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()");
  assert.ok(Number(constraints[0].count) >= 4);
  report.foreignKeys = Number(constraints[0].count);
  report.externalCalls = 0;
  report.scope = 'persistence and parent-lock integration only; provider/receipt authority is a closed fictional SQL fixture, not live broker acceptance';
  report.pool = { inUse: sql.connectionManager.pool.using, waiting: sql.connectionManager.pool.waiting };
  assert.equal(report.pool.inUse, 0);
  assert.equal(report.pool.waiting, 0);
}).catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });

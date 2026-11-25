'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { campaignResponsibilitySql, createLeadCampaignResponsibilityService } = require('../../services/leadCampaignResponsibility.service');
const { createLeadPatientAttentionService, KEY } = require('../../services/leadPatientAttention.service');
const { temporaryQuickChatEligibilitySql } = require('../../lib/temporary-quickchat-focus');
const { nativeMetaProof } = require('../../services/metaLeadAttributionView.service');
const { resolveLeadContactMethod } = require('../../lib/lead-attribution-view');

const H = text => crypto.createHash('sha256').update(text).digest('hex');

test('independent campaign responsibility: persisted native proofs, exact clinic and list/attention SQL parity', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Pacientes', timestamps: false });
  for (const file of ['usuario', 'campana', 'leadintake', 'leadattributionaudit', 'leadcontactattempt', 'citapaciente',
    'conversation', 'message', 'patientoperationalevent', 'PatientDirectionSetting', 'PatientDirectionAssignment',
    'externalcampaigninventory', 'externalcampaignassignment', 'clinicgoogleadsaccount', 'googleadsadinventory',
    'marketingpatientlist']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = 'campaign_responsibility_event_' + i; });
  await sql.sync();
  await sql.models.Clinica.bulkCreate([66, 72].map(id_clinica => ({ id_clinica, grupoClinicaId: 48 })));
  await sql.models.Paciente.create({ id_paciente: 100 });
  await db.Usuario.create({ id_usuario: 44, nombre: 'Synthetic director', email_usuario: 'maria.gonzalez@modmarketing.net' });
  const localCampaign = await db.Campana.create({ clinica_id: 72, nombre: 'Synthetic clinic72 campaign' });
  const foreignCampaign = await db.Campana.create({ clinica_id: 66, nombre: 'Synthetic foreign campaign' });
  const localGoogleAccount = await db.ClinicGoogleAdsAccount.create({ clinicaId: 72, assignmentScope: 'clinic',
    googleConnectionId: 1, customerId: '1234567890', isActive: true });
  const groupGoogleAccount = await db.ClinicGoogleAdsAccount.create({ grupoClinicaId: 48, assignmentScope: 'group',
    googleConnectionId: 1, customerId: '2222222222', isActive: true });
  const inactiveGoogleAccount = await db.ClinicGoogleAdsAccount.create({ clinicaId: 72, assignmentScope: 'clinic',
    googleConnectionId: 1, customerId: '3333333333', isActive: false });
  const foreignGoogleAccount = await db.ClinicGoogleAdsAccount.create({ grupoClinicaId: 99, assignmentScope: 'group',
    googleConnectionId: 1, customerId: '4444444444', isActive: true });
  const legacyGoogle = async (account, campaignId, clinics, { inventory = true } = {}) => {
    let row;
    if (inventory) {
      row = await db.ExternalCampaignInventory.create({ provider: 'google_ads', customer_id: account.customerId,
        campaign_id: campaignId, source: 'provider_sync' });
      await db.GoogleAdsAdInventory.create({ clinicGoogleAdsAccountId: account.id, customerId: account.customerId,
        campaignId, adGroupId: campaignId + '1', adId: campaignId + '2', present: true, observedAt: new Date() });
    }
    for (const clinic of clinics) await db.ExternalCampaignAssignment.create({ inventory_id: row?.id || null,
      provider: 'google_ads', customer_id: account.customerId, campaign_id: campaignId, clinica_id: clinic, status: 'active' });
  };
  await legacyGoogle(localGoogleAccount, '930', [72]);
  await legacyGoogle(localGoogleAccount, '931', [66]);
  await legacyGoogle(localGoogleAccount, '932', [72, 66]);
  await legacyGoogle(inactiveGoogleAccount, '933', [72]);
  await legacyGoogle(localGoogleAccount, '934', [72], { inventory: false });
  await legacyGoogle(groupGoogleAccount, '935', [72]);
  await legacyGoogle(foreignGoogleAccount, '936', [72]);
  const cases = [], allRows = [];
  const lead = async (label, overrides = {}, expected = false) => {
    const row = await db.LeadIntake.create({ clinica_id: 72, channel: 'paid', status_lead: 'nuevo',
      created_at: new Date('2026-11-01T10:00:00Z'), ...overrides }, { hooks: false });
    cases.push({ label, row, expected }); allRows.push(row.toJSON()); return row;
  };
  const audit = (row, steps, raw = {}) => db.LeadAttributionAudit.create({ lead_intake_id: row.id,
    raw_payload: raw, attribution_steps: steps });
  const metaIdentity = (overrides = {}) => ({ version: 1, verified_by: 'meta_graph', provider: 'meta_ads',
    clinic_id: 72, account_id: '700', campaign_id: '710', adset_id: '720', ad_id: '730', page_id: '601', form_id: '602', ...overrides });
  const nativeMeta = async (label, changes = {}, expected = true) => {
    const row = await lead(label, { source: 'meta_ads', external_source: 'meta_leadgen',
      external_id: String(500 + cases.length), source_detail: 'leadgen_form:602', ...changes.lead }, expected);
    const identity = metaIdentity(changes.identity);
    const raw = { provider: 'meta_leadgen', lead_id: row.external_id, form_id: '602', ...changes.raw };
    const steps = { meta_page_id: '601', advertising_identity: identity, ...changes.steps };
    await audit(row, steps, raw);
    return { row, identity, raw, steps };
  };
  const paid = await nativeMeta('native paid Meta without legacy campaign FK');
  assert.equal(paid.row.campana_id == null, true);
  assert.ok(nativeMetaProof(paid.row.toJSON(), [{ identity: paid.identity, native_provider: 'meta_leadgen',
    native_lead_id: paid.row.external_id, native_form_id: '602', native_page_id: '601' }]));
  await audit(paid.row, { type: 'lead_patient_context', lead_patient_context: { version: 1, relationship: 'new_contact' } });
  await audit(paid.row, paid.steps, paid.raw);
  await nativeMeta('organic form cannot acquire campaign responsibility', { lead: { source: null, channel: 'organic' }, steps: { advertising_identity: null } }, false);
  await nativeMeta('organic wins even over a stale valid paid receipt', { lead: { channel: 'organic' } }, false);
  await nativeMeta('native receipt belongs to another clinic', { identity: { clinic_id: 66 } }, false);
  await nativeMeta('native receipt belongs to another provider lead', { raw: { lead_id: '999' } }, false);
  await nativeMeta('native receipt belongs to another form', { raw: { form_id: '999' } }, false);
  await nativeMeta('native receipt is not server verified', { identity: { verified_by: 'browser' } }, false);
  await nativeMeta('native Meta mixed with Google identifiers fails closed', { lead: { google_ads_campaign_id: '123' } }, false);
  await nativeMeta('empty legacy Google fields do not conflict with verified native Meta', { lead: {
    gclid: '', gbraid: '', wbraid: '', google_ads_customer_id: '', google_ads_campaign_id: '', ttclid: '' } }, true);
  const conflict = await nativeMeta('conflicting native campaign receipts', {}, false);
  await audit(conflict.row, { ...conflict.steps, advertising_identity: metaIdentity({ campaign_id: '711' }) }, conflict.raw);
  await lead('click and UTM labels without verified campaign', { source: 'web', gclid: 'click-only', fbclid: 'click-only', utm_campaign: 'Synthetic unverified' }, false);
  await lead('unverified legacy Google identifiers are not a campaign link', { source: 'google_ads',
    google_ads_customer_id: '1234567890', google_ads_campaign_id: '810' }, false);
  await lead('legacy campaign exactly assigned to clinic', { source: 'web', campana_id: localCampaign.id }, true);
  await lead('legacy exact clinic campaign with NULL source has no requested phone channel', { source: null,
    source_detail: null, campana_id: localCampaign.id }, true);
  await lead('foreign legacy campaign cannot claim request', { source: 'web', campana_id: foreignCampaign.id }, false);
  await lead('organic legacy reference is still clinic responsibility', { source: 'web', channel: 'organic', campana_id: localCampaign.id }, false);
  for (const [label, customer, campaign, expected] of [
    ['verified legacy Google account/inventory/unique clinic assignment', '1234567890', '930', true],
    ['legacy Google campaign belongs to another clinic', '1234567890', '931', false],
    ['legacy Google clinic assignment is ambiguous', '1234567890', '932', false],
    ['legacy Google account mapping is inactive', '3333333333', '933', false],
    ['legacy Google has no provider inventory', '1234567890', '934', false],
    ['legacy Google group mapping includes this clinic', '2222222222', '935', true],
    ['legacy Google account mapping belongs to another group', '4444444444', '936', false],
  ]) await lead(label, { source: 'google_ads', google_ads_customer_id: customer, google_ads_campaign_id: campaign }, expected);
  for (const [source, detail] of [['web', 'tel_modal'], ['web', 'tel_modal_call'], ['web', 'web_phone'],
    ['web', 'phone_modal'], ['web', ' TEL_MODAL '], ['call_click', null], ['call_click', 'chat'],
    ['call_click', 'form_submission'], ['call_click', 'whatsapp'], ['call_click', 'chat_form'], ['web', 'web_phone_extra']]) {
    const method = resolveLeadContactMethod({ source, source_detail: detail });
    await lead('canonical requested channel ' + source + '/' + detail + ' resolves ' + method,
      { source, source_detail: detail, campana_id: localCampaign.id }, !['web_phone', 'phone'].includes(method));
  }
  const web = await lead('verified web campaign without a specific ad', { source: 'web' }, true);
  const webIdentity = { version: 2, verified_by: 'workspace_web_inventory', provider: 'meta_ads', clinic_id: 72,
    account_id: '700', campaign_id: '710', intake_config_id: 1, web_fingerprint: H('web'), campaign_binding: H('binding') };
  await audit(web, { advertising_identity: webIdentity });
  const phoneWeb = await lead('verified paid web campaign requesting reception phone', { source: 'web', source_detail: 'tel_modal_call' }, false);
  await audit(phoneWeb, { advertising_identity: webIdentity });
  const webConflict = await lead('conflicting verified web campaigns', { source: 'web' }, false);
  await audit(webConflict, { advertising_identity: webIdentity });
  await audit(webConflict, { advertising_identity: { ...webIdentity, campaign_id: '711' } });
  const googleNativeId = 'synthetic-native-google-lead';
  const google = await lead('native Google proof tolerates unrelated context audit', { source: 'google_ads',
    external_source: 'google_lead_form', external_id: H(googleNativeId), source_detail: 'leadgen_form:802',
    google_ads_customer_id: '1234567890', google_ads_campaign_id: '810' }, true);
  await audit(google, { advertising_identity: { version: 1, verified_by: 'google_ads_api', provider: 'google_ads',
    clinic_id: 72, account_id: '1234567890', campaign_id: '810', form_id: '802' } }, { lead_id: googleNativeId });
  await audit(google, { type: 'lead_patient_context', lead_patient_context: { version: 1, relationship: 'new_contact' } });
  const massCampaign = (medium, scope, criteria = {}) => db.MarketingPatientList.create({
    name: 'Envío ficticio', objective_id: 'mass_sends', ...scope,
    criteria: { record_kind: 'campaign', channels: [medium], template_commercial: true,
      capture_whatsapp_info_leads: medium === 'whatsapp', ...criteria },
  });
  const mailing = await massCampaign('email', { scope_type: 'clinic', clinica_id: 72 });
  const whatsapp = await massCampaign('whatsapp', { scope_type: 'group', grupo_clinica_id: 48, clinic_ids: [66, 72] });
  const otherClinic = await massCampaign('email', { scope_type: 'clinic', clinica_id: 66 });
  const review = await massCampaign('whatsapp', { scope_type: 'clinic', clinica_id: 72 }, { review_request: true });
  const massLead = async (label, campaign, medium, expected, { wrongHash = false, missingProof = false } = {}) => {
    const phone = '346000000' + String(cases.length).padStart(2, '0');
    const row = await lead(label, {
      external_source: medium === 'email' ? 'marketing_email_whatsapp' : 'bulk_whatsapp_reply',
      utm_medium: medium, channel: 'unknown', source: 'whatsapp', telefono: phone,
      grupo_clinica_id: 48, external_id: wrongHash ? H('wrong proof') : H(JSON.stringify([72, campaign.id, phone])),
    }, expected);
    if (!missingProof) await audit(row, {
      [medium === 'email' ? 'email_bulk_send' : 'whatsapp_bulk_send']: { campaign_id: campaign.id },
    }, { message_id: cases.length });
    return row;
  };
  const existingMailingLead = await massLead('mailing reply with exact local campaign receipt', mailing, 'email', true);
  await massLead('WhatsApp campaign reply with exact group campaign receipt', whatsapp, 'whatsapp', true);
  await massLead('mailing campaign belongs to another clinic', otherClinic, 'email', false);
  await massLead('mailing origin without verified audit', mailing, 'email', false, { missingProof: true });
  await massLead('mailing receipt that does not match the lead contact fingerprint', mailing, 'email', false, { wrongHash: true });
  await massLead('review campaign cannot claim direction', review, 'whatsapp', false);
  const service = createLeadCampaignResponsibilityService(db);
  let selects = 0;
  const logging = sql.options.logging; sql.options.logging = message => { if (/SELECT/.test(message)) selects++; };
  let result;
  try { result = await service.forLeads(allRows); } finally { sql.options.logging = logging; }
  for (const item of cases) assert.equal(result.get(item.row.id), item.expected, item.label);
  assert.equal(selects, 1, 'bulk eligibility has one metadata-only SELECT, without provider or per-lead queries');
  const [direct] = await sql.query(`SELECT LeadIntake.id, (${campaignResponsibilitySql()}) AS eligible FROM LeadIntakes AS LeadIntake ORDER BY id`);
  for (const row of direct) assert.equal(Boolean(Number(row.eligible)), result.get(row.id), 'direct shared predicate agrees with bulk');
  const scoped = await service.forLeads([{ ...paid.row.toJSON(), clinica_id: 66 }]);
  assert.equal(scoped.get(paid.row.id), false, 'caller cannot substitute another clinic for an eligible lead id');
  assert.throws(() => campaignResponsibilitySql('LeadIntake;SELECT 1'), /alias_invalid/);
  report.campaignProfiles = cases.length;
  report.checks.push('Independent real SQL: organic/UTM/click-only/foreign/conflicting/native spoof denied; verified Meta, web, Google native and legitimate legacy inventory accepted; canonical requested phone channels excluded with chat/form/WhatsApp precedence; one bulk read; exact caller clinic and alias checked.');

  const context = relationship => ({ relationship, patient_id: relationship === 'existing_patient' ? 100 : null, request_kind: 'commercial' });
  const attention = createLeadPatientAttentionService(db, { contexts: { get: async row => row.patient_context },
    authorize: async () => true, isAdmin: () => false, campaignResponsibility: service });
  const previousMailingLead = { ...existingMailingLead.toJSON(), patient_context: context('existing_patient') };
  const [mailingAttention] = await attention.enrich([previousMailingLead], { actorId: 44 });
  assert.equal(mailingAttention.patient_attention.state, 'pending_review');
  assert.equal(mailingAttention.patient_attention.responsibility, 'director');
  assert.equal(mailingAttention.patient_attention.can_decide, true);
  assert.equal(mailingAttention.channel, 'unknown', 'direction does not turn an owned mailing into paid acquisition');
  const existing = { ...paid.row.toJSON(), patient_context: context('existing_patient') };
  let projected = (await attention.enrich([existing], { actorId: 44 }))[0];
  assert.equal(projected.patient_attention.state, 'pending_review');
  assert.equal(projected.patient_attention.responsibility, 'director');
  assert.equal(projected.patient_attention.director_user_id, 44);
  assert.equal(projected.patient_attention.decided_at, null, 'pending responsibility is not a fabricated decision');
  await db.LeadContactAttempt.create({ lead_intake_id: paid.row.id, usuario_id: 99, canal: 'llamada', motivo: 'sin_respuesta' });
  projected = (await attention.enrich([existing], { actorId: 44 }))[0];
  assert.equal(projected.patient_attention.responsibility, 'director', 'another actor contact attempt does not transfer responsibility');
  const organic = { ...cases.find(row => /organic form/.test(row.label)).row.toJSON(), patient_context: context('existing_patient') };
  const organicView = (await attention.enrich([organic], { actorId: 44 }))[0];
  assert.equal(organicView.patient_attention.responsibility, 'clinic');
  assert.notEqual(organicView.patient_attention.state, 'pending_review');
  const requestedPhone = (await attention.enrich([{ ...phoneWeb.toJSON(), patient_context: context('new_contact') }], { actorId: 44 }))[0];
  assert.equal(requestedPhone.patient_attention.responsibility, 'clinic');
  assert.equal(requestedPhone.source, 'web');
  assert.equal(requestedPhone.channel, 'paid', 'requested telephone ownership does not rewrite marketing attribution');
  assert.equal(requestedPhone.source_detail, 'tel_modal_call');
  const mixed = await attention.enrich([organic, existing], { actorId: 44 });
  assert.equal(mixed[1].patient_attention.can_decide, true,
    'an organic row first in the same clinic must not cache away director permission on a paid request');
  const explicitOwner = (await attention.enrich([{ ...existing, asignado_a: 99 }], { actorId: 44 }))[0];
  assert.equal(explicitOwner.patient_attention.responsibility, 'clinic', 'explicit owner is preserved');
  await audit(paid.row, { type: KEY, [KEY]: { version: 1, decision: 'clinic', request_kind: 'patient_care',
    director_user_id: 44, actor_user_id: 44, clinic_id: 72, decided_at: '2026-11-02T10:00:00Z' } });
  const transferred = (await attention.enrich([existing], { actorId: 44 }))[0];
  assert.equal(transferred.patient_attention.responsibility, 'clinic', 'audited transfer wins over campaign');
  report.checks.push('Independent real attention: campaign+existing patient retains director while pending with no invented decision; another human attempt is not a transfer; organic, explicit other owner and durable clinic transfer remain clinic.');

  const existingGoogle = { ...google.toJSON(), patient_context: context('existing_patient') };
  await db.Conversation.create({ clinic_id: 72, lead_id: google.id, patient_id: 100, channel: 'whatsapp' });
  await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: web.id,
    inicio: new Date('2026-11-24T10:00:00Z'), fin: new Date('2026-11-24T10:30:00Z'), estado: 'completada' });
  const ownAppointment = await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: google.id,
    inicio: new Date('2026-11-25T10:00:00Z'), fin: new Date('2026-11-25T10:30:00Z'), estado: 'info_confirmada' });
  const pendingWithoutMarker = (await attention.enrich([existingGoogle], { actorId: 44 }))[0];
  assert.equal(pendingWithoutMarker.patient_attention.state, 'pending_review');
  assert.equal(pendingWithoutMarker.patient_attention.responsibility, 'director',
    'foreign request attendance and own confirmation do not terminate this campaign request');
  await ownAppointment.update({ estado: 'ha_acudido' });
  const attendedWithoutMarker = (await attention.enrich([existingGoogle], { actorId: 44 }))[0];
  assert.equal(attendedWithoutMarker.patient_attention.state, 'completed');
  assert.equal(attendedWithoutMarker.patient_attention.responsibility, null);
  assert.equal(attendedWithoutMarker.patient_attention.decided_at, null);
  report.checks.push('Existing patient pending review, without a temporal start: own future confirmation stays director; another lead same-patient attendance ignored; own actual attendance completes without fabricating a decision/event.');

  const conversations = [];
  for (const item of [cases.find(row => /native paid/.test(row.label)), cases.find(row => /organic form/.test(row.label))]) {
    conversations.push(await db.Conversation.create({ clinic_id: 72, lead_id: item.row.id, patient_id: 100, channel: 'whatsapp' }));
  }
  const [eligibleChats] = await sql.query(`SELECT Conversation.id, (${temporaryQuickChatEligibilitySql()}) AS eligible
    FROM Conversations AS Conversation WHERE Conversation.id IN (:ids) ORDER BY Conversation.id`,
    { replacements: { ids: conversations.map(row => row.id) } });
  // The paid request above was explicitly transferred; neither it nor organic
  // may remain in the director's habitual list.
  assert.deepEqual(eligibleChats.map(row => Number(row.eligible)), [0, 0]);
  assert.equal(await db.Message.count(), 0, 'all projections leave messages/events absent');
  assert.equal(await db.PatientDirectionAssignment.count(), 0, 'all projections leave assignment storage absent');
  report.checks.push('Independent real QuickChat predicate agrees with explicit clinic transfer and organic responsibility; projections create no message, assignment, provider operation or data repair.');

  const reused = await db.Conversation.create({
    clinic_id: 72, lead_id: existingMailingLead.id, patient_id: 100, channel: 'whatsapp',
  });
  await db.Message.create({ conversation_id: reused.id, message_type: 'event', status: 'sent', direction: 'outbound',
    automation_delivery_key: `temporary-patient-direction:handoff:${reused.id}`, sent_at: new Date('2026-10-07T12:00:00Z'),
    metadata: { source: 'temporary_patient_direction', kind: 'temporary_patient_direction_handoff',
      clinic_id: 72, director_user_id: 44, patient_id: 100 },
  });
  const [laterRequest] = await attention.enrich([previousMailingLead], { actorId: 44 });
  assert.equal(laterRequest.patient_attention.state, 'pending_review');
  assert.equal(laterRequest.patient_attention.responsibility, 'director');
  assert.equal(await db.Message.count(), 1, 'the old handoff is retained without consuming the later campaign reply');
}));

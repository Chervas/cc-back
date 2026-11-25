'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DataTypes, Op } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { attributeCampaignInfoReply, isInfoReply } = require('../../services/marketingWhatsappReplyLead.service');
const { imageHeader, withCampaignImage, resolveCampaignImage } = require('../../lib/whatsapp-campaign-image');
const { buildLeadAttributionView, buildMarketingOriginWhere } = require('../../lib/lead-attribution-view');
const { fillExistingPatientNames } = require('../../services/leadPatientNameProjection.service');

test('only the INFO keyword triggers lead capture', () => {
  for (const value of ['INFO', ' info ', '¡Info!', '¿INFO?']) assert.equal(isInfoReply(value), true);
  for (const value of ['', 'BAJA', 'información', 'Gracias, info', 'INFO BAJA']) assert.equal(isInfoReply(value), false);
});

test('a nameless campaign lead shows the patient name only with confirmed clinic, phone, and permissions', async () => {
  const lead = { external_source: 'marketing_email_whatsapp', clinica_id: 21, telefono: '34600000001',
    patient_context: { relationship: 'existing_patient', same_clinic: true, clinic_id: 21, patient_id: 99 } };
  const patient = { id_paciente: 99, clinica_id: 22, clinicasVinculadas: [{ clinica_id: 21 }],
    telefono_movil: '600 000 001', nombre: 'Nombre', apellidos: 'Ficticio' };
  const apply = (items, row = patient, canSeePatientDetails = async () => true) => fillExistingPatientNames(items, {
    canSeePatientDetails,
    loadPatients: async ids => {
      assert.deepEqual(ids, [99]);
      return [row];
    },
  });
  const native = { ...lead, external_source: 'bulk_whatsapp_reply' };
  const ambiguous = { ...lead, patient_context: { ...lead.patient_context, relationship: 'possible_patient' } };
  const redacted = { ...lead, privacy_redacted: true };
  const named = { ...lead, nombre: 'Nombre del formulario' };
  const rows = [lead, native, ambiguous, redacted, named];
  const results = await apply(rows);
  assert.deepEqual(results.map(row => row.nombre), ['Nombre Ficticio', 'Nombre Ficticio', undefined, undefined, 'Nombre del formulario']);
  assert.deepEqual(await apply(rows, patient, async () => false), rows);
  assert.deepEqual(await apply(rows, { ...patient, telefono_movil: '600000002' }), rows);
  assert.deepEqual(await apply(rows, { ...patient, clinicasVinculadas: [] }), rows);
  assert.equal(lead.nombre, undefined);
});

test('campaign templates retain a registered image independently of Meta’s sample handle', async () => {
  const source = [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['provider-sample'] } }, { type: 'BODY' }];
  const asset = { scope_type: 'clinic', clinica_id: 21, content_type: 'image/jpeg', size_bytes: 1500, public_url: 'https://media.example.test/photo.jpg' };
  const Model = { findOne: async ({ where }) => {
    assert.deepEqual(where, { id: 44, purpose: 'whatsapp_image', sensitivity: 'public', status: 'active' });
    return asset;
  } };
  const image = await resolveCampaignImage(Model, 44, { clinicIds: [21] });
  assert.deepEqual(image, { asset_id: 44, url: asset.public_url });
  assert.deepEqual(imageHeader(withCampaignImage(source, image)), { ...source[0], campaign_image: image });
  assert.equal(imageHeader(source).campaign_image, undefined);
  assert.equal(imageHeader(withCampaignImage([source[1]], image)), undefined);
  await assert.rejects(resolveCampaignImage(Model, 44, { clinicIds: [22] }), { code: 'whatsapp_campaign_image_invalid' });
  asset.content_type = 'image/gif';
  await assert.rejects(resolveCampaignImage(Model, 44, { clinicIds: [21] }), { code: 'whatsapp_campaign_image_invalid' });
});

test('the shared outbound builder uses the fixed image for tests and campaigns and still personalizes reviews', async () => {
  const source = fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'), 'utf8');
  const start = source.indexOf('async function buildTemplateComponentsForSend(');
  const end = source.indexOf('async function renderTemplatePreview(', start);
  assert.ok(start > 0 && end > start);
  const imageUrl = 'https://media.example.test/campaign.jpg';
  const reviewUrl = 'https://media.example.test/personalized.jpg';
  const build = vm.runInNewContext(source.slice(start, end) + '\nbuildTemplateComponentsForSend;', {
    isReviewRequestList: list => list?.criteria?.review_request === true,
    templateHasImageHeader: template => !!imageHeader(template.components),
    campaignImageMissing: () => Error('missing_image'),
    resolveReviewHeaderPhotoUrl: async () => reviewUrl,
    require: name => {
      assert.equal(name, '../lib/whatsapp-bulk-opt-out');
      return require('../../lib/whatsapp-bulk-opt-out');
    },
  });
  const template = { components: [{ type: 'HEADER', format: 'IMAGE' }] };
  const list = { criteria: { whatsapp_header_image: { url: imageUrl } } };
  for (const bulkOptOutMode of ['test', 'send']) {
    const components = await build({ template, list, bulkOptOutMode, params: ['Contacto ficticio'] });
    assert.equal(components[0].parameters[0].image.link, imageUrl);
    assert.equal(components[1].parameters[0].text, 'Contacto ficticio');
  }
  assert.equal((await build({ template, list: { criteria: { review_request: true } } }))[0].parameters[0].image.link, reviewUrl);
  await assert.rejects(build({ template }), /missing_image/);
  await assert.rejects(build({ template: { components: [] }, list }), /conservar la cabecera/);
});

test('the dispatch excludes an exact-recipient conflict before creating or sending a message', async () => {
  const source = fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'), 'utf8');
  const start = source.indexOf('function canResumeIdentityConflict(');
  const end = source.indexOf('async function runDispatchJob(', start);
  assert.ok(start > 0 && end > start);
  const failureMessage = 'El teléfono de destino no coincide con la conversación. Revisa la ficha antes de enviar.';
  const conflict = Object.assign(new Error(failureMessage), { code: 'whatsapp_contact_identity_conflict' });
  let recipientError = conflict;
  const changes = [];
  const calls = [];
  const { canResumeIdentityConflict, sendDispatchItem } = vm.runInNewContext(
    source.slice(start, end) + '\n({ canResumeIdentityConflict, sendDispatchItem });', {
      assertReviewRequestCommunicationAllowed: async () => calls.push('consent'),
      getDispatchConfig: () => ({ context: 'campaign' }),
      normalizeDispatchContext: value => value,
      buildTemplateParams: async () => [],
      buildTemplateComponentsForSend: async () => [],
      isReviewRequestList: () => true,
      renderTemplatePreview: async () => 'Solicitud de reseña ficticia',
      findCanonicalWhatsappConversation: async options => {
        assert.equal(options.requireExactContact, true);
        assert.equal(options.clinicId, 21);
        calls.push('exact_recipient');
        throw recipientError;
      },
      Message: { create: () => assert.fail('No message can be created for an unverified recipient') },
      whatsappService: { sendMessage: () => assert.fail('The provider must not be called') },
    });
  const item = { id: 8, phone: '+34000000000', update: async patch => changes.push(patch) };
  const context = { list: { id: 3 }, item, template: {}, clinic: {}, clinicConfig: { clinicId: 21 }, batchIndex: 1 };
  const result = await sendDispatchItem(context);
  assert.equal(result.sent, false);
  assert.equal(result.error_code, conflict.code);
  assert.deepEqual(calls, ['consent', 'exact_recipient']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].selected, false);
  assert.equal(changes[0].status, 'excluded_whatsapp_identity_conflict');
  assert.equal(changes[0].dispatch_status, 'failed');
  recipientError = new Error('database_unavailable');
  await assert.rejects(sendDispatchItem(context), /database_unavailable/);
  assert.equal(changes.length, 1);
  const interrupted = { status: 'failed', job_status: 'failed', last_error: failureMessage };
  assert.equal(canResumeIdentityConflict(interrupted), true);
  assert.equal(canResumeIdentityConflict({ ...interrupted, last_error: 'database_unavailable' }), false);
  assert.equal(canResumeIdentityConflict({ ...interrupted, status: 'paused_review' }), false);
});

test('one lead per verified campaign and contact, with quote matching and ambiguous replies held', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1',
}, async () => {
  await withIsolatedCampaignMysql(async ({ sql, models: db }) => {
    const strings = fields => Object.fromEntries(fields.split(' ').map(field => [field, DataTypes.STRING]));
    const ints = fields => Object.fromEntries(fields.split(' ').map(field => [field, DataTypes.INTEGER]));
    db.Message = sql.define('Message', {
      ...ints('conversation_id'), ...strings('direction status'), metadata: DataTypes.JSON,
    });
    db.Conversation = sql.define('Conversation', {
      ...ints('clinic_id patient_id lead_id'), ...strings('contact_id channel'),
    });
    db.LeadIntake = sql.define('LeadIntake', {
      ...ints('clinica_id grupo_clinica_id'),
      ...strings('external_source external_id source source_detail channel status_lead telefono phone_hash nombre utm_source utm_medium utm_campaign gclid gbraid wbraid google_ads_customer_id google_ads_campaign_id fbclid ttclid'),
      es_paciente: DataTypes.BOOLEAN, archived_at: DataTypes.DATE,
    }, { indexes: [{ unique: true, fields: ['external_source', 'external_id'] }] });
    db.MarketingPatientList = require('../../../models/marketingpatientlist')(sql, DataTypes);
    db.MarketingPatientListItem = require('../../../models/marketingpatientlistitem')(sql, DataTypes);
    db.LeadAttributionAudit = require('../../../models/leadattributionaudit')(sql, DataTypes);
    await sql.sync();

    const conversation = await db.Conversation.create({ clinic_id: 21, channel: 'whatsapp', contact_id: '34600000001', patient_id: 99 });
    const campaign = await db.MarketingPatientList.create({
      name: 'Promoción ficticia', objective_id: 'mass_sends', clinica_id: 21, clinic_ids: [21],
      criteria: { record_kind: 'campaign', capture_whatsapp_info_leads: true },
    });
    const recipient = await db.MarketingPatientListItem.create({
      list_id: campaign.id, clinica_id: 21, name: 'Contacto ficticio', phone: conversation.contact_id,
    });
    const send = (overrides = {}) => db.Message.create({
      conversation_id: conversation.id, direction: 'outbound', status: 'sent',
      metadata: { source: 'marketing_bulk_sends', kind: 'mass_campaign_send', dispatch_context: 'campaign',
        list_id: campaign.id, item_id: recipient.id, recipient: conversation.contact_id,
        phoneNumberId: '333', wabaId: '444', wamid: 'wamid.SYNTHETIC',
        capture_whatsapp_info_leads: true, ...overrides },
    });
    const outbound = await send();
    const other = await send({ list_id: campaign.id + 1, wamid: 'wamid.OTHER' });
    const quote = { provider_type: 'text', context: { id: 'wamid.SYNTHETIC' } };
    const binding = { clinicId: 21, phoneId: '333', wabaId: '444' };
    const message = { id: 112, direction: 'inbound', conversation_id: conversation.id, sent_at: new Date(),
      content: '¡Info!', metadata: { provider_type: 'text' } };
    const apply = (patch = {}, bindingPatch = {}) => sql.transaction(transaction => attributeCampaignInfoReply({
      db, conversation, binding: { ...binding, ...bindingPatch }, message: { ...message, ...patch }, transaction,
    }));

    assert.equal(await apply(), null);
    assert.equal(await apply({ metadata: quote }, { phoneId: '555' }), null);
    assert.equal(await apply({ content: 'BAJA', metadata: quote }), null);
    assert.equal(await apply({ metadata: { provider_type: 'text', context: { id: 'wamid.UNKNOWN' } } }), null);
    const first = await apply({ metadata: quote });
    assert.equal(first.duplicate, false);
    assert.equal(first.lead.es_paciente, true);
    await other.destroy();
    assert.equal((await apply({ id: 113 })).duplicate, true);
    const preview = await send({ kind: 'mass_campaign_test', wamid: 'wamid.TEST' });
    assert.equal(await apply(), null);
    assert.equal(await apply({ metadata: { provider_type: 'text', context: { id: 'wamid.TEST' } } }), null);
    await preview.destroy();
    await campaign.update({ criteria: { ...campaign.criteria, capture_whatsapp_info_leads: false } });
    assert.equal(await apply({ metadata: quote }), null);

    const lead = first.lead.get({ plain: true });
    const view = buildLeadAttributionView(lead);
    assert.equal(view.marketing_origin, 'bulk_whatsapp');
    assert.equal(view.contact_method, 'whatsapp');
    assert.equal(view.marketing_campaign.name, 'Promoción ficticia');
    assert.equal(await db.LeadIntake.count({ where: buildMarketingOriginWhere('bulk_whatsapp', Op) }), 1);
    assert.equal(await db.LeadIntake.count({ where: buildMarketingOriginWhere('whatsapp', Op) }), 0);
    assert.equal(Number((await conversation.reload()).lead_id), Number(first.lead.id));
    const audit = await db.LeadAttributionAudit.findOne();
    assert.deepEqual(audit.attribution_steps.whatsapp_bulk_send, { campaign_id: campaign.id, outbound_message_id: outbound.id });
    assert.equal(await db.LeadAttributionAudit.count(), 1);

    await campaign.update({ clinica_id: null, grupo_clinica_id: 4, clinic_ids: [21, 22],
      criteria: { ...campaign.criteria, capture_whatsapp_info_leads: true } });
    await recipient.update({ clinica_id: null });
    assert.equal(await apply({ metadata: quote }), null);
    await outbound.update({ metadata: { ...outbound.metadata, delivery_clinic_id: 21 } });
    assert.equal((await apply({ metadata: quote })).duplicate, true);
    await recipient.update({ clinica_id: 22 });
    assert.equal(await apply({ metadata: quote }), null);
  });
});

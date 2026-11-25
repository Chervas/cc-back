'use strict';

// Execute the real bulk service with a closed persistence/provider boundary.
// This process cannot load .env, connect to SQL, or open network sockets.
require('./fixtures/scheduled_jobs.fixture.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const sends = [], providerPayloads = [], messages = [], events = [];
let list, items;
const scope = { scope: 'clinic', clinicIds: [9001] };
const clinic = { id_clinica: 9001, nombre_clinica: 'Clínica ficticia' };
const config = { phoneNumberId: 'qa-phone', wabaId: 'qa-waba', accessToken: 'fictitious', clinicId: 9001 };
const template = {
  id: 7001, clinic_id: 9001, name: 'qa_custom_date', language: 'es', status: 'APPROVED', category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Hola {{1}}, tu fecha especial es {{2}}.', example: { body_text: [['Ejemplo', '01/01/2000']] } }],
  variables: [{ index: 1, name: 'nombre' }, { index: 2, name: 'fechaultimotratamiento', example: '01/01/2000' }],
};
function stubModule(relative, exports) {
  const file = require.resolve(relative);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stubModule('../../services/whatsappAccountHealth.service', { assertCanSend: async () => {} });
stubModule('../../services/whatsappPaymentStatus.service', { derivePaymentSnapshot: () => ({ status: 'unknown', missing: false }) });
stubModule('../../services/whatsappDeliveryGovernance.service', {
  recordImmediateSendResponse: async ({ response }) => ({ status: 'accepted', held: false, providerMessageId: response.messages[0].id }),
});
stubModule('../../services/whatsappTemplateScope.service', { resolveTemplateInWaba: async ({ template: selected, clinicId, wabaId }) => {
  assert.equal(clinicId, 9001); assert.equal(wabaId, 'qa-waba'); return selected;
} });
stubModule('../../services/googleLocalLinks.service', {
  resolveClinicGoogleLocalLinks: async () => ({}), resolveClinicGoogleReviewLinks: async () => ({}),
  mergeClinicLinksIntoContext: value => ({ ...value }),
});
stubModule('../../services/socket.service', { getIO: () => null });
stubModule('../../lib/canonical-conversation', { findCanonicalWhatsappConversation: async args => {
  assert.equal(args.clinicId, 9001);
  return { id: 6001, clinic_id: 9001, update: async () => {} };
} });
// Keep the real adapter's template/component builder; replace its final I/O.
const whatsapp = require('../../services/whatsapp.service');
whatsapp.getClinicConfig = async () => ({ ...config });
whatsapp.sendMessage = async request => {
  sends.push(structuredClone(request));
  return whatsapp.sendTemplateMessage(request);
};
whatsapp.dispatchMessage = async payload => {
  providerPayloads.push(structuredClone(payload));
  return { messages: [{ id: `qa-${providerPayloads.length}`, message_status: 'accepted' }] };
};
db.sequelize.transaction = async callback => callback({ LOCK: { UPDATE: 'UPDATE' } });
db.MarketingPatientList.findByPk = async id => Number(id) === list.id ? list : null;
db.MarketingPatientList.update = async patch => { Object.assign(list, patch); };
db.MarketingPatientListItem.bulkCreate = async () => { assert.fail('Unexpected recipient writes'); };
db.MarketingPatientListItem.findAll = async ({ where, limit } = {}) => {
  assert.equal(where.list_id, list.id);
  return limit ? items.slice(0, limit) : items;
};
db.MarketingPatientListItem.findOne = async ({ where }) => {
  assert.equal(where.list_id, list.id);
  return items.find(item => where.id !== undefined ? item.id === Number(where.id) : item.status === where.status) || null;
};
db.MarketingPatientContactEvent.create = async event => { events.push(event); };
db.Clinica.findByPk = async id => Number(id) === 9001 ? clinic : null;
db.ClinicMetaAsset.findOne = async () => null;
db.WhatsappTemplate.findByPk = async id => Number(id) === template.id ? template : null;
db.WhatsappTemplate.findAll = async () => [template];
db.Message.create = async payload => {
  const message = { id: 8000 + messages.length, ...payload, async update(patch) { Object.assign(this, patch); } };
  messages.push(message); return message;
};
const service = require('../../services/marketingBulkSends.service');
function model(data) {
  return { ...data, get(key) { return typeof key === 'string' ? this[key] : { ...this }; },
    set(key, value) { this[key] = value; }, async update(patch) { Object.assign(this, patch); } };
}
function reset({ missing = false, count = 2, variable = 'fechaultimotratamiento' } = {}) {
  sends.length = 0; providerPayloads.length = 0; messages.length = 0; events.length = 0;
  template.variables[1].name = variable;
  const rows = Array.from({ length: count }, (_, index) => ({
    Nombre: index === 1 ? 'Beatriz Ficticia' : 'Ana Ficticia', Telefono: String(34610000000 + index),
    [variable]: missing && index === count - 1 ? '' : index === 1 ? '29/02/2028' : '03/12/2026',
  }));
  const imported = service.__testing.buildItemsFromRows(rows, {
    clinic_id: 9001, column_mapping: { name: 'Nombre', phone: 'Telefono' },
    custom_fields_schema: [{ key: variable, source_column: variable, type: 'text' }],
  }, ['whatsapp']);
  items = imported.items.map((item, index) => model({ ...item, id: 10001 + index, list_id: 5001, clinica_id: 9001 }));
  list = model({ id: 5001, objective_id: 'mass_sends', name: 'Campaña QA', source: 'import', status: 'draft',
    scope_type: 'clinic', clinica_id: 9001, clinic_ids: [9001], channel: 'whatsapp', action_mode: 'whatsapp',
    criteria: { record_kind: 'campaign', channels: ['whatsapp'], template_usage: 'notificacion', template_commercial: false,
      consent_acknowledged: true, link_tracking: { enabled: false } },
    custom_fields_schema: imported.customFieldsSchema, safety_gates: {}, counters: {} });
  return imported;
}

test('save and prepare preserve the approved template and two imported custom dates', async () => {
  reset();
  const saved = await service.updateCampaign(scope, list.id, { whatsapp_template_id: template.id });
  assert.equal(saved.campaign.criteria.whatsapp_template_id, template.id);
  assert.equal(saved.campaign.template_snapshot.id, template.id);
  assert.equal(saved.campaign.template_snapshot.category, 'UTILITY');
  assert.equal(list.criteria.template_commercial, false);
  assert.equal(list.custom_fields_schema.find(field => field.key === 'fechaultimotratamiento').type, 'text');
  assert(items.every(item => !item.last_visit_at));
  assert.deepEqual(items.map(item => item.custom_fields.fechaultimotratamiento), ['03/12/2026', '29/02/2028']);
  const prepared = await service.prepareCampaign(scope, list.id, {});
  assert.equal(prepared.campaign.status, 'prepared');
  assert.equal(prepared.campaign.counters.ready, 2);
  assert.equal(prepared.campaign.criteria.template_commercial, false);
  assert.deepEqual(prepared.campaign.items_preview.map(item => item.custom_fields.fechaultimotratamiento), ['03/12/2026', '29/02/2028']);
  assert.equal(sends.length, 0); assert.equal(messages.length, 0);
});

test('test send uses each selected contact date in rendered content and exact provider body parameters', async () => {
  reset();
  list.criteria.whatsapp_template_id = template.id;
  for (const [index, item] of items.entries()) {
    const result = await service.sendTest(scope, list.id, { item_id: item.id, to: String(34620000001 + index) });
    assert.equal(result.success, true);
  }
  assert.deepEqual(sends.map(send => send.templateParams), [['Ana', '03/12/2026'], ['Beatriz', '29/02/2028']]);
  assert.deepEqual(sends.map(send => send.templateComponents), [
    [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '03/12/2026' }] }],
    [{ type: 'body', parameters: [{ type: 'text', text: 'Beatriz' }, { type: 'text', text: '29/02/2028' }] }],
  ]);
  assert.deepEqual(messages.map(message => message.content), [
    'Hola Ana, tu fecha especial es 03/12/2026.', 'Hola Beatriz, tu fecha especial es 29/02/2028.',
  ]);
  assert.deepEqual(providerPayloads.map(payload => payload.template.components), sends.map(send => send.templateComponents));
  assert(providerPayloads.every(payload => payload.messaging_product === 'whatsapp' && payload.type === 'template'
    && payload.template.name === template.name && payload.template.language.code === 'es'));
  assert(sends.every(send => send.useTemplate === true && send.templateName === template.name && send.templateLanguage === 'es'));
  assert(items.every(item => !item.sent_at && !item.dispatch_status), 'tests must not dispatch the audience');
});

test('a required custom date absent from the selected contact blocks test without example fallback or provider send', async () => {
  reset({ missing: true }); list.criteria.whatsapp_template_id = template.id;
  await assert.rejects(service.sendTest(scope, list.id, { item_id: items[1].id, to: '34620000003' }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.details.missing_variables[0].variable, 'fechaultimotratamiento');
    assert.equal(error.details.missing_variables[0].missing_count, 1);
    return true;
  });
  assert.equal(sends.length, 0); assert.equal(providerPayloads.length, 0); assert.equal(messages.length, 0);
});

test('prepare validates beyond the UI preview limit and blocks a missing date in contact 1001', async () => {
  reset({ count: 1001, missing: true }); list.criteria.whatsapp_template_id = template.id;
  await assert.rejects(service.prepareCampaign(scope, list.id, {}), error => {
    assert.equal(error.status, 409);
    const missing = error.details.missing_variables.find(variable => variable.variable === 'fechaultimotratamiento');
    assert.equal(missing.missing_count, 1); assert.equal(missing.total_ready, 1001);
    assert.deepEqual(missing.sample_item_ids, [11001]); return true;
  });
  assert.equal(list.status, 'draft'); assert.equal(sends.length, 0); assert.equal(messages.length, 0);
});

test('a separate custom variable with an underscore also keeps per-contact values', async () => {
  reset({ variable: 'fecha_promocion' }); list.criteria.whatsapp_template_id = template.id;
  for (const [index, item] of items.entries()) {
    await service.sendTest(scope, list.id, { item_id: item.id, to: String(34620000011 + index) });
  }
  assert.deepEqual(providerPayloads.map(payload => payload.template.components[0].parameters[1]), [
    { type: 'text', text: '03/12/2026' }, { type: 'text', text: '29/02/2028' },
  ]);
});

test('appending to a reusable list completes an existing contact without overwriting values or reopening a baja', async t => {
  reset();
  list.criteria = { record_kind: 'recipient_list', channels: ['email'] };
  const previous = model({
    id: 10021, list_id: list.id, name: 'Nombre original', email: 'CLIENTE@example.test',
    status: 'excluded_opt_out', selected: false, exclusion_reason: 'opt_out',
    custom_fields: { ciudad: 'Alicante', lote_importacion: 'original' },
  });
  const existing = model({
    id: 10022, list_id: list.id, name: 'Otro contacto', email: 'otro@example.test',
    phone: '+34612345670', status: 'ready', custom_fields: {},
  });
  items = [previous, existing];
  t.mock.method(db.Paciente, 'findAll', async () => []);
  t.mock.method(db.MarketingPatientListItem, 'bulkCreate', async rows => {
    items.push(...rows.map((row, index) => model({ ...row, id: 10100 + index })));
  });
  const append = {
    append_rows: [
      { Nombre: 'Nombre cambiado', Email: 'cliente@example.test', Tel: '612345670', Ciudad: 'Madrid', Pedido: '25/11/2026' },
      { Nombre: 'Nuevo', Email: 'nuevo@example.test', Tel: '612345670' },
      { Nombre: 'Solo teléfono', Tel: '612345671' },
    ],
    import_batch_id: 'nuevo-lote',
    column_mapping: { name: 'Nombre', email: 'Email', phone: 'Tel' },
    custom_fields_schema: [
      { key: 'ciudad', source_column: 'Ciudad' },
      { key: 'pedido', source_column: 'Pedido' },
    ],
  };
  const first = (await service.updateCampaign(scope, list.id, append)).import_result;
  assert.deepEqual([first.total, first.imported, first.updated_existing, first.discarded], [3, 2, 1, 0]);
  assert.equal(items.length, 4);
  assert.equal(previous.phone, '+34612345670');
  assert.equal(previous.email, 'CLIENTE@example.test');
  assert.equal(previous.name, 'Nombre original');
  assert.equal(previous.status, 'excluded_opt_out');
  assert.equal(previous.selected, false);
  assert.deepEqual(previous.custom_fields, { ciudad: 'Alicante', lote_importacion: 'original', pedido: '25/11/2026' });
  assert(first.imported_items.every(item => item.custom_fields.lote_importacion === 'nuevo-lote'));

  const repeated = (await service.updateCampaign(scope, list.id, append)).import_result;
  assert.deepEqual([repeated.imported, repeated.updated_existing, repeated.discarded], [0, 0, 3]);
  assert.equal(items.length, 4);
});

test('patient preview and list creation cover all current patients and share contact filters', async t => {
  reset();
  const patients = Array.from({ length: 1101 }, (_, index) => ({
    id_paciente: 1 + index, clinica_id: 9001, nombre: 'Paciente ficticio',
    telefono_movil: index % 2 === 0 ? `+346${String(index).padStart(8, '0')}` : null,
    email: index % 2 === 1 ? `paciente${index}@example.test` : null,
  }));
  t.mock.method(db.Paciente, 'findAll', async options => {
    assert.deepEqual(options.where.clinica_id[db.Sequelize.Op.in], [9001]);
    assert.equal(options.where.fecha_baja, null);
    assert.equal(options.limit, undefined);
    return patients;
  });
  const batches = [];
  t.mock.method(db.MarketingPatientListItem, 'bulkCreate', async rows => batches.push(rows));
  t.mock.method(db.MarketingPatientList, 'create', async data => {
    list = model({ ...data, id: 5002 });
    return list;
  });
  assert.deepEqual(await service.previewCurrentPatientAudience(scope),
    { total: 1101, with_email: 550, with_phone: 551, with_contact: 1101 });
  await assert.rejects(service.previewCurrentPatientAudience({ clinicIds: [] }), { status: 400 });
  const payload = { record_kind: 'recipient_list', list_source: 'current_patients', channels: ['whatsapp'] };
  await service.createCampaign(scope, payload);
  assert.deepEqual(batches.map(batch => batch.length), [1000, 101]);
  assert.equal(list.counters.ready, 1101);
  batches.length = 0;
  await service.createCampaign(scope, { ...payload, patient_contact_filter: 'email' });
  assert.equal(list.counters.ready, 550);
  assert(batches[0].every(item => item.email && !item.phone));
});

test('an outside clinic scope cannot save, prepare or test the fictitious campaign', async () => {
  reset(); const before = JSON.stringify(items);
  const outside = { scope: 'clinic', clinicIds: [9002] };
  for (const action of [
    () => service.updateCampaign(outside, list.id, { whatsapp_template_id: template.id }),
    () => service.prepareCampaign(outside, list.id, {}),
    () => service.sendTest(outside, list.id, { item_id: items[0].id, to: '34620000021' }),
  ]) await assert.rejects(action(), error => error.status === 404);
  assert.equal(JSON.stringify(items), before); assert.equal(list.status, 'draft');
  assert.equal(sends.length, 0); assert.equal(providerPayloads.length, 0); assert.equal(messages.length, 0); assert.equal(events.length, 0);
});

test('real Utility custom-template creation converts UI named body and persists the contract used by bulk send', async t => {
  reset();
  let released = 0;
  const lease = require('../../lib/waba-catalog-creation-lease');
  t.mock.method(lease, 'acquireWabaCatalogCreationLease', async wabaId => {
    assert.equal(wabaId, 'qa-waba');
    return { acquired: true, release: async () => { released += 1; } };
  });
  const broker = require('../../lib/whatsappAuthorizedBrokerClient');
  const management = require('../../../services/integrations-broker/src/whatsapp-template-management');
  const submissions = [], initialRows = [], recoveryJobs = [];
  t.mock.method(broker, 'templateBinding', async () => ({ clinicId: 9001, wabaId: 'qa-waba' }));
  t.mock.method(broker, 'templates', async (wabaId, operation, input) => {
    assert.equal(wabaId, 'qa-waba'); assert.equal(operation, management.CREATE);
    submissions.push(structuredClone(input)); return { id: 'qa-meta-template' };
  });
  t.mock.method(require('../../services/jobRequests.service'), 'enqueueUniqueJobRequest', async input => {
    recoveryJobs.push(input); return { job: { id: 9901 } };
  });
  t.mock.method(db.WhatsappTemplate, 'findOne', async () => null);
  t.mock.method(db.WhatsappTemplate, 'create', async payload => {
    initialRows.push(structuredClone(payload)); return model({ id: 7001, ...payload });
  });
  const creation = require('../../services/whatsappTemplates.service');
  const result = await creation.createCustomTemplateForClinic({
    clinicId: 9001, wabaId: 'qa-waba', displayName: 'Fecha personalizada ficticia', category: 'UTILITY',
    bodyText: 'Hola {{nombre}}, tu fecha especial es {{fechaultimotratamiento}}.',
    variables: [{ name: 'nombre', example: 'Ejemplo' }, { name: 'fechaultimotratamiento', example: '01/01/2000' }],
    createdByUserId: 90001,
    bulkOptOut: true,
  });
  assert.equal(result.submitted, true); assert.equal(released, 1);
  assert.equal(submissions[0].template.category, 'UTILITY');
  assert.equal(submissions[0].template.components[0].text, 'Hola {{1}}, tu fecha especial es {{2}}.');
  assert.deepEqual(submissions[0].template.components[1], {
    type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Pedir baja' }],
  });
  assert.deepEqual(initialRows[0].variables.map(variable => [variable.index, variable.name]), [
    [1, 'nombre'], [2, 'fechaultimotratamiento'],
  ]);
  assert.deepEqual(result.row.variables, initialRows[0].variables);
  assert.equal(result.row.category, 'UTILITY'); assert.equal(result.row.status, 'PENDING');
  assert.equal(recoveryJobs.length, 1); assert.equal(recoveryJobs[0].type, 'whatsapp_template_sync_delayed');
  // Approval is simulated in memory; no provider approval or existing template is queried.
  Object.assign(template, result.row.get({ plain: true }), { status: 'APPROVED' });
  await service.updateCampaign(scope, list.id, { whatsapp_template_id: template.id });
  await service.prepareCampaign(scope, list.id, {});
  for (const [index, item] of items.entries()) {
    await service.sendTest(scope, list.id, { item_id: item.id, to: String(34620000031 + index) });
  }
  assert.deepEqual(providerPayloads.map(payload => payload.template.components[0].parameters), [
    [{ type: 'text', text: 'Ana' }, { type: 'text', text: '03/12/2026' }],
    [{ type: 'text', text: 'Beatriz' }, { type: 'text', text: '29/02/2028' }],
  ]);
  const expectedButton = { type: 'button', sub_type: 'quick_reply', index: '0',
    parameters: [{ type: 'payload', payload: require('../../lib/whatsapp-bulk-opt-out').TEST_PAYLOAD }] };
  assert.deepEqual(providerPayloads.map(payload => payload.template.components[1]), [expectedButton, expectedButton]);
  assert(items.every(item => !item.last_visit_at));
});

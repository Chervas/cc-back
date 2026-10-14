'use strict';

// The complete production dispatcher, isolated from application bootstrap,
// credentials, network and real patients. Both transports are counters only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const eligibility = require('../../lib/whatsappAppointmentEligibility');
const workflow = require('../../lib/whatsapp-template-workflow');
const source = fs.readFileSync(require.resolve('../../services/whatsapp.service'), 'utf8');
const localLinksSource = fs.readFileSync(require.resolve('../../services/googleLocalLinks.service'), 'utf8');
const HELD = 'whatsapp_appointment_nonoperational_clinic_held';
const plainPayload = (body = 'Mensaje humano de prueba') => ({ messaging_product: 'whatsapp', to: '34000000001',
  type: 'text', text: { body } });
const templatePayload = (components = []) => ({ messaging_product: 'whatsapp', to: '34000000001',
  type: 'template', template: { name: 'custom_v17', language: { code: 'es' }, components } });
function fixture({ clinicId = 66, broker = false, template = null, catalog = null, message = null,
  conversationClinic = clinicId, reviewUrl = null, databaseError = false, conversationError = false,
  reviewAliasClinic = null } = {}) {
  const state = { graph: 0, broker: 0, managed: 0, scope: 0, reads: [] };
  const db = {
    Message: { findByPk: async id => { state.reads.push(['message', id]); return structuredClone(message); } },
    Conversation: { findByPk: async (id, options) => { state.reads.push(['conversation', id, options]);
      if (conversationError) throw Error('PRIVATE_SQL_OR_TOKEN_MUST_NOT_ESCAPE');
      return { id, clinic_id: conversationClinic }; } },
    WhatsappTemplate: { findOne: async options => { state.reads.push(['template', options]);
      if (databaseError) throw Error('PRIVATE_SQL_OR_TOKEN_MUST_NOT_ESCAPE'); return structuredClone(template); } },
    WhatsappTemplateCatalog: { findByPk: async (id, options) => { state.reads.push(['catalog', id, options]); return structuredClone(catalog); } },
    Clinica: { findByPk: async (id, options) => { state.reads.push(['clinic', id, options]);
      // Match the real model: url_dejar_resena is not a physical column.
      const actualColumns = ['id_clinica', 'configuracion', 'nombre_clinica', 'direccion', 'url_ficha_local'];
      for (const attribute of options.attributes) assert(actualColumns.includes(attribute), 'Unknown Clinicas column: ' + attribute);
      if (databaseError) throw Error('PRIVATE_SQL_OR_TOKEN_MUST_NOT_ESCAPE');
      return { id_clinica: id, configuracion: reviewAliasClinic && Number(id) === clinicId
        ? { reviews: { google_business_profile_alias: { clinic_id: reviewAliasClinic } } } : null }; } },
    ClinicBusinessLocation: { findOne: async options => {
      state.reads.push(['business_location', options]);
      const wantedClinic = Number(options.where.clinica_id);
      return reviewUrl && wantedClinic === Number(reviewAliasClinic || clinicId)
        ? { id: 90, clinica_id: wantedClinic, location_id: 'locations/unit-only', is_active: true,
          raw_payload: { metadata: { newReviewUri: reviewUrl } } } : null;
    } },
    sequelize: {},
  };
  const localLinksModule = { exports: {} };
  vm.runInNewContext(localLinksSource, { module: localLinksModule,
    require: name => { assert.equal(name, '../../models'); return db; } }, { filename: 'googleLocalLinks.service.js' });
  const modules = {
    '../../models': db, sequelize: { Op: {} }, '../lib/phone': {}, '../lib/whatsapp-channel-role': {},
    './whatsappAccountHealth.service': {}, './whatsappChannelBindings.service': {},
    '../lib/whatsappAppointmentEligibility': eligibility, '../lib/whatsapp-template-workflow': workflow,
    './googleLocalLinks.service': localLinksModule.exports,
    '../lib/automation-runtime-stop': { assertMessageCanDispatch: async () => {} },
    './whatsappTemplateScope.service': { assertTemplateInWaba: async () => { state.scope++; } },
    './securityMonitoring.service': { assertTemplateAllowed: async () => {} },
    '../lib/whatsappAuthorizedBrokerClient': { isManagedMessage: async () => false,
      send: async () => { state.broker++; return { messages: [{ id: 'FAKE_ONLY' }] }; } },
    '../lib/metaQuarantineHttp': { post: async () => { state.graph++; return { data: { messages: [{ id: 'FAKE_ONLY' }] } }; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: { env: {} }, URL, Buffer,
    require: name => { assert(Object.hasOwn(modules, name), 'Unexpected offline dependency: ' + name); return modules[name]; } },
  { filename: 'whatsapp.service.js' });
  const config = { clinicId, phoneNumberId: '401', wabaId: '501', originId: 1,
    ...(broker ? { authorizedBroker: { phoneId: '401', wabaId: '501' } } : { accessToken: 'FAKE_NEVER_USED' }) };
  return { state, service: module.exports,
    send: (payload, changes = {}) => module.exports.dispatchMessage(payload, { ...config, ...changes }, message ? { messageId: message.id } : {}) };
}
async function held(f, payload) {
  await assert.rejects(f.send(payload), error => {
    assert.equal(error.code, HELD); assert.equal(error.retryable, false); assert.equal(error.statusCode, 403);
    assert.equal(error.details.reason_code, HELD); assert.equal(error.message.includes('PRIVATE'), false); return true;
  });
  assert.equal(f.state.graph, 0); assert.equal(f.state.broker, 0);
}

test('all BS patients: actual consent/review payload is held before broker AND legacy Graph without execution or importer HOLD', async () => {
  for (const clinicId of [66, 72]) for (const broker of [false, true]) {
    for (const name of ['clinicaclick_solicitar_resena_v1', 'nuevo_consentimiento_custom']) {
      const payload = templatePayload(); payload.template.name = name;
      const f = fixture({ clinicId, broker }); await held(f, payload); assert.equal(f.state.scope, 0);
    }
  }
});

test('stored pending/manual domain cannot be erased by a care label or a neutral actual payload', async () => {
  for (const broker of [false, true]) for (const metadata of [
    { kind: 'review_google_link_followup', communication_scope: 'care' },
    { dispatch_context: 'review_request' }, { consent_package_id: 10 },
    { patient_consent_document_id: 11 }, { flow_domain: 'consent', communication_purpose: 'care' },
  ]) {
    const message = { id: 12, conversation_id: 13, metadata };
    const before = JSON.stringify(message), f = fixture({ broker, message });
    await held(f, plainPayload()); assert.equal(JSON.stringify(message), before);
    assert.deepEqual(Array.from(f.state.reads[1][2].attributes), ['id', 'clinic_id']);
  }
});

test('renamed server catalog identities and custom variables/static body remain protected, exact actual WABA/language is queried', async () => {
  const variants = [
    ...[9, 32, 34].map(id => ({ template: { id: 8, name: 'custom_v17', catalog_template_id: id }, catalog: { id } })),
    { template: { id: 8, variables: { link: '{{clinica.url_dejar_resena}}' } } },
    { template: { id: 8, variables: [{ key: 'enlace', binding: '{{consentimiento.enlace_publico}}' }] } },
    { template: { id: 8, variables: JSON.stringify({ template_usage: 'reviews' }) } },
    { template: { id: 8, components: [{ type: 'BODY', text: 'Por favor deja una reseña de tu visita' }] } },
    { template: { id: 8, catalog_template_id: 100 }, catalog: { id: 100, family_key: 'custom_consent_firma' } },
    { template: { id: 8, catalog_template_id: 101 }, catalog: { id: 101, family_key: 'review_request_followup' } },
  ];
  for (const variant of variants) for (const broker of [false, true]) {
    const f = fixture({ ...variant, broker }); await held(f, templatePayload());
    const query = f.state.reads.find(row => row[0] === 'template')[1];
    assert.equal(query.where.waba_id, '501'); assert.equal(query.where.name, 'custom_v17'); assert.equal(query.where.language, 'es');
    assert.equal(query.attributes.includes('accessToken'), false);
  }
});

test('strict consent routes are held in text, CTA, template parameters and document links, independent of filename', async () => {
  for (const url of ['https://qa.invalid/tablet/consentimientos/FAKE_SIGNED_TOKEN',
    'https://qa.invalid/api/consentimientos/documents/123/pdf?download=1',
    'https://qa.invalid/consentimientos/documents/123/pdf',
    'https://qa.invalid/tablet/%63onsentimientos/FAKE_SIGNED_TOKEN']) {
    const payloads = [plainPayload('Aquí está: ' + url),
      { type: 'interactive', interactive: { type: 'cta_url', action: { parameters: { display_text: 'Abrir', url } } } },
      templatePayload([{ type: 'button', parameters: [{ type: 'text', text: url }] }]),
      { type: 'document', document: { link: url, filename: 'cualquier-nombre.pdf' } }];
    for (const payload of payloads) for (const broker of [false, true]) await held(fixture({ broker }), payload);
  }
});

test('Google review endpoints and configured custom review URLs with extra tracking cannot bypass the hold', async () => {
  for (const url of ['https://g.page/r/FAKE/review', 'https://search.google.com/local/writereview?placeid=FAKE',
    'https://custom.invalid/r/clinic?site=66&utm_campaign=qa']) {
    const f = fixture({ reviewUrl: 'https://custom.invalid/r/clinic?site=66' }); await held(f, plainPayload(url));
  }
});

test('ordinary appointment URLs use only real clinic columns and local profile reads, including review aliases', async () => {
  for (const broker of [false, true]) for (const reviewAliasClinic of [null, 72]) {
    const f = fixture({ broker, clinicId: 66, reviewAliasClinic,
      reviewUrl: 'https://custom.invalid/review/clinic?source=local' });
    await f.send(plainPayload('Cómo llegar: https://www.google.com/maps/dir/?api=1&destination=QA'));
    assert.equal(f.state.graph + f.state.broker, 1);
    const clinicQuery = f.state.reads.find(row => row[0] === 'clinic');
    assert.deepEqual(Array.from(clinicQuery[2].attributes), ['id_clinica', 'configuracion']);
    assert(f.state.reads.some(row => row[0] === 'business_location'));
    if (reviewAliasClinic) assert(f.state.reads.some(row => row[0] === 'business_location'
      && Number(row[1].where.clinica_id) === reviewAliasClinic));
    const blocked = fixture({ broker, clinicId: 66, reviewAliasClinic,
      reviewUrl: 'https://custom.invalid/review/clinic?source=local' });
    await held(blocked, plainPayload('https://custom.invalid/review/clinic?source=local&utm_campaign=QA'));
  }
});

test('normal human messages, unrelated marketing, directions and generic clinical documents remain functional', async () => {
  for (const broker of [false, true]) for (const payload of [plainPayload(), plainPayload('Tengo una revisión clínica'),
    plainPayload('https://www.google.com/maps/dir/?api=1&destination=qa'),
    plainPayload('https://g.page/r/FAKE_PROFILE'), plainPayload('https://qa.invalid/tablet/consentimientos'),
    plainPayload('https://qa.invalid/consentimientos/documents/not-an-id/pdf'),
    { type: 'document', document: { link: 'https://qa.invalid/clinical/documents/123/pdf', filename: 'documento.pdf' } },
    templatePayload([{ type: 'body', parameters: [{ type: 'text', text: 'Oferta habitual' }] }]),
  ]) {
    const f = fixture({ broker, template: { id: 9, name: 'custom_v17', variables: { template_usage: 'marketing' },
      components: [{ type: 'BODY', text: 'Nuestro horario y novedades' }] },
    message: { id: 11, conversation_id: 12, metadata: { communication_scope: 'marketing', package_id: 33, document_id: 44 } } });
    await f.send(payload); assert.equal(f.state.graph + f.state.broker, 1);
  }
});

test('other clinics remain unaffected and unavailable authoritative BS reads fail closed without leaking provider/SQL details', async () => {
  const other = fixture({ clinicId: 123 }); await other.send(plainPayload('https://qa.invalid/tablet/consentimientos/FAKE'));
  assert.equal(other.state.graph, 1); assert.equal(other.state.reads.length, 0);
  await held(fixture({ databaseError: true }), templatePayload());
  await held(fixture({ databaseError: true }), plainPayload('https://custom.invalid/link'));
  await held(fixture({ message: { id: 1, conversation_id: 2, metadata: {} }, conversationClinic: 123 }), plainPayload());
});

test('a non-BS sender config cannot bypass the actual persisted BS conversation scope in either transport', async () => {
  for (const conversationClinic of [66, 72]) for (const broker of [false, true]) {
    const f = fixture({ clinicId: 123, conversationClinic, broker,
      message: { id: 1, conversation_id: 2, metadata: { clinic_id: 123, communication_scope: 'care' } } });
    await held(f, plainPayload());
    assert.equal(f.state.reads.find(row => row[0] === 'conversation')[1], 2);
  }
});

test('the added scope check leaves non-BS conversations independent and sanitizes unavailable scope without sending', async () => {
  const other = fixture({ clinicId: 123, conversationClinic: 124,
    message: { id: 1, conversation_id: 2, metadata: {} } });
  await other.send(plainPayload()); assert.equal(other.state.graph, 1);
  assert.equal(other.state.reads.filter(row => row[0] === 'conversation').length, 1);
  assert.equal(other.state.reads.some(row => row[0] === 'template'), false);
  const unknown = fixture({ clinicId: 123, conversationError: true,
    message: { id: 1, conversation_id: 2, metadata: {} } });
  await assert.rejects(unknown.send(plainPayload()), error => error.code === 'whatsapp_automation_scope_changed'
    && error.retryable === false && error.statusCode === 409 && !error.message.includes('PRIVATE'));
  assert.equal(unknown.state.graph, 0); assert.equal(unknown.state.broker, 0);
});

test('same-day/day-before reminders and operational confirmation/cancellation acknowledgements still pass both transports', async () => {
  for (const clinicId of [66, 72]) for (const broker of [false, true]) for (const templateName of [
    'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v11',
    'clinicaclick_recordatorio_dia_antes_v16', 'clinicaclick_confirmacion_datos_cita_hoy_v16',
    'clinicaclick_confirmacion_cita_v2', null,
  ]) {
    const payload = templateName ? templatePayload() : plainPayload('Tu cita ha quedado cancelada correctamente.');
    if (templateName) payload.template.name = templateName;
    const f = fixture({ clinicId, broker,
      template: { id: 60, name: templateName, catalog_template_id: 61, variables: [{ key: 'nombre_paciente' }] },
      catalog: { id: 61, family_key: 'appointment_reminder', body_text: '¿Nos confirmas tu asistencia?' },
      message: { id: 1, conversation_id: 2, metadata: { communication_scope: 'care', flow_domain: 'appointments' } } });
    await f.send(payload); assert.equal(f.state.graph + f.state.broker, 1);
  }
});

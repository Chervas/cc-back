'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const snapshots = require('../../lib/review-care-snapshot');
const dates = require('../../lib/marketing-template-variables');
const { createReviewCareContext } = require('../../services/reviewCareContext.service');
const source = fs.readFileSync(path.resolve(__dirname, '../../services/marketingBulkSends.service.js'), 'utf8');
function extract(name, next) {
  const at = source.indexOf(`function ${name}(`), end = source.indexOf('\n' + next, at);
  assert(at >= 0 && end > at, name);
  return source.slice(source.lastIndexOf('\n', at) + 1, end);
}
function template(names, id = 6071) {
  return { id, name: 'fictitious_selected_review', status: 'APPROVED', category: 'MARKETING', language: 'es',
    components: [{ type: 'BODY', text: names.map((_, i) => `{{${i + 1}}}`).join(' | ') }],
    variables: names.map((name, index) => ({ name, index: index + 1, position: index + 1 })) };
}
function fixture({ finalNames = ['nombre_paciente', 'fecha_ultima_cita_asistida'] } = {}) {
  const f = { samples: [], messages: [], events: [], sends: [], conversations: [], listWrites: [],
    itemReads: [], holds: new Set(), authorized: true, emailCalls: [], sourceRows: new Map() };
  const list = { id: 99, objective_id: 'mass_sends', clinica_id: 1, clinic_ids: [1], scope_type: 'clinic',
    created_by: 1, status: 'prepared', criteria: { review_care_version: 1, review_care_actor_id: 1,
      template_usage: 'solicitud_resena', review_sender_name: 'Equipo ficticio', whatsapp_template_id: 6071 },
    update: async patch => { f.listWrites.push(structuredClone(patch)); Object.assign(list, patch); } };
  function add(id, patientId, firstName, date, clinicId = 1) {
    const row = { id, list_id: 99, paciente_id: patientId, clinica_id: clinicId, name: `${firstName} Ficticia`,
      phone: '34900000001', email: 'fictitious@example.invalid', treatment: 'Servicio ficticio',
      last_visit_at: null, appointment_at: null, treatment_completed: false, status: 'ready', selected: true,
      custom_fields: { nombre: firstName, nombre_paciente: firstName, nombre_completo: `${firstName} Ficticia`,
        campo_emisor: `${firstName} autorizado`, import_care_date: { version: 1, status: 'invalid' } } };
    row.custom_fields[snapshots.KEY] = snapshots.sealCareSnapshot({ item: row, listId: 99, actorId: 1,
      care: { patientId, clinicId, latestCare: { date, kind: 'performed_service_import', provenance: [] } } });
    const record = { row, model: { ...row, get: () => structuredClone(row),
      update: async () => { throw Error('REAL_RECIPIENT_MUTATION_FORBIDDEN'); } } };
    f.sourceRows.set(id, record); return record;
  }
  add(11, 101, 'Ana', '2026-09-10'); add(12, 102, 'Bea', '2026-08-11');
  f.add = add; f.list = list;
  f.scope = { scope: 'clinic', clinicIds: [1], reviewCareAuthority: { actorId: 1,
    authorize: async ({ clinicId }) => {
      if (!f.authorized || !f.scope.clinicIds.includes(clinicId)) throw Object.assign(Error('forbidden'), { status: 403 });
      return { actorId: 1, sessionRef: 'fictitious-session' };
    } } };
  const care = createReviewCareContext({ db: { sequelize: { query: async (sql, { replacements }) => {
    assert.match(sql, /^SELECT patient_id FROM PatientImportedIdentities/);
    return replacements.patientIds.filter(id => f.holds.has(id)).map(patient_id => ({ patient_id }));
  } } },
    access: { assertPatientPairs: async ({ pairs }) => {
      for (const pair of pairs) {
        const found = [...f.sourceRows.values()].some(r => r.row.paciente_id === pair.patientId && r.row.clinica_id === pair.clinicId);
        if (!found) throw Object.assign(Error('patient_scope_invalid'), { status: 403 });
      }
    }, assertActorClinics: async ({ clinicIds }) => {
      if (clinicIds.some(id => !f.scope.clinicIds.includes(id))) throw Object.assign(Error('forbidden'), { status: 403 });
    } } });
  const requested = template(['nombre_paciente', 'fecha_ultima_cita_asistida']);
  const actual = template(finalNames, 7071); f.finalTemplate = actual;
  const itemModel = {
    findOne: async ({ where }) => {
      f.itemReads.push(structuredClone(where));
      if (!where.id) throw Error('FIRST_READY_OR_SAMPLE_FALLBACK_FORBIDDEN');
      const record = f.sourceRows.get(Number(where.id));
      return record && Number(record.row.list_id) === Number(where.list_id) ? record.model : null;
    },
    create: async data => {
      const row = structuredClone({ id: 1000 + f.samples.length, ...data }); f.samples.push(row);
      return { ...row, get: () => structuredClone(row) };
    },
  };
  const context = {
    crypto: require('node:crypto'), Date, Map, Set, Buffer, URL,
    asPlainObject: value => value || {}, normalizeKey: value => String(value || '').toLowerCase(),
    normalizeText: value => String(value || '').trim(), normalizeCampaignSenderName: value => value,
    normalizeTemplateUsage: value => value, normalizeReviewSenderName: value => value || '',
    requireReviewSenderName: value => { if (!value) throw Error('sender_required'); },
    isReviewTemplateUsage: value => value === 'solicitud_resena',
    isReviewRequestList: value => value.criteria.template_usage === 'solicitud_resena',
    careSnapshots: snapshots, resolveLastAttendedAppointmentDate: dates.resolveLastAttendedAppointmentDate,
    formatReviewDate: dates.formatMarketingDate, CAMPAIGN_SENDER_VARIABLE_KEYS: new Set(['usuario_nombre', 'nombre_remitente', 'sender_name']),
    resolveReviewDisplayClinicName: (value, clinic) => value.criteria.review_display_clinic_name || value.criteria.reviewDisplayClinicName || clinic?.nombre || 'Clínica ficticia',
    resolveReviewSenderName: value => value.criteria.review_sender_name || value.criteria.reviewSenderName || value.criteria.firma_resenas || '',
    resolveCampaignSenderName: value => value.criteria.sender_name || 'Equipo ficticio',
    resolvePatientFirstNameForTemplate: item => item.name.split(' ')[0],
    buildWhatsappTemplateVariableContract: value => value.variables,
    MarketingPatientList: { findByPk: async () => list }, MarketingPatientListItem: itemModel,
    MarketingPatientContactEvent: { create: async value => { f.events.push(structuredClone(value)); } },
    ensureScopeAccess: (_list, scope) => { if (!scope.clinicIds.includes(1)) throw Object.assign(Error('scope'), { status: 404 }); },
    ensureDispatchableCampaignRecord: () => {}, guardReviewCare: (scope, list, items = [], options = {}) => care.guard({ scope, list, items, ...options }),
    getLastReviewRequestTemplateForScope: async () => null,
    resolveReviewTeamPhotoSelection: () => null, matchesReviewTemplateMedia: () => true,
    templateHasImageHeader: () => false, publicMediaPersonalizationService: { normalizeHexColor: () => null },
    findApprovedReviewWhatsappTemplate: async () => requested, resolveWhatsappTemplate: async () => requested,
    loadClinicForTemplateVariables: async () => ({ nombre: 'Clínica ficticia' }),
    resolveWhatsappClinicConfigForList: async () => ({ wabaId: 'FICTITIOUS', phoneNumberId: 'FICTITIOUS' }),
    isWhatsappRoutingConfigAvailable: () => true,
    resolveWhatsappTemplateForClinic: async () => { if (f.beforeFinalTemplate) await f.beforeFinalTemplate(); return actual; },
    whatsappAccountHealthService: { assertCanSend: async () => {} },
    whatsappService: { normalizePhoneNumber: value => String(value || '').replace(/\D/g, ''),
      sendMessage: async value => { f.sends.push(structuredClone(value)); return { messages: [{ id: 'FICTITIOUS_WAMID' }] }; } },
    getListLinkTrackingConfig: () => ({ enabled: false }),
    extractBodyText: components => components.find(c => c.type === 'BODY')?.text || '',
    buildTemplateComponentsForSend: async ({ params }) => [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }],
    assertTestSendCooldown: () => {}, isCommercialTemplateUsage: () => false,
    findCanonicalWhatsappConversation: async value => {
      f.conversations.push(structuredClone(value)); return { id: 500, clinic_id: value.clinicId, update: async () => {} };
    },
    Message: { create: async value => {
      const row = structuredClone({ id: 2000 + f.messages.length, ...value }); f.messages.push(row);
      return { ...row, update: async patch => { Object.assign(row, structuredClone(patch)); } };
    } },
    emitQuickChatMessageCreated: () => {}, emitQuickChatMessageUpdated: () => {},
    resolveWhatsappChannelRole: () => 'primary', OBJECTIVE_ID: 'mass_sends',
    whatsappDeliveryGovernanceService: { recordImmediateSendResponse: async () => ({ status: 'accepted', held: false, providerMessageId: 'FICTITIOUS_WAMID' }) },
    marketingEmailDispatchService: { sendTest: async (...args) => { f.emailCalls.push(args); return { email: true }; } },
    require: name => {
      if (name === '../lib/whatsappAppointmentEligibility') return require('../../lib/whatsappAppointmentEligibility');
      throw Error('UNEXPECTED_DEPENDENCY_' + name);
    },
  };
  vm.createContext(context);
  for (const [name, next] of [
    ['serializeItem', 'function getBlockedGates'], ['resolveVariableValue', 'function getTemplateVariableContract'],
    ['getTemplateVariableContract', 'function getClinicIdForList'], ['getClinicIdForList', 'async function getOrCreateReviewTestSampleItem'],
    ['getOrCreateReviewTestSampleItem', 'function getSingleClinicIdForDispatchCalendar'],
    ['assertReviewRequestCommunicationAllowed', 'function getWhatsappRoutingPurposeForList'],
    ['buildMissingVariablesSummary', 'function partitionItemsByTemplateVariableAvailability'],
    ['resolveTemplateParamValue', 'async function buildTemplateParams'], ['buildTemplateParams', 'function isHttpsUrl'],
    ['isHttpsUrl', 'function resolveReviewTeamPhotoUrl'], ['renderTemplatePreview', 'async function prepareCampaign'],
    ['sendTest', 'async function getEmailTestStatus'],
  ]) vm.runInContext(extract(name, next), context);
  f.run = (body = {}, scope = f.scope) => context.sendTest(scope, 99, {
    item_id: 11, template_usage: 'solicitud_resena', whatsapp_template_id: 6071, to: '34900000099', ...body,
  });
  f.before = () => JSON.stringify([...f.sourceRows.values()].map(value => value.row));
  f.normalParams = id => context.buildTemplateParams({ template: actual,
    item: f.sourceRows.get(id).model.get(), list, clinic: { nombre: 'Clínica ficticia' } });
  f.normalPreview = id => context.renderTemplatePreview({ template: actual,
    item: f.sourceRows.get(id).model.get(), list, clinic: { nombre: 'Clínica ficticia' } });
  return f;
}
function isolated(f, sourceId) {
  const sample = f.samples.at(-1), message = f.messages.at(-1);
  assert.equal(sample.paciente_id, null); assert.equal(sample.selected, false);
  assert.equal(sample.status, 'test_sample'); assert.equal(sample.dispatch_status, 'test_only');
  assert.equal(sample.phone, null); assert.equal(sample.email, null);
  assert.equal(sample.custom_fields[snapshots.KEY], undefined);
  assert.equal(sample.custom_fields.review_test_source_item_id, sourceId);
  assert.match(sample.custom_fields.review_test_render_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(message.metadata.item_id, sample.id);
  assert.equal(message.metadata.review_test_source_item_id, sourceId);
  assert(f.events.every(event => event.item_id === sample.id && !event.paciente_id));
  assert.equal(f.sends.at(-1).to, '34900000099');
}
test('complete selected test renders authorized name/date and keeps the real recipient untouched', async () => {
  const f = fixture(), before = f.before(), response = await f.run();
  assert.equal(response.success, true); assert.deepEqual(f.sends[0].templateParams, ['Ana', '10/09/2026']);
  assert.equal(f.messages[0].content, 'Ana | 10/09/2026'); isolated(f, 11);
  assert.equal(f.before(), before); assert.equal(f.listWrites.length, 0);
  assert.equal(f.samples[0].custom_fields.import_care_date, undefined);
  assert.equal(f.sourceRows.get(11).row.custom_fields.import_care_date.status, 'invalid');
});
test('two selected sources with the same phone keep different test rows, values and render fingerprints', async () => {
  const f = fixture(), before = f.before(); await f.run();
  const previous = JSON.stringify(f.samples[0]); await f.run({ item_id: 12 });
  assert.deepEqual(f.sends.map(row => row.templateParams), [['Ana', '10/09/2026'], ['Bea', '11/08/2026']]);
  assert.equal(JSON.stringify(f.samples[0]), previous); assert.notEqual(f.samples[0].id, f.samples[1].id);
  assert.notEqual(f.samples[0].custom_fields.review_test_render_fingerprint, f.samples[1].custom_fields.review_test_render_fingerprint);
  assert.equal(f.events.at(-1).item_id, f.samples[1].id); assert.equal(f.before(), before);
});
test('materialization uses the final sender template contract and its public selected values', async () => {
  const f = fixture({ finalNames: ['nombre_completo', 'fecha_ultima_cita_asistida', 'campo_emisor'] });
  await f.run(); assert.equal(f.sends[0].templateName, f.finalTemplate.name);
  assert.deepEqual(f.sends[0].templateParams, ['Ana Ficticia', '10/09/2026', 'Ana autorizado']);
  assert.equal(f.messages[0].content, 'Ana Ficticia | 10/09/2026 | Ana autorizado'); isolated(f, 11);
});
test('only an explicit example request creates dummy data and it never reads a first patient or prior sample', async () => {
  const f = fixture(), before = f.before(); await f.run({ item_id: undefined, test_sample: true });
  assert.equal(f.itemReads.length, 0); assert.equal(f.samples[0].name, 'Paciente de ejemplo'); isolated(f, null);
  assert.equal(f.before(), before);
});
for (const body of [{ item_id: undefined }, { item_id: 'bad' }, { item_id: 999 }, { item_id: 11, test_sample: true }]) {
  test('missing, invalid or ambiguous selection fails without sample, transport or conversation: ' + JSON.stringify(body), async () => {
    const f = fixture(), before = f.before(); await assert.rejects(f.run(body), error => error.status === 400 && /^review_test_source_/.test(error.code));
    assert.equal(f.samples.length + f.sends.length + f.conversations.length + f.listWrites.length, 0); assert.equal(f.before(), before);
  });
}
test('an ID from another list never falls back to a real or dummy patient', async () => {
  const f = fixture(); f.sourceRows.get(11).row.list_id = 88;
  await assert.rejects(f.run(), { code: 'review_test_source_invalid' }); assert.equal(f.samples.length + f.sends.length, 0);
});
test('scope, tampered snapshot and current global HOLD all remain closed before copying selected values', async () => {
  for (const failure of ['scope', 'snapshot', 'missing_care', 'name', 'hold', 'late_authority']) {
    const f = fixture();
    if (failure === 'scope') f.scope.clinicIds = [2];
    if (failure === 'snapshot') f.sourceRows.get(11).row.custom_fields[snapshots.KEY].date = '2026-01-01';
    if (failure === 'missing_care') delete f.sourceRows.get(11).row.custom_fields[snapshots.KEY];
    if (failure === 'name') f.sourceRows.get(11).row.name = '';
    if (failure === 'hold') f.holds.add(101);
    if (failure === 'late_authority') f.beforeFinalTemplate = async () => { f.authorized = false; };
    const before = f.before(); await assert.rejects(f.run());
    assert.equal(f.samples.length + f.sends.length + f.conversations.length, 0, failure); assert.equal(f.before(), before);
  }
});
test('a foreign recipient clinic or conflicting requested clinic cannot be rendered into a test', async () => {
  for (const mode of ['recipient', 'request']) {
    const f = fixture();
    if (mode === 'recipient') { f.add(13, 103, 'Otra', '2026-07-01', 2); f.scope.clinicIds.push(2); }
    const before = f.before();
    await assert.rejects(f.run(mode === 'recipient' ? { item_id: 13 } : { clinic_id: 2 }),
      error => error.status === 403);
    assert.equal(f.samples.length + f.sends.length + f.conversations.length + f.listWrites.length, 0);
    assert.equal(f.before(), before);
  }
});
test('an existing synthetic row cannot masquerade as the selected real patient', async () => {
  const f = fixture(); f.sourceRows.get(11).row.status = 'test_sample';
  await assert.rejects(f.run(), { code: 'review_test_source_invalid' });
  assert.equal(f.samples.length + f.sends.length + f.conversations.length, 0);
});
test('a second explicit example also owns a new row and preserves earlier test history', async () => {
  const f = fixture(); await f.run({ item_id: undefined, test_sample: true });
  const previous = JSON.stringify(f.samples[0]); await f.run({ item_id: undefined, test_sample: true });
  assert.equal(f.samples.length, 2); assert.notEqual(f.samples[0].id, f.samples[1].id);
  assert.equal(JSON.stringify(f.samples[0]), previous); assert.equal(f.itemReads.length, 0);
});
test('explicit email tests keep their separate transport without creating a WhatsApp test row', async () => {
  const f = fixture(), response = await f.run({ channel: 'email', item_id: undefined });
  assert.equal(response.email, true); assert.equal(f.emailCalls.length, 1);
  assert.equal(f.samples.length + f.sends.length + f.messages.length, 0);
});

const clinicAliases = ['clinica', 'nombre_clinica', 'nombreclinica', 'nombre_clinica_visible'];
const reviewSenderAliases = ['firma_resenas', 'nombre_remitente_resenas', 'remitente_resena', 'review_sender_name'];
function staleContext(f) {
  const fields = f.sourceRows.get(11).row.custom_fields;
  for (const key of clinicAliases) fields[key] = 'Clínica ficticia anterior larga';
  for (const key of reviewSenderAliases) fields[key] = 'Firma ficticia anterior';
}
test('complete selected test uses the edited clinic/team context instead of frozen recipient values', async () => {
  const f = fixture({ finalNames: ['nombre_paciente', 'firma_resenas', 'nombre_clinica', 'fecha_ultima_cita_asistida'] });
  staleContext(f); const before = f.before();
  await f.run({ review_display_clinic_name: 'Clínica corta', review_sender_name: 'Firma actual' });
  assert.deepEqual(f.sends[0].templateParams, ['Ana', 'Firma actual', 'Clínica corta', '10/09/2026']);
  assert.equal(f.messages[0].content, 'Ana | Firma actual | Clínica corta | 10/09/2026');
  assert.equal(f.samples[0].custom_fields.nombre_clinica, 'Clínica corta');
  assert.equal(f.samples[0].custom_fields.firma_resenas, 'Firma actual');
  isolated(f, 11); assert.equal(f.before(), before);
});
test('ordinary recipient params and preview honor all clinic and review-team aliases without mutating the audience', async () => {
  const f = fixture({ finalNames: [...clinicAliases, ...reviewSenderAliases, 'nombre_paciente', 'fecha_ultima_cita_asistida'] });
  staleContext(f); f.list.criteria.review_display_clinic_name = 'Clínica corta'; f.list.criteria.review_sender_name = 'Firma actual';
  const before = f.before();
  const expected = [...clinicAliases.map(() => 'Clínica corta'), ...reviewSenderAliases.map(() => 'Firma actual'), 'Ana', '10/09/2026'];
  assert.deepEqual(Array.from(await f.normalParams(11)), expected);
  assert.equal(await f.normalPreview(11), expected.join(' | ')); assert.equal(f.before(), before);
  assert.equal(f.samples.length + f.sends.length + f.messages.length, 0);
});
test('editing clinic/team context changes the render fingerprint but leaves the prior sent test unchanged', async () => {
  const f = fixture({ finalNames: ['nombre_paciente', 'firma_resenas', 'nombre_clinica', 'fecha_ultima_cita_asistida'] });
  staleContext(f); const before = f.before();
  await f.run({ review_display_clinic_name: 'Clínica primera', review_sender_name: 'Primera firma' });
  const previous = JSON.stringify({ sample: f.samples[0], message: f.messages[0] });
  await f.run({ review_display_clinic_name: 'Clínica segunda', review_sender_name: 'Segunda firma' });
  assert.deepEqual(f.sends[1].templateParams, ['Ana', 'Segunda firma', 'Clínica segunda', '10/09/2026']);
  assert.notEqual(f.samples[0].custom_fields.review_test_render_fingerprint, f.samples[1].custom_fields.review_test_render_fingerprint);
  assert.equal(JSON.stringify({ sample: f.samples[0], message: f.messages[0] }), previous); assert.equal(f.before(), before);
});
test('camel-case explicit context is honored and blank review choices retain existing recipient fallback', async () => {
  const f = fixture({ finalNames: [...clinicAliases, ...reviewSenderAliases] }); staleContext(f);
  delete f.list.criteria.review_sender_name;
  Object.assign(f.list.criteria, { reviewDisplayClinicName: 'Clínica camel', reviewSenderName: 'Firma camel' });
  assert.deepEqual(Array.from(await f.normalParams(11)), [...clinicAliases.map(() => 'Clínica camel'), ...reviewSenderAliases.map(() => 'Firma camel')]);
  f.list.criteria.reviewDisplayClinicName = ''; f.list.criteria.reviewSenderName = '';
  assert.deepEqual(Array.from(await f.normalParams(11)), [...clinicAliases.map(() => 'Clínica ficticia anterior larga'), ...reviewSenderAliases.map(() => 'Firma ficticia anterior')]);
});
test('non-review custom fields and generic campaign sender aliases preserve their prior contracts', async () => {
  const genericAliases = ['usuario_nombre', 'nombre_remitente', 'sender_name'];
  const f = fixture({ finalNames: [...clinicAliases, ...reviewSenderAliases, ...genericAliases] }); staleContext(f);
  Object.assign(f.list.criteria, { template_usage: 'promocion', review_display_clinic_name: 'Review no aplicable',
    review_sender_name: 'Review no aplicable', sender_name: 'Remitente general actual' });
  for (const key of genericAliases) f.sourceRows.get(11).row.custom_fields[key] = 'Remitente general antiguo';
  const before = f.before();
  assert.deepEqual(Array.from(await f.normalParams(11)), [...clinicAliases.map(() => 'Clínica ficticia anterior larga'),
    ...reviewSenderAliases.map(() => 'Firma ficticia anterior'), ...genericAliases.map(() => 'Remitente general actual')]);
  assert.equal(f.before(), before);
});
test('context changes fill variables without rewriting approved literal clinic wording', async () => {
  const f = fixture({ finalNames: ['nombre_clinica'] }); staleContext(f);
  f.list.criteria.review_display_clinic_name = 'Clínica corta';
  f.finalTemplate.components[0].text = 'Texto aprobado: Clínica literal fija. Variable: {{1}}';
  const before = JSON.stringify(f.finalTemplate);
  assert.equal(await f.normalPreview(11), 'Texto aprobado: Clínica literal fija. Variable: Clínica corta');
  assert.equal(JSON.stringify(f.finalTemplate), before);
});
test('the real 6071 position contract renders clinic at 2 and review signature at 3 consistently', async () => {
  const f = fixture({ finalNames: ['nombre_paciente', 'nombre_clinica', 'firma_resenas', 'fecha_ultima_cita_asistida'] });
  f.finalTemplate.id = 6071;
  f.finalTemplate.components[0].text = '¡Hola {{1}}! Soy {{3}} de {{2}}. Tu visita fue el {{4}}.';
  staleContext(f); const sourceBefore = f.before(), templateBefore = JSON.stringify(f.finalTemplate);
  await f.run({ review_display_clinic_name: 'Clínica previa', review_sender_name: 'Firma previa' });
  const previousTest = JSON.stringify({ sample: f.samples[0], message: f.messages[0] });
  await f.run({ review_display_clinic_name: 'Clínica corta', review_sender_name: 'Firma actual' });
  assert.deepEqual(f.sends[1].templateParams, ['Ana', 'Clínica corta', 'Firma actual', '10/09/2026']);
  assert.equal(f.sends[1].templateParams[1], 'Clínica corta');
  assert.equal(f.sends[1].templateParams[2], 'Firma actual');
  assert.equal(f.messages[1].content, '¡Hola Ana! Soy Firma actual de Clínica corta. Tu visita fue el 10/09/2026.');
  assert.equal(f.samples[1].custom_fields.nombre_clinica, 'Clínica corta');
  assert.equal(f.samples[1].custom_fields.firma_resenas, 'Firma actual');
  assert.notEqual(f.samples[0].custom_fields.review_test_render_fingerprint, f.samples[1].custom_fields.review_test_render_fingerprint);
  assert.equal(JSON.stringify({ sample: f.samples[0], message: f.messages[0] }), previousTest);
  assert.equal(f.before(), sourceBefore); assert.equal(JSON.stringify(f.finalTemplate), templateBefore);
});

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
      const sample = f.samples.find(row => row.id === Number(where.id) && row.list_id === Number(where.list_id));
      if (sample) return sample;
      const record = f.sourceRows.get(Number(where.id));
      return record && Number(record.row.list_id) === Number(where.list_id) ? record.model : null;
    },
    create: async data => {
      const row = structuredClone({ id: 1000 + f.samples.length, ...data }); f.samples.push(row);
      return { ...row, get: () => structuredClone(row) };
    },
  };
  const context = {
    crypto: require('node:crypto'), Op: require('sequelize').Op, Date, Map, Set, Buffer, URL,
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
    MarketingPatientContactEvent: {
      findOne: async ({where}) => [...f.events].reverse().find(row => Object.entries(where).every(([key,value])=>row[key]===value)) || null,
      findAll: async ({where}) => f.events.filter(row => Object.entries(where).every(([key,value])=>
        value && typeof value==='object' ? Object.values(value).concat(Object.getOwnPropertySymbols(value).map(k=>value[k]))
          .flat().includes(row[key]) : row[key]===value)),
      create: async value => { const row={id: f.events.length+1,...structuredClone(value)};f.events.push(row);return row; },
    },
    ensureScopeAccess: (_list, scope) => { if (!scope.clinicIds.includes(1)) throw Object.assign(Error('scope'), { status: 404 }); },
    ensureDispatchableCampaignRecord: () => {}, guardReviewCare: (scope, list, items = [], options = {}) => care.guard({ scope, list, items, ...options }),
    getLastReviewRequestTemplateForScope: async () => null,
    resolveReviewTeamPhotoSelection: () => null, matchesReviewTemplateMedia: () => true,
    templateHasImageHeader: () => false, publicMediaPersonalizationService: { normalizeHexColor: () => null },
    findApprovedReviewWhatsappTemplate: async () => requested, resolveWhatsappTemplate: async () => requested,
    loadClinicForTemplateVariables: async () => ({ nombre: 'Clínica ficticia', url_dejar_resena: 'https://example.invalid/google-review' }),
    isWithinWhatsappSessionWindow: at => Date.now()-new Date(at).getTime()<23*60*60*1000+50*60*1000,
    extractProviderError: error => ({message:error.message,raw:null}),
    isReviewRatingTriggerMessage: message => message.metadata.kind==='mass_campaign_test',
    materializeReviewPrivateFeedback: async () => ({applied:false}),
    resolveWhatsappClinicConfigForList: async () => ({ originId: 411, wabaId: 'FICTITIOUS', phoneNumberId: 'FICTITIOUS' }),
    isWhatsappRoutingConfigAvailable: () => true,
    resolveWhatsappTemplateForClinic: async () => { if (f.beforeFinalTemplate) await f.beforeFinalTemplate(); return actual; },
    whatsappAccountHealthService: { assertCanSend: async input => f.healthGuard?.(input) },
    whatsappService: { normalizePhoneNumber: value => String(value || '').replace(/\D/g, ''),
      getClinicConfig: async () => ({ originId: 411, wabaId: 'FICTITIOUS', phoneNumberId: 'FICTITIOUS' }),
      sendMessage: async value => {
        if (f.healthGuard) await f.healthGuard({ clinicConfig: value.clinicConfig, source: value.healthContext.source,
          messageId: value.healthContext.messageId, allowPaymentRecoveryProbe: value.healthContext.allowPaymentRecoveryProbe });
        f.sends.push(structuredClone(value)); return { messages: [{ id: 'FICTITIOUS_WAMID' }] };
      } },
    getListLinkTrackingConfig: () => ({ enabled: false }),
    extractBodyText: components => components.find(c => c.type === 'BODY')?.text || '',
    buildTemplateComponentsForSend: async ({ params }) => [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }],
    assertTestSendCooldown: () => {}, isCommercialTemplateUsage: () => false,
    findCanonicalWhatsappConversation: async value => {
      f.conversations.push(structuredClone(value)); return { id: 500, clinic_id: value.clinicId, update: async () => {} };
    },
    Conversation: { findByPk: async id => Number(id) === 500 ? { id: 500, clinic_id: 1 } : null },
    Message: { findByPk: async id => f.messages.find(row => row.id === Number(id)) || null,
      findOne: async ({where}) => [...f.messages].reverse().find(row => Object.entries(where).every(([key,value])=>
        (key.startsWith('metadata.') ? row.metadata?.[key.slice(9)] : row[key])===value)) || null,
      create: async value => {
      const row = structuredClone({ id: 2000 + f.messages.length, createdAt: new Date(), ...value }); f.messages.push(row);
      return { ...row, update: async patch => { Object.assign(row, structuredClone(patch)); } };
    } },
    emitQuickChatMessageCreated: () => {}, emitQuickChatMessageUpdated: () => {},
    resolveWhatsappChannelRole: () => 'primary', OBJECTIVE_ID: 'mass_sends',
    whatsappDeliveryGovernanceService: { recordImmediateSendResponse: async () => ({ status: 'accepted', held: false, providerMessageId: 'FICTITIOUS_WAMID' }) },
    whatsappConnectionStatusService: { markDisconnectedAfterProviderError: async () => {} },
    whatsappPaymentStatusService: { markMissingPaymentFromProviderError: async () => {} },
    marketingEmailDispatchService: { sendTest: async (...args) => { f.emailCalls.push(args); return { email: true }; } },
    require: name => {
      if (name === '../lib/whatsappAppointmentEligibility') return require('../../lib/whatsappAppointmentEligibility');
      if (name === '../lib/whatsapp-dispatch-wait') return require('../../lib/whatsapp-dispatch-wait');
      if (name === '../lib/review-google-link-copy') return require('../../lib/review-google-link-copy');
      throw Error('UNEXPECTED_DEPENDENCY_' + name);
    },
  };
  vm.createContext(context);
  for (const [name, next] of [
    ['serializeItem', 'function getBlockedGates'], ['resolveVariableValue', 'function getTemplateVariableContract'],
    ['getTemplateVariableContract', 'function getClinicIdForList'], ['getClinicIdForList', 'async function getOrCreateReviewTestSampleItem'],
    ['getOrCreateReviewTestSampleItem', 'function getSingleClinicIdForDispatchCalendar'],
    ['isBulkSendTestMessage', 'function shouldScheduleReviewReminder'],
    ['assertReviewRequestCommunicationAllowed', 'function getWhatsappRoutingPurposeForList'],
    ['getWhatsappRoutingPurposeForList', 'function getRequestedWhatsappSenderOriginId'],
    ['sendReviewRatingFollowUp', 'function formatReviewDate'],
    ['materializeTestInboundReply', 'async function materializeInboundReply'],
    ['buildMissingVariablesSummary', 'function partitionItemsByTemplateVariableAvailability'],
    ['resolveTemplateParamValue', 'async function buildTemplateParams'], ['buildTemplateParams', 'function isHttpsUrl'],
    ['isHttpsUrl', 'function resolveReviewTeamPhotoUrl'], ['renderTemplatePreview', 'async function prepareCampaign'],
    ['sendTest', 'async function getEmailTestStatus'],
  ]) vm.runInContext(extract(name, next), context);
  f.run = (body = {}, scope = f.scope) => context.sendTest(scope, 99, {
    item_id: 11, template_usage: 'solicitud_resena', whatsapp_template_id: 6071, to: '34900000099', ...body,
  });
  f.before = () => JSON.stringify([...f.sourceRows.values()].map(value => value.row));
  f.requestedTemplate = requested;
  f.checkFollowUp = (patch = {}) => context.assertReviewRequestCommunicationAllowed({
    list, item: f.samples[0], conversation: { id: 500 }, triggerMessage: f.messages[0],
    forceReview: true, channel: 'whatsapp', ...patch,
  });
  f.followUp = (patch = {}) => context.sendReviewRatingFollowUp({
    list, item: f.samples[0], conversation: { id: 500, clinic_id: 1 }, triggerMessage: f.messages[0],
    rating: 5, occurredAt: new Date(), ...patch,
  });
  context.sendReviewRatingFollowUpOrStoreInlineFeedback = args => context.sendReviewRatingFollowUp(args);
  f.processTestReply = () => context.materializeTestInboundReply({ list, item:f.samples[0],
    conversation:{id:500,clinic_id:1},triggerMessage:f.messages[0],inboundMessage:{id:4000},
    ratingDetails:{rating:5,reason:''},repliedAt:new Date() });
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

function paymentGuard(f, { blocked = false, cooldown = true } = {}) {
  const healthSource = fs.readFileSync(path.resolve(__dirname, '../../services/whatsappAccountHealth.service.js'), 'utf8');
  const now = new Date(), state = { claims: 0, saves: 0, events: 0, blockedSends: 0 };
  const asset = { id: 411, assetType: 'whatsapp_phone_number', isActive: true,
    whatsappAuthorizationId: '11111111-1111-4111-8111-111111111111', additionalData: { payment: {
      ...(cooldown ? { last_probe_at: new Date(+now - 60000).toISOString() } : {}),
      ...(blocked ? { status: 'missing_payment_method', last_error_code: 131042,
        last_detected_at: new Date(+now - 3600000).toISOString() } : {}),
    } }, changed() {}, async save() { state.saves++; } };
  const health = { state: blocked ? 'blocked' : 'healthy', can_send: !blocked, is_stale: false,
    reason_code: blocked ? 'meta_error_131042_payment_missing' : 'provider_connected', provider_status: 'CONNECTED' };
  const context = { Date, paymentProbe: require('../../lib/whatsapp-payment-recovery-probe'),
    clean: value => String(value || '').trim(), safeObject: value => value || {},
    findAssetForConfig: async () => asset, summarizeAssetHealth: () => health,
    isBlockingState: require('../../lib/whatsapp-account-health').isBlockingState,
    db: { sequelize: { transaction: async work => { state.claims++; return work({ LOCK: { UPDATE: 'UPDATE' } }); } } },
    ClinicMetaAsset: { findByPk: async () => asset }, Message: { findByPk: async id => f.messages.find(row => row.id === id) },
    createEvent: async () => { state.events++; }, healthEventDetails: value => value,
    recordBlockedSend: async () => { state.blockedSends++; },
  };
  vm.createContext(context);
  for (const [name, next] of [['paymentRecoveryProbeEligibility', 'async function claimPaymentRecoveryProbe'],
    ['claimPaymentRecoveryProbe', 'function sha256'], ['blockedError', 'async function recordBlockedSend'],
    ['assertCanSend', 'async function recordProviderFailure']]) {
    const at = healthSource.indexOf(`function ${name}(`), end = healthSource.indexOf('\n' + next, at);
    vm.runInContext(healthSource.slice(healthSource.lastIndexOf('\n', at) + 1, end), context);
  }
  f.healthGuard = input => context.assertCanSend(input);
  return { state, asset, health };
}
test('ordinary healthy Review ignores an old probe flag and its existing payment cooldown', async () => {
  for (const bodyLabel of ['solicitud_resena', 'promocion']) {
    const f = fixture(), guard = paymentGuard(f), before = JSON.stringify(guard.asset.additionalData);
    const result = await f.run({ payment_recovery_probe: true, template_usage: bodyLabel });
    assert.equal(result.success, true); assert.equal(f.sends.length, 1);
    assert.equal(f.messages[0].metadata.payment_recovery_probe, false);
    assert.equal(f.sends[0].healthContext.allowPaymentRecoveryProbe, false);
    assert.equal(f.sends[0].healthContext.source, 'marketing_bulk_sends');
    assert.equal(guard.state.claims + guard.state.saves + guard.state.events, 0);
    assert.equal(JSON.stringify(guard.asset.additionalData), before);
  }
});
test('an actually payment-blocked Review remains blocked and cannot claim a recovery probe', async () => {
  const f = fixture(), guard = paymentGuard(f, { blocked: true });
  const before = JSON.stringify(guard.asset.additionalData);
  await assert.rejects(f.run({ payment_recovery_probe: true }), { code: 'WHATSAPP_SENDER_HEALTH_BLOCKED' });
  assert.equal(f.sends.length + f.messages.length + f.samples.length, 0);
  assert.equal(guard.state.claims + guard.state.saves + guard.state.events, 0);
  assert.equal(JSON.stringify(guard.asset.additionalData), before);
});
test('non-Review recovery retains the current cooldown and the legitimate eligible recovery claim', async () => {
  for (const cooldown of [true, false]) {
    const f = fixture(); f.list.criteria.template_usage = 'promocion';
    f.requestedTemplate.name = f.finalTemplate.name = 'fictitious_campaign_contact';
    const guard = paymentGuard(f, { blocked: true, cooldown });
    if (cooldown) {
      await assert.rejects(f.run({ template_usage: 'promocion', payment_recovery_probe: true }),
        error => error.code === 'WHATSAPP_SENDER_HEALTH_BLOCKED' && error.details.retry_after_seconds > 0);
      assert.equal(f.sends.length + guard.state.saves + guard.state.events, 0);
    } else {
      assert.equal((await f.run({ template_usage: 'promocion', payment_recovery_probe: true })).success, true);
      assert.equal(f.sends.length, 1); assert.equal(guard.state.saves, 1); assert.equal(guard.state.events, 1);
      assert.equal(f.sends[0].healthContext.allowPaymentRecoveryProbe, true);
    }
    assert.equal(guard.state.claims, 1);
  }
});

test('a protected test reply validates the selected original without treating the sample as a patient', async () => {
  const f=fixture(), before=f.before();await f.run();
  assert.equal((await f.checkFollowUp()).clinicId,1);
  assert.equal(f.before(),before);assert.equal(f.samples[0].paciente_id,null);
  assert.equal(f.samples[0].custom_fields[snapshots.KEY],undefined);
});

test('an explicit dummy reply checks clinic authority without manufacturing a patient/snapshot',async()=>{
  const f=fixture();await f.run({item_id:null,test_sample:true});
  assert.equal((await f.checkFollowUp()).clinicId,1);assert.equal(f.samples[0].paciente_id,null);
  f.scope.clinicIds=[];await assert.rejects(f.checkFollowUp(),/forbidden/);
});

for(const tamper of ['fingerprint','source','item','list','conversation','direction','kind','recipient','sample_status','sample_patient','sample_selected','sample_dispatch','source_missing','source_clinic','source_snapshot'])
test(`a persisted test reply rejects ${tamper} changes instead of weakening clinical guards`,async()=>{
  const f=fixture();await f.run();const sample=f.samples[0],message=f.messages[0];
  if(tamper==='fingerprint')message.metadata.review_test_render_fingerprint='a'.repeat(64);
  if(tamper==='source')message.metadata.review_test_source_item_id=12;
  if(tamper==='item')message.metadata.item_id=12;
  if(tamper==='list')message.metadata.list_id=100;
  if(tamper==='conversation')message.conversation_id=501;
  if(tamper==='direction')message.direction='inbound';
  if(tamper==='kind')message.metadata.kind='mass_campaign_send';
  if(tamper==='recipient')message.metadata.recipient=null;
  if(tamper==='sample_status')sample.status='ready';
  if(tamper==='sample_patient')sample.paciente_id=101;
  if(tamper==='sample_selected')sample.selected=true;
  if(tamper==='sample_dispatch')sample.dispatch_status='sent';
  if(tamper==='source_missing')f.sourceRows.delete(11);
  if(tamper==='source_clinic')f.sourceRows.get(11).model.clinica_id=2;
  if(tamper==='source_snapshot')delete f.sourceRows.get(11).model.custom_fields[snapshots.KEY];
  await assert.rejects(f.checkFollowUp());assert.equal(f.sends.length,1);
});

test('HOLD and revoked access between test and response still block the follow-up',async()=>{
  const f=fixture();await f.run();f.holds.add(101);
  await assert.rejects(f.checkFollowUp(),e=>e.code==='review_care_messages_held');
  f.holds.clear();f.scope.clinicIds=[];await assert.rejects(f.checkFollowUp(),/forbidden/);
  assert.equal(f.sends.length,1);
});

test('private-feedback replies retain the original test binding and cannot cross test recipients',async()=>{
  const f=fixture();await f.run();const initial=f.messages[0];
  const followup={id:3000,conversation_id:500,direction:'outbound',metadata:{source:'marketing_bulk_sends',
    kind:'review_private_feedback_request',test_send:true,list_id:99,item_id:f.samples[0].id,
    trigger_message_id:initial.id,recipient:initial.metadata.recipient}};
  f.messages.push(followup);assert.equal((await f.checkFollowUp({triggerMessage:followup})).clinicId,1);
  followup.metadata.recipient='34900000088';await assert.rejects(f.checkFollowUp({triggerMessage:followup}));
});

for(const rating of [1,4,5]) test(`selected protected test completes the native ${rating}/5 follow-up without real-patient counters`,async()=>{
  const f=fixture(),before=f.before();await f.run();const r=await f.followUp({rating});
  assert.equal(r.sent,true);assert.equal(f.sends.length,2);assert.equal(f.sends[1].to,'34900000099');
  assert.equal(f.sends[1].useTemplate,false);
  assert.equal(f.messages[1].metadata.kind,rating===5?'review_google_link_followup':'review_private_feedback_request');
  if(rating===5)assert.match(f.sends[1].body,/https:\/\/example.invalid\/google-review/);
  else assert.doesNotMatch(f.sends[1].body,/example.invalid/);
  assert.equal(f.before(),before);assert(f.events.every(e=>!e.paciente_id));
  assert.equal((await f.followUp({rating})).reason,'already_sent');assert.equal(f.sends.length,2);
  assert.equal(f.messages[1].metadata.google_publication_reminder_enabled,undefined);
});

test('a test continuation after the session window does not send a template or enter a real reminder queue',async()=>{
  const f=fixture();await f.run();const r=await f.followUp({occurredAt:new Date(Date.now()-25*60*60*1000)});
  assert.equal(r.reason,'whatsapp_session_window_expired');assert.equal(f.sends.length,1);
});

test('a test whose outbound was stored before its event is not blindly sent again',async()=>{
  const f=fixture();await f.run();await f.followUp();
  f.events.splice(f.events.findIndex(e=>e.event_type==='review_test_rating_followup_sent'),1);
  const r=await f.followUp();assert.equal(r.reason,'already_recorded');assert.equal(f.sends.length,2);
});

test('native protected sample, persisted rating, failed guard, retry and duplicate complete one isolated continuation',async()=>{
  const f=fixture(),before=f.before();await f.run();f.scope.clinicIds=[];
  await assert.rejects(f.processTestReply(),/forbidden/);
  assert.equal(f.sends.length,1);assert.equal(f.events.filter(e=>e.event_type==='review_test_rating_received').length,1);
  f.scope.clinicIds=[1];const resumed=await f.processTestReply();assert.equal(resumed.follow_up.sent,true);
  assert.equal(f.sends.length,2);assert.equal(f.events.filter(e=>e.event_type==='review_test_rating_received').length,1);
  assert.equal((await f.processTestReply()).reason,'test_reply_already_processed');assert.equal(f.sends.length,2);
  assert.equal(f.before(),before);assert.equal(f.listWrites.length,0);
});

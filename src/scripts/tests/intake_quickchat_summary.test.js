'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const {
  isQuickChatSummaryRequest,
  buildSanitizedSummary,
  materializeIntakeQuickChatSummary,
} = require('../../services/intakeQuickChatSummary.service');
const {
  normalizeConfiguredLocations,
  sanitizePublicLocationLabel,
} = require('../../lib/intake-public-locations');
const {
  extractChatLocationId,
  resolveChatStateClinicSelection,
} = require('../../lib/intakeChatLocation');

function makeMessage(messages, payload, id) {
  const message = {
    id,
    ...payload,
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
    async destroy() {
      const index = messages.indexOf(this);
      if (index >= 0) messages.splice(index, 1);
    },
  };
  messages.push(message);
  return message;
}

async function testSummaryMaterialization() {
  const messages = [];
  const lead = {
    id: 91,
    clinica_id: 56,
    nombre: 'Nombre previo',
    telefono: '+34600111222',
    email: 'previo@example.com',
  };
  const conversation = {
    id: 701,
    clinic_id: 56,
    lead_id: null,
    last_message_at: null,
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  const canonicalCalls = [];
  const dependencies = {
    sequelize: {
      transaction: async (work) => work({ LOCK: { UPDATE: 'UPDATE' } }),
    },
    LeadIntake: {
      findByPk: async (id) => (Number(id) === lead.id ? lead : null),
    },
    Message: {
      findAll: async ({ where }) => messages.filter((message) => (
        Number(message.conversation_id) === Number(where.conversation_id)
        && message.message_type === where.message_type
      )),
      create: async (payload) => makeMessage(messages, payload, messages.length + 1),
    },
    findCanonicalWhatsappConversation: async (args) => {
      canonicalCalls.push(args);
      conversation.lead_id = args.leadId;
      return conversation;
    },
  };
  const body = {
    source: 'web',
    source_detail: 'chatbot_quickchat',
    page_url: 'https://www.propdental.es/implantes/?utm_source=test',
    chat_state: {
      step: 8,
      data: {
        nombre: '<b>Ana García</b>',
        telefono: '+34 600 111 222',
        email: 'ANA@EXAMPLE.COM',
        location: 56,
        location_label: 'Barcelona - Sant Martí',
        vive_catalunya: 'si',
        motivo: 'Implantes\ncon valoración',
        preferencias: { horario: 'tarde', password: 'no-debe-aparecer' },
        access_token: 'token-muy-secreto',
      },
    },
  };

  assert.equal(isQuickChatSummaryRequest(body), true);
  assert.equal(isQuickChatSummaryRequest({ source: 'chatbot_quickchat' }), false);

  const sanitized = buildSanitizedSummary({ body, lead });
  assert.equal(sanitized.nombre, 'Ana García');
  assert.equal(sanitized.telefono, '+34600111222');
  assert.equal(sanitized.email, 'ana@example.com');
  assert.equal(sanitized.chat_state_step, '8');
  assert.equal(sanitized.extra_pairs.some((pair) => pair.key === 'access_token'), false);
  assert.equal(JSON.stringify(sanitized).includes('no-debe-aparecer'), false);
  assert.equal(JSON.stringify(sanitized).includes('token-muy-secreto'), false);
  assert.deepEqual(
    sanitized.extra_pairs.filter((pair) => pair.key === 'Clínica'),
    [{ key: 'Clínica', value: 'Barcelona - Sant Martí' }]
  );
  assert.deepEqual(
    sanitized.extra_pairs.find((pair) => pair.key === 'Vive en Barcelona o Catalunya'),
    { key: 'Vive en Barcelona o Catalunya', value: 'Sí' }
  );

  const first = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    body,
  }, dependencies);
  assert.equal(first.created, true);
  assert.equal(first.updated, false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, 'inbound');
  assert.equal(messages[0].message_type, 'event');
  assert.equal(messages[0].status, 'sent');
  assert.equal(messages[0].metadata.kind, 'quickchat_summary');
  assert.equal(messages[0].metadata.hidden_from_patient, true);
  assert.equal(messages[0].metadata.lead_intake_id, lead.id);
  assert.equal(messages[0].metadata.summary.nombre, 'Ana García');
  assert.equal(messages[0].content.includes('token-muy-secreto'), false);
  assert.match(messages[0].content, /Clínica: Barcelona - Sant Martí/);
  assert.match(messages[0].content, /Vive en Barcelona o Catalunya: Sí/);
  assert.doesNotMatch(messages[0].content, /location(?:_label)?:/i);
  assert.equal(canonicalCalls[0].clinicId, 56);
  assert.equal(canonicalCalls[0].contactId, '+34600111222');
  assert.equal(canonicalCalls[0].leadId, lead.id);
  assert.equal(canonicalCalls[0].createIfMissing, true);

  const suppliedTransaction = { LOCK: { UPDATE: 'SUPPLIED_UPDATE' } };
  const transactionReuse = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    body,
  }, {
    ...dependencies,
    transaction: suppliedTransaction,
    sequelize: {
      transaction: async () => {
        throw new Error('must not open a nested transaction');
      },
    },
  });
  assert.equal(transactionReuse.created, false);
  assert.equal(canonicalCalls.at(-1).transaction, suppliedTransaction);

  const retry = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    body,
  }, dependencies);
  assert.equal(retry.created, false);
  assert.equal(retry.updated, false);
  assert.equal(retry.message_id, first.message_id);
  assert.equal(messages.length, 1, 'A retry must not create a second QuickChat event');

  const changedBody = JSON.parse(JSON.stringify(body));
  changedBody.chat_state.data.nombre = 'Ana García López';
  const changed = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    body: changedBody,
  }, dependencies);
  assert.equal(changed.created, false);
  assert.equal(changed.updated, true);
  assert.equal(changed.message_id, first.message_id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].metadata.summary.nombre, 'Ana García López');

  makeMessage(messages, {
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'inbound',
    content: 'Duplicado histórico',
    message_type: 'event',
    status: 'sent',
    sent_at: new Date(),
    metadata: {
      source: 'snippet_chatbot',
      kind: 'quickchat_summary',
      lead_intake_id: lead.id,
    },
  }, 999);
  const consolidated = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    body: changedBody,
  }, dependencies);
  assert.equal(consolidated.consolidated, true);
  assert.equal(messages.length, 1, 'Historical duplicate summaries must be consolidated');
  assert.equal(messages[0].id, first.message_id);

  await assert.rejects(
    materializeIntakeQuickChatSummary({
      leadId: lead.id,
      clinicId: 58,
      body,
    }, dependencies),
    (error) => error?.status === 409 && error?.code === 'quickchat_summary_clinic_mismatch'
  );
  assert.equal(messages.length, 1, 'A cross-clinic dedupe must not create or move messages');

  const originalPhone = lead.telefono;
  lead.telefono = null;
  await assert.rejects(
    materializeIntakeQuickChatSummary({
      leadId: lead.id,
      clinicId: 56,
      body: {
        source_detail: 'chatbot_quickchat',
        chat_state: { data: { nombre: 'Sin teléfono' } },
      },
    }, dependencies),
    (error) => error?.status === 422 && error?.code === 'quickchat_summary_phone_required'
  );
  lead.telefono = originalPhone;
  assert.equal(messages.length, 1, 'An invalid contact must not create a shared or internal fallback chat');
}

function testPublicLocationAlias() {
  const normalized = normalizeConfiguredLocations(
    [{
      id: 56,
      label: 'Etiqueta antigua',
      public_label: '  <strong>Barcelona - Sant Martí</strong>  ',
    }],
    [{
      id: 56,
      label: 'Propdental Glòries',
      phone: '934000000',
      whatsapp: '34600000000',
      address: 'Carrer de la Independència, 275',
    }]
  );

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 56, 'The public alias must not change clinic routing');
  assert.equal(normalized[0].public_label, 'Barcelona - Sant Martí');
  assert.equal(normalized[0].label, 'Barcelona - Sant Martí');
  assert.equal(normalized[0].phone, '934000000');

  const fallback = normalizeConfiguredLocations(
    [{ id: 56, public_label: { unsafe: true } }],
    [{ id: 56, label: 'Propdental Glòries' }]
  );
  assert.equal(fallback[0].public_label, null);
  assert.equal(fallback[0].label, 'Propdental Glòries');
  assert.equal(sanitizePublicLocationLabel('   '), null);
}

async function testGroupChatLocationSelection() {
  const clinics = new Map([
    [56, { id_clinica: 56, grupoClinicaId: 5, estado_clinica: true }],
    [58, { id_clinica: 58, grupoClinicaId: 5, estado_clinica: true }],
    [60, { id_clinica: 60, grupoClinicaId: 5, estado_clinica: false }],
    [74, { id_clinica: 74, grupoClinicaId: 28, estado_clinica: true }],
  ]);
  const findClinicById = async (id) => clinics.get(Number(id)) || null;
  const groupConfig = {
    assignment_scope: 'group',
    group_id: 5,
    config: {
      locations: [
        { id: 19 },
        { id: 56, public_label: 'Barcelona - Sant Martí' },
      ],
    },
  };

  assert.equal(extractChatLocationId({ chat_state: { data: { location: 56 } } }), 56);
  assert.equal(extractChatLocationId({ chatState: { data: { sede: { id: '56' } } } }), 56);
  assert.equal(extractChatLocationId({ chat_state: { data: { clinica_id: '56' } } }), 56);

  const selected = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { location: 56, location_label: 'Barcelona - Sant Martí' } } },
    requestedGroupId: 5,
    submittedClinicId: 56,
    configRecord: groupConfig,
    findClinicById,
  });
  assert.deepEqual(selected, {
    matched: true,
    hasCandidate: true,
    reason: null,
    candidateClinicId: 56,
    clinicId: 56,
    groupId: 5,
  });

  const submittedOnly = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { nombre: 'Runtime 3.2.3 sin location' } } },
    requestedGroupId: 5,
    submittedClinicId: 56,
    configRecord: groupConfig,
    findClinicById,
  });
  assert.deepEqual(submittedOnly, {
    matched: true,
    hasCandidate: true,
    reason: null,
    candidateClinicId: 56,
    clinicId: 56,
    groupId: 5,
  });

  const submittedOnlyOutsideGroup = await resolveChatStateClinicSelection({
    body: { chat_state: { data: {} } },
    requestedGroupId: 5,
    submittedClinicId: 74,
    configRecord: {
      ...groupConfig,
      config: { locations: [{ id: 56 }, { id: 74 }] },
    },
    findClinicById,
  });
  assert.equal(submittedOnlyOutsideGroup.matched, false);
  assert.equal(submittedOnlyOutsideGroup.hasCandidate, true);
  assert.equal(submittedOnlyOutsideGroup.reason, 'clinic_outside_group');

  const explicitClinicConflict = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { location: 56 } } },
    requestedGroupId: 5,
    submittedClinicId: 58,
    configRecord: groupConfig,
    findClinicById,
  });
  assert.equal(explicitClinicConflict.matched, false);
  assert.equal(explicitClinicConflict.hasCandidate, true);
  assert.equal(explicitClinicConflict.reason, 'clinic_chat_mismatch');

  const crossGroup = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { location: 74 } } },
    requestedGroupId: 5,
    configRecord: {
      ...groupConfig,
      config: { locations: [{ id: 56 }, { id: 74 }] },
    },
    findClinicById,
  });
  assert.equal(crossGroup.matched, false);
  assert.equal(crossGroup.hasCandidate, true);
  assert.equal(crossGroup.reason, 'clinic_outside_group');
  assert.equal(crossGroup.clinicId, null);

  const inaccessible = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { location: 58 } } },
    requestedGroupId: 5,
    configRecord: groupConfig,
    findClinicById,
  });
  assert.equal(inaccessible.matched, false);
  assert.equal(inaccessible.hasCandidate, true);
  assert.equal(inaccessible.reason, 'clinic_not_configured');

  const inactive = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { location: 60 } } },
    requestedGroupId: 5,
    configRecord: {
      ...groupConfig,
      config: { locations: [{ id: 60 }] },
    },
    findClinicById,
  });
  assert.equal(inactive.matched, false);
  assert.equal(inactive.hasCandidate, true);
  assert.equal(inactive.reason, 'clinic_inactive');

  const malformed = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { location: 'sede-manipulada' } } },
    requestedGroupId: 5,
    configRecord: groupConfig,
    findClinicById,
  });
  assert.equal(malformed.matched, false);
  assert.equal(malformed.hasCandidate, true);
  assert.equal(malformed.reason, 'invalid_candidate');

  const absent = await resolveChatStateClinicSelection({
    body: { chat_state: { data: { nombre: 'Sin selector de sede' } } },
    requestedGroupId: 5,
    configRecord: groupConfig,
    findClinicById,
  });
  assert.equal(absent.matched, false);
  assert.equal(absent.hasCandidate, false);
  assert.equal(absent.reason, 'no_candidate');
}

function testControllerStopsBeforeExternalTracking() {
  const controllerPath = path.resolve(__dirname, '../../controllers/intake.controller.js');
  const source = fs.readFileSync(controllerPath, 'utf8');
  const ingestStart = source.indexOf('exports.ingestLead =');
  const ingestEnd = source.indexOf('exports.previewLeadImport =', ingestStart);
  const ingest = source.slice(ingestStart, ingestEnd);
  const quickStart = ingest.indexOf('if (isQuickChatSummaryRequest(body))');
  const quickEnd = ingest.indexOf('// La primera llamada del widget (`source_detail=chatbot`)', quickStart);
  const quickBlock = ingest.slice(quickStart, quickEnd);
  const metaSend = ingest.indexOf('await sendMetaEvent({');
  const googleSend = ingest.indexOf('await maybeUploadGoogleConversion({');
  const embeddedSummaryComment = ingest.indexOf('// La primera llamada del widget (`source_detail=chatbot`)');
  const embeddedSummaryCall = ingest.indexOf('embeddedQuickChatSummary = await materializeIntakeQuickChatSummary({');
  const persistedLeadResponse = ingest.lastIndexOf('res.status(201).json({');
  const chatLocationResolution = ingest.indexOf('await resolveChatStateClinicSelection({');
  const groupFallback = ingest.indexOf('await resolveFallbackClinicForGroup(');
  const invalidLocationResponse = ingest.indexOf("error: 'invalid_chat_location'");
  const leadCreation = ingest.indexOf('await dedupeAndCreateLead(');

  assert.ok(quickStart >= 0 && quickEnd > quickStart);
  assert.match(quickBlock, /materializeIntakeQuickChatSummary\(/);
  assert.match(quickBlock, /return res\.status\(dedupeConflict \? 200 : 201\)/);
  assert.doesNotMatch(quickBlock, /sendMetaEvent|maybeUploadGoogleConversion|outboundWhatsApp|queues\./);
  assert.ok(quickEnd < metaSend, 'QuickChat summary must return before Meta CAPI');
  assert.ok(quickEnd < googleSend, 'QuickChat summary must return before Google Ads uploads');
  assert.equal(embeddedSummaryComment, quickEnd, 'save_lead must document its embedded QuickChat fallback');
  assert.ok(
    embeddedSummaryCall > quickEnd && embeddedSummaryCall < metaSend && embeddedSummaryCall < googleSend,
    'save_lead must materialize QuickChat before Meta/Google so a client timeout cannot orphan the lead'
  );
  assert.ok(
    persistedLeadResponse > metaSend && persistedLeadResponse > googleSend,
    'save_lead must preserve the existing best-effort tracking before acknowledging the request'
  );
  assert.ok(
    chatLocationResolution >= 0 && chatLocationResolution < groupFallback,
    'chat_state.data.location must be validated before applying the group fallback clinic'
  );
  assert.match(ingest.slice(chatLocationResolution, groupFallback), /clinicMatchSource = 'chat_location'/);
  assert.match(
    ingest.slice(chatLocationResolution - 500, groupFallback),
    /cfg\?\.assignment_scope === 'group'[\s\S]*submittedClinicId: explicitClinicIdRaw/
  );
  assert.match(
    ingest.slice(chatLocationResolution, groupFallback),
    /chatClinicSelection\.hasCandidate[\s\S]*return res\.status\(422\)/
  );
  assert.ok(
    invalidLocationResponse > chatLocationResolution
      && invalidLocationResponse < groupFallback
      && invalidLocationResponse < leadCreation,
    'An invalid supplied chat location must fail before fallback, dedupe, lead creation, or external events'
  );

  const servicePath = path.resolve(__dirname, '../../services/intakeQuickChatSummary.service.js');
  const serviceSource = fs.readFileSync(servicePath, 'utf8');
  assert.doesNotMatch(
    serviceSource,
    /sendMetaEvent|maybeUploadGoogleConversion|outboundWhatsApp|whatsappService|sendMessage\(/,
    'Summary persistence must not contain an external delivery path'
  );
}

async function run() {
  await testSummaryMaterialization();
  testPublicLocationAlias();
  await testGroupChatLocationSelection();
  testControllerStopsBeforeExternalTracking();
  console.log('intake_quickchat_summary.test.js OK');
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

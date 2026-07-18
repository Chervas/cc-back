'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const {
  isQuickChatSummaryRequest,
  buildSanitizedSummary,
  validateQuickChatContact,
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

  const invalidPhone = validateQuickChatContact({
    body: { source_detail: 'chatbot', chat_state: { data: { telefono: '14725' } } },
  });
  assert.equal(invalidPhone.phone_valid, false);
  const invalidEmail = validateQuickChatContact({
    body: {
      source_detail: 'chatbot',
      chat_state: { data: { telefono: '+34600111222', email: 'correo-invalido' } },
    },
  });
  assert.equal(invalidEmail.phone_valid, true);
  assert.equal(invalidEmail.email_present, true);
  assert.equal(invalidEmail.email_valid, false);

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

async function testNewestAuditWinsWithoutTouchingStaleSummary() {
  const messages = [];
  let conversationUpdateCount = 0;
  let messageUpdateCount = 0;
  const lead = {
    id: 191,
    clinica_id: 56,
    nombre: 'Paciente ordenado',
    telefono: '+34600111222',
    email: 'orden@example.com',
  };
  const conversation = {
    id: 1701,
    clinic_id: 56,
    lead_id: lead.id,
    last_message_at: new Date('2026-07-14T08:00:00.000Z'),
    async update(patch) {
      conversationUpdateCount += 1;
      Object.assign(this, patch);
    },
  };
  const Message = {
    findAll: async ({ where }) => {
      const rawConversationFilter = where.conversation_id;
      const conversationIds = rawConversationFilter && typeof rawConversationFilter === 'object'
        ? Object.getOwnPropertySymbols(rawConversationFilter)
          .flatMap((symbol) => rawConversationFilter[symbol] || [])
          .map(Number)
        : [Number(rawConversationFilter)];
      return messages.filter((message) => (
        conversationIds.includes(Number(message.conversation_id))
        && message.message_type === where.message_type
      ));
    },
    create: async (payload) => {
      const message = makeMessage(messages, payload, 1801);
      const baseUpdate = message.update.bind(message);
      message.update = async (patch) => {
        messageUpdateCount += 1;
        return baseUpdate(patch);
      };
      return message;
    },
  };
  const dependencies = {
    sequelize: {
      transaction: async (work) => work({ LOCK: { UPDATE: 'UPDATE' } }),
    },
    LeadIntake: {
      findByPk: async (id) => (Number(id) === lead.id ? lead : null),
    },
    Conversation: {
      findAll: async ({ where }) => (
        Number(where.clinic_id) === 56 && Number(where.lead_id) === lead.id
          ? [conversation]
          : []
      ),
    },
    Message,
    findCanonicalWhatsappConversation: async () => conversation,
  };
  const bodyFor = (nombre) => ({
    source_detail: 'chatbot_quickchat',
    chat_state: { data: { nombre, telefono: '+34600111222', email: 'orden@example.com' } },
  });

  const legacy = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    body: bodyFor('Resumen X'),
  }, dependencies);
  assert.equal(legacy.created, true);
  assert.equal(messages[0].metadata.intake_audit_id, undefined, 'legacy summaries have no ordering marker');
  const legacyContent = messages[0].content;

  const marker100 = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    auditId: 100,
    body: bodyFor('Resumen X'),
  }, dependencies);
  assert.equal(marker100.updated, true, 'an identical legacy summary must adopt the first durable marker');
  assert.equal(messages[0].metadata.intake_audit_id, 100);
  assert.equal(messages[0].content, legacyContent, 'adopting a marker must not require a content change');

  const marker102 = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    auditId: 102,
    body: bodyFor('Resumen X'),
  }, dependencies);
  assert.equal(marker102.updated, true, 'identical content must still advance the durable watermark');
  assert.equal(messages[0].metadata.intake_audit_id, 102);
  assert.equal(messages[0].content, legacyContent);

  const contentAfterNewest = messages[0].content;
  const metadataAfterNewest = JSON.stringify(messages[0].metadata);
  const lastMessageAfterNewest = conversation.last_message_at;
  const conversationUpdatesAfterNewest = conversationUpdateCount;
  const messageUpdatesAfterNewest = messageUpdateCount;

  const stale = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    auditId: 101,
    body: bodyFor('Resumen Y que llega tarde'),
  }, dependencies);
  assert.equal(stale.stale, true);
  assert.equal(stale.persisted_audit_id, 102);
  assert.equal(messages[0].content, contentAfterNewest);
  assert.equal(JSON.stringify(messages[0].metadata), metadataAfterNewest);
  assert.equal(conversation.last_message_at, lastMessageAfterNewest);
  assert.equal(conversationUpdateCount, conversationUpdatesAfterNewest);
  assert.equal(messageUpdateCount, messageUpdatesAfterNewest);

  const duplicateNewest = await materializeIntakeQuickChatSummary({
    leadId: lead.id,
    clinicId: 56,
    auditId: 102,
    body: bodyFor('Resumen X'),
  }, dependencies);
  assert.equal(duplicateNewest.stale, undefined);
  assert.equal(duplicateNewest.updated, false);
  assert.equal(messages.length, 1, 'double POST/retry must preserve one summary');
}

function testPublicLocationAlias() {
  const normalized = normalizeConfiguredLocations(
    [{
      id: 56,
      label: 'Etiqueta antigua',
      public_label: '  <strong>Barcelona - Sant Martí</strong>  ',
      phone: 'OLD-PHONE',
      whatsapp: 'OLD-WHATSAPP',
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
  assert.equal(normalized[0].whatsapp, '34600000000');

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
  const quickStart = ingest.indexOf('if (isDirectQuickChatSummary)');
  const quickEnd = ingest.indexOf('const embeddedQuickChatSummary =', quickStart);
  const quickBlock = ingest.slice(quickStart, quickEnd);
  const metaSend = ingest.indexOf('await sendMetaEvent({');
  const googleSend = ingest.indexOf('await maybeUploadGoogleConversion({');
  const outboxFastPathCall = ingest.indexOf('quickChatFastPathOutcome = await triggerIntakeQuickChatSummaryFastPath(');
  const persistedLeadResponse = ingest.lastIndexOf('res.status(ingestResponseStatus).json({');
  const chatLocationResolution = ingest.indexOf('await resolveChatStateClinicSelection({');
  const groupFallback = ingest.indexOf('await resolveFallbackClinicForGroup(');
  const invalidLocationResponse = ingest.indexOf("error: 'invalid_chat_location'");
  const leadCreation = ingest.indexOf('await dedupeAndCreateLead(');
  const quickChatContactValidation = ingest.indexOf('const quickChatContact = validateQuickChatContact({');
  const dedupChatbotOutcome = ingest.indexOf('if (dedupeConflict && isCompletedChatbotLead)');
  const generalDedupeOutcome = ingest.indexOf('if (dedupeConflict) {', dedupChatbotOutcome + 1);
  const fastPathCatchStart = ingest.indexOf('} catch (summaryError) {', outboxFastPathCall);
  const fastPathCatchEnd = ingest.indexOf('\n    }', fastPathCatchStart) + 6;
  const fastPathCatch = ingest.slice(fastPathCatchStart, fastPathCatchEnd);

  assert.ok(quickStart >= 0 && quickEnd > quickStart);
  assert.doesNotMatch(quickBlock, /materializeIntakeQuickChatSummary\(/);
  assert.match(quickBlock, /quickChatFastPathOutcome\?\.quickchat_summary_saved === true/);
  assert.match(quickBlock, /return res\.status\(dedupeConflict \? 200 : 201\)/);
  assert.match(quickBlock, /return res\.status\(202\)/);
  assert.match(quickBlock, /quickchat_summary_queued: true/);
  assert.doesNotMatch(quickBlock, /sendMetaEvent|maybeUploadGoogleConversion|outboundWhatsApp|queues\./);
  assert.ok(quickEnd < metaSend, 'QuickChat summary must return before Meta CAPI');
  assert.ok(quickEnd < googleSend, 'QuickChat summary must return before Google Ads uploads');
  assert.ok(
    outboxFastPathCall >= 0 && outboxFastPathCall < quickStart && outboxFastPathCall < metaSend && outboxFastPathCall < googleSend,
    'both source_detail contracts must consume the durable outbox before branching or invoking providers'
  );
  assert.ok(
    dedupChatbotOutcome > outboxFastPathCall
      && dedupChatbotOutcome < generalDedupeOutcome
      && generalDedupeOutcome < metaSend
      && generalDedupeOutcome < googleSend,
    'deduplicated chatbot must return its outbox outcome before the general 409 and advertising providers'
  );
  const dedupChatbotBlock = ingest.slice(dedupChatbotOutcome, generalDedupeOutcome);
  assert.match(dedupChatbotBlock, /return res\.status\(200\)/);
  assert.match(dedupChatbotBlock, /return res\.status\(202\)/);
  assert.match(dedupChatbotBlock, /return res\.status\(safeTerminalStatus\)/);
  assert.match(dedupChatbotBlock, /quickChatFastPathOutcome\?\.error_code \|\| 'quickchat_summary_failed'/);
  assert.doesNotMatch(dedupChatbotBlock, /sendMetaEvent|maybeUploadGoogleConversion/);
  assert.match(
    ingest.slice(generalDedupeOutcome, metaSend),
    /return res\.status\(409\)/,
    'non-chatbot dedupe must preserve the general 409 contract'
  );
  assert.match(fastPathCatch, /quickchat_summary_outcome_unknown: true/);
  assert.match(fastPathCatch, /quickchat_summary_state: 'unknown_durable'/);
  assert.doesNotMatch(fastPathCatch, /job_status: 'pending'|quickchat_summary_queued: true/);
  assert.ok(
    persistedLeadResponse > metaSend && persistedLeadResponse > googleSend,
    'save_lead must preserve the existing best-effort tracking before acknowledging the request'
  );
  assert.match(
    ingest.slice(persistedLeadResponse, ingest.length),
    /\.\.\.\(embeddedQuickChatSummary[\s\S]*?quickchat_summary_saved: true[\s\S]*?quickchat_summary_queued: false/,
    'save_lead may report a saved summary only when the fast path returned a real saved result'
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
    ingest.slice(chatLocationResolution - 900, chatLocationResolution),
    /const mustValidateGroupChatLocation = !webLandingAttribution/,
    'a server-validated Web publication must preserve its authoritative clinic match source'
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
  assert.ok(
    quickChatContactValidation >= 0 && quickChatContactValidation < leadCreation,
    'completed/direct QuickChat requests must reject invalid contact data before lead creation'
  );
  assert.match(
    ingest.slice(quickChatContactValidation, leadCreation),
    /return res\.status\(422\)[\s\S]*quickchat_summary_saved: false/
  );

  const controllerSource = fs.readFileSync(controllerPath, 'utf8');
  const persistenceStart = controllerSource.indexOf('async function dedupeAndCreateLead(');
  const persistenceEnd = controllerSource.indexOf('\nexports.ingestLead =', persistenceStart);
  const persistenceBlock = controllerSource.slice(persistenceStart, persistenceEnd);
  assert.match(persistenceBlock, /persistLeadAuditAndQuickChatOutbox\(/);
  assert.match(persistenceBlock, /quickChatOutbox === true/);
  assert.match(ingest, /const isQuickChatOutboxLead = isCompletedChatbotLead \|\| isDirectQuickChatSummary/);
  assert.match(ingest, /quickChatOutbox: isQuickChatOutboxLead/);
  assert.match(ingest, /onQuickChatOutboxCreated/);
  assert.match(ingest, /persistExistingLeadAuditAndQuickChatOutbox\([\s\S]*?rawPayload: req\.body \|\| \{\}/);
  assert.equal(
    (ingest.match(/resolved_clinic_id: clinicaIdParsed/g) || []).length,
    2,
    'new and deduplicated outboxes must persist the resolved clinic in their exact audit'
  );
  assert.equal(
    (ingest.match(/resolved_group_id: grupoClinicaIdParsed/g) || []).length,
    2,
    'new and deduplicated outboxes must persist the resolved group in their exact audit'
  );
  assert.doesNotMatch(
    ingest,
    /await materializeIntakeQuickChatSummary/,
    'neither chatbot source_detail may bypass JobRequest with a lateral DB call'
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
  await testNewestAuditWinsWithoutTouchingStaleSummary();
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

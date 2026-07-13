'use strict';

const assert = require('node:assert/strict');
const {
  conversionEventIds,
  parseOptions,
  validateQuickChatMessage,
  validateState,
} = require('../../../scripts/cleanup-intake-e2e-run');

const MARKER = 'CC-E2E-20260713-073000';
const NOW = new Date('2026-07-13T07:35:00.000Z');

function options(overrides = {}) {
  return {
    mode: 'dry-run',
    groupId: 5,
    marker: MARKER,
    leadIds: [7201],
    appointmentIds: [],
    sessionIds: ['cc_session_abcdef'],
    maxAgeHours: 72,
    maxWebEvents: 250,
    domain: 'www.propdental.es',
    acknowledgeExternalConversions: false,
    ...overrides,
  };
}

function state(overrides = {}) {
  const leads = [{
    id: 7201,
    clinica_id: 19,
    grupo_clinica_id: 5,
    source: 'web',
    source_detail: 'chatbot',
    event_id: 'cc_event_7201',
    nombre: MARKER,
    email: null,
    notas: null,
    external_id: null,
    created_at: '2026-07-13T07:30:00.000Z',
    gclid: null,
    gbraid: null,
    wbraid: null,
    callback_reminder_job_id: null,
  }];
  const appointments = [];
  return {
    leads,
    groupClinics: [{ id_clinica: 19 }],
    appointments,
    appointmentHolds: [],
    conversations: [{
      id: 4001,
      clinic_id: 19,
      patient_id: null,
      lead_id: 7201,
      channel: 'whatsapp',
      createdAt: '2026-07-13T07:30:02.000Z',
    }],
    messages: [{
      id: 5001,
      conversation_id: 4001,
      direction: 'inbound',
      message_type: 'event',
      status: 'sent',
      metadata: {
        kind: 'quickchat_summary',
        source_detail: 'chatbot_quickchat',
        hidden_from_patient: true,
        lead_intake_id: 7201,
      },
      createdAt: '2026-07-13T07:30:02.000Z',
    }],
    conversationReads: [],
    marketingConversationRefs: [],
    whatsappOriginRefs: [],
    formSubmissions: [{
      id: 6001,
      clinic_id: 19,
      group_id: 5,
      lead_intake_id: 7201,
      form_id: '77822',
      created_at: '2026-07-13T07:30:03.000Z',
    }],
    webEvents: [{
      id: 7001,
      clinic_id: 19,
      group_id: 5,
      event_name: 'ViewContent',
      event_id: 'web-event-1',
      session_id: 'cc_session_abcdef',
      domain: 'www.propdental.es',
      occurred_at: '2026-07-13T07:29:00.000Z',
    }],
    conversionAttempts: [{
      id: 8001,
      clinica_id: 19,
      grupo_clinica_id: 5,
      event_name: 'lead',
      event_id: 'cc_event_7201',
      status: 'skipped',
      provider_request_id: null,
      attempted_at: '2026-07-13T07:30:04.000Z',
    }],
    attributionAudits: [{ id: 9001, lead_intake_id: 7201 }],
    contactAttempts: [],
    flowInstances: [],
    eventIds: conversionEventIds(leads, appointments),
    ...overrides,
  };
}

const parsed = parseOptions([
  '--group-id=5',
  `--marker=${MARKER}`,
  '--lead-ids=7201,7202',
  '--session-ids=cc_session_abcdef,cc_session_ghijkl',
  '--appointment-ids=99',
  '--simulate',
]);
assert.equal(parsed.mode, 'simulate');
assert.deepEqual(parsed.leadIds, [7201, 7202]);
assert.deepEqual(parsed.appointmentIds, [99]);
assert.deepEqual(parsed.sessionIds, ['cc_session_abcdef', 'cc_session_ghijkl']);

assert.deepEqual(
  conversionEventIds(
    [{ id: 42, event_id: 'browser-event-42' }],
    [{ id_cita: 99 }],
  ),
  [
    'browser-event-42',
    'lead-42',
    'lead-42-qualified',
    'appointment-99',
    'appointment-99-treatment-completed',
  ],
);

assert.equal(validateQuickChatMessage(state().messages[0], 7201), true);
assert.equal(validateQuickChatMessage({
  ...state().messages[0],
  direction: 'outbound',
}, 7201), false);

const valid = validateState(state(), options(), NOW);
assert.equal(valid.externalConversionRows, 0);
assert.deepEqual(valid.clinicIds, [19]);

assert.throws(
  () => validateState(state({
    leads: [{ ...state().leads[0], nombre: 'not a marked lead' }],
  }), options(), NOW),
  /does not carry marker/,
);

assert.throws(
  () => validateState(state({
    conversionAttempts: [{
      ...state().conversionAttempts[0],
      status: 'succeeded',
      provider_request_id: 'provider-request-1',
    }],
  }), options({ mode: 'simulate' }), NOW),
  /will not retract them/,
);

const dryRunWithExternal = validateState(state({
  conversionAttempts: [{
    ...state().conversionAttempts[0],
    status: 'succeeded',
    provider_request_id: 'provider-request-1',
  }],
}), options(), NOW);
assert.equal(dryRunWithExternal.externalConversionRows, 1);

const acknowledged = validateState(state({
  conversionAttempts: [{
    ...state().conversionAttempts[0],
    status: 'succeeded',
    provider_request_id: 'provider-request-1',
  }],
}), options({ mode: 'simulate', acknowledgeExternalConversions: true }), NOW);
assert.equal(acknowledged.externalConversionRows, 1);

console.log('cleanup_intake_e2e_run.test.js OK');
